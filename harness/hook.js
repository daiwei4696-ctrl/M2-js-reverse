/* 注入到页面的 hook：包裹 fetch / XMLHttpRequest，落 window.__CAPTURED__ */
module.exports = String.raw`
(function () {
  var CAP = [];
  window.__CAPTURED__ = CAP;
  function rec(kind, info) {
    var stack = "";
    try { stack = (new Error()).stack; } catch (e) {}
    var item = { kind: kind, t: Date.now() };
    for (var k in info) item[k] = info[k];
    item.stack = String(stack).split("\n").slice(0, 8).join("\n");
    CAP.push(item);
    try { console.log("[hook] " + JSON.stringify(item)); } catch (e) {}
  }
  function hdrPairs(h) {
    var out = {};
    try { if (typeof h.forEach === "function") { h.forEach(function (v, k) { out[k] = v; }); } else out = Object.assign({}, h); } catch (e) {}
    return out;
  }
  if (typeof fetch === "function") {
    var _f = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var o = init || {};
      rec("fetch", { url: url, method: o.method || (input && input.method) || "GET",
                     headers: hdrPairs(o.headers), body: o.body == null ? null : String(o.body) });
      return _f.apply(this, arguments);
    };
  }
  if (window.XMLHttpRequest) {
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    var _set = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__h = this.__h || {}; this.__m = m; this.__u = u; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this.__h[k] = v; return _set.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      rec("xhr", { url: this.__u, method: this.__m, headers: this.__h, body: b == null ? null : String(b) });
      return _send.apply(this, arguments);
    };
  }
  rec("boot", { ua: navigator.userAgent, sid: (function(){ try { return localStorage.getItem("sid"); } catch(e){ return null; } })(),
                referrer: document.referrer, href: location.href });
})();
`;
