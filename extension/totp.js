// totp.js — 纯 JS TOTP (RFC 6238) 实现, 使用 Web Crypto, 无任何外部依赖
// 在 popup / content script / service worker 中均可使用

const Totp = (() => {
  function base32Decode(str) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
    let bits = "";
    const out = [];
    for (const ch of clean) {
      const idx = alphabet.indexOf(ch);
      if (idx === -1) throw new Error("Base32 非法字符: " + ch);
      bits += idx.toString(2).padStart(5, "0");
      while (bits.length >= 8) {
        out.push(parseInt(bits.slice(0, 8), 2));
        bits = bits.slice(8);
      }
    }
    return new Uint8Array(out);
  }

  async function generate(secret, opts) {
    opts = opts || {};
    const digits = opts.digits || 6;
    const period = opts.period || 30;
    const key = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const msg = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
      msg[i] = c & 0xff;
      c = Math.floor(c / 256);
    }
    const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg));
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin =
      ((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3];
    return String(bin % Math.pow(10, digits)).padStart(digits, "0");
  }

  function secondsRemaining(period) {
    period = period || 30;
    return period - (Math.floor(Date.now() / 1000) % period);
  }

  function currentCounter(period) {
    return Math.floor(Date.now() / 1000 / (period || 30));
  }

  return { generate, secondsRemaining, currentCounter };
})();
