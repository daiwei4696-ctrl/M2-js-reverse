#!/usr/bin/env node
/* ============================================================================
 * server.js —— r2coin 靶场服务端
 *   静态托管 public/（index.html + app.obf.js）
 *   POST /api/pay  用与前端同一套算法校验 x-key / x-ts / x-sign
 *
 * 服务端 == 前端算法的白盒复刻。envFingerprint 三项来源：
 *   ua       <- 请求头 user-agent（与浏览器 navigator.userAgent 一致）
 *   sid      <- localStorage 固定值 "lab-sid-2026"
 *   ref      <- Referer 请求头（fetch 相对路径时浏览器填当前页 URL，
 *              与页面里 location.href 一致）
 * ==========================================================================*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const ROOT = path.join(__dirname, "public");

const KEY_ID = "r2c-4f8a";
const SECRET = "s3cr3t-of-r2c0in";
const SALT = "l4b-salt-2026";
const ROUNDS = 3;
const SID = "lab-sid-2026";
const WINDOW_MS = 60000;   // 时间戳容差 ±60s

function md5(s) { return crypto.createHash("md5").update(s, "utf8").digest("hex"); }

function envFingerprint(ua, ref) {
  return [KEY_ID, SID, ref, ua.length, String(ua.charCodeAt(0) || 0)].join("|");
}

function calcSign(pathName, ts, body, ua, ref) {
  const nonce = Math.floor(ts / 30000);
  let acc = [pathName, String(ts), String(nonce), body,
             envFingerprint(ua, ref), SECRET, SALT].join("&");
  for (let i = 0; i < ROUNDS; i++) acc = md5(acc + SECRET);
  return acc;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css; charset=utf-8", ".json": "application/json",
               ".ico": "image/x-icon", ".map": "application/json" };
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8",
                        "Content-Length": b.length, "Access-Control-Allow-Origin": "*" });
  res.end(b);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let n = 0; const chunks = [];
    req.on("data", function (c) {
      n += c.length;
      if (n > 1e6) { reject(new Error("body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

const server = http.createServer(async function (req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type,x-key,x-sign,x-ts",
        "Access-Control-Allow-Methods": "POST,GET,OPTIONS" });
      return res.end();
    }
    const urlPath = req.url.split("?")[0];
    if (urlPath === "/api/pay" && req.method === "POST") return handlePay(req, res);
    if (urlPath === "/api/ping") return sendJson(res, 200, { ok: true, note: "r2coin api alive" });
    return serveStatic(req, res);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

async function handlePay(req, res) {
  const raw = await readBody(req);
  const pathName = req.url.split("?")[0];
  const ua = req.headers["user-agent"] || "";
  const ref = req.headers["referer"] || "";   // 与页面 envFingerprint() 里的 location.href 对齐

  let body;
  try { body = JSON.parse(raw); }
  catch (e) { return sendJson(res, 400, { ok: false, error: "bad json" }); }

  const hKey = req.headers["x-key"];
  const hTs = String(req.headers["x-ts"] || "");
  const hSign = req.headers["x-sign"] || "";
  const serverTs = Date.now();
  const fail = [];

  if (hKey !== KEY_ID) fail.push("x-key 不匹配");
  if (!/^\d+$/.test(hTs)) fail.push("x-ts 不是毫秒时间戳");
  else if (Math.abs(Number(hTs) - serverTs) > WINDOW_MS) fail.push("x-ts 超出容差窗口");
  if (!/^[0-9a-f]{32}$/.test(hSign)) fail.push("x-sign 不是 32 位 hex");

  const want = calcSign(pathName, Number(hTs), raw, ua, ref);

  console.log("[pay] " + new Date().toISOString() +
              " x-key=" + hKey + " x-ts=" + hTs +
              " ua.len=" + ua.length + " ref=" + JSON.stringify(ref) +
              " recv=" + hSign + " calc=" + want);

  if (!fail.length && hSign === want) {
    return sendJson(res, 200, { ok: true, orderId: "R2C" + hTs, amount: body.amount,
                                serverTs: serverTs, note: "token granted" });
  }
  return sendJson(res, 401, { ok: false, error: fail.length ? fail.join("; ") : "签名校验失败",
                              recv: hSign, calc: want });
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^[\\\/]+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("404 " + p); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
                         "Cache-Control": "no-store" });
    res.end(buf);
  });
}

server.listen(PORT, "127.0.0.1", function () {
  console.log("[server] http://127.0.0.1:" + PORT + "  (static: public/   api: POST /api/pay)");
});
