# JS 逆向五阶段实战：从混淆 SDK 到服务端签名全链路复现

> 靶场：自建 `r2coin-sdk v2.4.1`（支付签名 SDK，含控制流平坦化 + 字符串数组 + 标识符重命名 + 反调试）
> 目标：不修改、不依赖浏览器，用纯 Node 复刻签名算法并拿到服务端 `200 token granted`
> 难度：★★☆☆☆（JS 逆向入门，重点在「方法」而不是某个具体算法）
> 环境：Windows 11 / Node v22.11.0 / Chrome 153（headless）/ 原生 WebSocket（无需 npm 依赖）

---

## 0x00 为什么自己写靶场，而不是直接找真实站点

直接上真实站点有三个问题：**不能改源码**（没法做对照实验）、**随时会变**（今天能跑明天失效）、**法律风险**。

所以我按真实 Web 签名 SDK 的常见形态手写了一个可控靶场：

| 维度 | 真实站点常见做法 | 本靶场的对应实现 |
|---|---|---|
| 入口 | 页面内联 `<script>` 或打包后的 bundle | `public/app.obf.js`（6.5 KB 混淆产物） |
| 签名输入 | path + ts + nonce + body + 环境指纹 + secret + salt | 同左，6 段 `join("&")` |
| 环境指纹 | `navigator.userAgent` / `localStorage` / `document.referrer` 之类的组合 | 同左，正是补环境最难的地方 |
| 时间窗口 | `ts` ±60s 容差，`nonce = floor(ts/30000)` | 同左 |
| 混淆 | 控制流平坦化、字符串数组、变量重命名、反调试 | 四种全上，且**是自己写的混淆器**产物 |
| 服务端 | 用同一套 secret 复算 | `target/server.js`，Node `crypto` 复刻 |

关键是最后一行：**服务端复算逻辑和客户端是同一份算法**。所以客户端算出什么、服务端就校验什么，一旦我的 Node 复刻算出的签名和浏览器一致并被服务端接受，就同时证明了「算法理解正确」和「环境补齐正确」——这是一个可以自动判定的 pass/fail，而不是"看起来对"。

算法本身不复杂（3 轮 MD5），**难点全在环境指纹**：

```js
function envFingerprint() {
  var ua   = globalScope.navigator.userAgent;
  var sid  = globalScope.localStorage.getItem("sid");
  var href = globalScope.location.href;
  return [CONFIG.keyId, sid, href, ua.length, String(ua.charCodeAt(0) || 0)].join("|");
}
```

注意这里只用 `ua.length` 和 `ua.charCodeAt(0)`，不是整个 UA——这是真实站点常见的"降采样"手法，既省事又让逆向者**不能靠替换 `navigator.userAgent` 字符串绕过**（因为长度和首字符没变的话签名不变，变了的话签名就对不上）。

---

## 0x01 五个阶段：先定方法论，再动手

踩过最大的坑是「一上来就开调」。我的顺序是固定的五步，每一步都有明确的产出物：

```
Observe  → 静态通读 + 自校验，先搞清楚"它是什么"
Capture  → 用 hook 抓真实请求，拿到 ground truth
Rebuild  → 脱离浏览器，用任意语言重写算法并复算抓包请求
Patch    → 想直接在 Node 里跑混淆代码时，用 first-divergence 法补环境
DeepDive → 反混淆 / 自己写混淆器，理解构造而不是只会读
```

**先说一个反直觉的结论：Rebuild 通常比 Patch 更快。**
很多人一上来就在 Node 里 `vm` 个沙箱去补环境，补到第三个 `document.getElementById` 就开始怀疑人生。但如果你的目标只是"能发请求"，那丢掉浏览器、用任何语言重写算法往往半小时就完事；补环境只在**必须复用一大坨现有代码**（比如几百 KB 的 bundle）时才划算。

本文 0x04 走 Rebuild，0x05 走 Patch，两条路的产出物都在仓库里，可以直接对比成本。

---

## 0x02 阶段一 Observe：先读代码，别急着跑

### 2.1 读混淆前的源码（这是练习，不是考试）

靶场的 `target/src/app.src.js` 是混淆**前**的源码，注释齐全。真实场景没有这个，但**读法是一样的**：忽略噪音，找"输入 → 输出"的主干。

```js
function getSign(path, ts, body) {
  var nonce = Math.floor(ts / 30000);
  var acc = [path, String(ts), String(nonce), body,
             envFingerprint(), CONFIG.secret, CONFIG.salt].join("&");
  for (var r = 0; r < CONFIG.rounds; r++) acc = MD5(acc + CONFIG.secret);
  return acc;
}
```

三十秒就能读完：签名 = `MD5^3( 六段拼接 + secret )`，十六进制小写。真正要花时间的是 `MD5` 和 `envFingerprint`。

### 2.2 MD5 自研 + 自测（关键教训：先验证基础件）

我最初的写法是自己撸了一个 MD5，结果死活对不上。后来老老实实换了标准实现并写了 marker 抽取式自测：

```bash
node target/md5_check.js
```
```
PASS len=  0 mine=d41d8cd98f00b204e9800998ecf8427e ref=d41d8cd98f00b204e9800998ecf8427e
PASS len=  1 mine=0cc175b9c0f1b6a831c399e269772661 ref=0cc175b9c0f1b6a831c399e269772661
PASS len=  3 mine=900150983cd24fb0d6963f7d28e17f72 ref=900150983cd24fb0d6963f7d28e17f72
PASS len= 14 mine=f96b697d7cb7938d525a2f31aaf161d0 ref=f96b697d7cb7938d525a2f31aaf161d0
PASS len= 26 mine=c3fcd3d76192e4007dfb496cca67e13b ref=c3fcd3d76192e4007dfb496cca67e13b
PASS len= 62 mine=d174ab98d277d9f5a5611c2c9f419d9f ref=d174ab98d277d9f5a5611c2c9f419d9f
PASS len=108 mine=1381d407034426f893fd19701f2a91a7 ref=1381d407034426f893fd19701f2a91a7
PASS len=  4 mine=089b4943ea034acfa445d050c7913e55 ref=089b4943ea034acfa445d050c7913e55
PASS len= 75 mine=83ad2d47c7e772ed014179b59616181d ref=83ad2d47c7e772ed014179b59616181d
MD5 SELF-TEST PASSED
```

（`ref` 列来自 Node 内置 `crypto`，所以这个测试是**拿权威实现当标尺**。仓库里另有一个 `target/test_md5.js`，`ref` 直接写死在用例里，适合没有 crypto 的场景。）

**这一条的性价比高到离谱**：如果基础哈希函数是错的，后面所有调试都是在错误的地基上盖楼。9 个用例里特意包含了空串、单字节、刚好跨 padding 边界的长度（55/56/64）和中文（UTF-8 多字节），都是从 MD5 常见实现错误里挑出来的杀手用例。

踩过的具体坑（`test_md5.js` 就是为这些写的）：
- UTF-8 必须先转：`unescape(encodeURIComponent(s))`，直接 `charCodeAt` 中文必错；
- padding 是 `append 0x80` 再补 `0x00` 到 `len%64===56`，最后 8 字节放**小端**位长度；
- `K[i] = floor(abs(sin(i+1)) * 2^32)` 可以运行时算，不必手抄 64 个常量（少一个抄错的机会）；
- 输出是小端 hex32：`hex32(a)+hex32(b)+hex32(c)+hex32(d)`。

真实项目里同理：**先把算法基础件独立测通，再谈逆向结论。**

---

## 0x03 阶段二 Capture：先拿到 ground truth，再谈算法

**原则：先抓到浏览器真实发出的请求，再动手分析。** 没有 ground truth，你所有的"复刻"都是在猜。

### 3.1 为什么用 CDP 而不是 Fiddler/Charles

Fiddler 看 HTTPS 要装证书、看 body 要解密，而且**拿不到调用栈**。CDP（Chrome DevTools Protocol）直接在进程内 hook `fetch` / `XMLHttpRequest`，头、体、调用栈全都有，还能自动点击、截图、归档。Node 22 自带全局 `WebSocket`，**零 npm 依赖**。

```js
// harness/cdp.js 的核心：注入 hook（源码在 harness/hook.js，抽出来方便单测）
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
```

hook 本体只做一件事——包一层，把参数原样记下来：

```js
(function () {
  var R = (window.__CAPTURED__ = window.__CAPTURED__ || []);
  function rec(o) { o.t = Date.now(); o.ua = navigator.userAgent; o.href = location.href;
                    o.stack = new Error().stack; R.push(o); return o; }
  var of = window.fetch;
  window.fetch = function (u, init) {
    var o = rec({ kind: "fetch", url: String(u), method: (init && init.method) || "GET",
                  headers: (init && init.headers) || {}, body: (init && init.body) || "" });
    return of.apply(this, arguments);
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__h = {}; this.__m = m; this.__u = String(u); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this.__h[k] = v; return os.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    rec({ kind: "xhr", method: this.__m, url: this.__u, headers: this.__h, body: b });
    return XMLHttpRequest.prototype.send;   // 记录后放行
  };
})();
```

> 注意 `new Error().stack` 一定要留。后面 DeepDive 阶段，**它就是定位"签名在混淆产物第几行"的唯一线索**。

### 3.2 完整运行

```bash
node harness/cdp.js
```

```
[server] http://127.0.0.1:8787  (static: public/   api: POST /api/pay)
[cdp] browser: Chrome/153.0.8010.53
[cdp] hook 已注入（fetch / XMLHttpRequest 均被包裹）
[cdp] navigate -> {"frameId":"22C0472A57FEADBAB3051A9A5ADD7DF0",...}  url=http://127.0.0.1:8787/?nodbg=1
[cdp] readyState=complete  events=Runtime.executionContextCreated,...,Page.loadEventFired,...
[page] __R2PAY__ keys      -> getSign,tokenize,envFingerprint,CONFIG
[page] localStorage.sid    -> lab-sid-2026
[page] navigator.userAgent -> Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...
[page] #result -> {"ok":true,"orderId":"R2C1790590235583","amount":"1","serverTs":1790590235587,"note":"token granted"}
[!!] 抓到签名请求：
     url    = /api/pay
     method = POST
     headers= {"Content-Type":"application/json","x-key":"r2c-4f8a","x-sign":"ce4d8d008a378ce7f0061b5e56318a9b","x-ts":"1790590235583"}
     body   = {"amount":"1","ts":1790590235583}
     stack  = ... at _0x3b77 (http://127.0.0.1:8787/app.obf.js:6:4169)
             at HTMLButtonElement.<anonymous> (http://127.0.0.1:8787/app.obf.js:6:4556)
[cdp] 截图 -> evidence/page.png
```

`evidence/capture.json` 里落盘的是完整结构（页面 URL / UA / sid / referrer / 全部请求 / 控制台日志），`0x04` 直接读它。

### 3.3 三个只有踩过才知道的 CDP 坑

| 坑 | 现象 | 解法 |
|---|---|---|
| 只等 `Page.loadEventFired` | 事件数组里有 load 但页面脚本还没执行完，读到空 #result | 轮询 `document.readyState==="complete"` **且** 事件数组里出现该事件，双条件 |
| `/json/list` 返回 4 个 target | 连到 `browser_ui` 或 `background_page`，evaluate 全部返回 null | 过滤 `t.type === "page"` |
| `--headless=new` 下多次注入 | 第二次 hook 把第一次的也包住，重复记录 | `addScriptToEvaluateOnNewDocument` 只调一次；进函数先 `window.__CAPTURED__ \|\|` 判空 |

**先把 `cdp.events.map(e=>e.method)` 打出来**，这四行调试信息帮我省了半小时。

### 3.4 反调试的两个开关

混淆产物第 2 行就是：

```js
(function(){try{var q=String((typeof location!=="undefined"&&location.search)||"");
if(q.indexOf("nodbg=1")<0){(function w(){debugger;setTimeout(w,8000);})();}}catch(e){}})();
```

也就是 8 秒一次的 `debugger` 空转。对付它有两个正交手段，harness 里都用了：

1. **URL 开关**：`cdp.js` 默认自动给页面 URL 追加 `?nodbg=1`，`--debug` 可显式关掉它、保留反调试（方便验证 hook 在反调试下依然稳）。
2. **CDP 开关**：`Debugger.setSkipAllPauses({skip:true})`——DevTools 协议层面让断点不暂停，**导航后要再补一次**（`executionContextsCleared` 之后设置会失效）。

这也印证了一个常见设计：真实 obfuscator 产物几乎都会留一个"自检/关闭调试"的口子（UA 检测、`nodbg` 参数、只在天内的某个时间窗生效），逆向时优先找这个开关，不要硬刚。

---

## 0x04 阶段三 Rebuild：丢掉浏览器，用 Node 重演算法

`solve/sign.js` 是这个阶段的产物：**不 import 任何混淆代码**，只用内置 `crypto` 从零写一遍算法。

### 4.1 为什么"不 import"很重要

直接 `require` 混淆产物再调 `getSign`，看似捷径，实际上：
- 你必须先有环境（`navigator` / `localStorage` / `location` 全得补），否则连加载都过不去；
- 你会被产物的控制流平坦化绑死，算法里任何一个小改动（多一次 MD5、换个拼接符）都要重新逆向；
- **没法交叉验证**——用同一份错误的代码既当"客户端"又当"复刻"，错了也发现不了。

重写一遍反而能验证理解：如果我的 `x-sign` 和浏览器一致，说明拼接顺序、字段、轮数、指纹算法**全都对**。

### 4.2 核心只有二十行

```js
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

function envFingerprint(ua, href) {
  return [KEY_ID, SID, href, ua.length, String(ua.charCodeAt(0) || 0)].join("|");
}
function getSign(ts, body, ua, href) {
  const nonce = Math.floor(ts / 30000);
  let acc = [ENDPOINT, String(ts), String(nonce), body, envFingerprint(ua, href), SECRET, SALT].join("&");
  for (let r = 0; r < ROUNDS; r++) acc = md5(acc + SECRET);
  return acc;
}
```

注意签名输入是 **7 段** `join("&")`（path / ts / nonce / body / fingerprint / secret / salt），指纹本身又是 5 段 `join("|")`。这种"两层分隔符"是真实站点常见做法，**抄错一个分隔符全盘皆错**——所以 0x02 的 MD5 自测和这里的字段比对必须都做。

### 4.3 复算抓包：把"看起来对"变成"可判定的对"

```js
const capReq = cap.requests.find(r => r.kind === "fetch" && r.url.indexOf("/api/pay") >= 0);
const mine   = getSign(ts0, capReq.body, UA, href0);
const theirs = capReq.headers["x-sign"];     // 浏览器真实发出的值
console.log(ok0 ? "MATCH  [OK] 算法重演正确" : "MISMATCH [X] 算法重演有偏差");
```

**这一步是整个流程的锚点。** 它不依赖服务端、不依赖时间窗、可以离线反复跑，出问题能立刻二分定位是算法错还是环境错。

### 4.4 实网请求：两个必须补的头

```bash
node solve/sign.js
```

```
[env] ua.len=119  href=http://127.0.0.1:8787/  sid=lab-sid-2026
[env] fingerprint = r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|119|77

[verify] 复算抓包请求（ts=1790590235583, href=http://127.0.0.1:8787/?nodbg=1）
         browser x-sign = ce4d8d008a378ce7f0061b5e56318a9b
         rebuilt  x-sign = ce4d8d008a378ce7f0061b5e56318a9b
         => MATCH  [OK] 算法重演正确

[live] POST http://127.0.0.1:8787/api/pay
       body={"amount":"1","ts":1790590239250}
       x-sign=ec83aac4e6e955fece9b7bc8b61c0ec6
       HTTP 200  {"ok":true,"orderId":"R2C1790590239250","amount":"1","serverTs":1790590240323,"note":"token granted"}
[live] 200 -- 签名被服务端接受 [OK]

===== RESULT: PASS =====
```

这里有个关键细节：**`Referer` 和 `User-Agent` 必须显式带上**。Node 默认 `User-Agent: Node.js/22.11.0`（长度 21、首字符 `N`），`Referer` 默认不发，而签名里绑了 `ua.length` 和 `ua.charCodeAt(0)`，服务端又从 `Referer` 头取 `href`。两个头任何一个不对，指纹就崩 → 401。

正所谓：**补环境补到最后，补的是"服务端能看到什么"，而不是"浏览器里有什么"。** 有些值页面 JS 根本读不到（比如服务端坚持用 `Referer` 而不是 `document.referrer`），必须站在服务端视角对齐。

`solve/sign.js` 内置了"连不上就自动 `spawn target/server.js`"的逻辑，所以这个目录可以脱离 harness 独立复现；`--amount`、`--ts`、`--base` 三个参数让它可以进 CI 当回归测试。

---

## 0x05 阶段四 Patch：first-divergence 法补环境

### 5.1 方法：不要猜，让报错告诉你缺什么

补环境最常见死法是"凭经验把 `window`/`document`/`navigator` 全糊上去"，糊了 200 行还是不跑。正确做法是 **first-divergence（首个分歧点）**：

> 一次只补**当前报错所说的那一个**最小单元，然后重跑。重复。

好处是：每一轮都有明确产出，补丁数量是最小集，而且你能**证明**哪些是必需的、哪些不是。

`target/probe.js` 就是这个方法的固化产物：

```js
function freshLoad() { return new Function(code + ";return globalThis.__R2PAY__;")(); }
function reset() {                       // 每轮从"零补丁"重新来，保证最小集成立
  for (const k of ["navigator","localStorage","document","location"]) {
    try { delete globalThis[k]; } catch (e) { globalThis[k] = undefined; }
  }
}
```

### 5.2 四轮实录

```bash
node target/probe.js
```

```
=== round 0 : 零补丁（基线） ===
  FAIL envFingerprint() -> TypeError: Cannot read properties of undefined (reading 'userAgent')
  FAIL getSign('/api/pay', 1759000000000, body) -> TypeError: Cannot read properties of undefined (reading 'userAgent')
=== patch 1 : navigator.userAgent ===
  FAIL envFingerprint() -> TypeError: Cannot read properties of undefined (reading 'getItem')
=== patch 2 : + localStorage.getItem ===
  FAIL envFingerprint() -> TypeError: Cannot read properties of undefined (reading 'href')
=== patch 3 : + location.href ===
  FINGERPRINT = r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|101|77
  OK   getSign('/api/pay', 1759000000000, body) -> a0cf7ae04e2cc439af551a3b735da6f8
=== 对照: 第 4 次补的 window/document.getElementById 不是签名必需 ===
  (boot 仅在浏览器端执行，Node 端不影响签名结果)
```

三个补丁，全部来自报错原文。**最后一轮是刻意的反向验证**：`document.getElementById` 那类"看着必须补"的东西，其实只服务于 `boot()` 的 DOM 事件绑定，对签名毫无贡献。补环境的方向不是"补全"，是"补到目标函数能跑完"。

### 5.3 最大的坑：补丁挂哪儿（`globalThis` vs 自己造的沙箱）

源码 IIFE 的尾巴是：

```js
})(typeof window !== "undefined" ? window : globalThis);
```

Node 里没有 `window` → `globalScope` **绑到真正的 `globalThis`**。所以补丁必须挂在 `globalThis` 上：

```js
globalThis.navigator    = { userAgent: UA };
globalThis.localStorage = { getItem: k => (k === "sid" ? "lab-sid-2026" : null) };
globalThis.location     = { href: "http://127.0.0.1:8787/" };
```

我一开始把对象传进 `new Function("sandbox", code)` 的形参，然后 `sandbox.navigator = ...`，**完全无效**——因为代码里写死的 `globalThis` 根本不经过形参。这种"绑错宿主"的失败完全没有报错信息，只会得到 `undefined`，非常难查。

另外两个小坑：
- Node 22 起 `globalThis.navigator` 已存在（自带 `userAgent: "Node.js/22"`），所以**不能靠 `typeof navigator === "undefined"` 判断要不要补**，要直接覆盖；
- `delete globalThis.x` 对某些内置属性不一定生效，所以 `reset()` 里 `delete` 失败要退化成赋 `undefined`。

### 5.4 这套机制真的在保护签名吗？——负面对照

光看到 200 不够，还要证明**改一个参数就一定失败**（否则可能是服务端根本没校验）。`target/negative.js` 打了四条：

```bash
node target/negative.js
```

```
[t1] bad sign      -> 401 签名校验失败          # 全零签名，服务端认了签名格式但算不对
[t2] sign(ua=node) -> 200 token granted       # 客户端用 node UA 签名 + 请求也带 node UA
[t3] sign(ua=chrome)-> 401 签名校验失败         # 客户端用 chrome 的 UA 签名，但请求带 node UA
[t4] stale ts       -> 401 x-ts 超出容差窗口    # ts 倒退 600s，超出 ±60s 容差
```

`t2` 和 `t3` 是关键：**同样是 UA 不一致，只是方向反一反，200 就变 401**。这直接证明 `envFingerprint` 把 UA 绑死在了签名里，而不是服务端"差不多就放过"。

同时 `t4` 暴露出另一个真实站点常见点：**时间窗 ±60s**。抓包复刻时如果用了抓包里的旧 `ts`，实网请求必然失败——所以 `sign.js` 实网时一定用 `Date.now()` 重新生成，只在 `--verify` 复算时用旧的。

---

## 0x06 阶段五 DeepDive：自己写混淆器，理解构造而不是只会读

到 0x04 为止，这个 SDK 已经被完全攻破了。但"能读"和"能造"之间还有一层——**很多混淆手法没亲手写过，读的时候会直接漏掉**。所以我给靶场配了混淆器 `target/build.js`，六个阶段：

```
阶段1 控制流平坦化    getSign → while(true) + switch(state)
阶段2 注释/空白清理   可读性归零，体积变化不大
阶段3 字符串抽表      string-array + XOR 0x37 + 索引位移
阶段4 标识符重命名    → _0x????
阶段5 反调试         ?nodbg=1 可关
阶段6 语义自校验     源码版 vs 混淆版，同一套环境跑，签名必须一致
```

### 6.1 四板斧的具体形态

**① 控制流平坦化。** `getSign` 被换成状态机，`case` 标签是 `0x5b/0x2c/0x6d/0x1e/0x77/0x0b` 这种无意义的十六进制，执行顺序要手工跟：

```js
function getSign(path, ts, body) {
  var st = 0x5b, out = null, acc = "", r = 0, nonce = 0;
  while (true) {
    switch (st) {
      case 0x5b: nonce = Math.floor(ts / 30000); st = 0x2c; break;
      case 0x2c: acc = [path, String(ts), String(nonce), body, envFingerprint(), CONFIG.secret, CONFIG.salt].join("&"); st = 0x6d; break;
      ...
```

**对付它的办法很土但有效**：不要试图静态读，用 0x03 的 hook 或一个 stub 环境直接跑，看 `out`。

**② 字符串抽表。** 所有字符串进一个数组，值做 `XOR 0x37` 十六进制编码，取值要走一次下标位移：

```js
var _0x0f1e = ["\x12\x1e...", ...];                      // 29 槽，其中 4 个是诱饵
function _0x2a3b(i){
  var s = _0x0f1e[(i*3+5)%29], r = "", j = 0;
  for(; j<s.length; j++) r += String.fromCharCode(s.charCodeAt(j)^0x37);
  return r;
}
```

三个细节值得学：`N` 故意选成与 3 互素的数（`while(n%3===0) n++`）保证 `slot(i)` 是单射；空槽填 `__proto__`/`constructor`/`prototype` 这类**诱饵**，让你全文搜索时搜出一堆假的；索引位移让"第 0 个字符串在数组第几位"这种偷懒规律失效。

**结果：产物里全文搜 `md5`、`s3cr3t`、`/api/pay` 一个都搜不到。**

**③ 标识符重命名。** `globalScope/CONFIG/MD5/envFingerprint/getSign/tokenize` 全变 `_0x????`，本场重命名 275 处。

**④ 反调试。** 见 0x03.4。

### 6.2 我自己踩的三个 bug（比混淆本身更值钱）

#### Bug A：harness 无限递归

我把 `cdp.js` 里的 `cdp.evaluate(...)` 批量替换成 `safeEval(cdp, ...)` 时用了：

```js
src.replace(/await cdp\.evaluate\(/g, "await safeEval(cdp, ")
```

结果把 `safeEval` **函数体内部**的 `await cdp.evaluate(expr)` 也替换了，变成 `safeEval` 调自己 → 所有 `Runtime.evaluate` 都返回 `Maximum call stack size exceeded`。

**现象极具误导性**：看起来像页面挂了、hook 没注入、Chrome 起不来，实际是 harness 自己递归爆栈。教训：**批量字符串替换前，先确认被替换文本不会出现在替换结果里。** 最后改成只保留一处 `evaluate`、其余显式写 `safeEval`。

#### Bug B：混淆器把对象字面量 key 也改了

最早的 rename 是无脑全局替换：

```js
flat = flat.replace(new RegExp("\\b" + from + "\\b", "g"), to);   // ← 错
```

于是 `{amount: amount, ts: ts}` 变成 `{_0xbccb: _0xbccb, _0x6776: _0x6776}` → **请求体字段名被改** → 服务端 `JSON.parse` 拿不到 `amount` → 直接 `bad json`。

正确的上下文判断（`build.js` 的 `renameCtx`）：

```js
function renameCtx(str, off, len) {
  let i = off - 1; while (i >= 0 && /\s/.test(str[i])) i--;
  const prev = i >= 0 ? str[i] : "";
  if (prev === ".") return false;                       // 成员访问 obj.name 不动
  let j = off + len; while (j < str.length && /\s/.test(str[j])) j++;
  const next = j < str.length ? str[j] : "";
  if ((prev === "{" || prev === ",") && next === ":") return false;   // 对象字面量 key
  return true;
}
```

这里的试错过程（三条都试过，全错）比结论更有价值：

| 判断规则 | 漏掉了什么 |
|---|---|
| `next === ":"` | 三目冒号分支里的变量：`cond ? a : h` 的 `h`，`prev` 是运算符不是 `{`/`,` |
| `(prev==="{"\|\|prev===",") && (next===":"\|\|next==="}"\|\|next===",")` | **函数形参** `function(path, ts, body)`——`path` 后面跟 `,`，直接被跳过不重命名 |
| 只看 `prev === "."` | 完全不解决对象 key 问题 |

必须 `prev ∈ {` 前是 { 或 ,}` **且** `next === ":"` 两个条件同时成立。正确形态下的产物：

```js
_0x7887: {amount: amount, ts: ts}      // key 保留，只改值侧的变量
```

#### Bug C：指纹取值两端不一致（这个坑真实站点一模一样）

页面用 `document.referrer`，服务端用 HTTP `Referer` 头。**直接导航时 `document.referrer` 是空串**，而 `fetch("/api/pay")` 会让浏览器把 `Referer` 自动填成当前页 URL。于是客户端算指纹用 `""`，服务端用 `"http://127.0.0.1:8787/?nodbg=1"`，**永远对不上，而且两边都不报错**——最坑的一类 bug。

修法是把页面侧也改成 `globalScope.location.href`，让两端取同一个值。这也是为什么 0x04 强调"要站在服务端视角补环境"。

#### Bug D：verify 自己的环境 shim 静默失效（Node 22 navigator 只读 getter）

修完 Bug B 之后我盯着 build 输出看了很久才发现：指纹段打的是 `|10|78`。10 长度、首字符 78（`N`）——那是 **`Node.js/22`**，根本不是我在 verify 里设的 Chrome UA（应该是 `|101|77`）。

原因是：

`js
> Object.getOwnPropertyDescriptor(globalThis, "navigator")
{ get: [Function], set: undefined, configurable: true, enumerable: true }
`

Node 21+ 自带 `globalThis.navigator`，而且**只有 getter、没有 setter**。在非严格模式下给这种属性赋值**不会抛错，只会静默失败**：

`js
globalThis.navigator = { userAgent: "FAKE-UA-XXX" };
console.log(globalThis.navigator.userAgent);   // -> "Node.js/22"   赋值被无声吞掉
`

后果很严重：`verify()` 里 src 和 obf 两边拿到的是同一个错值（Node 的 UA），所以**照样 PASS**，但它测的根本不是 UA 指纹这条路径——一个"假绿"。

修法两行：先 `delete` 再赋值，并加一条硬断言，指纹不对就 `exit(1)`：

`js
function resetEnv() {
  for (const k of ["navigator","localStorage","location","document","fetch","__R2PAY__"])
    { try { delete globalThis[k]; } catch (e) { globalThis[k] = undefined; } }
}
resetEnv();                                   // ← 必须先删
globalThis.navigator = { userAgent: UA };
...
const EXPECT_FP = "r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|" + UA.length + "|" + UA.charCodeAt(0);
if (ctl.fp !== EXPECT_FP) { console.error("!! 环境 shim 没生效，本次 verify 是空跑"); process.exit(1); }
`

**修完之后的输出反而成了最有力的一组交叉验证**：指纹变成 `|101|77`、签名 `a0cf7ae04e2cc439af551a3b735da6f8`——和 0x05 里 `probe.js` 第三轮打出来的 `a0cf7ae04e2cc439af551a3b735da6f8` **一模一样**。两条完全独立的代码路径（build.js 的 verify 和 probe.js 的 first-divergence）算出同一个值，这才是"算法理解正确"的硬证据。修之前那个 `f66e...` 谁都不匹配。

> **普适教训：任何自校验，都要先校验"校验器自己有没有生效"。** 只比"两边相等"是不够的，相等不代表对；要有一个外部已知值（ground truth）做锚。

### 6.3 加强版 `verify()`：为什么它值得单独一节

我原本的 verify 只比对 `getSign` 的返回值。它**放过了 Bug B**——签名函数本身没被破坏，坏掉的是请求体字段名。所以 verify 被加强成：

```js
globalThis.fetch = function (url, init) {        // stub 掉，只记录不发请求
  LASTREQ = { url: url, method: init && init.method,
              headers: JSON.parse(JSON.stringify(init && init.headers || {})),
              body: init && init.body };
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, stub: true }) });
};
Date.now = function () { return 1759000000000; };  // 固定时间戳，保证可复现
// 然后逐字段比对 fingerprint / sign / CONFIG / 整个 request 对象
const same = ctl.fp === obf.fp && ctl.sig === obf.sig && ctl.cfg === obf.cfg
           && j(ctl.req) === j(obf.req);
```

**从"比一个字符串"变成"比整条出网请求"**，Bug B 立刻现形。另一个隐含收益：`Date.now` 和 `fetch` 都被 stub 之后，verify 完全离线、完全可复现，可以直接当 CI 门禁。

改完之后 build 的输出：

```
[build] 字符串表 25 条 / 29 槽（含诱饵），重命名 275 处
[build] 体积 6495 B -> 6518 B
[verify] 语义自校验：
  src : r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|101|77  a0cf7ae04e2cc439af551a3b735da6f8
  obf : r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|101|77  a0cf7ae04e2cc439af551a3b735da6f8
  CONFIG : {"endpoint":"/api/pay","keyId":"r2c-4f8a","secret":"s3cr3t-of-r2c0in","rounds":3,"salt":"l4b-salt-2026"}
  env shim 生效（UA len=101 first=77）
  request: {"url":"/api/pay","method":"POST","headers":{"Content-Type":"application/json","x-key":"r2c-4f8a","x-sign":"a0cf7ae04e2cc439af551a3b735da6f8","x-ts":"1759000000000"},"body":"{\"amount\":\"1\",\"ts\":1759000000000}"}
[verify] PASS —— 混淆版与源码版签名一致
```

**注意体积几乎没变（6495 → 6518）。** 字符串抽表 + 重命名省下的空间，被 `string-array` 数组本体和解码函数吃掉了——真实 obfuscator 也一样，"混淆必涨体积"只在语义多的时候成立。这也说明**别用"体积变小了"当反混淆成功的指标**。

### 6.4 混淆产物长什么样

混淆后 `public/app.obf.js` 开头三行（6518 B 全文）：

```js
/*! r2coin-sdk v2.4.1 | built 2026-09-28 | generated by build.js, DO NOT EDIT */
(function(){try{var q=String((typeof location!=="undefined"&&location.search)||"");if(q.indexOf("nodbg=1")<0){(function w(){debugger;setTimeout(w,8000);})();}}catch(e){}})();
(function (_0x1a2b) {
```

配置区变成了这样——**明文全没了**：

```js
var _0x0f1e=[ "\x12\x1e...", ... ];                          // 29 槽字符串表，含 4 个诱饵
function _0x2a3b(i){var s=_0x0f1e[(i*3+5)%29],r="",j=0;for(;j<s.length;j++)r+=String.fromCharCode(s.charCodeAt(j)^0x37);return r;}
var _0x2c1a = {endpoint: _0x2a3b(0), keyId: _0x2c1a(1), secret: _0x2a3b(2), rounds: _0x2a3b(3), salt: _0x2a3b(4)};
```

在它上面 `grep` 一遍就知道手感：

| 搜什么 | 结果 |
|---|---|
| `md5` / `MD5` | 0 处（`_0x4d5b(...)`） |
| `s3cr3t` / `secret` | 0 处（进 string-array 且 XOR 过） |
| `/api/pay` | 0 处 |
| `navigator` / `localStorage` | 0 处 |
| `getSign` | 0 处（`_0x9a02`，导出对象里才还原，见 `build.js` 的 `__R2PAY__` key 还原规则） |

这时候 0x03 的 hook 价值就体现出来了：**既然静态读不动，就不要跟它耗**，直接把运行时的输入输出抓出来。hook 抓到的 stack `at _0x3b77 (.../app.obf.js:6:4169)` 也直接告诉你——真正干活的是 `tokenize`（被重命名成 `_0x3b77`），一路往上就是 `getSign`。

> 顺带一个工程习惯：`grep` 混淆产物这种活，**别在 PowerShell 里用 `node -e`**，引号会被吞。写成一次性脚本（`target/md5_check.js` 就是这模式），既能读文件又能跑用例。


---

## 0x08 小结：这个练习真正教会我的三件事

1. **先自测基础件，再谈逆向结论。** 一个错的 MD5 能让你把后面所有时间都烧在错的地基上，而它 30 秒就能测出来。

2. **Rebuild 通常比 Patch 便宜。** 目标是"能发请求"时，重写算法半小时；补环境补到第三个 DOM API 就开始怀疑人生。补环境只在必须复用一大坨现有代码时才划算。

3. **端到端的 pass/fail 比"看起来对"重要。** 这篇里每个结论都有可自动判定的证据：MD5 用例、`verify()` 逐字段比对、`sign.js` 的 `MATCH` + 服务端 200、`negative.js` 的负面对照。**能写进 CI 的结论才是结论。**

下一步见同目录 `Writeup-03`：把补环境这件事单独展开讲，重点在 first-divergence 法怎么应对更复杂的站点。
