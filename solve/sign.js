#!/usr/bin/env node
/* ============================================================================
 * solve/sign.js —— M2「Rebuild」阶段产物
 *
 * 不 import 任何混淆代码，只用 Node 内置 crypto 从零重演 r2coin 的签名算法，
 * 然后用从 harness 抓包里得到的真实浏览器参数发同一个请求。
 *
 * 用法:
 *   node solve/sign.js                 # 复算 capture.json 里的请求 + 实网请求
 *   node solve/sign.js --amount 6      # 自定义金额
 *   node solve/sign.js --ts 1759...    # 用固定 ts 复算抓包里的 x-sign
 *   node solve/sign.js --base http://127.0.0.1:8787
 *
 * 退出码: 0 = 复算一致且实网 200；1 = 任一环节不符（可直接进 CI）
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

/* ----------------------------- 0. 参数 ----------------------------- */
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const AMOUNT = arg("amount", "1");
const BASE = arg("base", "http://127.0.0.1:8787");
const FIXED_TS = arg("ts", null);
const EVID = path.join(__dirname, "..", "evidence");

/* ---------- 1. 逆向结论：算法常量（来自 app.src.js，混淆版里同样能读出来） ---------- */
const KEY_ID = "r2c-4f8a";
const SECRET = "s3cr3t-of-r2c0in";
const SALT = "l4b-salt-2026";
const ROUNDS = 3;
const ENDPOINT = "/api/pay";
const SID = "lab-sid-2026";                          // index.html 种进 localStorage 的固定值
const PAGE_HREF = new URL(BASE).origin + "/";        // 页面 location.href

/* ---------------- 2. 签名算法重演（等价于页面里的 MD5 + getSign） ---------------- */
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

/** envFingerprint(ua, href) = [keyId, sid, href, ua.length, ua.charCodeAt(0)] */
function envFingerprint(ua, href) {
  return [KEY_ID, SID, href, ua.length, String(ua.charCodeAt(0) || 0)].join("|");
}
/** getSign: nonce=floor(ts/30000); acc = 6 段 join("&"); 再 MD5 拌 SECRET 跑 ROUNDS 轮 */
function getSign(ts, body, ua, href) {
  const nonce = Math.floor(ts / 30000);
  let acc = [ENDPOINT, String(ts), String(nonce), body, envFingerprint(ua, href), SECRET, SALT].join("&");
  for (let r = 0; r < ROUNDS; r++) acc = md5(acc + SECRET);
  return acc;
}

function post(payload, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + ENDPOINT);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", headers: headers
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------- 3. 主流程 ------------------------------- */
(async function main() {
  /* 3.1 读抓包结果，拿「真实浏览器参数」 */
  let cap = null;
  try { cap = JSON.parse(fs.readFileSync(path.join(EVID, "capture.json"), "utf8")); } catch (e) { cap = null; }
  const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
  const UA = (cap && cap.ua) || DEFAULT_UA;

  console.log("[env] ua.len=" + UA.length + "  href=" + PAGE_HREF + "  sid=" + SID);
  console.log("[env] fingerprint = " + envFingerprint(UA, PAGE_HREF));

  /* 3.2 Rebuild 验收：复算 harness 抓到的那个请求 */
  let ok0 = true, verified = false;
  const capReq = cap && Array.isArray(cap.requests)
    ? cap.requests.find(r => r.kind === "fetch" && String(r.url).indexOf(ENDPOINT) >= 0) : null;
  if (capReq && capReq.headers) {
    const ts0 = Number(capReq.headers["x-ts"]);
    // 抓包时页面 URL 可能带 ?nodbg=1 之类的实验开关，必须用当时的 href 复算
    const href0 = (cap && cap.page) || PAGE_HREF;
    const mine = getSign(ts0, capReq.body, UA, href0);
    const theirs = capReq.headers["x-sign"];
    verified = true;
    ok0 = (mine === theirs);
    console.log("");
    console.log("[verify] 复算抓包请求（ts=" + ts0 + ", href=" + href0 + "）");
    console.log("         browser x-sign = " + theirs);
    console.log("         rebuilt  x-sign = " + mine);
    console.log("         => " + (ok0 ? "MATCH  [OK] 算法重演正确" : "MISMATCH [X] 算法重演有偏差"));
  } else {
    console.log("");
    console.log("[verify] 没找到 capture.json 里的抓包记录（先跑 ../harness/cdp.js），跳过复算");
  }

  /* 3.3 实网请求。注意必须补两个头：
   *     User-Agent  —— 签名里绑了 ua.length / ua.charCodeAt(0)
   *     Referer     —— 签名里绑了 location.href，服务端是从 Referer 头取这个值的 */
  const ts = FIXED_TS ? Number(FIXED_TS) : Date.now();
  const body = JSON.stringify({ amount: AMOUNT, ts: ts });
  const sign = getSign(ts, body, UA, PAGE_HREF);
  const h = {
    "Content-Type": "application/json",
    "User-Agent": UA,
    "Referer": PAGE_HREF,
    "x-key": KEY_ID,
    "x-sign": sign,
    "x-ts": String(ts)
  };

  console.log("");
  console.log("[live] POST " + BASE + ENDPOINT);
  console.log("       body=" + body);
  console.log("       x-sign=" + sign);

  let lastErr = null, spawned = null;
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await post(body, h);
      const j = JSON.parse(r.body);
      const good = r.status === 200 && !!j.ok;
      console.log("       HTTP " + r.status + "  " + r.body);
      console.log(good ? "[live] 200 -- 签名被服务端接受 [OK]"
                       : "[live] 被拒绝：" + (j.error || "?") + "  (recv != calc)");
      console.log("");
      console.log("===== RESULT: " + ((ok0 && good) ? "PASS" : "FAIL") + " =====");
      process.exit(ok0 && good ? 0 : 1);
    } catch (e) {
      lastErr = e;
      if (i === 2 && !spawned) {
        // 自己把 target/server.js 拉起来，保证 solve/ 可独立复现
        console.log("[live] 连不上，自动拉起 target/server.js ...");
        spawned = spawn(process.execPath, [path.join(__dirname, "..", "target", "server.js"),
          String(new URL(BASE).port || 8787)], { stdio: "ignore" });
        spawned.on("error", () => {});
        process.on("exit", () => { try { spawned.kill(); } catch (e) {} });
      }
      await sleep(500);
    }
  }
  console.error("[live] 连不上 " + BASE + "（已尝试自动拉起 server）");
  console.error("       " + (lastErr && lastErr.message));
  console.log("");
  console.log("===== RESULT: " + (ok0 ? "PARTIAL(实网未通)" : "FAIL") + " =====");
  process.exit(1);
})();