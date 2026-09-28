/* ============================================================
 * 「Node 直跑 → 观察 first divergence → 一次补一个最小单元」
 * 这是 M2 Rebuild/Patch 阶段的第一手证据：脚本按轮次打印补丁前后差异。
 *
 * 用法: node probe.js
 * 要点: build 出来的 app.src.js 结尾是
 *         (function(globalScope){...})(typeof window!=="undefined"?window:globalThis);
 *       在 Node 里 window 不存在 -> globalScope 绑定到真正的 globalThis，
 *       所以补丁必须挂在 globalThis 上（而不是我传进去的沙箱对象）。
 * ============================================================ */
var fs = require("fs");
var code = fs.readFileSync(__dirname + "/src/app.src.js", "utf8");

function freshLoad() { return new Function(code + ";return globalThis.__R2PAY__;")(); }
function t(label, fn) {
  try { console.log("  OK   " + label + " -> " + fn()); }
  catch (e) { console.log("  FAIL " + label + " -> " + e.constructor.name + ": " + e.message); }
}

function reset() {
  try { delete globalThis.navigator; } catch (e) { globalThis.navigator = undefined; }
  try { delete globalThis.localStorage; } catch (e) { globalThis.localStorage = undefined; }
  try { delete globalThis.document; } catch (e) { globalThis.document = undefined; }
  try { delete globalThis.location; } catch (e) { globalThis.location = undefined; }
}

var PAGE_URL = "http://127.0.0.1:8787/";
var UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
var BODY = JSON.stringify({ amount: "1", ts: 1759000000000 });

console.log("=== round 0 : 零补丁（基线） ===");
reset();
var R = freshLoad();
t("envFingerprint()", function () { return R.envFingerprint(); });
t("getSign('/api/pay', 1759000000000, body)", function () { return R.getSign("/api/pay", 1759000000000, BODY); });

console.log("=== patch 1 : navigator.userAgent ===");
globalThis.navigator = { userAgent: UA };
t("envFingerprint()", function () { return R.envFingerprint(); });

console.log("=== patch 2 : + localStorage.getItem ===");
globalThis.localStorage = { getItem: function (k) { return k === "sid" ? "lab-sid-2026" : null; } };
t("envFingerprint()", function () { return R.envFingerprint(); });

console.log("=== patch 3 : + location.href ===");
globalThis.location = { href: PAGE_URL };
globalThis.document = { referrer: "", getElementById: function () { return { addEventListener: function () {} }; } };
console.log("  FINGERPRINT = " + R.envFingerprint());
t("getSign('/api/pay', 1759000000000, body)", function () {
  return R.getSign("/api/pay", 1759000000000, BODY);
});

console.log("=== 对照: 第 4 次补的 window/document.getElementById 不是签名必需 ===");
globalThis.document.getElementById = function () { return { addEventListener: function () {} }; };
console.log("  (boot 仅在浏览器端执行，Node 端不影响签名结果)");