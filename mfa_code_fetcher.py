#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mfa_code_fetcher.py — 监听飞书邮箱中的 MFA 验证码邮件 (后端服务)

工作流程:
  IMAP 长连接轮询 -> 逐封分析(发件人白名单 / 关键词双路命中) -> 提取验证码
  -> 剪贴板 + 系统通知 + latest_code.json + 日志
  -> 本地 HTTP API (127.0.0.1:8642) 供浏览器扩展自动填充

用法:
  python3 mfa_code_fetcher.py            # 常驻监听 (launchd/systemd 用这个)
  python3 mfa_code_fetcher.py --test     # 只测试登录与配置然后退出
  python3 mfa_code_fetcher.py --once     # 只检查一次收件箱后退出
  python3 mfa_code_fetcher.py --diag     # 诊断: 分析最近邮件, 打印完整判定链

日志:
  logs/mfa-fetcher.log (自动轮转, 5MB x 3 份), 级别可用 log_level 配置

v1.3.0 变更:
  - 修复: 阿里云邮件标题本地化(如「二次认证」)导致关键词过滤漏收 →
          新增 sender_allowlist 发件人白名单, 与关键词构成"双路命中"
  - 新增: 完整日志系统 (文件+stdout, 立即落盘)
  - 新增: --diag 诊断模式, 逐封展示判定链
"""

import json
import logging
import os
import re
import subprocess
import sys
import time
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from logging.handlers import RotatingFileHandler

import imaplib
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
STATE_PATH = os.path.join(BASE_DIR, "latest_code.json")
SEEN_PATH = os.path.join(BASE_DIR, ".seen_ids")
LOG_DIR = os.path.join(BASE_DIR, "logs")
LOG_PATH = os.path.join(LOG_DIR, "mfa-fetcher.log")

# 默认发件人白名单: 命中即进入提取阶段 (不怕邮件标题被本地化)
DEFAULT_SENDER_ALLOWLIST = ["notice.aliyun.com"]
# 默认关键词: 用于白名单之外的邮件兜底匹配 (发件人或正文/主题命中)
DEFAULT_KEYWORDS = ["MFA", "verification"]

log = logging.getLogger("mfa")


# ---------------------------------------------------------------- 日志

def setup_logging(cfg=None):
    """文件日志 (立即落盘, 自动轮转) + stdout"""
    cfg = cfg or {}
    os.makedirs(LOG_DIR, exist_ok=True)
    level = getattr(logging, str(cfg.get("log_level", "INFO")).upper(), logging.INFO)

    log.setLevel(logging.DEBUG)
    log.handlers.clear()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    fh = RotatingFileHandler(LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3,
                             encoding="utf-8")
    fh.setLevel(level)
    fh.setFormatter(fmt)
    log.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setLevel(level)
    sh.setFormatter(fmt)
    log.addHandler(sh)

    # 防止 launchd 环境下 stdout 无终端导致异常
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    return log


# ---------------------------------------------------------------- 配置与状态

def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(f"[!] 未找到配置文件: {CONFIG_PATH}")
        print("    请复制 config.example.json 为 config.json 并填写邮箱与专用密码")
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_seen():
    if os.path.exists(SEEN_PATH):
        try:
            with open(SEEN_PATH, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except Exception as e:
            log.warning("读取 .seen_ids 失败, 重新开始: %s", e)
    return set()


def save_seen(seen):
    try:
        with open(SEEN_PATH, "w", encoding="utf-8") as f:
            json.dump(sorted(seen)[-500:], f)  # 只保留最近500条
    except Exception as e:
        log.warning("写入 .seen_ids 失败: %s", e)


def write_state(code, meta):
    """写入 latest_code.json, 供浏览器插件通过本地 API 读取"""
    state = {
        "code": code,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": int(time.time()),
        "subject": meta.get("subject", ""),
        "from": meta.get("from", ""),
    }
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.error("写入 latest_code.json 失败: %s", e)


# ---------------------------------------------------------------- 本地 API

class ApiHandler(BaseHTTPRequestHandler):
    """本地 HTTP 接口, 供浏览器扩展获取最新验证码"""

    def do_GET(self):
        if self.path == "/code":
            self._send_code()
        elif self.path == "/health":
            self._send_json({"ok": True, "service": "mfa-code-fetcher"})
        else:
            self.send_response(404)
            self.end_headers()

    def _send_code(self):
        fresh_seconds = 300  # 5 分钟内的验证码才算有效
        payload = {"code": None, "age_seconds": None, "fetched_at": None}
        if os.path.exists(STATE_PATH):
            try:
                with open(STATE_PATH, "r", encoding="utf-8") as f:
                    state = json.load(f)
                age = int(time.time()) - int(state.get("timestamp", 0))
                if age <= fresh_seconds:
                    payload = {
                        "code": state.get("code"),
                        "age_seconds": age,
                        "fetched_at": state.get("fetched_at"),
                    }
            except Exception as e:
                log.debug("读取 latest_code.json 失败: %s", e)
        self._send_json(payload)

    def _send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # 安全: 故意不加 Access-Control-Allow-Origin 头。
        # 扩展凭 host_permissions 直接跨源读取, 无需 CORS;
        # 不加该头可阻止任意网页的 JS 通过 CORS 读取验证码。
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        log.debug("API %s", fmt % args)


def start_api_server(cfg):
    """在后台线程启动本地 API (默认 127.0.0.1:8642)"""
    port = int(cfg.get("api_port", 8642))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), ApiHandler)
    except OSError as e:
        log.error("本地 API 启动失败 (端口 %d 可能被占用): %s", port, e)
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("本地 API 已启动: http://127.0.0.1:%d/code (供浏览器扩展调用)", port)
    return server


# ---------------------------------------------------------------- 系统集成

def copy_to_clipboard(code):
    """跨平台复制到剪贴板"""
    try:
        if sys.platform == "darwin":
            subprocess.run(["pbcopy"], input=code.encode(), check=True)
        elif sys.platform.startswith("linux"):
            for cmd in (["wl-copy"], ["xclip", "-selection", "clipboard"]):
                try:
                    subprocess.run(cmd, input=code.encode(), check=True)
                    break
                except (FileNotFoundError, subprocess.CalledProcessError):
                    continue
        elif sys.platform == "win32":
            subprocess.run(["clip"], input=code.encode(), check=True)
    except Exception as e:
        log.warning("复制到剪贴板失败: %s", e)


def notify(code, subject):
    """系统通知: macOS / Windows / Linux"""
    title = "MFA 验证码"
    message = f"{code}  已复制到剪贴板"
    try:
        if sys.platform == "darwin":
            script = (
                f'display notification "{message}" with title "{title}" '
                f'subtitle "{subject[:40]}" sound name "Glass"'
            )
            subprocess.run(["osascript", "-e", script], check=True,
                           capture_output=True, timeout=5)
        elif sys.platform == "win32":
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "Add-Type -AssemblyName System.Drawing;"
                "$n = New-Object System.Windows.Forms.NotifyIcon;"
                "$n.Icon = [System.Drawing.SystemIcons]::Information;"
                "$n.Visible = $true;"
                f"$n.ShowBalloonTip(5000, '{title}', '{message}', 'Info');"
                "Start-Sleep -Seconds 6;"
                "$n.Dispose()"
            )
            subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, timeout=15)
        elif sys.platform.startswith("linux"):
            subprocess.run(["notify-send", "-a", "mfa-code-fetcher", title, message],
                           check=True, capture_output=True, timeout=5)
    except Exception as e:
        # launchd 环境下通知可能无权限, 不影响主流程
        log.warning("系统通知发送失败 (不影响取码): %s", e)


# ---------------------------------------------------------------- 邮件解析

def decode_subject(msg):
    """解码邮件主题 (policy.default 会自动处理 encoded-word)"""
    subject = msg["Subject"]
    if not subject:
        return ""
    try:
        return str(subject)
    except Exception:
        from email.header import decode_header, make_header
        try:
            return str(make_header(decode_header(str(subject))))
        except Exception:
            return str(subject)


def get_text_bodies(msg):
    """提取邮件纯文本内容 (含 HTML 去标签兜底)"""
    texts = []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_content()
                if isinstance(payload, bytes):
                    payload = payload.decode("utf-8", errors="ignore")
            except Exception:
                continue
            if ctype == "text/html":
                payload = re.sub(r"<[^>]+>", " ", payload)
            texts.append(payload)
    else:
        try:
            payload = msg.get_content()
            if isinstance(payload, bytes):
                payload = payload.decode("utf-8", errors="ignore")
            if msg.get_content_type() == "text/html":
                payload = re.sub(r"<[^>]+>", " ", payload)
            texts.append(payload)
        except Exception:
            pass
    return texts


def extract_code(text, code_regex=None):
    """从文本中提取验证码: 先找'code/验证码'附近的数字, 再退化匹配"""
    if code_regex:
        m = re.search(code_regex, text)
        if m:
            return m.group(1) if m.groups() else m.group(0)
    patterns = [
        r"(?:code|CODE|Code|验证码|校验码|动态码|认证码)[^0-9A-Za-z]{0,20}([0-9]{4,8})",
        r"([0-9]{6})",
        r"([0-9]{4,8})",
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            return m.group(1)
    return None


def analyze_message(msg, cfg):
    """分析单封邮件, 返回完整判定结果 (供主流程与 --diag 共用)"""
    subject = decode_subject(msg)
    sender = str(msg["From"] or "")
    try:
        mail_time = parsedate_to_datetime(msg["Date"]).timestamp()
        date_err = None
    except Exception as e:
        mail_time = time.time()
        date_err = type(e).__name__
    age_seconds = time.time() - mail_time

    bodies = get_text_bodies(msg)
    full_text = subject + "\n" + "\n".join(bodies)
    keywords = cfg.get("subject_keywords", DEFAULT_KEYWORDS)
    allowlist = [s.lower() for s in cfg.get("sender_allowlist", DEFAULT_SENDER_ALLOWLIST)]

    kw_hit = [k for k in keywords if k.lower() in full_text.lower()]
    sender_hit = [a for a in allowlist if a in sender.lower()]
    hit = bool(sender_hit) or bool(kw_hit)
    code = extract_code(full_text, cfg.get("code_regex"))

    ttl = cfg.get("code_ttl_minutes", 10) * 60
    result = {
        "msg_id": str(msg["Message-ID"] or ""),
        "subject": subject,
        "sender": sender,
        "date_header": str(msg["Date"] or ""),
        "date_err": date_err,
        "age_seconds": age_seconds,
        "ttl_seconds": ttl,
        "sender_hit": sender_hit,
        "kw_hit": kw_hit,
        "hit": hit,
        "code": code,
        "text_len": len(full_text),
    }
    # 判定顺序: TTL -> 命中特征 -> 提取到码
    if age_seconds > ttl:
        result["skip_reason"] = "ttl"
    elif not hit:
        result["skip_reason"] = "no_match"
    elif not code:
        result["skip_reason"] = "no_code"
    else:
        result["skip_reason"] = None
    return result


def describe_skip(reason):
    return {
        "ttl": "超过有效期(旧邮件), 未处理",
        "no_match": "未命中发件人白名单/关键词",
        "no_code": "命中特征但未提取到验证码",
    }.get(reason, "")


# ---------------------------------------------------------------- IMAP

def connect(cfg):
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(cfg["imap_host"], cfg.get("imap_port", 993), ssl_context=ctx)
    conn.login(cfg["email"], cfg["password"])
    return conn


def check_inbox(conn, cfg, seen, verbose_skip=False):
    """检查收件箱, 返回新验证码列表 [(code, subject, from)]"""
    codes = []
    conn.select("INBOX", readonly=True)
    since = time.strftime("%d-%b-%Y", time.localtime(time.time() - 86400 * 2))
    status, data = conn.search(None, f'SINCE "{since}"')
    if status != "OK":
        log.error("IMAP SEARCH 失败: %s", status)
        return codes
    nums = data[0].split()
    log.debug("本轮扫描 %d 封邮件 (SINCE %s)", len(nums), since)

    for num in nums:
        status, mdata = conn.fetch(num, "(RFC822)")
        if status != "OK":
            log.warning("拉取邮件 %s 失败: %s", num, status)
            continue
        msg = BytesParser(policy=policy.default).parsebytes(mdata[0][1])
        info = analyze_message(msg, cfg)
        msg_id = info["msg_id"] or f"{num.decode()}-{info['date_header']}"
        if msg_id in seen:
            continue

        # 首次处理这封邮件, 记录判定过程并永久标记
        seen.add(msg_id)
        if info["skip_reason"]:
            if verbose_skip or info["skip_reason"] != "no_match":
                log.debug("跳过邮件 | %s | 原因=%s | 主题=%r | 正文长度=%d",
                          info["sender"][:50], describe_skip(info["skip_reason"]),
                          info["subject"][:50], info["text_len"])
            continue

        log.info("命中邮件 | 发件人=%s | 主题=%r | 白名单=%s | 关键词=%s",
                 info["sender"][:50], info["subject"][:50],
                 info["sender_hit"], info["kw_hit"])
        codes.append((info["code"], info["subject"], info["sender"]))
    return codes


def run_diag(cfg, limit=20):
    """--diag: 分析最近邮件并打印完整判定链, 快速定位漏收原因"""
    print("=" * 96)
    print("诊断模式: 分析最近 %d 封邮件 (不写入状态, 不触发通知)" % limit)
    print("当前规则: 发件人白名单=%s | 关键词=%s | TTL=%s 分钟" % (
        cfg.get("sender_allowlist", DEFAULT_SENDER_ALLOWLIST),
        cfg.get("subject_keywords", DEFAULT_KEYWORDS),
        cfg.get("code_ttl_minutes", 10)))
    print("=" * 96)
    conn = connect(cfg)
    print("[✓] IMAP 登录成功: %s" % cfg["email"])
    conn.select("INBOX", readonly=True)
    since = time.strftime("%d-%b-%Y", time.localtime(time.time() - 86400 * 2))
    status, data = conn.search(None, f'SINCE "{since}"')
    nums = data[0].split()
    print("两天内邮件总数: %d, 展示最近 %d 封" % (len(nums), min(limit, len(nums))))
    print("-" * 96)
    for num in nums[-limit:]:
        status, mdata = conn.fetch(num, "(RFC822)")
        msg = BytesParser(policy=policy.default).parsebytes(mdata[0][1])
        info = analyze_message(msg, cfg)
        verdict = "✅ 可提取" if not info["skip_reason"] else "⏭  跳过: " + describe_skip(info["skip_reason"])
        print("From    : %s" % info["sender"][:80])
        print("Subject : %r" % info["subject"][:60])
        print("Date    : %s (距今 %.1f 分钟)" % (info["date_header"], info["age_seconds"] / 60))
        print("正文长度: %d | 白名单命中: %s | 关键词命中: %s" % (
            info["text_len"], info["sender_hit"], info["kw_hit"]))
        print("提取验证码: %s" % (info["code"] or "无"))
        print("判定    : %s" % verdict)
        print("-" * 96)
    conn.logout()


# ---------------------------------------------------------------- 主流程

def main():
    cfg = load_config()
    setup_logging(cfg)
    seen = load_seen()

    if "--diag" in sys.argv:
        try:
            run_diag(cfg)
        except Exception as e:
            log.exception("诊断失败: %s", e)
            sys.exit(1)
        return

    if "--test" in sys.argv or "--once" in sys.argv:
        try:
            conn = connect(cfg)
            log.info("IMAP 登录成功: %s (%s)", cfg["email"], cfg["imap_host"])
            codes = check_inbox(conn, cfg, seen, verbose_skip=True)
            if "--once" in sys.argv:
                for code, subject, sender in codes:
                    log.info("发现验证码: %s <- %s", code, subject)
            save_seen(seen)
            conn.logout()
            log.info("配置检查完成")
        except Exception as e:
            log.exception("连接失败: %s", e)
            sys.exit(1)
        return

    interval = cfg.get("poll_interval", 5)
    log.info("=" * 70)
    log.info("启动 MFA 验证码监听服务")
    log.info("邮箱=%s | 轮询间隔=%ss | 白名单=%s | 关键词=%s",
             cfg["email"], interval,
             cfg.get("sender_allowlist", DEFAULT_SENDER_ALLOWLIST),
             cfg.get("subject_keywords", DEFAULT_KEYWORDS))
    log.info("日志文件: %s", LOG_PATH)
    start_api_server(cfg)

    conn = None
    rounds = 0
    last_heartbeat = time.time()
    try:
        while True:
            try:
                if conn is None:
                    conn = connect(cfg)
                    log.info("已连接到邮箱服务器")
                before = len(seen)
                codes = check_inbox(conn, cfg, seen)
                if len(seen) != before:
                    save_seen(seen)

                for code, subject, sender in codes:
                    log.info("收到验证码: %s | 来自=%s | 主题=%r", code, sender[:40], subject[:40])
                    copy_to_clipboard(code)
                    notify(code, subject)
                    write_state(code, {"subject": subject, "from": sender})
                    log.info("已复制到剪贴板 / 已通知 / 已写入 latest_code.json")

                rounds += 1
                conn.noop()  # 保活
                # 心跳: 每分钟一条, 便于确认服务存活
                if time.time() - last_heartbeat >= 60:
                    log.info("运行中 | 已轮询 %d 次 | IMAP 连接正常 | 已知邮件 %d 条",
                             rounds, len(seen))
                    last_heartbeat = time.time()
            except (imaplib.IMAP4.abort, imaplib.IMAP4.error, OSError) as e:
                log.warning("IMAP 连接异常, %ss 后重连: %s", interval, e)
                conn = None
                save_seen(seen)
            except Exception as e:
                log.exception("轮询出现未预期异常 (将继续运行): %s", e)
            time.sleep(interval)
    except KeyboardInterrupt:
        log.info("收到退出信号, 服务结束")
        if conn:
            try:
                conn.logout()
            except Exception:
                pass


if __name__ == "__main__":
    main()
