# MFA AutoFill — Email MFA Codes + TOTP One-Time Passwords

English · [中文](README.md)

**Stop retyping MFA codes.**

Every time you connect to the VPN, an email shows up, you switch windows, copy six
digits, paste them, and hope the window did not expire. MFA AutoFill removes that
loop — the code lands in the right input field the moment it exists, so you can go
straight back to work.

It ships as two independent channels, and you can use either or both:

| Channel | How it works | Needs the Python daemon? |
|---|---|---|
| **Email code** | A local Python daemon watches your IMAP mailbox, recognises MFA mails, extracts the code and serves it on `127.0.0.1:8642`. The browser extension polls that endpoint and types the code into the verification field. | Yes |
| **TOTP** | The extension implements RFC 6238 itself. Store the Base32 secret you got when enrolling your authenticator, and the extension becomes a browser-native authenticator: a fresh 30-second code on every fill. | No |

### Why it is built the way it is

- **No preset hosts.** Most MFA pages are internal or vendor-specific, and nobody can
  predict which domain you will need. Earlier versions hard-coded vendor domains into
  the manifest; that is wrong for a general-purpose tool. Now the extension injects
  scripts **only** into domains *you* authorise in the popup, and asks for permission
  at that moment — nothing else.
- **Nothing leaves your machine.** TOTP is computed locally with Web Crypto. The email
  channel only talks to your own IMAP server and to `127.0.0.1`. No analytics, no
  remote logging, no third-party service.
- **Your accounts only.** It reads codes from your own mailbox and does not bypass,
  weaken or replay any factor. The second factor still has to be passed by you — this
  only saves the typing.
- **The last step stays yours.** It fills the code but never clicks submit.

### What else it handles

- Split-code inputs — pages that render six separate boxes (Tencent Cloud, Google
  style) get filled cell by cell, with keyboard events dispatched per box
- React / Vue controlled inputs, filled through native setters so the framework
  actually sees the value
- Bare inputs with no attributes, located by scoring the label and nearby text;
  including inputs inside open shadow roots and `position:fixed` overlays
- Codes that no longer fill? The popup reports a live diagnosis: injected or not,
  recognised as an MFA page or not, how many split boxes were found, which channel
  was chosen, and the real reason the local API is unreachable
- Monthly log rotation on the daemon side, with automatic pruning of logs older than
  two months, plus a `--diag` mode that prints the full decision chain for every
  recent mail — the first thing to run when a code gets missed

> **v1.3.0 core change: domains are driven entirely by your configuration; there are no preset sites in the extension.**
> Older versions hard-coded `*.example.com`, `*.tencent.com` and other vendor domains into `manifest.json`. For an open-source tool that is simply wrong — nobody can predict which domains others will use. The extension now injects scripts **only** into domains you configure for a record or a site in the popup; everywhere else, nothing is injected and no permission is requested.

## Responsible use

- **Only for your own accounts.** It reads codes from your own mailbox, addressed to you. It does not crack or bypass any second factor — you still have to pass MFA yourself.
- **No network calls to third parties.** TOTP is computed fully locally; the email channel only connects to your own IMAP server and a local API on `127.0.0.1`. No telemetry, no remote server.
- **When in doubt, ask IT first.** If your organisation has a security policy about "scripts reading mail" or "browser extensions autofilling verification codes", check with them before using this.
- **Credentials stay on your machine.** `config.json` holds the app-specific password and `chrome.storage.local` holds TOTP secrets; neither is uploaded. **Never commit them to a repository or send them to anyone.**

## One-time setup (about 3 minutes)

1. **Generate a Feishu / Lark app-specific password** (this can only be done in the desktop client, not the web or mobile version):
   Feishu client → avatar (top left) → Settings → Email → Sign in with third-party email client → go to settings → select Mac → Generate.
   (If you cannot find this option, your administrator has not enabled it — ask IT.)
2. Copy the example config: `cp config.example.json config.json`
3. Edit `config.json` and enter your email address and the app-specific password you just generated.

## Usage

```bash
# Verify the configuration first (logs in once, then exits)
python3 mfa_code_fetcher.py --test

# Run continuously: on arrival of an MFA mail, copy the code + show a notification + start the local API
python3 mfa_code_fetcher.py
```

It is best to leave the daemon running before you connect to the VPN. When a code arrives, macOS shows a notification in the top-right corner with a sound; the code is already in your clipboard, so just `Cmd+V` into the page.

## Autofill (option 2: the Chrome extension)

While running, the daemon starts a local API at `127.0.0.1:8642` (`/code` returns the newest code from the last 5 minutes). Once the extension is installed, autofill just works:

1. In Chrome, open `chrome://extensions` and turn on **Developer mode** in the top right.
2. Click **Load unpacked** and select the `extension/` folder in this directory.
3. Keep `mfa_code_fetcher.py` running in the background and connect to the VPN as usual.

**Extension behaviour:**

- Scripts are injected only into domains you have authorised (see the next section). Once injected, if the page contains text such as "MFA", "Email Code", "verification code", "验证码", "二次验证", "安全码", "登录保护" or "authenticator", a purple status bar appears in the top-right corner: "MFA AutoFill active".
- If the domain is authorised but **no channel is configured** (no matching TOTP record and email codes not enabled), the bar reads "Autofill not enabled on this page — click the extension icon to enable it". This is a hint, not a failure.
- It checks for a code every 3 seconds (up to 5 minutes), fills it automatically when found (React / Vue compatible), and the bar turns green with the code shown.
- **Split-code inputs are supported**: when a page renders six single-character boxes (Tencent Cloud, Google style), each box is filled in turn with a keyboard event dispatched per box.
- A code is never filled twice; the confirm/submit button is **never clicked automatically** — the last step stays with you.
- Click the extension icon to open the toolbar popup: view the latest code / copy in one click / check the local service status / "Force fill this page".
- The popup shows a **per-page enablement bar** at the top (yellow = not enabled, with an "Enable this page" button; green = enabled) and live detection at the bottom: whether scripts are injected, whether the page is recognised as an MFA page, and how many split boxes were found.

## Enabling autofill for a site (the v1.3.0 permission model)

The extension injects scripts into **no websites by default**. There are two ways to enable a site, both from the popup:

**A. The site uses TOTP**
Click "+ Add secret" → enter a name / Base32 secret / bound domain (or click "Use current page" to fill it in) → save. The moment you save, Chrome asks for permission ("Read and change data on xxx"); click Allow.

**B. The site uses an email code**
Open that site's login/verification page → click the extension icon → the yellow bar at the top reads "Autofill not enabled on this page (xxx.com)" → click "Enable this page" → click Allow in the permission dialog.

Once authorised: the top bar turns green ("Autofill enabled on this page"), and scripts are **injected into the current tab immediately**, without a manual refresh (since v1.3.1). Other already-open pages of the same site still need one refresh.

> Both paths request the same permission: `https://*.your-domain/*` and `http://*.your-domain/*` (http is requested too, because internal MFA pages often run over plain http; Chrome shows a single dialog). To revoke access, go to `chrome://extensions` → this extension's "Details" → "Site access" and remove the entry; the extension unregisters the corresponding injection immediately.
>
> Under each TOTP record the popup displays its authorisation status: authorised records show only the domain; unauthorised ones show an extra line "Injection not authorised [Authorise]".

**Why this step is necessary**: MV3's `optional_host_permissions` requires per-domain user confirmation. That is the security price of doing away with a hard-coded domain list — the extension does not need to know in advance which sites you use.

**Do I need to flip the switches in "Site access" manually?** No, and the extension has no API to flip them for you. Since v1.3.4 there are three fallbacks so this unreliable switch **no longer blocks usage**:

1. **Inject when the popup opens**: if the current page has any configured channel (a TOTP record or an email-code site), opening the popup performs one injection via `activeTab` — this path is **unaffected by any toggle** (opening the popup is itself a user gesture). In daily use you can ignore those switches entirely.
2. **"Inject into this page now" button**: when the status line detects "rule registered but not injected into this page", an extra button row appears; clicking it takes effect immediately.
3. **"Open permission settings" button**: one click to the extension's details page (Chrome/Edge each have their own URL), so you do not have to hunt for it when you want to change long-term behaviour.

> Bottom line: for **persistent** autofill on a site, use "Authorise / Enable this page" in the popup. If the per-site switch on the extension details page looks off, that is just display drift from dynamic authorisation — **trust the status line at the bottom of the popup** ("injected · recognised as an MFA page" means it works).

- The browser permission dialog triggered by "Authorise / Enable this page" and the switch list in the extension details are **two entry points to the same permission**; authorising in the popup is equivalent to switching it on there.
- Conversely, flipping the switch manually does not tell the extension which channel to use (TOTP or email), so the extension still needs its own record — which is why authorisation is centralised in the popup.
- Edge / Chrome sometimes show inconsistent states for dynamically granted optional permissions (the master switch on, per-site switches shown off). **Trust runtime state**: "injected · recognised as an MFA page" in the popup means it is working.
- The real place to revoke permission is the site access list in extension details, or simply stop configuring that domain in the extension; the injection is unregistered right away.

**Where do the domains in "Site access" come from?** There are exactly three sources; there is no hidden preset list:

| What you see | Source |
|---|---|
| `http://127.0.0.1:8642/*`, `http://localhost:8642/*` | `host_permissions` in `manifest.json` — required to read the local API for email codes; fixed |
| `https://*.your-domain/*`, `http://*.your-domain/*` | **Requested when you click "Authorise"** (http and https together, one Chrome dialog) |
| Vendor domains left over from old versions | Upgraded from v1.2.x. v1.2.x hard-coded seven domains in the manifest; Chrome does not necessarily clear "once granted" permissions on reload. The code no longer references them, so they do nothing — turn them off individually, or uninstall and reload the extension once for a clean slate. |

**Manual fallback**: any page can be injected once via "Force fill this page" in the popup (`activeTab` permission; clicking authorises it without persisting), useful for checking whether the page is recognised correctly.

## FAQ — Browser extension

- **Do I need to restart the browser after installing?** No. But pages opened *before* the extension was installed will not be injected automatically — refresh them once. After changing extension files, click the refresh icon on the extension card in `chrome://extensions`.
- **No status bar at all** = the content script was not injected. Check, in order:
  1. Is the MFA page open in **Chrome**? (A VPN client may open the system default browser — if that is Safari/Edge, the extension will not run. Consider setting Chrome as default.)
  2. What is the **actual domain** in the address bar? If it was never enabled in the popup, the extension will not inject — follow "Enabling autofill for a site" above, or use "Force fill this page" as a one-off.
  3. The bar says "Local API unreachable": v1.3.5 lists the **real reason for each address** — see which one it is.
     - Text contains `[unauthorised]` / "site access has been turned off" → **this is a newer-browser quirk, not a service problem**. Chrome/Edge 142+ let users turn off site access to `127.0.0.1` separately; once the extension loses this host permission, `fetch` to the local service throws `TypeError: Failed to fetch` (Chrome's own LNA docs: extensions are exempt from local network access restrictions **only if they hold the corresponding host permission**). **Click the red "Restore local API permission" button once**, or turn on the two switches for `http://127.0.0.1:8642/*` and `http://localhost:8642/*` in the extension details.
     - Text says "make sure mfa_code_fetcher.py is running" → this *is* a server-side issue: an old process (started before 17:31) has no API; restart with Ctrl+C; `curl --noproxy '*' http://127.0.0.1:8642/health` should return `{"ok": true}`.
     - v1.3.5 **removed the `[::1]` fallback**: the daemon binds only IPv4 `127.0.0.1`, so that address can never connect and previously sent troubleshooting down the wrong path ("is IPv6 enabled?").
     - Port conflict? Change `api_port` in `config.json` (and the 8642 in `extension/background.js` and `manifest.json`).
- **"No code input found"**: send me the HTML structure of the input field (right-click → Inspect element) so I can tune `content.js`.
- **Filled the wrong field**: same as above — send the HTML structure.
- **Authorised, no more "not authorised" warning, but still no fill** (v1.3.1 troubleshooting): the status line at the bottom of the popup tells you which case it is:
  - `(rule registered but page not injected)` → most often Chrome has restricted this site's access to "on click". "Force fill this page" works immediately (via `activeTab`), but for persistent autofill you need to turn the site switch on in extension details.
  - `(injection not authorised for this domain)` → not authorised yet; click "Enable this page".
  - `(injected, but page not recognised as MFA)` → no verification-code wording in the page body, or the input is inside a **cross-origin closed iframe** (v1.3.1 supports `allFrames`, but a fully closed iframe may still be inaccessible).
  - `(injected · recognised as an MFA page · N split boxes)` → injection and detection are fine; the problem is code retrieval — see the local API items above.
- **Does the domain match? Do not guess**: `https://*.cloud.tencent.com/*` matches **both `cloud.tencent.com` itself and its subdomains** (Chromium's `url_pattern.cc` strips the `*.` prefix and compares hosts for equality first; MDN's example table also lists `https://mozilla.org/` as matching `*://*.mozilla.org/*`). So configuring `cloud.tencent.com` with the page at `cloud.tencent.com` is fine — stop investigating this direction.

## TOTP — entirely inside the extension, no Python daemon required

Click the extension icon → "TOTP (one-time passwords)" → "+ Add secret":

- **Name**: e.g. "Company IDaaS"
- **Base32 secret**: the secret given at enrolment (spaces and hyphens are ignored)
- **Bound domain** (optional): if set, pages on that domain get a freshly computed code and autofill on open (each fill uses the current 30-second window, so codes never go stale; the same window is not filled twice). Leave it empty to use the extension as a plain "browser authenticator" and copy the code manually from the popup.
- **"Use current page"**: fills in the current tab's domain with one click to avoid typos.

**Records are editable** (v1.2.2+): each record has Copy / Edit / Delete. "Edit" lets you change the name, secret and domain; after saving, refresh the MFA page — no extension reload needed.

**Tolerant domain input**: `https://idaas.example.com/`, `IDAAS.Example.com`, `idaas.example.com:443` and full URLs with paths are all normalised to `idaas.example.com`. A parent domain (e.g. `example.com`) covers all its subdomains, but `vpn.example.com` will not accidentally match `idaas.example.com`.

> If the page needs a one-time code but no record matches the current domain, a bar in the top-right reads "Bound: xxx — click the extension icon to edit the domain", to make misconfiguration easy to spot.

**Which channel handles the IDaaS "authenticator app" page (e.g. `vpn.example.com`)?** It depends on the MFA method selected on the page:

- Wording like "authenticator app / Authenticator" → **TOTP channel**. Bind a parent domain such as `example.com` (covers `vpn.*` / `idaas.*`) to a TOTP record and authorise it.
- The "email code" method is selected → **email channel** (enable this page + daemon running + a new mail received). Note: the TOTP page does not send mail, so the email channel will never get a code there — that is expected, not a bug.
- The "Channel: …" line at the bottom of the popup shows the current decision, e.g. "Page requests a one-time code, but no TOTP record matches vpn.example.com".

**Improved detection for single-input pages** (v1.3.3): IDaaS-style pages whose label reads "Enter the code from your authenticator app" but whose input has no identifying attributes are now located by scoring nearby text. Inputs in open shadow roots, semantic inputs with `inputmode="numeric"` / `autocomplete="one-time-code"`, and real visibility checks (`position:fixed` overlays are no longer falsely rejected) are also supported.

The TOTP implementation passes every standard test vector in RFC 6238 Appendix B and is fully compatible with Google Authenticator, Feishu codes and similar apps. You can verify it by comparing a code from your existing script with the one in the extension popup at the same time.

**Security note**: secrets are stored in plain text in the extension's `chrome.storage.local` (the same way a phone authenticator stores its private keys) — do not leave the device unattended. If this is a work account, check that your company's security policy allows it. The extension computes locally, never accesses the network for this, and never uploads a secret; it is, however, persistent local data that a local process can read if the disk is unencrypted.

## Other browsers

| Browser | Support |
|---|---|
| **Chrome** | Load directly (primary browser during development) |
| **Edge** | Works with zero changes: `edge://extensions` → Developer mode → "Load unpacked" → select `extension/` |
| **Safari** | Requires conversion and packaging: `xcrun safari-web-extension-converter extension/` to generate an Xcode project → build and sign as a macOS app → enable in Safari preferences. Usable, but the process is cumbersome |
| Firefox | Needs small changes (service worker → event page); not adapted yet |

The TOTP channel has no local API dependency and works standalone in any browser; the email channel needs the local daemon running.

## Extraction rules (v1.3.0: dual-path matching)

Three levels in series; any failure skips the mail (and is recorded in the log):

1. **Freshness**: only mails received within the last 10 minutes are processed (`code_ttl_minutes` is configurable); older mails are skipped.
2. **Feature match (two paths, either one suffices)**:
   - **Sender allowlist**: `notice.aliyun.com` by default (Alibaba Cloud notification mail) — **matches regardless of subject**, and is the primary path.
   - **Keywords**: `MFA` / `verification` by default; a hit in the subject or body counts (`subject_keywords` is configurable).
3. **Code extraction**: first look for 4–8 digits near "code / 验证码 / 校验码 / 动态码", then fall back to any 6-digit number.

> **Why the sender allowlist**: Alibaba Cloud's MFA mail subject changes with the language template (English "MFA verification" ↔ Chinese "二次认证"), so keywords alone miss mails when the subject is localised. Matching by sender is immune to subject changes.
> To add another sender, add its domain to `sender_allowlist` in `config.json`.

## Logging and diagnostics

- **Monthly log files**: `logs/mfa-fetcher-2026-11.log`, `logs/mfa-fetcher-2026-12.log`, … — rotation happens automatically at month boundaries, including while the daemon is running (no restart needed). Follow live with `tail -f logs/mfa-fetcher-$(date +%Y-%m).log`.
- **Automatic pruning**: keeps the **current month plus the previous two** (three files); older ones are deleted at startup and on each month change. To change the retention period, add `"log_keep_months": 2` to `config.json` (default 2; `0` keeps only the current month, `6` keeps half a year).
- **Legacy single-file migration**: on upgrade, an existing `logs/mfa-fetcher.log` is merged into the current month's file on first start; nothing is lost and the old file is then removed.
- **Recorded content**: connections, heartbeats, the decision reason for every mail, extraction results and exception traces.
- **Diagnostic mode**: `python3 mfa_code_fetcher.py --diag` — prints the full decision chain for each recent mail (sender / subject / time / allowlist hit / keyword hit / extraction result / skip reason). **Start here when a code is missed.**
- Log level: `log_level` in `config.json` (`DEBUG` additionally logs details of every skipped mail).
- **Tests**: `python3 tests/test_log_rotation.py` verifies rotation and pruning without connecting to a mailbox.

## File reference

| File | Purpose |
|---|---|
| `config.json` | Account configuration (contains the app-specific password — do not commit to git) |
| `latest_code.json` | Most recent code and timestamp (data source for the API) |
| `.seen_ids` | Processed mail IDs for de-duplication |
| `logs/` | Runtime logs, automatically created and rotated (one file per month) |
| `extension/` | Browser extension (Manifest V3): manifest.json + background.js + content.js + totp.js + popup.* |
| `tests/injection.test.js` | Regression tests for the dynamic injection logic (mock chrome API, no browser needed): `node tests/injection.test.js` |

## FAQ — Email and filling

- **Mail arrived but the extension got no code**: run `python3 mfa_code_fetcher.py --diag` and check the decision reason for each mail; if it says "no sender allowlist / keyword hit", add that sender's domain to `sender_allowlist` in `config.json`.
- **The extension cannot reach the code**: make sure the daemon is running and `curl --noproxy '*' http://127.0.0.1:8642/health` returns ok; on a port conflict, change `api_port` in `config.json` (and the 8642 in `extension/background.js` and `manifest.json`).
- **Filled the wrong field**: send me the HTML structure of the MFA page's input (right-click → Inspect element) so I can tune `content.js`.
