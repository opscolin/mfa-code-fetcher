// popup.js — 工具栏弹窗: 邮箱验证码 + TOTP 动态口令管理(增删改) + 本页启用 + 诊断
// v1.3.0: 域名驱动动态注入 —— 配置了哪个域名就只注入哪个域名, 无预置名单

const $ = (id) => document.getElementById(id);

// ---------- 邮箱验证码 ----------

function requestCode() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_CODE" }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: "无响应" });
      }
    });
  });
}

// 本地回环地址的 origin 权限。background 会随失败回传实际用到的 pattern,
// 这里留一份默认值, 保证首次点击「恢复权限」时也有值可用。
let apiPatterns = ["http://127.0.0.1:8642/*", "http://localhost:8642/*"];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function refreshEmailCode(statusHtmlRef) {
  const resp = await requestCode();
  const fixBox = $("api-fix");
  let html = "";
  if (!resp.ok) {
    if (Array.isArray(resp.apiPatterns) && resp.apiPatterns.length) {
      apiPatterns = resp.apiPatterns;
    }
    $("code").textContent = "—";
    $("code-meta").textContent = "无法获取";
    // v1.3.5: 不再用一句"未运行或旧版本"盖过所有原因, 把每个地址的结果原样摆出来
    $("api-fix-text").textContent = resp.needPermission
      ? "本地回环地址的站点访问权限被关闭 — 这就是连接失败的真正原因"
      : "本地服务没有响应（也可能是站点访问开关拦住了请求）";
    // 两种情况都给出修复入口: 已授权时 request 会立即返回 true, 不会骚扰用户;
    // 这正好覆盖"permissions.contains 说已授权、但开关仍拦着"的灰色情况。
    fixBox.style.display = "flex";
    html =
      `<span class="err">✗ 本地 API 不可达</span>` +
      `<br><span class="hint">${escapeHtml(resp.error || "")}</span>` +
      `<br><span class="hint">不影响取码：验证码已由脚本自动复制到剪贴板，可直接粘贴</span>`;
  } else if (resp.code) {
    fixBox.style.display = "none";
    $("code").textContent = resp.code;
    $("code-meta").textContent = `收到于 ${resp.fetchedAt || "未知时间"}`;
    html = `<span class="ok">✓ 本地服务正常, 有可用验证码</span>`;
  } else {
    fixBox.style.display = "none";
    $("code").textContent = "—";
    $("code-meta").textContent = "暂无新鲜验证码 (5 分钟内)";
    html = `<span class="ok">✓ 本地服务正常</span>, 等待 MFA 邮件`;
  }
  statusHtmlRef.email = html;
}

// ---------- 工具 ----------

/** 域名规范化: 去掉协议/路径/端口/空格/首尾点, 转小写 */
function normalizeDomain(v) {
  let d = String(v || "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split("/")[0].split("?")[0].split(":")[0];
  return d.replace(/^\.+|\.+$/g, "");
}

/** 与 background.js 保持一致: 每个域名同时申请 http 与 https */
function originPatterns(domain) {
  return ["https://*." + domain + "/*", "http://*." + domain + "/*"];
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

let currentHost = "";
// 当前页「授权」按钮真正要申请的域名:
// 若本页命中了某条 TOTP 记录, 要授权的是该记录填写的域名(可能是父域),
// 而不是当前页 host —— 否则按 host 申请到的权限不覆盖记录的域名, 注入永远不生效。
let currentTargetDomain = "";

async function currentTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return { id: null, host: "", scheme: "" };
  let host = "";
  let scheme = "";
  try {
    const u = new URL(tab.url);
    host = normalizeDomain(u.hostname);
    scheme = u.protocol.replace(":", "").toLowerCase();
  } catch (e) {}
  return { id: tab.id, host, scheme };
}

function hasPermission(domain) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: originPatterns(domain) }, (v) => {
      resolve(!!v && !chrome.runtime.lastError);
    });
  });
}

/** 必须在用户点击手势中"同步"调用 (不要在 await 之后调用) */
function requestPermission(domain) {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: originPatterns(domain) }, (granted) => {
      resolve(!!granted && !chrome.runtime.lastError);
    });
  });
}

function syncInjection() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SYNC_INJECTION" }, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp || { ok: false, error: "无响应" });
    });
  });
}

function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve({ ok: true, data: resp || {} });
      }
    });
  });
}

/** 读取后台已注册的注入清单 */
function requestInjectionState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "INJECTION_STATE" }, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, scripts: [], lastError: "" });
      else resolve(resp || { ok: false, scripts: [], lastError: "" });
    });
  });
}

/** 从 match pattern 里取 host 部分: "https://*.a.com/*" → "*.a.com" */
function patternHost(pattern) {
  const m = /^[a-z*]+:\/\/([^/]+)/i.exec(String(pattern || ""));
  return m ? m[1].toLowerCase() : "";
}

/** 已注册的注入规则是否覆盖当前 host */
function scriptCoversHost(patterns, host) {
  return (patterns || []).some((p) => {
    let ph = patternHost(p);
    if (!ph) return false;
    if (ph.startsWith("*.")) ph = ph.slice(2);
    return hostMatches(host, ph);
  });
}

/**
 * 立刻把脚本注入当前标签页 —— 走 activeTab 通道, 不依赖"刷新页面",
 * 也不受浏览器「站点访问权限」开关的限制(弹窗的打开本身就是一次用户手势授权)。
 */
async function injectToActiveTab() {
  const info = await currentTabInfo();
  if (!info.id) return false;
  // 逐帧注入: 登录组件可能在 iframe 里
  try {
    await chrome.scripting.executeScript({
      target: { tabId: info.id, allFrames: true },
      files: ["totp.js", "content.js"],
    });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: info.id },
        files: ["totp.js", "content.js"],
      });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/** 当前页 host 是否已配置过某个通道 (TOTP 记录或邮箱验证码站点) */
async function isHostConfigured(host) {
  if (!host) return false;
  const secrets = await loadSecrets();
  const hitTotp = secrets.some((e) => {
    const d = normalizeDomain(e.domain);
    return d && hostMatches(host, d);
  });
  if (hitTotp) return true;
  const emailHosts = (await loadEmailHosts()).map(normalizeDomain);
  return emailHosts.some((d) => hostMatches(host, d));
}

/**
 * 打开弹窗时: 若当前页已配置过通道, 直接注入一次。
 * 这是绕开浏览器「站点访问权限」开关不可靠的关键路径 —— 弹窗打开 = activeTab 手势授权,
 * executeScript 必然被允许, 不受任何开关影响。
 */
async function autoInjectIfConfigured() {
  const info = await currentTabInfo();
  if (!info.id || (info.scheme !== "https" && info.scheme !== "http")) return;
  if (await isHostConfigured(info.host)) {
    await injectToActiveTab();
  }
}

/** 打开本扩展在浏览器里的详情页(里面有站点访问开关) */
function openPermissionSettings() {
  const isEdge = navigator.userAgent.indexOf("Edg/") >= 0;
  const base = isEdge ? "edge://extensions" : "chrome://extensions";
  chrome.tabs.create({ url: base + "/?id=" + chrome.runtime.id });
}

// ---------- TOTP 数据 ----------

function loadSecrets() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["totpSecrets"], (s) => resolve(s.totpSecrets || []));
  });
}

function saveSecrets(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ totpSecrets: list }, resolve);
  });
}

function loadEmailHosts() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["emailCodeHosts"], (s) => resolve(s.emailCodeHosts || []));
  });
}

function saveEmailHosts(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ emailCodeHosts: list }, resolve);
  });
}

let editingId = null; // 正在编辑的记录 id (null = 无)

// ---------- 本页启用状态 ----------

async function renderHostBox() {
  const box = $("host-box");
  if (!currentHost) { box.style.display = "none"; currentTargetDomain = ""; return; }
  box.style.display = "flex";
  box.classList.remove("on");

  const secrets = await loadSecrets();
  const totpHit = secrets.find((e) => {
    const d = normalizeDomain(e.domain);
    return d && hostMatches(currentHost, d);
  });
  const emailHosts = (await loadEmailHosts()).map(normalizeDomain);
  const emailHit = emailHosts.some((d) => hostMatches(currentHost, d));

  const targetDomain = totpHit ? normalizeDomain(totpHit.domain) : currentHost;
  currentTargetDomain = targetDomain;
  const granted = await hasPermission(targetDomain);

  if (granted && (totpHit || emailHit)) {
    box.classList.add("on");
    $("host-text").textContent = totpHit
      ? `本页已启用 · 动态口令「${totpHit.label || "(未命名)"}」`
      : "本页已启用 · 邮箱验证码";
    return;
  }

  if (totpHit) {
    $("host-text").textContent =
      `已为「${totpHit.label || "(未命名)"}」配置域名 ${targetDomain}，但尚未授权自动注入`;
    $("btn-enable-host").textContent = "授权本页";
  } else {
    $("host-text").textContent =
      `本页(${currentHost})未启用自动填充。启用后此站点的验证码才会自动填入`;
    $("btn-enable-host").textContent = "启用本页";
  }
}

// ---------- 渲染 TOTP 列表 ----------

async function renderTotp() {
  const list = await loadSecrets();
  const box = $("totp-list");
  const empty = $("totp-empty");
  box.innerHTML = "";
  empty.style.display = list.length ? "none" : "block";
  if (!list.length) return;

  for (const entry of list) {
    if (entry.id === editingId) {
      box.appendChild(renderEditCard(entry));
    } else {
      box.appendChild(await renderItemCard(entry));
    }
  }
}

async function renderItemCard(entry) {
  const item = document.createElement("div");
  item.className = "totp-item";
  item.dataset.id = entry.id;

  let codeText = "------";
  let bad = false;
  try {
    codeText = await Totp.generate(entry.secret);
  } catch (e) {
    codeText = "无效秘钥";
    bad = true;
  }

  // 行1: 名称 + 倒计时
  const row1 = document.createElement("div");
  row1.className = "row1";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = entry.label || "(未命名)";
  label.title = entry.label || "";
  const cd = document.createElement("div");
  cd.className = "countdown";
  cd.textContent = bad ? "" : Totp.secondsRemaining(30) + "s";
  row1.appendChild(label);
  row1.appendChild(cd);

  // 行2: 验证码 + 复制/编辑/删除
  const row2 = document.createElement("div");
  row2.className = "row2";
  const codeEl = document.createElement("div");
  codeEl.className = "tcode";
  codeEl.textContent = codeText;

  const btnCopy = document.createElement("button");
  btnCopy.textContent = "复制";
  btnCopy.onclick = () => {
    navigator.clipboard.writeText(codeText);
    btnCopy.textContent = "已复制 ✓";
    setTimeout(() => (btnCopy.textContent = "复制"), 1500);
  };

  const btnEdit = document.createElement("button");
  btnEdit.className = "edit";
  btnEdit.textContent = "编辑";
  btnEdit.onclick = () => {
    editingId = entry.id;
    renderTotp();
  };

  const btnDel = document.createElement("button");
  btnDel.className = "del";
  btnDel.textContent = "删除";
  btnDel.onclick = async () => {
    if (!confirm(`确定删除「${entry.label || "(未命名)"}」吗？`)) return;
    const cur = await loadSecrets();
    await saveSecrets(cur.filter((e) => e.id !== entry.id));
    if (editingId === entry.id) editingId = null;
    await syncInjection();
    renderTotp();
    renderHostBox();
  };

  row2.appendChild(codeEl);
  row2.appendChild(btnCopy);
  row2.appendChild(btnEdit);
  row2.appendChild(btnDel);

  item.appendChild(row1);
  item.appendChild(row2);

  // 行3: 域名绑定 + 授权状态
  const domain = normalizeDomain(entry.domain);
  if (domain) {
    const d = document.createElement("div");
    d.className = "domain";
    d.textContent = "自动填充: " + domain;
    item.appendChild(d);

    const granted = await hasPermission(domain);
    if (!granted) {
      const warn = document.createElement("div");
      warn.className = "perm-warn";
      const t = document.createElement("span");
      t.textContent = "未授权自动注入";
      const b = document.createElement("button");
      b.textContent = "授权";
      b.onclick = () => {
        // 同步发起授权, 保留用户手势
        requestPermission(domain).then(async (ok) => {
          if (ok) {
            await syncInjection();
            await injectToActiveTab(); // 当前页若是该站点, 立即生效
            await renderTotp();
            await renderHostBox();
            refreshStatus();
          }
        });
      };
      warn.appendChild(t);
      warn.appendChild(b);
      item.appendChild(warn);
    }
  } else {
    const d = document.createElement("div");
    d.className = "domain";
    d.textContent = "未绑定域名 — 仅弹窗手动复制";
    item.appendChild(d);
  }

  return item;
}

function renderEditCard(entry) {
  const item = document.createElement("div");
  item.className = "totp-item editing";

  const form = document.createElement("div");
  form.className = "edit-form";

  const inLabel = document.createElement("input");
  inLabel.placeholder = "名称";
  inLabel.value = entry.label || "";

  const inSecret = document.createElement("input");
  inSecret.placeholder = "Base32 秘钥";
  inSecret.value = entry.secret || "";

  const domainRow = document.createElement("div");
  domainRow.className = "field-row";
  const inDomain = document.createElement("input");
  inDomain.placeholder = "绑定域名 (留空=仅手动复制)";
  inDomain.value = entry.domain || "";
  const btnUsePage = document.createElement("button");
  btnUsePage.className = "use-page";
  btnUsePage.textContent = "用当前页";
  btnUsePage.onclick = async () => {
    const info = await currentTabInfo();
    if (info.host) {
      inDomain.value = info.host;
    } else {
      btnUsePage.textContent = "取不到";
      setTimeout(() => (btnUsePage.textContent = "用当前页"), 1500);
    }
  };
  domainRow.appendChild(inDomain);
  domainRow.appendChild(btnUsePage);

  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const btnSave = document.createElement("button");
  btnSave.className = "save";
  btnSave.textContent = "保存";
  const btnCancel = document.createElement("button");
  btnCancel.className = "cancel";
  btnCancel.textContent = "取消";
  actions.appendChild(btnSave);
  actions.appendChild(btnCancel);

  const tip = document.createElement("div");
  tip.className = "edit-tip";
  tip.textContent = "保存时会请求该域名的注入授权；保存后刷新 MFA 页面即生效";

  form.appendChild(inLabel);
  form.appendChild(inSecret);
  form.appendChild(domainRow);
  form.appendChild(actions);
  form.appendChild(tip);
  item.appendChild(form);

  btnCancel.onclick = () => {
    editingId = null;
    renderTotp();
  };

  btnSave.onclick = async () => {
    const label = inLabel.value.trim() || "(未命名)";
    const secret = inSecret.value.trim();
    const domain = normalizeDomain(inDomain.value);
    if (!secret) { alert("秘钥不能为空"); return; }
    try {
      await Totp.generate(secret);
    } catch (e) {
      alert("秘钥格式无效 (应为 Base32 字母数字): " + e);
      return;
    }
    const cur = await loadSecrets();
    const idx = cur.findIndex((e) => e.id === entry.id);
    if (idx === -1) { editingId = null; renderTotp(); return; }

    // 域名变更 → 同步发起授权 (必须在点击手势内)
    let permPromise = null;
    if (domain && domain !== normalizeDomain(entry.domain)) {
      permPromise = requestPermission(domain);
    }

    cur[idx] = Object.assign({}, cur[idx], { label, secret, domain });
    await saveSecrets(cur);
    if (permPromise) await permPromise;
    await syncInjection();
    editingId = null;
    renderTotp();
    renderHostBox();
  };

  return item;
}

// ---------- 新增表单 ----------

function bindTotpForm() {
  $("btn-add").onclick = () => $("totp-form").classList.toggle("show");

  const btnUsePage = $("btn-use-page");
  if (btnUsePage) {
    btnUsePage.onclick = async () => {
      const info = await currentTabInfo();
      if (info.host) {
        $("inp-domain").value = info.host;
      } else {
        btnUsePage.textContent = "取不到";
        setTimeout(() => (btnUsePage.textContent = "用当前页"), 1500);
      }
    };
  }

  $("btn-save").onclick = async () => {
    const label = $("inp-label").value.trim() || "(未命名)";
    const secret = $("inp-secret").value.trim();
    const domain = normalizeDomain($("inp-domain").value);
    if (!secret) { alert("秘钥不能为空"); return; }
    try {
      await Totp.generate(secret);
    } catch (e) {
      alert("秘钥格式无效 (应为 Base32 字母数字): " + e);
      return;
    }
    // 同步发起授权 (必须在点击手势内)
    let permPromise = null;
    if (domain) permPromise = requestPermission(domain);

    const list = await loadSecrets();
    list.push({ id: "t" + Date.now().toString(36), label, secret, domain });
    await saveSecrets(list);
    if (permPromise) await permPromise;
    await syncInjection();
    $("inp-label").value = ""; $("inp-secret").value = ""; $("inp-domain").value = "";
    $("totp-form").classList.remove("show");
    renderTotp();
    renderHostBox();
  };
}

// ---------- 状态与操作 ----------

async function refreshStatus() {
  const statusEl = $("status");
  const fixRow = $("fix-row");
  const parts = { email: "" };

  await refreshEmailCode(parts);

  let html = parts.email;

  const info = await currentTabInfo();
  if (info.host) {
    const ping = await pingTab(info.id);
    let stateHtml;
    if (!ping.ok) {
      // 未注入 → 区分两种原因，给出可执行的动作
      const state = await requestInjectionState();
      const covered = state.scripts.some((s) => scriptCoversHost(s.matches, info.host));
      fixRow.style.display = "flex";
      if (state.lastError) {
        stateHtml += `<br><span class="err">注册报错: ${state.lastError}</span>`;
      }
      if (covered) {
        stateHtml = ` <span class="err">(规则已注册但页面未注入)</span>` +
          `<br><span class="hint">浏览器的站点访问开关没有放行 ${info.host}。` +
          `点「立即注入本页」马上生效(不受开关影响)；要每次自动填, ` +
          `点「打开权限设置」把对应开关打开</span>`;
      } else {
        stateHtml = ` <span class="err">(该域名未授权注入)</span>` +
          `<br><span class="hint">点上方「启用本页」授权后即可注入</span>`;
        fixRow.style.display = "none";
      }
    } else {
      fixRow.style.display = "none";
      if (ping.data.isMfa) {
        stateHtml = ` <span class="ok">(已注入 · 识别为 MFA 页面` +
          (ping.data.split ? ` · 分格 ${ping.data.boxCount} 框` : ` · 单框`) +
          (ping.data.isTop === false ? ` · 子框架` : ``) +
          `)</span>`;
        if (!ping.data.filled && ping.data.diag) {
          stateHtml += `<br><span class="hint">通道: ${ping.data.diag}</span>`;
        }
      } else {
        stateHtml = ` <span class="err">(已注入, 但页面未识别为 MFA 页面)</span>` +
          `<br><span class="hint">页面里没有 MFA/验证码 等字样，或输入框在封闭的跨域 iframe 内</span>`;
      }
    }
    html += `<br>当前页面: ${info.host}` + stateHtml;
  } else {
    fixRow.style.display = "none";
  }
  statusEl.innerHTML = html;
}

$("btn-copy").onclick = async () => {
  const code = $("code").textContent;
  if (code && code !== "—" && code !== "…") {
    await navigator.clipboard.writeText(code);
    $("btn-copy").textContent = "已复制 ✓";
    setTimeout(() => ($("btn-copy").textContent = "复制"), 1500);
  }
};

// 恢复本地 API 权限: Chrome 允许用户把 127.0.0.1 的站点访问也关掉
// (截图里就是这个状态), 关了之后扩展 fetch 本地服务会直接抛 TypeError。
// 必须在点击手势里同步调用 request, 不能放到 await 之后。
$("btn-fix-api").onclick = () => {
  const btn = $("btn-fix-api");
  btn.textContent = "请求中…";
  chrome.permissions.request({ origins: apiPatterns }, (granted) => {
    const err = chrome.runtime.lastError;
    if (err || !granted) {
      btn.textContent = "恢复本地 API 权限";
      $("api-fix-text").textContent =
        "授权未完成 — 也可去扩展详情页把 127.0.0.1 的开关手动打开";
      return;
    }
    btn.textContent = "已授权, 重试中…";
    setTimeout(async () => {
      btn.textContent = "恢复本地 API 权限";
      await refreshStatus();
      // 授权了但还是连不上 → 说明不是权限问题, 明确指路, 别让用户反复点
      if ($("api-fix").style.display !== "none") {
        $("api-fix-text").textContent =
          "权限已授予但仍连不上 — 请确认 mfa_code_fetcher.py 在运行；" +
          "或去扩展详情页把 127.0.0.1 的开关手动打开";
      }
    }, 200);
  });
};

// 手动设置: 直达扩展详情页, 自己把 127.0.0.1 的两个开关打开
$("btn-fix-settings").onclick = () => openPermissionSettings();

$("btn-fill").onclick = async () => {
  const btn = $("btn-fill");
  btn.textContent = "注入中…";
  const ok = await injectToActiveTab();
  btn.textContent = ok ? "已注入并开始填充 ✓" : "注入失败(该站点可能未授权)";
  setTimeout(() => (btn.textContent = "强制填充当前页"), 2500);
  if (ok) setTimeout(refreshStatus, 600);
};

// 启用本页: 授权该域名 + (若无 TOTP 记录匹配) 加入"邮箱验证码站点"列表
$("btn-enable-host").onclick = () => {
  const host = currentHost;
  if (!host) return;
  // 授权目标: 命中 TOTP 记录时用记录里的域名, 否则用当前页 host。
  // 必须"同步"调用以保留用户点击手势。
  const target = currentTargetDomain || host;
  requestPermission(target).then(async (granted) => {
    if (!granted) {
      $("host-text").textContent = "授权被拒绝 — 无法自动注入 " + target;
      return;
    }
    const secrets = await loadSecrets();
    const hasTotp = secrets.some((e) => {
      const d = normalizeDomain(e.domain);
      return d && hostMatches(host, d);
    });
    if (!hasTotp) {
      const hosts = (await loadEmailHosts()).map(normalizeDomain);
      if (!hosts.some((d) => hostMatches(host, d))) {
        hosts.push(host);
        await saveEmailHosts(hosts);
      }
    }
    const res = await syncInjection();
    await renderHostBox();
    if (res && res.ok === false) {
      $("host-text").textContent =
        "已授权, 但注册注入规则失败" + (res.errors && res.errors.length ? " — " + res.errors[0] : "");
      refreshStatus();
      return;
    }
    // 授权后立刻注入当前页, 不必手动刷新
    await injectToActiveTab();
    refreshStatus();
  });
};

// ---------- 初始化 ----------

async function init() {
  const info = await currentTabInfo();
  currentHost = info.host;

  bindTotpForm();
  await renderTotp();
  renderHostBox();
  // 关键: 弹窗打开即尝试注入(仅限已配置过通道的站点)。
  // 弹窗打开 = activeTab 手势授权, 不受浏览器站点访问开关的影响。
  await autoInjectIfConfigured();
  refreshStatus();
}

init();

// 「立即注入本页」: 走 activeTab, 不依赖站点访问开关
$("btn-inject-now").onclick = async () => {
  const btn = $("btn-inject-now");
  btn.textContent = "注入中…";
  const ok = await injectToActiveTab();
  btn.textContent = ok ? "已注入 ✓" : "注入失败";
  setTimeout(() => (btn.textContent = "立即注入本页"), 2000);
  refreshStatus();
};

// 「打开权限设置」: 直达本扩展的详情页(站点访问开关在那里)
$("btn-perm-settings").onclick = () => openPermissionSettings();

// 智能倒计时: 每秒只更新数字, 30s 窗口切换时才重新渲染; 编辑中暂停
let lastSecs = null;
setInterval(async () => {
  if (editingId !== null) { lastSecs = Totp.secondsRemaining(30); return; }
  const secs = Totp.secondsRemaining(30);
  if (lastSecs !== null && secs >= lastSecs) {
    await renderTotp();
  } else {
    document.querySelectorAll(".totp-item .countdown").forEach((el) => {
      el.textContent = secs + "s";
    });
  }
  lastSecs = secs;
}, 1000);
setInterval(refreshStatus, 5000);
