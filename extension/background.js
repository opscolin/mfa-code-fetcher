// background.js — service worker
// 1) 代理对本地 API 的请求 (扩展有 host_permissions, 不受 CORS/混合内容限制)
// 2) 动态注入管理: 按用户配置的 TOTP 域名 / 邮箱验证码域名注册 content script (v1.3.0)

// 本地 API 地址。
// v1.3.5: 去掉 [::1] —— 服务端只监听 127.0.0.1, 这个地址永远连不上,
// 只会让错误信息指向一个无关的地址(之前就把用户引向了"没打开 IPv6"的错误方向)。
// 每个目标都带上自己的 origin pattern, 用于区分"权限被关"和"服务没起"。
const API_TARGETS = [
  { base: "http://127.0.0.1:8642", pattern: "http://127.0.0.1:8642/*" },
  { base: "http://localhost:8642", pattern: "http://localhost:8642/*" },
];
const API_PATTERNS = API_TARGETS.map((t) => t.pattern);
const API_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------- 本地 API

/** 该 origin 的 host permission 是否仍在 (Chrome 允许用户逐站点关掉, 包括声明为必需的) */
function originGranted(pattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [pattern] }, (v) => {
        void chrome.runtime.lastError;
        resolve(!!v);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/** 把 fetch 异常翻成人话。以前一律吞成 null, 权限问题被伪装成"服务没运行" */
function describeFetchError(e) {
  if (!e) return "未知错误";
  if (e.name === "AbortError") return `超时 ${API_TIMEOUT_MS / 1000}s`;
  const msg = String(e.message || e);
  if (/permission|denied|not allowed|blocked/i.test(msg)) return "浏览器拒绝(权限)";
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(msg)) return "连不上";
  return msg.slice(0, 60);
}

async function tryFetch(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const resp = await fetch(`${target.base}/code`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const data = await resp.json();
    if (data.code) {
      return { ok: true, code: data.code, fetchedAt: data.fetched_at };
    }
    return { ok: true, code: null, ageSeconds: data.age_seconds };
  } catch (e) {
    return { ok: false, reason: describeFetchError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取码。失败时把每个地址的结果 + 该地址的权限状态一起返回,
 * 让弹窗/角标能直接说清"是服务没起, 还是站点访问权限被关了"。
 * 这是 v1.3.5 的核心修复: 之前只报最后一个地址的"连接失败", 无法定位。
 */
async function fetchLatestCode() {
  const attempts = [];
  for (const t of API_TARGETS) {
    const r = await tryFetch(t);
    if (r.ok) return r;
    attempts.push({ base: t.base, pattern: t.pattern, reason: r.reason });
  }

  let needPermission = false;
  for (const a of attempts) {
    a.granted = await originGranted(a.pattern);
    if (!a.granted) needPermission = true;
  }

  const detail = attempts
    .map((a) => `${a.base} → ${a.reason}${a.granted ? "" : " (站点访问权限未授予)"}`)
    .join("; ");

  console.warn("[MFA AutoFill] 本地 API 全部失败 |", detail,
               "| manifest host_permissions:",
               JSON.stringify(chrome.runtime.getManifest().host_permissions || []));

  return {
    ok: false,
    needPermission,
    attempts,
    apiPatterns: API_PATTERNS,
    error: needPermission
      ? `本地 API 不可达 — ${detail}。本扩展对本地回环地址的站点访问权限已被关闭,` +
        `点弹窗里的「恢复本地 API 权限」修复`
      : `本地 API 不可达 — ${detail}。请确认 mfa_code_fetcher.py 正在运行;` +
        `若确认在运行, 则是浏览器的站点访问开关拦了 127.0.0.1 —` +
        `点「恢复本地 API 权限」或去扩展详情页打开该开关`,
  };
}

// ---------------------------------------------------------------- 动态注入

let lastSyncError = ""; // 最近一次同步的注册错误, 供弹窗诊断显示

function normalizeDomain(v) {
  let d = String(v || "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split("/")[0].split("?")[0].split(":")[0];
  return d.replace(/^\.+|\.+$/g, "");
}

/** 域名 → 需要申请的 origin 列表 (同时支持 http/https, 内网 MFA 常是 http) */
function patternsFor(domain) {
  return ["https://*." + domain + "/*", "http://*." + domain + "/*"];
}

/** 域名 → 稳定的脚本 id (仅 [a-z0-9_-], 附短哈希避免 a.b / a-b 撞车) */
function domainToScriptId(domain) {
  let h = 0;
  for (let i = 0; i < domain.length; i++) {
    h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  }
  const slug = domain.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return "mfa_" + slug + "_" + h.toString(36);
}

/**
 * 依据用户配置计算需要注入的域名
 * 来源: TOTP 记录里填写的域名 + 邮箱验证码启用域名
 * 不含任何预置域名 —— 开源给他人使用时, 完全由使用者的配置决定
 */
function buildDesiredDomains(totpSecrets, emailCodeHosts) {
  const set = new Set();
  (totpSecrets || []).forEach((e) => {
    const d = normalizeDomain(e && e.domain);
    if (d) set.add(d);
  });
  (emailCodeHosts || []).forEach((h) => {
    const d = normalizeDomain(h);
    if (d) set.add(d);
  });
  return Array.from(set).map((domain) => ({
    domain,
    id: domainToScriptId(domain),
    patterns: patternsFor(domain),
  }));
}

/**
 * 同步已注册的 content script:
 * - 配置里已不存在的域名 → 注销
 * - 已授权但未注册 → 注册
 * - 授权范围变了(如从只有 https 变成 http+https) → 注销后重注册
 */
async function syncInjection() {
  try {
    const s = await chrome.storage.local.get(["totpSecrets", "emailCodeHosts"]);
    const desired = buildDesiredDomains(s.totpSecrets || [], s.emailCodeHosts || []);

    const existing = await chrome.scripting.getRegisteredContentScripts();
    const mine = existing.filter((x) => x.id && x.id.indexOf("mfa_") === 0);
    const existingById = {};
    mine.forEach((x) => { existingById[x.id] = x; });
    const desiredIds = desired.map((d) => d.id);

    const toRemove = mine
      .filter((x) => desiredIds.indexOf(x.id) === -1) // 配置已删除
      .map((x) => x.id);

    const toAdd = [];
    for (const d of desired) {
      // 逐个 origin 判断: 用户可能只授权了 https (升级前的老权限), 那就只注册 https 规则,
      // 避免因 http 未授权导致整条注册失败
      const grantedPatterns = [];
      for (const p of d.patterns) {
        const ok = await chrome.permissions.contains({ origins: [p] });
        if (ok) grantedPatterns.push(p);
      }

      const cur = existingById[d.id];
      if (!grantedPatterns.length) {
        if (cur) toRemove.push(d.id); // 授权被撤销 → 注销
        continue;
      }
      if (cur) {
        const same = cur.matches && cur.matches.length === grantedPatterns.length &&
          grantedPatterns.every((p) => cur.matches.indexOf(p) >= 0);
        if (same) continue;           // 已是最新状态
        toRemove.push(d.id);          // 授权范围变了 → 重注册
      }
      // 注意: RegisteredContentScript 的合法字段只有
      // id/matches/excludeMatches/js/css/allFrames/runAt/world/persistAcrossSessions/matchOriginAsFallback。
      // matchAboutBlank 是静态 manifest content_scripts 的字段, 传进来会被 schema 校验拒绝,
      // 导致整次 registerContentScripts 调用抛错(一个域名失败 = 全部失败)。
      toAdd.push({
        id: d.id,
        matches: grantedPatterns,
        js: ["totp.js", "content.js"],
        runAt: "document_idle",
        allFrames: true, // 登录组件常嵌在 iframe 里, 只注顶层框架会完全找不到输入框
      });
    }

    const removeIds = Array.from(new Set(toRemove));
    if (removeIds.length) {
      await chrome.scripting.unregisterContentScripts({ ids: removeIds });
    }

    // 逐个注册: 单个域名失败(权限不足/字段校验)不能拖垮其它域名
    const errors = [];
    let added = 0;
    for (const script of toAdd) {
      try {
        await chrome.scripting.registerContentScripts([script]);
        added++;
      } catch (e) {
        errors.push(script.matches.join(",") + " → " + String(e).slice(0, 200));
        console.warn("[MFA AutoFill] 注册失败:", script.matches, e);
      }
    }
    lastSyncError = errors.join(" | ");
    console.log("[MFA AutoFill] 注入同步完成 | 目标域名:", desired.length,
                "| 新注册:", added, "| 移除:", removeIds.length,
                "| 失败:", errors.length);
    return {
      ok: errors.length === 0,
      total: desired.length,
      added,
      removed: removeIds.length,
      errors,
    };
  } catch (e) {
    console.warn("[MFA AutoFill] 注入同步失败:", e);
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------- 事件

/** 当前已注册的动态注入清单 (供弹窗诊断: 区分"没授权"和"授权了但被拦") */
async function getInjectionState() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const mine = scripts
      .filter((x) => x.id && x.id.indexOf("mfa_") === 0)
      .map((x) => ({ id: x.id, matches: x.matches || [] }));
    return { ok: true, scripts: mine, lastError: lastSyncError };
  } catch (e) {
    return { ok: false, error: String(e), scripts: [], lastError: lastSyncError };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_CODE") {
    fetchLatestCode().then(sendResponse);
    return true; // 异步响应
  }
  if (msg.type === "CODE_USED") {
    chrome.storage.local.set({ lastUsedCode: msg.code, lastUsedAt: Date.now() });
  }
  if (msg.type === "SYNC_INJECTION") {
    syncInjection().then(sendResponse);
    return true;
  }
  if (msg.type === "INJECTION_STATE") {
    getInjectionState().then(sendResponse);
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[MFA AutoFill] 已安装/更新至", chrome.runtime.getManifest().version);
  syncInjection();
});

chrome.runtime.onStartup.addListener(() => {
  syncInjection();
});

// 配置变更(新增/编辑/删除 TOTP 记录, 或启用新域名) → 重新同步注入
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.totpSecrets || changes.emailCodeHosts) {
    syncInjection();
  }
});

// 用户撤销某域名授权 → 立即清理对应注入
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => {
    syncInjection();
  });
}
