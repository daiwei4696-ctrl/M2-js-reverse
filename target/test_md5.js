/* 自测：从 app.src.js 里原样抠出 MD5 实现执行，和 Node crypto 对拍。
 * 用法: node test_md5.js [app.src.js 路径]
 */
var fs = require("fs");
var crypto = require("crypto");

var srcPath = process.argv[2] ||
  "D:\\逆向\\逆向学习\\practice\\M2-js-reverse\\target\\src\\app.src.js";
var src = fs.readFileSync(srcPath, "utf8");

var start = src.indexOf("/*MD5-BEGIN*/");
var end = src.indexOf("/*MD5-END*/");
if (start < 0 || end < 0) {
  console.error("FAIL: 未找到 MD5 标记块");
  process.exit(1);
}
var code = src.slice(start, end);

var MD5 = new Function(code + "; return MD5;")();

var cases = [
  "", "a", "abc", "message digest", "abcdefghijklmnopqrstuvwxyz",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
  "中文混合 mixed 测试", "x"
];
var bad = 0;
cases.forEach(function (c) {
  var mine = MD5(c);
  var ref = crypto.createHash("md5").update(Buffer.from(c, "utf8")).digest("hex");
  var ok = mine === ref;
  if (!ok) bad++;
  console.log((ok ? "PASS " : "FAIL ") + "len=" + String(c.length).padStart(3) +
              " mine=" + mine + (ok ? "" : " ref=" + ref));
});
if (bad) { console.log("MD5 SELF-TEST FAILED (" + bad + ")"); process.exit(1); }
console.log("MD5 SELF-TEST PASSED");