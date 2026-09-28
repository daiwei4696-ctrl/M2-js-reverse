var crypto = require("crypto");
var MD5 = (function () {
  var S = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
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
    for (i = 0; i < 4; i++) msg.push(0);
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

var cases = ["", "a", "abc", "message digest", "abcdefghijklmnopqrstuvwxyz",
             "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
             "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789",
             "中文测试", "123456789012345678901234567890123456789012345678901234567890123456789012345"];
var bad = 0;
cases.forEach(function (c) {
  var mine = MD5(c);
  var ref = crypto.createHash("md5").update(Buffer.from(c, "utf8")).digest("hex");
  var ok = mine === ref;
  if (!ok) bad++;
  console.log((ok ? "PASS" : "FAIL") + " len=" + c.length + " mine=" + mine + " ref=" + ref);
});
console.log(bad === 0 ? "MD5 SELF-TEST PASSED" : "MD5 SELF-TEST FAILED (" + bad + ")");