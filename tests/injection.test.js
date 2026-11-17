// tests/injection.test.js — 用 mock 的 chrome API 验证「域名驱动动态注入」核心逻辑
// 运行: node tests/injection.test.js
// 不依赖浏览器, 纯逻辑回归。覆盖:
//   按配置生成目标域名 / 未授权不注册 / 幂等 / 删除后注销 / 授权后新增 /
//   空配置零注入 / 不误删他人脚本 / id 不撞车 / 域名容错 / 父域覆盖子域 /
//   部分授权(仅 https) / 授权扩大后重注册 / 撤销授权后注销

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "extension", "background.js");
const code = fs.readFileSync(SRC, "utf8");

// ---------------------------------------------------------------- mock chrome

function makeChrome(initialStorage, initialGranted) {
  const state = {
    storage: Object.assign({}, initialStorage),
    granted: new Set(initialGranted || []),
    registered: new Map(), // id -> descriptor
    log: [],
  };

  const chrome = {
    storage: {
      local: {
        // 真实 MV3 同时支持回调与 Promise, mock 两者都实现
        get(keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : Object.keys(state.storage);
          list.forEach((k) => {
            if (k in state.storage) out[k] = JSON.parse(JSON.stringify(state.storage[k]));
          });
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set(obj, cb) {
          Object.assign(state.storage, JSON.parse(JSON.stringify(obj)));
          if (cb) cb();
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
    scripting: {
      async getRegisteredContentScripts() {
        return Array.from(state.registered.values()).map((d) => ({
          id: d.id,
          matches: d.matches.slice(),
          js: d.js.slice(),
        }));
      },
      async registerContentScripts(list) {
        list.forEach((d) => {
          // 严格 schema 校验: RegisteredContentScript 的合法字段白名单。
          // 真实 Chrome/Edge 遇到未知字段(如 matchAboutBlank)会直接抛错, 整次调用失败。
          Object.keys(d).forEach((k) => {
            if (!REGISTERED_SCRIPT_FIELDS.has(k)) {
              throw new Error("Unexpected property: '" + k + "'");
            }
          });
          if (state.registered.has(d.id)) throw new Error("duplicate id: " + d.id);
          state.registered.set(d.id, JSON.parse(JSON.stringify(d)));
          state.log.push("register " + d.id);
        });
      },
      async unregisterContentScripts({ ids }) {
        (ids || []).forEach((id) => {
          state.registered.delete(id);
          state.log.push("unregister " + id);
        });
      },
    },
    permissions: {
      contains({ origins }, cb) {
        const all = (origins || []).every((o) => state.granted.has(o));
        if (cb) cb(all);
        return Promise.resolve(all);
      },
      onRemoved: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getManifest: () => ({ version: "test" }),
    },
  };
  return { chrome, state };
}

// ---------------------------------------------------------------- 加载被测代码

function load(chrome, opts) {
  opts = opts || {};
  const sandbox = {
    chrome,
    console: { log() {}, warn() {} },
    AbortController: typeof AbortController !== "undefined" ? AbortController : function () {
      this.abort = function () {};
      this.signal = {};
    },
    setTimeout,
    clearTimeout,
    fetch:
      opts.fetch ||
      (async () => {
        throw new Error("no network in test");
      }),
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    code +
      "\nmodule.exports = { buildDesiredDomains, syncInjection, domainToScriptId, patternsFor, normalizeDomain, getInjectionState, fetchLatestCode, describeFetchError, API_TARGETS };\n",
    sandbox,
    { filename: "background.js" }
  );
  return sandbox.module.exports;
}

// ---------------------------------------------------------------- 断言

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label + "\n      期望: " + e + "\n      实际: " + a);
  }
}

// RegisteredContentScript 的合法字段（chrome.scripting.registerContentScripts）
// 注意没有 matchAboutBlank —— 那是静态 manifest content_scripts 的字段
const REGISTERED_SCRIPT_FIELDS = new Set([
  "id", "matches", "excludeMatches", "js", "css",
  "allFrames", "runAt", "world", "persistAcrossSessions", "matchOriginAsFallback",
]);

const HTTPS = (d) => "https://*." + d + "/*";
const HTTP = (d) => "http://*." + d + "/*";
const BOTH = (d) => [HTTPS(d), HTTP(d)];

(async function main() {
  console.log("\n[1] buildDesiredDomains: 只来自用户配置, 去重规范化");
  {
    const { chrome } = makeChrome({}, []);
    const api = load(chrome);
    const d = api.buildDesiredDomains(
      [
        { domain: "cloud.tencent.com" },
        { domain: "https://idaas.example.com/login" }, // 带协议+路径
        { domain: "  Portal.Example.COM.  " }, // 大小写/空格/首尾点
        { domain: "" }, // 空 → 跳过
        { label: "no domain" }, // 无域名 → 跳过
        { domain: "cloud.tencent.com" }, // 重复
      ],
      ["portal.example.com"]
    );
    eq("域名集合与顺序", d.map((x) => x.domain), [
      "cloud.tencent.com",
      "idaas.example.com",
      "portal.example.com",
    ]);
    eq("同时生成 http + https 规则", d[0].patterns, BOTH("cloud.tencent.com"));
    eq("id 唯一且仅含合法字符", new Set(d.map((x) => x.id)).size === 3 &&
      d.every((x) => /^[a-z0-9_]+$/.test(x.id)), true);
  }

  console.log("\n[2] syncInjection: 未授权域名不注册");
  {
    const { chrome, state } = makeChrome(
      {
        totpSecrets: [{ id: "t1", domain: "cloud.tencent.com" }],
        emailCodeHosts: ["portal.example.com"],
      },
      BOTH("cloud.tencent.com") // 只授权了腾讯云
    );
    const api = load(chrome);
    const r = await api.syncInjection();
    eq("注册数 (1 已授权 / 1 未授权)", state.registered.size, 1);
    eq("只注册了腾讯云", Array.from(state.registered.values())[0].matches,
      BOTH("cloud.tencent.com"));
    eq("注入顺序 totp.js → content.js",
      Array.from(state.registered.values())[0].js, ["totp.js", "content.js"]);
    eq("返回值统计", [r.ok, r.total, r.added], [true, 2, 1]);
  }

  console.log("\n[3] syncInjection 幂等: 重复调用不重复注册");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "cloud.tencent.com" }] },
      BOTH("cloud.tencent.com")
    );
    const api = load(chrome);
    await api.syncInjection();
    const first = state.registered.size;
    const r2 = await api.syncInjection();
    eq("注册数不变", state.registered.size, first);
    eq("第二次 added=0 且 removed=0", [r2.added, r2.removed], [0, 0]);
  }

  console.log("\n[4] 删除 TOTP 记录 → 对应注入被注销");
  {
    const { chrome, state } = makeChrome(
      {
        totpSecrets: [{ id: "t1", domain: "cloud.tencent.com" }],
        emailCodeHosts: ["portal.example.com"],
      },
      [...BOTH("cloud.tencent.com"), ...BOTH("portal.example.com")]
    );
    const api = load(chrome);
    await api.syncInjection();
    eq("初始注册 2 个", state.registered.size, 2);

    state.storage.totpSecrets = []; // 用户删掉了腾讯云记录
    const r = await api.syncInjection();
    eq("剩 1 个", state.registered.size, 1);
    eq("剩下的是 portal", Array.from(state.registered.values())[0].matches,
      BOTH("portal.example.com"));
    eq("removed=1", r.removed, 1);
  }

  console.log("\n[5] 新增授权 → 下次同步自动注册");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "cloud.tencent.com" }] },
      BOTH("cloud.tencent.com")
    );
    const api = load(chrome);
    await api.syncInjection();
    state.storage.totpSecrets.push({ id: "t2", domain: "id.example.org" });
    await api.syncInjection();
    eq("未授权时仍是 1 个", state.registered.size, 1);

    BOTH("id.example.org").forEach((p) => state.granted.add(p)); // 用户点了「授权」
    const r = await api.syncInjection();
    eq("授权后变 2 个", state.registered.size, 2);
    eq("added=1", r.added, 1);
  }

  console.log("\n[6] 完全空配置 → 不注册任何脚本 (干净安装)");
  {
    const { chrome, state } = makeChrome({}, []);
    const api = load(chrome);
    const r = await api.syncInjection();
    eq("注册数 0", state.registered.size, 0);
    eq("total=0", r.total, 0);
  }

  console.log("\n[7] 非本扩展注册的脚本不被误删");
  {
    const { chrome, state } = makeChrome({}, []);
    state.registered.set("other-ext-script", {
      id: "other-ext-script",
      matches: ["https://x.com/*"],
      js: ["x.js"],
    });
    const api = load(chrome);
    await api.syncInjection();
    eq("外部脚本保留", state.registered.has("other-ext-script"), true);
  }

  console.log("\n[8] 域名 id 不撞车: a.b.com 与 a-b.com");
  {
    const { chrome } = makeChrome({}, []);
    const api = load(chrome);
    const d = api.buildDesiredDomains(
      [{ domain: "a.b.com" }, { domain: "a-b.com" }],
      []
    );
    eq("两个 id 不同", d[0].id !== d[1].id, true);
    eq("id 稳定 (同域名重复计算一致)",
      api.domainToScriptId("a.b.com"), api.domainToScriptId("a.b.com"));
  }

  console.log("\n[9] normalizeDomain 容错");
  {
    const { chrome } = makeChrome({}, []);
    const api = load(chrome);
    eq("协议+路径+端口", api.normalizeDomain("https://A.Example.com:8443/x?y=1"), "a.example.com");
    eq("首尾点", api.normalizeDomain(".example.com."), "example.com");
    eq("空值", api.normalizeDomain(null), "");
  }

  console.log("\n[10] 父域记录覆盖子域页面");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "example.com" }] },
      BOTH("example.com")
    );
    const api = load(chrome);
    await api.syncInjection();
    eq("注册的是父域规则", Array.from(state.registered.values())[0].matches,
      BOTH("example.com"));
    eq("pattern 含 *. 前缀 (Chrome 语义: 同时匹配父域与子域)",
      HTTPS("example.com").indexOf("://*.") > 0, true);
  }

  console.log("\n[11] 部分授权 (只给了 https, 升级前的老权限) → 只注册 https 规则, 不整体失败");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "old.example.com" }] },
      [HTTPS("old.example.com")] // 只有 https
    );
    const api = load(chrome);
    const r = await api.syncInjection();
    eq("仍然注册成功", state.registered.size, 1);
    eq("只含 https 规则", Array.from(state.registered.values())[0].matches,
      [HTTPS("old.example.com")]);
    eq("ok=true", r.ok, true);
  }

  console.log("\n[12] 授权范围扩大 → 注销后按新范围重注册 (不会遗漏 http)");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "old.example.com" }] },
      [HTTPS("old.example.com")]
    );
    const api = load(chrome);
    await api.syncInjection();
    eq("初始只有 https", Array.from(state.registered.values())[0].matches,
      [HTTPS("old.example.com")]);

    state.granted.add(HTTP("old.example.com")); // 用户补授权 http
    const r = await api.syncInjection();
    eq("重注册后含 http+https", Array.from(state.registered.values())[0].matches,
      BOTH("old.example.com"));
    eq("计数为 1 移除 1 新增", [r.removed, r.added], [1, 1]);
  }

  console.log("\n[13] 撤销授权 → 注入立即注销");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "cloud.tencent.com" }] },
      BOTH("cloud.tencent.com")
    );
    const api = load(chrome);
    await api.syncInjection();
    eq("初始注册 1 个", state.registered.size, 1);

    state.granted.clear(); // 用户在 chrome://extensions 撤销权限
    const r = await api.syncInjection();
    eq("注入被注销", state.registered.size, 0);
    eq("removed=1", r.removed, 1);
  }

  console.log("\n[14] 注册载荷合法: 带 iframe 支持, 且不含 schema 之外的字段");
  {
    const { chrome, state } = makeChrome(
      { totpSecrets: [{ id: "t1", domain: "cloud.tencent.com" }] },
      BOTH("cloud.tencent.com")
    );
    const api = load(chrome);
    const r = await api.syncInjection();
    const d = Array.from(state.registered.values())[0];
    eq("注册成功 (schema 校验通过)", r.ok, true);
    eq("allFrames=true", d.allFrames, true);
    eq("runAt=document_idle", d.runAt, "document_idle");
    eq("不含 matchAboutBlank", "matchAboutBlank" in d, false);
    eq("字段全在白名单内",
      Object.keys(d).every((k) => REGISTERED_SCRIPT_FIELDS.has(k)), true);
  }

  console.log("\n[15] 单个域名注册失败不拖垮其它域名 (逐个注册 + 错误回收)");
  {
    const { chrome, state } = makeChrome(
      {
        totpSecrets: [
          { id: "t1", domain: "good.example.com" },
          { id: "t2", domain: "bad.example.com" },
        ],
      },
      [...BOTH("good.example.com"), ...BOTH("bad.example.com")]
    );
    // 让 bad 那条在注册时被 mock 判为非法字段(模拟真实环境里的 schema 拒绝)
    const originalRegister = chrome.scripting.registerContentScripts;
    chrome.scripting.registerContentScripts = async function (list) {
      const s = list[0];
      if (s.matches[0].indexOf("bad.") >= 0) {
        throw new Error("Unexpected property: 'matchAboutBlank'");
      }
      return originalRegister.call(chrome.scripting, list);
    };
    const api = load(chrome);
    const r = await api.syncInjection();
    eq("good 仍注册成功", state.registered.size, 1);
    eq("注册的是 good", Array.from(state.registered.values())[0].matches,
      BOTH("good.example.com"));
    eq("ok=false (有失败)", r.ok, false);
    eq("错误被回收到 errors", r.errors.length, 1);
    eq("错误文案含出错域名", String(r.errors[0]).indexOf("bad.example.com") >= 0, true);

    const st = await api.getInjectionState();
    eq("弹窗诊断能读到 lastError", st.lastError.indexOf("bad.example.com") >= 0, true);
    eq("已注册清单只含 good", st.scripts.length, 1);
  }

  // ================================================================
  // 本地 API 取码层 (v1.3.5)
  // 背景: 用户环境里 127.0.0.1 的站点访问开关被关, fetch 抛 TypeError,
  // 而旧实现把所有异常吞成"连接失败"并只报最后一个地址([::1]),
  // 把"权限被关"伪装成"服务没运行"。
  // ================================================================

  console.log("\n[15] API 目标地址不含 [::1] (服务端只监听 IPv4, 该地址永远连不上)");
  {
    const { chrome } = makeChrome({}, []);
    const api = load(chrome);
    const bases = api.API_TARGETS.map((t) => t.base);
    eq("目标数", bases.length, 2);
    eq("首个是 127.0.0.1", bases[0], "http://127.0.0.1:8642");
    eq("无 [::1]", bases.indexOf("http://[::1]:8642"), -1);
    eq("每个目标自带 pattern",
      api.API_TARGETS.map((t) => t.pattern),
      ["http://127.0.0.1:8642/*", "http://localhost:8642/*"]);
  }

  console.log("\n[16] 正常取码");
  {
    const { chrome } = makeChrome({}, ["http://127.0.0.1:8642/*"]);
    const calls = [];
    const api = load(chrome, {
      fetch: async (url) => {
        calls.push(url);
        return {
          ok: true,
          json: async () => ({ code: "942710", fetched_at: "2026-10-27 10:56:42" }),
        };
      },
    });
    const r = await api.fetchLatestCode();
    eq("ok", r.ok, true);
    eq("码", r.code, "942710");
    eq("只请求一次", calls.length, 1);
  }

  console.log("\n[17] 权限被关 + fetch TypeError → 必须指出是权限问题");
  {
    const { chrome } = makeChrome({}, []); // 两个回环 origin 都未授权
    const api = load(chrome, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const r = await api.fetchLatestCode();
    eq("ok=false", r.ok, false);
    eq("needPermission=true", r.needPermission, true);
    eq("错误文案点出权限", r.error.indexOf("站点访问权限已被关闭") >= 0, true);
    eq("错误文案列出全部地址", r.attempts.length, 2);
    eq("回传 apiPatterns 供弹窗申请", r.apiPatterns.length, 2);
    eq("每个地址标注未授权", r.attempts.every((a) => a.granted === false), true);
    eq("含具体地址", r.error.indexOf("127.0.0.1:8642") >= 0, true);
    eq("含 localhost", r.error.indexOf("localhost:8642") >= 0, true);
  }

  console.log("\n[18] 权限正常但服务没起 → 指向服务, 不要误导成权限");
  {
    const { chrome } = makeChrome(
      {},
      ["http://127.0.0.1:8642/*", "http://localhost:8642/*"]
    );
    const api = load(chrome, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const r = await api.fetchLatestCode();
    eq("needPermission=false", r.needPermission, false);
    eq("提示启动脚本", r.error.indexOf("mfa_code_fetcher.py") >= 0, true);
    eq("不该说权限被关", r.error.indexOf("站点访问权限已被关闭"), -1);
  }

  console.log("\n[19] 首个地址失败 → 回退到第二个地址");
  {
    const { chrome } = makeChrome({}, []);
    let n = 0;
    const api = load(chrome, {
      fetch: async (url) => {
        n++;
        if (n === 1) throw new TypeError("Failed to fetch");
        return { ok: true, json: async () => ({ code: "123456" }) };
      },
    });
    const r = await api.fetchLatestCode();
    eq("回退成功", r.code, "123456");
    eq("请求了两次", n, 2);
  }

  console.log("\n[20] HTTP 错误码与超时要能区分");
  {
    const { chrome } = makeChrome({}, []);
    const api1 = load(chrome, {
      fetch: async () => ({ ok: false, status: 500 }),
    });
    const r1 = await api1.fetchLatestCode();
    eq("HTTP 500 被记录", r1.attempts[0].reason, "HTTP 500");

    const abort = new Error("aborted");
    abort.name = "AbortError";
    const api2 = load(chrome, {
      fetch: async () => {
        throw abort;
      },
    });
    eq("AbortError → 超时", api2.describeFetchError(abort), "超时 4s");
    eq("TypeError → 连不上",
      api2.describeFetchError(new TypeError("Failed to fetch")), "连不上");
    eq("权限文案 → 浏览器拒绝",
      api2.describeFetchError(new Error("Permission denied")), "浏览器拒绝(权限)");
  }

  console.log("\n" + "=".repeat(48));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log("=".repeat(48) + "\n");
  process.exit(fail ? 1 : 0);
})();
