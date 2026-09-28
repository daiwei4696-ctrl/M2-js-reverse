#!/usr/bin/env node
/* ============================================================================
 * cdp.js —— Chrome DevTools Protocol 抓包 harness（Hook-preferred，不用断点）
 *
 * 流程:
 *   1. 拉起 server.js（静态 + /api/pay）
 *   2. 拉起 headless Chrome (--remote-debugging-port=9222)
 *   3. 原生 WebSocket 连上 CDP（Node 22 自带全局 WebSocket，无需 npm 包）
 *   4. Page.addScriptToEvaluateOnNewDocument 注入 hook：包裹 fetch / XHR，
 *      记录 URL / 方法 / 请求头 / body，并带上 new Error().stack
 *   5. 导航 -> 等 DOMContentLoaded -> 点 #pay -> 读 #result
 *   6. 输出 evidence/capture.json + 人读日志
 *
 * 用法: node cdp.js [--url http://127.0.0.1:8787/] [--port 8787] [--keep]
 *       --keep 测完不杀进程，方便你自己开 DevTools 手撸
 * ==========================================================================*/
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "target");
const EVID = path.join(ROOT, "evidence");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const HAS = function (n) { return process.argv.indexOf("--" + n) >= 0; };
const PORT = Number(arg("port", "8787"));
const NODBG = !HAS("debug");
let PAGE_URL = arg("url", "http://127.0.0.1:" + PORT + "/");
if (NODBG && PAGE_URL.indexOf("nodbg=1") < 0) {
  PAGE_URL += (PAGE_URL.indexOf("?") >= 0 ? "&" : "?") + "nodbg=1";
}
const CDPPORT = Number(arg("cdp", "9222"));
const KEEP = HAS("keep");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.CHROME_PATH
].filter(Boolean);
const CHROME = CHROME_CANDIDES_SAFE();
function CHROME_CANDIDES_SAFE() {
  for (const c of CHROME_CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error("没找到 chrome.exe，请设置 CHROME_PATH");
}

/* hook 源码抽到 ./hook.js，方便单独测试和复用 */
const HOOK = require("./hook.js");
/* --------------------------------- CDP 客户端 --------------------------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.logs = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message + " (" + m.error.code + ")")); else resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
        if (m.method === "Runtime.consoleAPICalled") {
          const args = (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(" ");
          this.logs.push(args);
        }
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); } }, 15000);
    });
  }
  waitEvent(method, timeout) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = this.events.find(e => e.method === method);
        if (hit) return resolve(hit.params);
        if (Date.now() - t0 > (timeout || 10000)) return reject(new Error("waitEvent timeout: " + method));
        setTimeout(tick, 50);
      };
      tick();
    });
  }
  async evaluate(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function safeEval(cdp, expr) {
  try { return await cdp.evaluate(expr); }
  catch (e) { return "<err:" + (e && e.message) + ">"; }
}
function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
const http = require("http");

/* --------------------------------- 主流程 --------------------------------- */
(async function main() {
  fs.mkdirSync(EVID, { recursive: true });

  const srv = spawn(process.execPath, [path.join(TARGET, "server.js"), String(PORT)], { stdio: "pipe" });
  const SRVLOG = [];
  srv.stdout.on("data", d => { process.stdout.write("[server] " + d); SRVLOG.push(String(d).trimEnd()); });
  srv.stderr.on("data", d => { process.stdout.write("[server!] " + d); SRVLOG.push("[stderr] " + String(d).trimEnd()); });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "r2pay-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + CDPPORT, "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-features=Translate", "--window-size=1280,800", "about:blank"
  ], { stdio: "pipe" });
  chrome.stderr.on("data", () => {});

  const cleanup = () => { try { chrome.kill(); } catch (e) {} if (!KEEP) { try { srv.kill(); } catch (e) {} } };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  // 等 CDP 端口就绪
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    try { info = await httpJson("http://127.0.0.1:" + CDPPORT + "/json/version"); } catch (e) { await sleep(250); }
  }
  if (!info) { console.error("Chrome CDP 没起来"); process.exit(1); }
  console.log("[cdp] browser: " + info.Browser);

  const targets = await httpJson("http://127.0.0.1:" + CDPPORT + "/json/list");
  console.log("[cdp] targets: " + targets.map(t => t.type + "/" + (t.url||"")).join(" | "));
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(rej, 8000); });

  const cdp = new CDP(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.setSkipAllPauses", { skip: true });   // 反调试的 debugger 不卡我们
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  console.log("[cdp] hook 已注入（fetch / XMLHttpRequest 均被包裹）");

  const nav = await cdp.send("Page.navigate", { url: PAGE_URL });
  console.log("[cdp] navigate -> " + JSON.stringify(nav) + "  url=" + PAGE_URL);
  try { await cdp.send("Debugger.setSkipAllPauses", { skip: true }); } catch (e) {}
  let rs = ""; let evNames = [];
  for (let i = 0; i < 120; i++) {
    try { rs = await safeEval(cdp, "document.readyState"); } catch (e) { rs = "<err:" + e.message + ">"; }
    evNames = cdp.events.map(e => e.method);
    if (rs === "complete" && evNames.indexOf("Page.loadEventFired") >= 0) break;
    await sleep(100);
  }
  console.log("[cdp] readyState=" + rs + "  events=" + evNames.join(","));
  console.log("[cdp] location.href -> " + await safeEval(cdp, "location.href"));
  await sleep(400);

  console.log("[page] readyState/readyState -> " + await safeEval(cdp, "document.readyState"));
  console.log("[page] __R2PAY__ keys      -> " + await safeEval(cdp, "Object.keys(window.__R2PAY__||{}).join(',')"));
  console.log("[page] localStorage.sid    -> " + await safeEval(cdp, "(function(){try{return localStorage.getItem('sid')}catch(e){return '<err>'}})()"));
  console.log("[page] navigator.userAgent -> " + (await safeEval(cdp, "navigator.userAgent")).slice(0, 60) + "...");

  // 触发业务
  await safeEval(cdp, "document.getElementById('pay').click()");
  const t0 = Date.now();
  let result = "";
  while (Date.now() - t0 < 8000) {
    result = await safeEval(cdp, "document.getElementById('result').textContent");
    if (result && result !== "signing..." && result.indexOf("等待操作") < 0) break;
    await sleep(150);
  }
  console.log("[page] #result -> " + result);

  const captured = await safeEval(cdp, "JSON.stringify(window.__CAPTURED__)");
  let reqs = [];
try { reqs = JSON.parse(captured || "[]"); }
catch (e) { console.log("[!!] __CAPTURED__ 解析失败: " + String(captured).slice(0, 200)); }
  const pay = reqs.find(r => r.kind === "fetch" && String(r.url).indexOf("/api/pay") >= 0);

  const report = {
    page: PAGE_URL, ua: await safeEval(cdp, "navigator.userAgent"),
    sid: await safeEval(cdp, "(function(){try{return localStorage.getItem('sid')}catch(e){return null}})()"),
    referrer: await safeEval(cdp, "document.referrer"),
    resultText: result, requests: reqs, consoleLogs: cdp.logs
  };
  fs.writeFileSync(path.join(EVID, "capture.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("[cdp] evidence -> evidence/capture.json  (" + reqs.length + " 条 hook 记录)");

  /* 截图 + 服务端日志一起归档，便于回溯 */
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(EVID, "page.png"), Buffer.from(shot.data, "base64"));
    console.log("[cdp] 截图 -> evidence/page.png");
  } catch (e) { console.log("[cdp] 截图失败: " + e.message); }
  fs.writeFileSync(path.join(EVID, "server.log"), SRVLOG.join("\n") + "\n", "utf8");

  if (pay) {
    console.log("[!!] 抓到签名请求：");
    console.log("     url    = " + pay.url);
    console.log("     method = " + pay.method);
    console.log("     headers= " + JSON.stringify(pay.headers));
    console.log("     body   = " + pay.body);
    console.log("     stack  = " + String(pay.stack).split("\n").slice(0, 4).join(" | "));
  } else {
    console.log("[!!] 没抓到 /api/pay 请求（hook 没生效或页面没发请求）");
  }

  if (!KEEP) { cleanup(); }
  ws.close();
  process.exit(0);
})().catch(e => { console.error("harness error: " + (e && e.stack || e)); process.exit(1); });
