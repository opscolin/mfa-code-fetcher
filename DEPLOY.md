# MFA Code Fetcher 部署文档

一套"邮箱 MFA 验证码 + TOTP 动态口令"自动填充方案，支持 macOS / Windows / Ubuntu（图形桌面）。

## 一、架构概览

```
┌─────────────────────────────────────────────────────┐
│  浏览器扩展 (extension/)                             │
│  - TOTP 通道: 纯本地计算, 独立工作, 不依赖任何后端    │
│  - 邮箱通道: 从本地 API 取码自动填充                  │
└──────────────────┬──────────────────────────────────┘
                   │ http://127.0.0.1:8642/code (仅本机)
┌──────────────────┴──────────────────────────────────┐
│  后端服务 mfa_code_fetcher.py (Python, 标准库实现,   │
│  无第三方依赖)                                       │
│  - IMAP 长连接监听飞书邮箱                           │
│  - 提取 MFA 验证码 → 剪贴板 + 系统通知               │
│  - 内置本地 HTTP API (127.0.0.1:8642)                │
└─────────────────────────────────────────────────────┘
```

| 组件 | 何时需要 | 依赖 |
|------|----------|------|
| 浏览器扩展 | 必装 | Chrome 或 Edge（Chromium 内核） |
| Python 后端 | 仅邮箱验证码通道需要 | Python 3.8+，**零第三方依赖**；TOTP 用户可完全跳过 |

**通用准备（三个平台一致）：**

1. 把整个 `mfa-code-fetcher/` 目录拷贝到目标机器（如 `~/mfa-code-fetcher`），扩展从该目录的 `extension/` 子目录加载
2. 若用邮箱通道：在飞书**桌面客户端**生成专用密码（头像 → 设置 → 邮箱 → 第三方邮箱客户端登录 → 生成；需公司管理员已开启该功能）
3. `cp config.example.json config.json`，填入邮箱地址和专用密码
4. **安全建议**：`chmod 600 config.json`（限本人可读），且不要把 `config.json` 提交到 git

> 升级到 v1.3.0 后**必须重新授权域名**：旧版靠 `manifest.json` 里的预置域名清单自动注入，v1.3.0 删掉了这份清单，改为按你配置的域名动态注入。升级后打开每个要用的 MFA 站点，按第五节把它「启用本页」一次即可，会生成新的权限记录。

## 二、macOS 部署

```bash
cd ~/mfa-code-fetcher
python3 mfa_code_fetcher.py --test   # 验证 IMAP 配置
python3 mfa_code_fetcher.py          # 常驻运行
```

- macOS 自带 python3，无需安装
- 系统通知：首次触发通知后，到 系统设置 → 通知 → 允许"脚本编辑器/Terminal"的通知
- 剪贴板：原生支持，无需安装

**开机自启（launchd）：**

创建 `~/Library/LaunchAgents/com.mfa.fetcher.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mfa.fetcher</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/Users/你的用户名/mfa-code-fetcher/mfa_code_fetcher.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mfa-fetcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/mfa-fetcher.log</string>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.mfa.fetcher.plist
# 验证: curl --noproxy '*' http://127.0.0.1:8642/health
```

> **关于 stdout 缓冲**：Python 在 stdout 被重定向到文件时默认块缓冲，不加处理 `/tmp/mfa-fetcher.log` 会长期为 0 字节。本服务的脚本已在 `setup_logging()` 里调用 `sys.stdout.reconfigure(line_buffering=True)` 自行开启行缓冲，**无需**在 plist 里额外加 `PYTHONUNBUFFERED`。
> 服务自身的日志**不依赖** stdout，写在项目目录 `logs/mfa-fetcher-YYYY-MM.log`（带时间戳，按月切分，默认保留 3 个月）。

**修改代码后重启服务**（请在自己的终端里执行，不要在受限/沙箱化的环境中执行）：

```bash
launchctl unload ~/Library/LaunchAgents/com.mfa.fetcher.plist
launchctl load -w ~/Library/LaunchAgents/com.mfa.fetcher.plist
# 或一步到位:
launchctl kickstart -k gui/$(id -u)/com.mfa.fetcher
```

> **注意**：`launchctl` 必须在**用户自己登录的终端会话**中执行。在受限环境（沙箱、CI、远程非 GUI 上下文）里执行会报 `Bootstrap failed: 5: Input/output error`，且 `launchctl list` 也看不到已加载的服务。若确认在正常终端中仍报此错，重启终端或注销重新登录一次再试。



## 三、Windows 部署

1. 安装 Python：从 https://www.python.org/downloads/ 下载，安装时**勾选 "Add Python to PATH"**
2. 把 `mfa-code-fetcher/` 放到如 `C:\Tools\mfa-code-fetcher`
3. 在 `config.json` 填好账号（注意 Windows 下路径用记事本编辑即可）
4. 启动：

```powershell
cd C:\Tools\mfa-code-fetcher
python mfa_code_fetcher.py --test
python mfa_code_fetcher.py
```

- 剪贴板：走系统 `clip.exe`，原生支持
- 系统通知：脚本自动调用 PowerShell 气泡通知，无需安装
- **开机自启（后台无窗口运行）**：`Win+R` 输入 `shell:startup` 回车，在打开的文件夹里新建 `start_mfa.vbs`：

```vbs
Set ws = CreateObject("Wscript.Shell")
ws.Run "pythonw.exe C:\Tools\mfa-code-fetcher\mfa_code_fetcher.py", 0, False
```

（`pythonw.exe` 是无窗口版 Python；验证运行状态：`curl http://127.0.0.1:8642/health` 或任务管理器找 pythonw 进程）

## 四、Ubuntu（图形桌面）部署

```bash
sudo apt update
sudo apt install -y python3 xclip wl-clipboard libnotify-bin
cd ~/mfa-code-fetcher
python3 mfa_code_fetcher.py --test
python3 mfa_code_fetcher.py
```

- 剪贴板：X11 会话用 `xclip`，Wayland 用 `wl-copy`（脚本自动探测）
- 系统通知：`notify-send`（libnotify），GNOME 桌面原生支持
- **开机自启（systemd 用户服务）**：创建 `~/.config/systemd/user/mfa-fetcher.service`：

```ini
[Unit]
Description=MFA Code Fetcher
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 %h/mfa-code-fetcher/mfa_code_fetcher.py
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now mfa-fetcher
# 验证: curl --noproxy '*' http://127.0.0.1:8642/health
```

## 五、浏览器扩展安装（Chrome / Edge）

1. Chrome 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `extension/` 文件夹
4. 点击工具栏扩展图标确认弹窗正常；TOTP 秘钥在弹窗里「+ 添加秘钥」添加
5. 扩展升级后：扩展卡片上点刷新图标即可，无需重启浏览器

**安装后必须做的第二步：授权你要自动填充的站点。**

v1.3.0 起扩展**不含任何预置域名**，装完默认不往任何网站注入脚本。两种授权方式（都在弹窗里）：

| 场景 | 操作 |
|------|------|
| 该站点用 TOTP 动态口令 | 「+ 添加秘钥」→ 填名称/秘钥/**绑定域名**（可点「用当前页」）→ 保存 → 弹出 Chrome 权限框点「允许」 |
| 该站点用邮箱验证码 | 打开该站点页面 → 点扩展图标 → 顶部黄色条点「启用本页」→ 权限框点「允许」 |

授权后**刷新页面**生效（已打开的页面不会自动补注入）。弹窗顶部状态条由黄变绿即表示成功。
权限范围是 `https://*.域名/*` + `http://*.域名/*`（同时申请 http，因为内网 MFA 页面常跑在 http；Chrome 只弹一次对话框）。
收回权限：`chrome://extensions` → 本扩展「详情」→「网站访问权限」→ 移除对应域名，扩展会立即注销该域名的注入。

> 权限对话框是 MV3 的 `optional_host_permissions` 机制，用户逐个域名确认。这是安全代价，也是取代"开发者预置厂商域名清单"的正解。

> 其他浏览器：Firefox 需适配（暂不支持）；Safari 需用 Xcode 的 `safari-web-extension-converter` 转换打包，有需要再做。

## 六、安全说明（重要）

**TOTP 秘钥安全性——结论：个人设备上使用是安全的，与手机 authenticator 同等安全级别，但需了解边界：**

| 层面 | 现状 |
|------|------|
| 存储位置 | `chrome.storage.local`，**仅存本机、仅限当前浏览器 Profile、不云同步**——秘钥不会离开你的电脑 |
| 隔离性 | 其他网页/其他扩展**无法读取**（扩展存储按 origin 隔离） |
| 访问门槛 | 等同于"能打开你浏览器 Profile 的人/程序"——与手机上解锁后打开 authenticator App 类似，但少了生物识别那一道锁 |
| 风险场景 | 电脑被恶意软件完全控制、或他人物理使用你未锁屏的电脑时，秘钥可被读取 |
| 加分项 | 相比把秘钥存进第三方在线服务，本地存储无云端泄露面 |

**已内置的安全措施：**
- 本地 API 只监听 `127.0.0.1`，外网机器无法访问
- API **不返回 CORS 头**（v1.2.1 起），任意网页的 JS 无法跨源读取验证码
- 验证码只在本地 API 存活 5 分钟，过期自动失效
- **最小权限**（v1.3.0 起）：扩展不声明任何站点权限，`host_permissions` 只有 `127.0.0.1:8642`；其余域名走 `optional_host_permissions`，**由用户逐个授权**，且只注入已授权的域名。撤销授权后注入立即注销

**建议**：公司账号请确认 IT 安全策略是否允许软件类 authenticator；公用电脑不要存秘钥；`config.json`（含飞书专用密码）设为本人可读（Mac/Linux `chmod 600`，Windows 右键→属性→安全仅保留自己）。

## 七、日志与诊断

**日志文件**：项目目录下 `logs/mfa-fetcher-YYYY-MM.log`（**按自然月切分**，每条立即落盘），同时输出到 stdout。

```bash
tail -f ~/mfa-code-fetcher/logs/mfa-fetcher-$(date +%Y-%m).log    # 实时跟踪当月日志
ls -lh ~/mfa-code-fetcher/logs/                                   # 看历史月份
```

**自动清理**：默认保留**当月 + 往前 2 个月**（共 3 个文件），更早的在启动时和跨月切换时自动删除。要改保留时长，在 `config.json` 里加 `"log_keep_months": 2`（`0` = 只留当月，`6` = 留半年）。旧版本留下的单文件 `logs/mfa-fetcher.log` 会在首次启动时自动并入当月文件，内容不丢。

日志记录内容：启动配置摘要、IMAP 连接/重连、每分钟心跳、每封邮件的命中判定（发件人白名单/关键词）、提取到的验证码、剪贴板/通知/写状态结果、所有异常堆栈。级别可用 `config.json` 的 `log_level` 调整（DEBUG / INFO / WARNING）。

**漏收排查：`--diag` 诊断模式**（最常用）

```bash
cd ~/mfa-code-fetcher && python3 mfa_code_fetcher.py --diag
```

逐封打印最近邮件的完整判定链：发件人、主题、邮件时间、正文长度、白名单是否命中、关键词是否命中、能否提取出验证码、最终判定（可提取 / 跳过原因）。**"邮件收到了但插件没取到码"这类问题，跑一次 --diag 就能定位到是哪一环丢的。**

## 八、排障速查

| 症状 | 处理 |
|------|------|
| 扩展显示"本地 API 不可达" | 确认服务在跑；`curl --noproxy '*' http://127.0.0.1:8642/health` |
| curl 走了代理报 upstream 错误 | 加 `--noproxy '*'`；Chrome 走系统代理时在代理例外里加 `127.0.0.1` |
| **邮件收到了但插件没取到码** | 跑 `python3 mfa_code_fetcher.py --diag`，看判定原因；若"未命中白名单/关键词"，把该邮件的发件人域名加入 `config.json` 的 `sender_allowlist` |
| **`/tmp/mfa-fetcher.log` 是空的** | Python stdout 块缓冲所致。脚本已自行开启行缓冲（见第五节说明），一般无需处理；服务自身日志请直接看 `logs/mfa-fetcher-YYYY-MM.log` |
| 看起来一切正常但没反应 | 看当月日志的心跳行「运行中 \| 已轮询 N 次 \| IMAP 连接正常」确认存活 |
| IMAP 登录失败 | 飞书专用密码是否最新生成；管理员是否开启第三方客户端登录；日志里有完整异常 |
| 端口 8642 被占 | 改 `config.json` 的 `api_port`，同步改 `extension/manifest.json` 和 `background.js` 里的 8642 |
| 填错输入框 | 右键检查元素复制输入框 HTML 发给维护者精调 `content.js` |

