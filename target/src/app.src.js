/* ============================================================================
 * r2pay-lab  target source （可读版）
 * build.js 会把它混淆成 public/app.obf.js：
 *   1) 注释/空白清理            -> 可读性下降
 *   2) 字符串抽进 string-array  -> 常量不可全文搜索
 *   3) 标识符重命名            -> 变量名全部变成 _0x???? 
 *   4) getSign 控制流平坦化     -> while(true)+switch(state)
 *   5) 反调试（可用 ?nodbg=1 关闭）
 *
 * 混淆后的算法与本文件 100% 等价，server.js 用同一套算法校验签名。
 * ==========================================================================*/
(function (globalScope) {
  "use strict";

  /* ------------------------------ 配置区 ------------------------------ */
  var CONFIG = {
    endpoint: "/api/pay",     // 签名路径
    keyId: "r2c-4f8a",        // x-key
    secret: "s3cr3t-of-r2c0in",// 主密钥（混淆后只以 string-array 形式存在）
    rounds: 3,                // 哈希迭代轮数
    salt: "l4b-salt-2026"
  };

  /* ------------------------------ MD5 ------------------------------ */
  /*MD5-BEGIN*/
  var MD5 = (function () {
    var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    var K = [];
    for (var k = 0; k < 64; k++) {
      K.push(Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296));
    }
    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }
    function toUTF8(str) { return unescape(encodeURIComponent(String(str))); }
    function hex32(x) {
      var u = x >>> 0;
      var s = "";
      for (var i = 0; i < 4; i++) {
        var byte = (u >>> (i * 8)) & 0xFF;
        var h = byte.toString(16);
        s += h.length === 1 ? "0" + h : h;
      }
      return s;
    }
    return function (input) {
      var s = toUTF8(input);
      var msg = [];
      var i;
      for (i = 0; i < s.length; i++) msg.push(s.charCodeAt(i));
      var bitLen = msg.length * 8;
      msg.push(0x80);
      while (msg.length % 64 !== 56) msg.push(0x00);
      var lo = bitLen % 4294967296;
      for (i = 0; i < 4; i++) { msg.push(lo % 256); lo = Math.floor(lo / 256); }
      for (i = 0; i < 4; i++) msg.push(0x00);
      var a = 0x67452301 | 0, b = 0xEFCDAB89 | 0, c = 0x98BADCFE | 0, d = 0x10325476 | 0;
      var off;
      for (off = 0; off < msg.length; off += 64) {
        var M = [];
        var o;
        for (o = 0; o < 16; o++) {
          M[o] = (msg[off + o * 4] & 0xFF) | ((msg[off + o * 4 + 1] & 0xFF) << 8) |
                 ((msg[off + o * 4 + 2] & 0xFF) << 16) | ((msg[off + o * 4 + 3] & 0xFF) << 24);
        }
        var A = a, B = b, C = c, D = d;
        for (o = 0; o < 64; o++) {
          var f, g;
          if (o < 16) { f = (B & C) | (~B & D); g = o; }
          else if (o < 32) { f = (D & B) | (~D & C); g = (5 * o + 1) % 16; }
          else if (o < 48) { f = B ^ C ^ D; g = (3 * o + 5) % 16; }
          else { f = C ^ (B | ~D); g = (7 * o) % 16; }
          var tmp = D;
          var sum = (A + f + K[o] + M[g]) | 0;
          D = C; C = B;
          B = (B + rotl(sum, S[Math.floor(o / 16) * 4 + (o % 4)])) | 0;
          A = tmp;
        }
        a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
      }
      return hex32(a) + hex32(b) + hex32(c) + hex32(d);
    };
  })();
  /*MD5-END*/

  /* ---------------- 环境指纹：Node 直接跑必炸的三个坑 ----------------
   * 注意这里用 location.href 而不是 document.referrer：
   * 直接导航时 document.referrer 是空串，而服务端能看到的只有 HTTP Referer 头
   * （fetch 相对路径时浏览器会自动填成当前页 URL）。两端取值不一致 -> 签名永远对不上。
   * 改成 location.href 后页面和服务端读到的是同一个值。 */
  function envFingerprint() {
    var ua = globalScope.navigator.userAgent;
    var sid = globalScope.localStorage.getItem("sid");
    var href = globalScope.location.href;
    return [CONFIG.keyId, sid, href, ua.length, String(ua.charCodeAt(0) || 0)].join("|");
  }

  /* --------------------------- 签名主函数 --------------------------- */
  /* OBF:FUNC getSign */
  function getSign(path, ts, body) {
    var nonce = Math.floor(ts / 30000);
    var acc = [path, String(ts), String(nonce), body, envFingerprint(), CONFIG.secret, CONFIG.salt].join("&");
    for (var r = 0; r < CONFIG.rounds; r++) acc = MD5(acc + CONFIG.secret);
    return acc;
  }
  /* OBF:END */

  /* --------------------------- 业务入口 --------------------------- */
  function tokenize(amount) {
    var ts = Date.now();
    var path = CONFIG.endpoint;
    var body = JSON.stringify({ amount: amount, ts: ts });
    var sign = getSign(path, ts, body);
    /* 注意：headers 用中括号赋值而不是对象字面量——
       这样其中的字符串才能被 build.js 安全地抽进 string-array
       （对象字面量里的字符串键无法替换成函数调用）。 */
    var h = {};
    h["Content-Type"] = "application/json";
    h["x-key"] = CONFIG.keyId;
    h["x-sign"] = sign;
    h["x-ts"] = String(ts);
    return globalScope.fetch(path, {
      method: "POST",
      headers: h,
      body: body
    }).then(function (r) { return r.json(); });
  }

  function boot() {
    globalScope.document.getElementById("pay").addEventListener("click", function () {
      var amount = globalScope.document.getElementById("amount").value || "1";
      globalScope.document.getElementById("result").textContent = "signing...";
      tokenize(amount).then(function (res) {
        globalScope.document.getElementById("result").textContent = JSON.stringify(res);
      })["catch"](function (e) {
        globalScope.document.getElementById("result").textContent = "ERR " + e;
      });
    });
  }

  if (globalScope.document && typeof globalScope.document.getElementById === "function") {
    if (/complete|interactive/.test(globalScope.document.readyState)) boot();
    else globalScope.document.addEventListener("DOMContentLoaded", boot);
  }

  globalScope.__R2PAY__ = {
    getSign: getSign, tokenize: tokenize, envFingerprint: envFingerprint, CONFIG: CONFIG
  };
})(typeof window !== "undefined" ? window : globalThis);