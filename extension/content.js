// content.js — 检测 MFA 验证码页面并自动填充
// v1.3.0: 支持"分格输入框"(6 个单字符框, 如腾讯云/Google 风格) + 增强页面识别
// 双通道: TOTP 动态口令(绑定域名时本地实时计算, 优先) + 邮箱验证码(经本地 API)
// 依赖: totp.js 须在 content.js 之前加载

const POLL_INTERVAL_MS = 3000;     // 取码轮询间隔
const GIVE_UP_MS = 5 * 60 * 1000;  // 最长等待 5 分钟
let startedAt = Date.now();
let filled = false;
let badge = null;
let gen = 0;                          // 循环代号: 重新注入时让旧循环自行退出
let lastDiag = "";                    // 最近一次判定原因, 供弹窗诊断
const IS_TOP = window === window.top; // 子框架只负责填充, 不显示状态条(位置会很怪)

// ---------- 页面识别 ----------

function bodyText() {
  return (document.body ? document.body.innerText : "").toLowerCase();
}

function isMfaPage() {
  const text = bodyText();
  const keys = [
    "mfa", "email code", "verification code", "authenticator", "one-time",
    "验证码", "动态口令", "动态密码", "二次验证", "二次认证", "安全码",
    "登录保护", "身份验证", "校验码", "otp",
  ];
  return keys.some((k) => text.includes(k));
}

// ---------- 输入框识别 ----------

/** 真实可见性判断: 不能用 offsetParent(position:fixed 的元素它恒为 null, 登录弹层会误杀) */
function isVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = window.getComputedStyle(el);
  return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
}

function isCodeishType(el) {
  const type = (el.type || "text").toLowerCase();
  if (["text", "tel", "number", "password", "search"].indexOf(type) !== -1) return true;
  // 数字键盘 / 一次性验证码语义的输入框, 即使 type 怪异也认
  if ((el.getAttribute("inputmode") || "").toLowerCase() === "numeric") return true;
  if ((el.getAttribute("autocomplete") || "").toLowerCase() === "one-time-code") return true;
  return false;
}

function isEditableInput(el) {
  if (!isCodeishType(el)) return false;
  if (el.disabled) return false;
  // readOnly 常见于"点击后才可输入"的组件; 若明确标注 one-time-code 则不放弃
  if (el.readOnly &&
      (el.getAttribute("autocomplete") || "").toLowerCase() !== "one-time-code") return false;
  if (!isVisible(el)) return false;
  return true;
}

/** 穿透 open shadow DOM 收集 input (Web Components 登录框越来越常见) */
function deepQueryInputs() {
  const out = [];
  const walk = function (root) {
    const inputs = root.querySelectorAll("input");
    for (let i = 0; i < inputs.length; i++) out.push(inputs[i]);
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) walk(all[i].shadowRoot);
    }
  };
  walk(document);
  return out;
}

function classOf(el) {
  return typeof el.className === "string" ? el.className : "";
}

// 明显不是验证码的字段 (邮箱/账号/密码)
function looksLikeNonCode(el) {
  const ph = (el.placeholder || "").toLowerCase();
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  const idCls = ((el.id || "") + " " + classOf(el)).toLowerCase();
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac === "username" || ac === "email" || ac === "current-password" || ac === "new-password") return true;
  if (ph.indexOf("email") >= 0 || aria.indexOf("email") >= 0 || idCls.indexOf("email") >= 0) return true;
  if (ph.indexOf("user") >= 0 || ph.indexOf("account") >= 0 ||
      aria.indexOf("user") >= 0 || idCls.indexOf("username") >= 0) return true;
  if ((el.type || "").toLowerCase() === "password") return true;
  return false;
}

/** 输入框附近的可见文案 (label / 前面的兄弟节点), IDaaS 这类"label 写验证码、input 无任何标识"的页面靠它 */
function nearbyText(el) {
  let t = "";
  try {
    const label = el.labels && el.labels[0];
    if (label) t += " " + label.textContent;
    let p = el.parentElement;
    for (let i = 0; p && i < 3; i++, p = p.parentElement) {
      t += " " + (p.textContent || "");
      if (t.length > 400) break;
    }
  } catch (e) {}
  return t.toLowerCase();
}

function maxLenOf(el) {
  const v = parseInt(el.getAttribute("maxlength") || el.maxLength || 0, 10);
  return isNaN(v) ? 0 : v;
}

/**
 * 返回 { inputs: [...], split: boolean } 或 null
 * split = true 表示"每个框一个字符"的分格输入
 */
function findCodeTargets() {
  if (!isMfaPage()) return null;

  const inputs = deepQueryInputs()
    .filter(isEditableInput)
    .filter(function (el) { return !looksLikeNonCode(el); });
  if (!inputs.length) return null;

  // 分格输入框: 多个 maxlength<=2 的短框 (或宽度很窄且无 placeholder 的框)
  const boxes = inputs.filter(function (el) {
    const ml = maxLenOf(el);
    if (ml > 0 && ml <= 2) return true;
    let w = el.clientWidth || 0;
    if (!w && el.getBoundingClientRect) w = el.getBoundingClientRect().width || 0;
    return w > 0 && w <= 64 && !(el.placeholder || "").trim();
  });
  if (boxes.length >= 4) {
    return { inputs: boxes.slice(0, 8), split: true };
  }

  // 单框: 打分挑选最像验证码输入框的那个
  function score(el) {
    const ph = (el.placeholder || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const idCls = ((el.id || "") + " " + classOf(el)).toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    let s = 0;
    if (/code|verif|otp|mfa|安全码|验证码|口令/.test(ph + " " + aria + " " + idCls)) s += 3;
    // 标识完全没写, 但附近文案在说"验证码"(IDaaS 风格) → 也认
    if (/验证码|动态码|口令|security code|verification/.test(nearbyText(el))) s += 3;
    if (ac === "one-time-code") s += 5;
    const ml = maxLenOf(el);
    if (ml > 0 && ml <= 8) s += 2;
    if (!el.value) s += 1;
    return s;
  }
  inputs.sort(function (a, b) { return score(b) - score(a); });
  const best = inputs[0];
  return best ? { inputs: [best], split: false } : null;
}

// ---------- 填充 (React / Vue 兼容) ----------

function setNativeValue(el, value) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function fillCode(target, code) {
  if (!target || !target.inputs.length) return false;

  // 单框: 一次填入
  if (!target.split) {
    setNativeValue(target.inputs[0], code);
    return true;
  }

  // 分格: 逐框填一个字符
  const inputs = target.inputs;
  const n = Math.min(inputs.length, code.length);
  for (let i = 0; i < n; i++) {
    const el = inputs[i];
    const ch = code.charAt(i);
    try { el.focus(); } catch (e) {}
    setNativeValue(el, ch);
    // 兜底: 部分组件只搬键盘事件, 对合成 input 不响应
    if (el.value !== ch) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    }
    await sleep(35);
  }
  return true;
}

// ---------- 可见状态条 ----------

const dismissedTexts = {}; // 用户手动关掉的提示不再重复弹出

function clearBadge() {
  if (badge) {
    badge.remove();
    badge = null;
  }
}

function showBadge(text, opts) {
  if (!IS_TOP) return; // 子框架(iframe)里不显示
  opts = opts || {};
  if (dismissedTexts[text]) return;      // 用户已关闭过这条提示
  if (badge && badge.__text === text) {  // 同一条提示正在显示, 不重建 (避免每 3 秒闪烁)
    return;
  }
  clearBadge();
  badge = document.createElement("div");
  badge.__text = text;
  badge.textContent = text;
  Object.assign(badge.style, {
    position: "fixed", top: "16px", right: "16px", zIndex: "99999",
    background: opts.color || "#534AB7", color: "#fff", padding: "10px 16px",
    borderRadius: "8px", fontSize: "13px", fontFamily: "system-ui, sans-serif",
    boxShadow: "0 2px 8px rgba(0,0,0,0.25)", cursor: "pointer",
    maxWidth: "320px", wordBreak: "break-all",
  });
  badge.onclick = function () {
    dismissedTexts[text] = true;
    clearBadge();
  };
  document.documentElement.appendChild(badge);
}

// ---------- TOTP 通道 ----------

function normalizeDomain(v) {
  // 容错: 用户可能填了 https://xxx/ 、带端口、带路径、大写或结尾点
  let d = String(v || "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split("/")[0].split("?")[0].split(":")[0];
  return d.replace(/^\.+|\.+$/g, "");
}

function getBoundTotpSecret() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["totpSecrets"], function (s) {
      const list = s.totpSecrets || [];
      const host = normalizeDomain(location.hostname);
      const boundDomains = [];
      let found = null;
      for (const e of list) {
        const d = normalizeDomain(e.domain);
        if (!d) continue;
        boundDomains.push(d);
        if (!found && e.secret && (host === d || host.endsWith("." + d))) {
          found = e;
        }
      }
      resolve({ entry: found, boundDomains: boundDomains });
    });
  });
}

function totpUsedThisWindow(entryId, counter) {
  return new Promise(function (resolve) {
    const key = "totpUsed_" + entryId;
    chrome.storage.local.get([key], function (s) {
      const prev = s[key];
      chrome.storage.local.set({ [key]: { counter: counter } });
      resolve(!!(prev && prev.counter === counter));
    });
  });
}

function hostMatches(host, domains) {
  return (domains || []).some(function (d) {
    return host === d || host.endsWith("." + d);
  });
}

/** 邮箱验证码通道的启用域名 (由用户在弹窗里为本页启用) */
function getEmailHosts() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["emailCodeHosts"], function (s) {
      resolve((s.emailCodeHosts || []).map(normalizeDomain).filter(Boolean));
    });
  });
}

async function fillFromTotp(target, entry) {
  const counter = Totp.currentCounter(30);
  if (await totpUsedThisWindow(entry.id, counter)) {
    showBadge("MFA AutoFill: " + entry.label + " 的动态口令本窗口已填过, 等下一个 30 秒窗口…",
              { color: "#854F0B" });
    return true;
  }
  try {
    const code = await Totp.generate(entry.secret);
    await fillCode(target, code);
    filled = true;
    showBadge("动态口令已自动填入: " + code +
              (target.split ? " (分格输入)" : "") + " · 30 秒内有效", { color: "#0F6E56" });
    setTimeout(clearBadge, 15000);
    return true;
  } catch (e) {
    showBadge("MFA AutoFill: TOTP 秘钥无效 (" + String(e).slice(0, 60) + ")", { color: "#A32D2D" });
    return true;
  }
}

// ---------- 邮箱验证码通道 ----------

function requestCode() {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: "GET_CODE" }, function (resp) {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: "no response" });
      }
    });
  });
}

function alreadyUsed(code) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["lastUsedCode", "lastUsedAt"], function (s) {
      const stale = !s.lastUsedAt || Date.now() - s.lastUsedAt > 10 * 60 * 1000;
      resolve(!stale && s.lastUsedCode === code);
    });
  });
}

async function tryFillEmailCode(target) {
  const resp = await requestCode();
  if (resp.ok && resp.code) {
    if (await alreadyUsed(resp.code)) {
      showBadge("MFA AutoFill: 该验证码已使用过, 等待新邮件…", { color: "#854F0B" });
    } else {
      await fillCode(target, resp.code);
      chrome.runtime.sendMessage({ type: "CODE_USED", code: resp.code });
      filled = true;
      showBadge("MFA 验证码已自动填入: " + resp.code + " (" + (resp.fetchedAt || "") + ")",
                { color: "#0F6E56" });
      setTimeout(clearBadge, 15000);
      return;
    }
  } else if (!resp.ok) {
    // 角标只放"该怎么办", 完整逐地址原因写进 lastDiag 供弹窗展示
    const hint = resp.needPermission
      ? "本地 API 权限被关, 点扩展图标 → 「恢复本地 API 权限」"
      : "服务未响应, 确认 mfa_code_fetcher.py 在运行";
    showBadge("MFA AutoFill: 本地 API 不可达 — " + hint + " (点此关闭)",
              { color: "#A32D2D" });
    lastDiag = resp.error || hint;
    console.warn("[MFA AutoFill] 本地 API 失败:", resp.error);
  } else {
    showBadge("MFA AutoFill 已激活, 等待验证码邮件…", { color: "#534AB7" });
  }
}

// ---------- 主循环 ----------

async function tick(g) {
  if (g !== gen) return;   // 已被新一轮注入接管, 本循环退出
  if (filled) return;
  if (Date.now() - startedAt > GIVE_UP_MS) {
    if (isMfaPage()) {
      showBadge("MFA AutoFill: 等待超时已停止 (点此关闭)", { color: "#5F5E5A" });
    }
    return;
  }

  if (!isMfaPage()) {
    scheduleNext(g);
    return;
  }

  const target = findCodeTargets();
  if (!target) {
    lastDiag = "页面无可见的可填验证码输入框 (共 " + deepQueryInputs().length + " 个 input)";
    showBadge("MFA AutoFill 已激活, 未找到验证码输入框…", { color: "#534AB7" });
    scheduleNext(g);
    return;
  }

  const host = normalizeDomain(location.hostname);
  const totp = await getBoundTotpSecret();
  if (g !== gen) return;   // await 期间可能已被重启

  if (totp.entry) {
    // 通道1: 当前域名绑定了 TOTP 记录
    lastDiag = "TOTP 通道 · 记录「" + (totp.entry.label || "(未命名)") + "」";
    await fillFromTotp(target, totp.entry);
  } else if (hostMatches(host, await getEmailHosts())) {
    // 通道2: 当前域名被启用为"邮箱验证码"站点
    lastDiag = "邮箱验证码通道";
    await tryFillEmailCode(target);
  } else {
    // 两个通道都没为本页启用
    const wantsTotp = /动态口令|authenticator|totp|手机软件/i.test(bodyText());
    if (wantsTotp) {
      lastDiag = "页面要求动态口令, 但无 TOTP 记录匹配 " + host +
                 " (已绑定: " + (totp.boundDomains.join(", ") || "无") + ")";
    } else {
      lastDiag = "本页未配置任何通道 (TOTP / 邮箱验证码)";
    }
    let text = "本页未启用自动填充 — 点扩展图标可启用 (点此关闭)";
    if (wantsTotp && totp.boundDomains.length) {
      text = "本页需要动态口令, 但无记录匹配 " + host +
             "。已绑定: " + totp.boundDomains.join(", ") + " — 点扩展图标可编辑域名";
    }
    showBadge(text, { color: "#854F0B" });
    console.log("[MFA AutoFill] 本页未启用填充 | host:", host,
                "| TOTP 已绑定域名:", totp.boundDomains);
  }
  scheduleNext(g);
}

function scheduleNext(g) {
  setTimeout(function () { tick(g); }, POLL_INTERVAL_MS);
}

/** 启动(或重新启动)探测: 重新注入时也能立刻生效, 不受上次超时/已填过的限制 */
function restart() {
  gen++;
  filled = false;
  startedAt = Date.now();
  const t = findCodeTargets();
  console.log("[MFA AutoFill] content script 注入:", location.href,
              "| top:", IS_TOP, "| MFA 页面:", isMfaPage(),
              "| 输入框:", t ? t.inputs.length + (t.split ? " (分格)" : " (单框)") : "未找到");
  if (IS_TOP && isMfaPage()) {
    showBadge("MFA AutoFill 已激活…", { color: "#534AB7" });
  }
  tick(gen);
}

// ---------- 供弹窗探测注入状态 ----------

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "PING") {
    const t = findCodeTargets();
    sendResponse({
      injected: true,
      host: location.hostname,
      isTop: IS_TOP,
      isMfa: isMfaPage(),
      split: !!(t && t.split),
      boxCount: t ? t.inputs.length : 0,
      filled: filled,
      diag: lastDiag || (t ? "已定位输入框, 等待取码" : "未定位到输入框"),
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    });
  }
  if (msg && msg.type === "RESTART") {
    restart();
    sendResponse({ ok: true });
  }
});

// ---------- 引导 ----------
// 已注入过再注入(点「强制填充当前页」/ 授权后自动注入) → 重置后重新开始。
// 否则上次已 filled 或已超时的脚本会直接 return, 看起来像"点了没反应"。

if (!window.__MFA_AUTOFILL_LOADED__) {
  window.__MFA_AUTOFILL_LOADED__ = true;
}
restart();
