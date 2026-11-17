#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日志按月切分 + 过期清理 的回归测试
运行: python3 tests/test_log_rotation.py
不依赖 pytest，也不需要真实邮箱/网络。
"""

import os
import sys
import tempfile
import logging
import shutil
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import mfa_code_fetcher as m  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [ok] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s %s" % (name, extra))


def touch(path, content=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def names(d):
    return sorted(os.listdir(d))


def main():
    tmp = tempfile.mkdtemp(prefix="mfa-log-test-")
    try:
        # ---------- 1. 文件名规则 ----------
        print("\n[1] 当月文件名格式")
        p = m.monthly_log_path(datetime(2026, 11, 16), log_dir=tmp)
        check("路径为 mfa-fetcher-2026-11.log", p.endswith("mfa-fetcher-2026-11.log"), p)

        # ---------- 2. 清理: 保留当月 + 前 2 个月 ----------
        print("\n[2] 清理过期日志 (keep_months=2, 当前 2026-11)")
        d2 = os.path.join(tmp, "clean2")
        for ym in ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]:
            touch(os.path.join(d2, "mfa-fetcher-%s.log" % ym), "x")
        touch(os.path.join(d2, "other.log"), "x")                 # 非本插件文件
        touch(os.path.join(d2, "mfa-fetcher-2026-11.log.bak"), "x")  # 不符合命名
        h = m.MonthlyLogHandler(d2, m.LOG_PREFIX, 2)
        removed = h.cleanup(datetime(2026, 11, 16))
        h.close()
        check("删除 07/08 月", sorted(removed) == ["mfa-fetcher-2026-07.log", "mfa-fetcher-2026-08.log"], removed)
        check("保留 09/10/11 月", names(d2) == [
            "mfa-fetcher-2026-09.log", "mfa-fetcher-2026-10.log",
            "mfa-fetcher-2026-11.log", "mfa-fetcher-2026-11.log.bak", "other.log"], names(d2))
        check("不误删非本插件文件", "other.log" in names(d2))

        # ---------- 3. keep_months=0 只留当月 ----------
        print("\n[3] keep_months=0 只保留当月")
        d3 = os.path.join(tmp, "clean0")
        for ym in ["2026-10", "2026-11"]:
            touch(os.path.join(d3, "mfa-fetcher-%s.log" % ym), "x")
        h = m.MonthlyLogHandler(d3, m.LOG_PREFIX, 0)
        removed = h.cleanup(datetime(2026, 11, 16))
        h.close()
        check("删除 10 月", removed == ["mfa-fetcher-2026-10.log"], removed)
        check("只剩 11 月", names(d3) == ["mfa-fetcher-2026-11.log"], names(d3))

        # ---------- 4. 非法配置值回落默认 ----------
        print("\n[4] keep_months 非法值回落")
        h = m.MonthlyLogHandler(tmp, m.LOG_PREFIX, "abc")
        check("字符串 'abc' → 默认 2", h.keep_months == 2, h.keep_months)
        h2 = m.MonthlyLogHandler(tmp, m.LOG_PREFIX, -5)
        check("负数 → 0", h2.keep_months == 0, h2.keep_months)
        h.close()
        h2.close()

        # ---------- 5. 跨月自动切换文件 ----------
        print("\n[5] 跨月切换")
        d5 = os.path.join(tmp, "rotate")
        h = m.MonthlyLogHandler(d5, m.LOG_PREFIX, 2)
        h.setFormatter(logging.Formatter("%(message)s"))
        h._open_for(datetime(2026, 10, 31, 23, 59))
        check("10 月文件已建", os.path.exists(os.path.join(d5, "mfa-fetcher-2026-10.log")))
        h._open_for(datetime(2026, 11, 1, 0, 1))
        check("11 月文件已建", os.path.exists(os.path.join(d5, "mfa-fetcher-2026-11.log")))
        with open(os.path.join(d5, "mfa-fetcher-2026-11.log"), encoding="utf-8") as f:
            body = f.read()
        check("新文件写入切换提示", "跨月切换" in body, body[:80])
        h.close()

        # ---------- 6. emit 真实写入 + 立即落盘 ----------
        print("\n[6] emit 写入当前月文件")
        d6 = os.path.join(tmp, "emit")
        h = m.MonthlyLogHandler(d6, m.LOG_PREFIX, 2)
        h.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        lg = logging.getLogger("mfa-test-emit")
        lg.setLevel(logging.INFO)
        lg.handlers.clear()
        lg.addHandler(h)
        lg.info("hello-rotation")
        cur = m.monthly_log_path(log_dir=d6)
        check("当月文件存在", os.path.exists(cur), cur)
        with open(cur, encoding="utf-8") as f:
            check("内容已落盘", "hello-rotation" in f.read())
        h.close()

        # ---------- 7. 旧版单文件迁移 ----------
        print("\n[7] 旧版 mfa-fetcher.log 迁移")
        d7 = os.path.join(tmp, "migrate")
        legacy = os.path.join(d7, "mfa-fetcher.log")
        touch(legacy, "OLD-LINE\n")
        target = m.migrate_legacy_log(d7)
        check("返回目标路径", bool(target) and os.path.basename(target).startswith("mfa-fetcher-"),
              target)
        check("旧文件已消失", not os.path.exists(legacy))
        with open(target, encoding="utf-8") as f:
            check("旧内容未丢", "OLD-LINE" in f.read())

        d7b = os.path.join(tmp, "migrate-merge")
        legacy = os.path.join(d7b, "mfa-fetcher.log")
        target = m.monthly_log_path(log_dir=d7b)
        touch(legacy, "OLD-PART\n")
        touch(target, "NEW-PART\n")
        m.migrate_legacy_log(d7b)
        with open(target, encoding="utf-8") as f:
            merged = f.read()
        check("目标已存在时追加而非覆盖", "NEW-PART" in merged and "OLD-PART" in merged, merged)
        check("合并后旧文件删除", not os.path.exists(legacy))

        # ---------- 8. 无旧文件时不报错 ----------
        print("\n[8] 无旧文件时迁移为 no-op")
        d8 = os.path.join(tmp, "empty")
        os.makedirs(d8, exist_ok=True)
        check("返回 None", m.migrate_legacy_log(d8) is None)

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 48)
    print("结果: %d 通过, %d 失败" % (PASS, FAIL))
    print("=" * 48)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
