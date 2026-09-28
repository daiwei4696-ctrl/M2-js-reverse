/* ============================================================================
 * build.js —— 把 src/app.src.js 混淆成 public/app.obf.js
 *
 *   阶段1  控制流平坦化   getSign -> while(true)+switch(state)   （标记区替换）
 *   阶段2  注释/空白清理
 *   阶段3  字符串抽表     string-array + XOR 0x37 + 索引位移   （全文搜不到常量）
 *   阶段4  标识符重命名   -> _0x???? 
 *   阶段5  反调试         默认开启，?nodbg=1 关闭（真实 obfuscator 的常见做法）
 *   阶段6  语义自校验     用同一套环境 shim 跑源码版 vs 混淆版，签名必须一致
 *
 * 用法: node build.js [--no-verify]
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src", "app.src.js");
const OUT = path.join(ROOT, "public", "app.obf.js");

/* ---------- 阶段1：控制流平坦化模板（getSign 的等价 while-switch 形态） ---------- */
const FLATTEN_TPL = [
  "  function getSign(path, ts, body) {",
  "    var st = 0x5b, out = null, acc = \"\", r = 0, nonce = 0;",
  "    while (true) {",
  "      switch (st) {",
  "        case 0x5b: nonce = Math.floor(ts / 30000); st = 0x2c; break;",
  "        case 0x2c: acc = [path, String(ts), String(nonce), body, envFingerprint(), CONFIG.secret, CONFIG.salt].join(\"&\"); st = 0x6d; break;",
  "        case 0x6d: r = 0; st = 0x1e; break;",
  "        case 0x1e: if (r < CONFIG.rounds) { acc = MD5(acc + CONFIG.secret); r = r + 1; st = 0x1e; break; } st = 0x77; break;",
  "        case 0x77: out = acc; st = 0x0b; break;",
  "        case 0x0b: return out;",
  "      }",
  "    }",
  "  }"
].join("\n");

const RENAME = {
  globalScope: "_0x1a2b", CONFIG: "_0x2c1a", MD5: "_0x4d5b", envFingerprint: "_0x7e1f",
  getSign: "_0x9a02", tokenize: "_0x3b77", boot: "_0x6c08",
  S: "_0x11e4", K: "_0x22f5", k: "_0x33a6", rotl: "_0x44b7", x: "_0x55c8", n: "_0x66d9",
  toUTF8: "_0x77ea", str: "_0x88fb", hex32: "_0x99ac", u: "_0xaabd", s: "_0xbbce",
  byte: "_0xccdf", h: "_0xdde0", i: "_0xee11", input: "_0xff22", msg: "_0x1033",
  bitLen: "_0x2144", lo: "_0x3255", a: "_0x4366", b: "_0x5477", c: "_0x6588",
  d: "_0x7699", off: "_0x87aa", M: "_0x98bb", o: "_0xa9cc", A: "_0xbadd",
  B: "_0xbbee", C: "_0xccff", D: "_0xdd00", f: "_0xee11", g: "_0xff22",
  tmp: "_0x0110", sum: "_0x1221", ua: "_0x2332", sid: "_0x3443", ref: "_0x4554",
  path: "_0x5665", ts: "_0x6776", body: "_0x7887", nonce: "_0x8998", acc: "_0x9aa9",
  r: "_0xabba", amount: "_0xbccb", sign: "_0xcddc", st: "_0xdeed", out: "_0xeffe"
};
// 注: f/g/i 等在多个函数里复用同一个新名字是可读的（等价作用域），也可自行差异化。

const STR_EXCLUDE = new Set(["use strict"]);   // 指令前言的字符串不能被函数调用替换

/* --------------------------------- 工具 --------------------------------- */
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2; out += " "; continue;
    }
    if (c === '"' || c === "'" || c === "`") {          // 字符串内部的 // /* 不当注释
      const q = c; let j = i + 1;
      while (j < src.length) { if (src[j] === "\\") { j += 2; continue; } if (src[j] === q) { j++; break; } j++; }
      out += src.slice(i, j); i = j; continue;
    }
    out += c; i++;
  }
  return '"' + out + '"';
}

/* 把源码切成 [text, STR, text, STR, ...]，STR 是解码后的字符串值 */
function tokenize(src) {
  const toks = []; let buf = ""; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let j = i + 1; let raw = "";
      while (j < src.length) {
        if (src[j] === "\\") { raw += src[j] + (src[j + 1] || ""); j += 2; continue; }
        if (src[j] === q) { j++; break; }
        raw += src[j]; j++;
      }
      toks.push({ t: "text", v: buf }); buf = "";
      toks.push({ t: "str", v: decodeLiteral(raw) }); i = j; continue;
    }
    buf += c; i++;
  }
  toks.push({ t: "text", v: buf });
  return toks;
}

function decodeLiteral(raw) {
  if (!raw.includes("\\")) return raw;
  return raw.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
             .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
             .replace(/\\(.)/g, (m, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}
function escStr(v) { return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'; }
function escHex(v) {
  if (v === "") return '""';
  let out = "";
  for (const ch of v) {
    const code = ch.charCodeAt(0) ^ 0x37;
    out += "\\x" + (code < 16 ? "0" : "") + code.toString(16);
  }
  return '"' + out + '"';
}

/* --------------------------------- 主流程 --------------------------------- */
function build() {
  let src = fs.readFileSync(SRC, "utf8");

  /* 阶段1: 控制流平坦化 */
  const re = /([ \t]*)\/\* OBF:FUNC getSign \*\/[\s\S]*?\/\* OBF:END \*\//;
  if (!re.test(src)) throw new Error("没找到 OBF:FUNC getSign 标记区");
  src = src.replace(re, FLATTEN_TPL);

  /* 阶段2: 去注释 */
  let code = stripComments(src);

  /* 外层包装固定，方便后续把字符串表插到 IIFE 内部 */
  const OPEN = "(function (globalScope) {";
  const CLOSE = "})(typeof window !== \"undefined\" ? window : globalThis);";
  const a = code.indexOf(OPEN), b = code.lastIndexOf(CLOSE);
  if (a < 0 || b < 0) throw new Error("外层 IIFE 包装不匹配");
  let inner = code.slice(a + OPEN.length, b);
  const directive = inner.match(/^\s*("use strict"|'use strict')\s*;/);
  if (directive) inner = inner.slice(directive[0].length);

  /* 阶段3: 字符串抽表 */
  const toks = tokenize(inner);
  const uniq = []; const idxOf = new Map();
  const ntoks = toks.map((tk) => {
    if (tk.t !== "str") return tk;
    if (STR_EXCLUDE.has(String(tk.v))) return { t: "text", v: escStr(tk.v) };
    if (!idxOf.has(tk.v)) { idxOf.set(tk.v, uniq.length); uniq.push(tk.v); }
    return { t: "str", v: idxOf.get(tk.v) };
  });
  let flat = ntoks.map((tk) => (tk.t === "text" ? tk.v : "\u0001" + tk.v + "\u0001")).join("");

  /* 阶段4: 标识符重命名（带上下文判断，不误伤对象字面量 key / 成员访问）
     踩过的坑：早年无脑全局 \\b 替换，把 {amount: amount, ts: ts} 的 key
     也换成了 _0xbccb，导致请求体字段名被改掉、服务端解析失败。
     判断规则：前一个非空字符是 . → 成员访问，跳过；
               前后分别是 { 或 , 与 : → 对象字面量 key，跳过；
               前是 { 或 , 且后是 } 或 , → 简写属性，跳过。 */
  function renameCtx(str, off, len) {
    let i = off - 1;
    while (i >= 0 && /\s/.test(str[i])) i--;
    const prev = i >= 0 ? str[i] : "";
    if (prev === ".") return false;
    let j = off + len;
    while (j < str.length && /\s/.test(str[j])) j++;
    const next = j < str.length ? str[j] : "";
    /* 对象字面量的 key：前一个非空字符是 { 或 , 且后一个非空字符是 :
       （形参表 next 是 , 或 )，三目冒号分支 prev 是运算符，都不会被误判） */
    if ((prev === "{" || prev === ",") && next === ":") return false;
    return true;
  }
  let renamed = 0;
  for (const [from, to] of Object.entries(RENAME)) {
    const rx = new RegExp("\\b" + from + "\\b", "g");
    flat = flat.replace(rx, function (m, off, str) {
      if (!renameCtx(str, off, m.length)) return m;
      renamed++;
      return to;
    });
  }

  /* 导出对象的 key 还原回原始名（真实项目里 window.__R2PAY__ 也要保留契约） */
  const REV = {}; for (const kk of Object.keys(RENAME)) REV[RENAME[kk]] = kk;
  flat = flat.replace(/__R2PAY__\s*=\s*\{([^}]*)\};/, function (m, body) {
    const pairs = body.split(",").map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) {
      const kv = x.split(":");
      return (REV[kv[0].trim()] || kv[0].trim()) + ": " + kv.slice(1).join(":").trim();
    });
    return "__R2PAY__ = {" + pairs.join(", ") + "};";
  });
  /* 空白清理：\s+ -> 空格，再去掉 ] 和 ( 前多余空格 */
  flat = flat.replace(/[ \t]*\r?\n[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ");
  flat = flat.replace(/ ?([)\]])/g, "$1").replace(/([([{]) /g, "$1");

  /* 字符串表生成：索引位移 + XOR 0x37 */
  const N = (function () { let n = uniq.length + 4; while (n % 3 === 0 || n < uniq.length) n++; return n; })();
  const slot = (i) => (i * 3 + 5) % N;                    // gcd(3,N)=1 => 单射
  const table = new Array(N).fill(null);
  for (let i = 0; i < uniq.length; i++) table[slot(i)] = escHex(uniq[i]);
  const decoys = ["__proto__", "constructor", "prototype", "__defineGetter__", "toString"];
  let di = 0;
  for (let i = 0; i < N; i++) if (table[i] === null) table[i] = escHex(decoys[di++ % decoys.length]);
  const ARR = "_0x0f1e", ACC = "_0x2a3b";
  const strBlock = "var " + ARR + "=[" + table.join(",") + "];"
    + "function " + ACC + "(i){var s=" + ARR + "[(i*3+5)%" + N + "],r=\"\",j=0;"
    + "for(;j<s.length;j++)r+=String.fromCharCode(s.charCodeAt(j)^0x37);return r;}";

  /* 还原字符串占位符 */
  flat = flat.replace(/\u0001(\d+)\u0001/g, (m, i) => ACC + "(" + i + ")");

  const antiDebug = [
    "(function(){",
    "try{var q=String((typeof location!==\"undefined\"&&location.search)||\"\");",
    "if(q.indexOf(\"nodbg=1\")<0){(function w(){debugger;setTimeout(w,8000);})();}}catch(e){}",
    "})();"
  ].join("");

  const banner = "/*! r2coin-sdk v2.4.1 | built " + new Date().toISOString().slice(0, 10) +
                 " | generated by build.js, DO NOT EDIT */\n";

  const out = banner + antiDebug + "\n" + OPEN.replace("globalScope", RENAME.globalScope) + "\n"
    + (directive ? directive[1] + ";\n" : "")
    + strBlock + "\n" + flat + "\n" + CLOSE + "\n";

  fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
  fs.writeFileSync(OUT, out, "utf8");

  return {
    strings: uniq.length, slots: N, renamed,
    srcBytes: Buffer.byteLength(src), outBytes: Buffer.byteLength(out),
    entries: uniq.slice()
  };
}

/* ---------------- 阶段6：语义自校验（源码版 vs 混淆版） ---------------- */
function resetEnv() {
  for (const k of ["navigator", "localStorage", "location", "document", "fetch", "__R2PAY__"]) {
    try { delete globalThis[k]; } catch (e) { globalThis[k] = undefined; }
  }
}
function verify(entries) {
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const env = {
    getItem: function (k) { return k === "sid" ? "lab-sid-2026" : null; }
  };
  /* Node >= 21 自带 globalThis.navigator，而且是个只读 getter（configurable 但无 setter）。
     直接 globalThis.navigator = {...} 在非严格模式下会【静默失败】：拿到的仍是
     "Node.js/22" 而不是我们设的 UA，于是 verify 看似通过、实际根本没测到 UA 指纹。
     必须先 delete 掉再赋值（或 Object.defineProperty）。 */
  resetEnv();
  globalThis.navigator = { userAgent: UA };
  globalThis.localStorage = env;
  globalThis.location = { href: "http://127.0.0.1:8787/" };
  globalThis.document = {
    referrer: "",
    readyState: "complete",
    getElementById: function () { return { addEventListener: function () {}, textContent: "" }; },
    addEventListener: function () {}
  };
  const REAL_NOW = Date.now;
  const TS = 1759000000000;
  Date.now = function () { return TS; };          // 固定时间戳，保证可复现
  let LASTREQ = null;
  globalThis.fetch = function (url, init) {       // 假 fetch：只记录不发请求
    LASTREQ = { url: url, method: init && init.method, headers: JSON.parse(JSON.stringify(init && init.headers || {})),
                body: init && init.body };
    return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, stub: true }); } });
  };
  function run(file) {
    const code = fs.readFileSync(file, "utf8");
    try { delete globalThis.__R2PAY__; } catch (e) {}
    LASTREQ = null;
    new Function(code)();
    const A = globalThis.__R2PAY__;
    const sig = A.getSign("/api/pay", TS, JSON.stringify({ amount: "1", ts: TS }));
    A.tokenize("1");
    return { fp: A.envFingerprint(), sig: sig, cfg: JSON.stringify(A.CONFIG), req: LASTREQ };
  }
  const ctl = run(SRC);
  const obf = run(OUT);
  Date.now = REAL_NOW;
  const j = function (o) { return JSON.stringify(o); };
  const same = ctl.fp === obf.fp && ctl.sig === obf.sig && ctl.cfg === obf.cfg
             && j(ctl.req) === j(obf.req);
  console.log("  src : " + ctl.fp + "  " + ctl.sig);
  console.log("  obf : " + obf.fp + "  " + obf.sig);
  console.log("  CONFIG : " + ctl.cfg);
  /* 环境 shim 自检：指纹里的 UA 段必须等于我们设的 UA（本文件顶部 UA 常量）。
     如果出现 10/78，说明 navigator 被 Node 内置只读 getter 顶掉了，本次 verify 是空跑。 */
  const EXPECT_FP = "r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|" + UA.length + "|" + String(UA.charCodeAt(0));
  if (ctl.fp !== EXPECT_FP) {
    console.error("  !! 环境 shim 没生效：指纹 = " + ctl.fp);
    console.error("     !! 期望          = " + EXPECT_FP);
    console.error("     !! Node 内置 navigator（只读 getter）把 UA 顶掉了，本次 verify 是空跑");
    process.exit(1);
  }
  console.log("  env shim 生效（UA len=" + UA.length + " first=" + UA.charCodeAt(0) + "）");
  console.log("  request: " + j(ctl.req));
  if (j(ctl.req) !== j(obf.req)) {
    console.error("  !! 请求参数不一致");
    console.error("     src: " + j(ctl.req));
    console.error("     obf: " + j(obf.req));
  }
  if (!same) { console.error("!! 语义自校验失败：混淆改变了行为"); process.exit(1); }
  return true;
}

const stat = build();
console.log("[build] 字符串表 " + stat.strings + " 条 / " + stat.slots + " 槽（含诱饵），重命名 " + stat.renamed + " 处");
console.log("[build] 体积 " + stat.srcBytes + " B -> " + stat.outBytes + " B");
if (!process.argv.includes("--no-verify")) {
  console.log("[verify] 语义自校验：");
  verify(stat.entries);
  console.log("[verify] PASS —— 混淆版与源码版签名一致");
  process.exit(0);   // 反调试里的 setTimeout 会挂住事件循环，显式退出
}