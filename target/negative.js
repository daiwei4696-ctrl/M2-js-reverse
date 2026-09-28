/* 服务端自测：以「同一算法的第三方客户端」身份打 /api/pay，验 401/200 两条路径 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const KEY_ID = "r2c-4f8a", SECRET = "s3cr3t-of-r2c0in", SALT = "l4b-salt-2026", ROUNDS = 3, SID = "lab-sid-2026";

function md5(s) { return crypto.createHash("md5").update(s, "utf8").digest("hex"); }
function fp(ua, ref) { return [KEY_ID, SID, ref, ua.length, String(ua.charCodeAt(0) || 0)].join("|"); }
function sign(p, ts, body, ua, ref) {
  const n = Math.floor(ts / 30000);
  let acc = [p, String(ts), String(n), body, fp(ua, ref), SECRET, SALT].join("&");
  for (let i = 0; i < ROUNDS; i++) acc = md5(acc + SECRET);
  return acc;
}

const PORT = 8899;
const srv = spawn(process.execPath, [path.join(__dirname, "server.js"), String(PORT)], { stdio: "inherit" });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function post(body, hdrs) {
  const r = await fetch("http://127.0.0.1:" + PORT + "/api/pay", {
    method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, hdrs), body: body
  });
  return { code: r.status, json: await r.json() };
}

(async function () {
  await sleep(700);
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

  // 1) 错误签名 -> 401
  const ts = Date.now();
  const body = JSON.stringify({ amount: "1", ts: ts });
  let r = await post(body, { "x-key": KEY_ID, "x-ts": String(ts), "x-sign": "0".repeat(32) });
  console.log("[t1] bad sign      -> " + r.code + " " + JSON.stringify(r.json));

  // 2) 正确签名（注意 Node fetch 的实际 UA 头是 "node"）
  r = await post(body, { "x-key": KEY_ID, "x-ts": String(ts), "x-sign": sign("/api/pay", ts, body, "node", "") });
  console.log("[t2] sign(ua=node) -> " + r.code + " " + JSON.stringify(r.json));

  // 3) UA 用错 -> 401（证明 envFingerprint 真的绑死了 UA）
  r = await post(body, { "x-key": KEY_ID, "x-ts": String(ts), "x-sign": sign("/api/pay", ts, body, UA, "") });
  console.log("[t3] sign(ua=chrome) -> " + r.code + " " + JSON.stringify(r.json));

  // 4) ts 超窗 -> 401
  const old = ts - 600000;
  const body4 = JSON.stringify({ amount: "1", ts: old });
  r = await post(body4, { "x-key": KEY_ID, "x-ts": String(old), "x-sign": sign("/api/pay", old, body4, "node", "") });
  console.log("[t4] stale ts       -> " + r.code + " " + JSON.stringify(r.json));

  srv.kill();
  process.exit(0);
})();