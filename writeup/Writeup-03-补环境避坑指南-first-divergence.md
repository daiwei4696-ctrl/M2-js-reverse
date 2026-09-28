# 补环境避坑指南：first-divergence 法

> 配套阅读：`Writeup-02-JS逆向五阶段实战.md` 的 0x05 节。
> 这篇把"在 Node 里跑浏览器代码"这件事单独展开。结论先行：**补环境不是玄学，是可以用报错驱动的确定性流程；而且大部分情况下你根本不需要补。**

---

## 0x00 先做决策：你到底需不需要补环境

| 目标 | 推荐做法 | 成本 |
|---|---|---|
| 能发出签名请求 | **Rebuild**（重写算法） | 分钟级 |
| 读懂算法细节 | Observe + 单点 hook | 分钟级 |
| 必须复用几百 KB 的 bundle / 一大堆工具函数 | **Patch**（补环境直跑） | 小时级，随依赖爆炸 |
| 要"完全还原"验证一致性 | Patch + 交叉比对 | 小时级 |

**为什么要先问这个**：补环境的成本不是线性的，是**阶乘级**的。第一个 `navigator` 一分钟，第二个 `document.cookie` 十分钟，第三个 `document.createElement('canvas').getContext('2d')` 半天，第四个 `XMLHttpRequest` 的 `onreadystatechange` + `window.onload` 时序就能让你想放弃。

所以：**除非"必须跑它的原码"，否则一律优先 Rebuild。** 我这次的结论也一样——`solve/sign.js` 二十行搞定，`target/probe.js` 补了三个属性才跑通同一个函数。

---

## 0x01 first-divergence 法：让报错替你决定补什么

### 1.1 原则

```
1. 零补丁跑一次，记录第一个 TypeError 的 "Cannot read properties of undefined (reading 'X')"
2. 只补报错里那个 X，一个字都不要多补
3. 重跑，回到 1
4. 跑到函数能返回为止 —— 此时的补丁集合就是"最小必要集"
```

关键词是 **first**：只修第一个错，不要凭经验把后面可能缺的一起补上。原因是：
- 补多了你会**不知道哪个补丁真正有用**，最后留一堆垃圾 shim；
- 有些 shim 会把 bug 掩盖掉——比如给 `localStorage` 一个假实现，可能让一段本该报错的代码悄悄返回了错值；
- 最小集才是可复用的资产，换一个目标只改差集。

### 1.2 代码骨架

```js
var code = fs.readFileSync(__dirname + "/src/app.src.js", "utf8");

// 每轮重新加载，保证"最小集"是从零补起来的，而不是在上一轮的残余上堆
function freshLoad() { return new Function(code + ";return globalThis.__R2PAY__;")(); }

function reset() {
  for (var k of ["navigator", "localStorage", "document", "location"]) {
    try { delete globalThis[k]; } catch (e) { globalThis[k] = undefined; }
  }
}
function t(label, fn) {
  try { console.log("  OK   " + label + " -> " + fn()); }
  catch (e) { console.log("  FAIL " + label + " -> " + e.constructor.name + ": " + e.message); }
}
```

两个要点：**`reset()` 必须做**（否则第二轮看到的是第一轮的残留环境，"最小集"结论不成立）；**`freshLoad()` 必须重新 `new Function`**（否则模块级的闭包和缓存变量会串味）。

---

## 0x02 四轮逐条解剖

```
=== round 0 : 零补丁（基线） ===
  FAIL envFingerprint() -> TypeError: Cannot read properties of undefined (reading 'userAgent')
=== patch 1 : navigator.userAgent ===
  FAIL envFingerprint() -> TypeError: Cannot read properties of undefined (reading 'getItem')
=== patch 2 : + localStorage.getItem ===
  FAIL envFingerprint() -> TypeError: Cannot read properties of undefined (reading 'href')
=== patch 3 : + location.href ===
  FINGERPRINT = r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|101|77
  OK   getSign('/api/pay', 1759000000000, body) -> a0cf7ae04e2cc439af551a3b735da6f8
```

**Round 0**：读的是 `globalScope.navigator`。注意这里报的是 `undefined`（`globalScope` 本身在，是 `globalScope.navigator` 不存在）——**分清"对象是 undefined"还是"对象上的属性是 undefined"**，这决定了你要补的对象挂在哪一层。

**Round 1**：报 `getItem`。此时容易犯的错是"补一堆 localStorage 方法"。实际只需要 `getItem` 一个函数（`setItem` / `clear` / `key` / `length` 全是噪音，签名压根不碰）。**"凭经验多补一点"就是从这里开始失控的。**

**Round 2**：报 `href`。这一条信息量最大：它告诉你**原代码用的是 `location.href` 而不是 `document.referrer`**。如果只按"浏览器里 `href` 都在 `document.location` 上"的直觉去补 `document.location.href`，就会错——代码写的是 `location`。

**Round 3**：跑通，指纹 `r2c-4f8a|lab-sid-2026|http://127.0.0.1:8787/|101|77`。五个字段逐个对得上：
- `r2c-4f8a` = CONFIG.keyId
- `lab-sid-2026` = localStorage.getItem("sid")
- `http://127.0.0.1:8787/` = location.href
- `101` = UA 长度
- `77` = `"M"` = UA 首字符

**反证（Round 3.5）**：`document.getElementById` 这种"看着必须补"的东西，其实只服务 `boot()` 里的 DOM 事件绑定，对签名零贡献。不补它，`getSign` 照样出正确结果。**这一条比补上的三条更有价值——它划出了"最小集"的边界。**

---

## 0x03 最大的坑：补丁挂在哪（`globalThis` 绑定）

源码尾巴：

```js
})(typeof window !== "undefined" ? window : globalThis);
```

Node 里没有 `window` → `globalScope` **绑到真正的 `globalThis`**。

所以：

```js
// [正确] 挂 globalThis
globalThis.navigator    = { userAgent: UA };
globalThis.localStorage = { getItem: function (k) { return k === "sid" ? "lab-sid-2026" : null; } };
globalThis.location     = { href: "http://127.0.0.1:8787/" };
```

```js
// [错误] 传进 Function 形参的"沙箱"对象，代码根本看不到
var sandbox = {};
new Function("sandbox", code)(sandbox);
sandbox.navigator = { userAgent: UA };      // ← 代码里写死的是 globalThis，永远 undefined
```

第二种写法**没有任何报错**，只会得到 `undefined`，是补环境里最难查的一类问题。判断方法很简单：**读被加载代码的第一行和最后一行，看它从哪里取全局对象。** 常见四种：

| 代码长什么样 | 挂哪 |
|---|---|
| `(function(){...})(this)` | `this`，Node 里 module 作用域是 `module.exports`，要换方式 |
| `(function(g){...})(window)` | 必须定义 `globalThis.window = globalThis`（**自引用**，不是新对象） |
| `(function(g){...})(globalThis)` | `globalThis`，直接挂 |
| `var _ = window; ... _.localStorage` | 同上，但要确认 `window` 已定义 |

**`globalThis.window = globalThis` 这个自引用几乎总是要写的**，成本一行，能省掉一整类报错。

### 3.1 Node 22 的隐藏陷阱：`navigator` 是只读 getter

```js
Object.getOwnPropertyDescriptor(globalThis, "navigator")
// { get: [Function], set: undefined, configurable: true, enumerable: true }
```

Node 21+ 自带 `globalThis.navigator`，**只有 getter 没有 setter**。于是：

```js
globalThis.navigator = { userAgent: "FAKE-UA-XXX" };
globalThis.navigator.userAgent      // -> "Node.js/22"   赋值被无声吞掉
```

严格模式下会 `TypeError: Cannot set property navigator of #<Object> which has only a getter`，非严格模式下**静默失败**。这就是我在 `build.js` 的 verify 里踩到的 Bug D：verify 看起来 PASS，实际用的是 `"Node.js/22"` 算的指纹（`|10|78`），UA 那条路径根本没被测到。

**唯一可靠的写法是先 `delete`**（该属性 `configurable: true`，删得掉）：

```js
function resetEnv() {
  for (var k of ["navigator","localStorage","location","document","fetch","__R2PAY__"]) {
    try { delete globalThis[k]; } catch (e) { globalThis[k] = undefined; }
  }
}
resetEnv();
globalThis.navigator = { userAgent: UA };    // 这次才真的生效
```

`localStorage` / `location` / `document` 现在倒是可以裸赋值，但**统一走 `resetEnv()` 最安全**——你永远不知道下一个 Node 版本又会内置什么。

---

## 0x04 最小补丁集：这个靶场最终只需要三行

```js
globalThis.navigator    = { userAgent: UA };
globalThis.localStorage = { getItem: function (k) { return k === "sid" ? "lab-sid-2026" : null; } };
globalThis.location     = { href: PAGE_URL };
```

三个原则：

1. **只补被报错点到的那一个。** 别顺手补 `window`、`document`、`screen`、`Date`。
2. **shim 要能参数化。** `UA`/`PAGE_URL` 写死就死了一半，否则你没法做"改 UA 看签名变不变"的对照实验（Writeup-02 的 0x05.4 负面对照全靠它）。
3. **补丁要能被 reset。** 唯一保证"最小集"结论可复现的方式。

对照一个"反面教材"式的写法（社区里常见的补环境脚本）：

```js
// 反面：一次补 200 行，看起来专业，实际没人知道哪行有用
var window = { navigator: {...}, location: {...}, document: {...},
               addEventListener(){}, setTimeout, setInterval, ... };
var document = window.document;
var navigator = window.navigator;
...
```

这种脚本的问题是：**目标代码的任何一个报错都会被这堆 shim 吸收掉**，你既不知道它有没有生效，也没法在换目标时裁剪。用 first-divergence 得到的 3 行，换到下一个靶场通常只差 1~2 行。

---

## 0x05 反调试：先找开关，别硬刚

混淆产物默认带 8 秒一次的 `debugger` 空转。两个正交开关：

| 手段 | 做法 | 备注 |
|---|---|---|
| URL 开关 | 页面 URL 追加 `?nodbg=1` | 我的靶场主动留了这个口，真实 obfuscator 也常有（UA 检测、时间窗、域名白名单） |
| CDP 开关 | `Debugger.setSkipAllPauses({skip:true})` | 不依赖产物配合，**通用** |

CDP 那个有个坑：**`Page.navigate` 之后 `executionContextsCleared` 会清掉设置，必须再补一次**。

反调试的花样通常还有：`Function.prototype.toString` 检测（hook 后 `toString` 返回值变了会暴露）、无限 `while` 烧 CPU、`debugger` 放在 `setInterval` 里难断。应对思路统一是：**先花五分钟找"关闭开关"，找不到再上 `setSkipAllPauses`，最后才考虑静态分析。**

---

## 0x06 从 Patch 平滑过渡到 Rebuild

补环境跑通之后，不要停——**这时候是转 Rebuild 的最佳时机**，因为此时：

- 你已经拿到了 `envFingerprint()` 的真实输出，知道它由哪几个字段拼成；
- 你可以用"假 UA"和"真 UA"各跑一次，**用差分定位每个输入的影响**：
  ```js
  // 改 UA 长度 -> 指纹第 4 段变 -> 确认 UA 以 length 参与
  // 改 localStorage.sid -> 指纹第 2 段变 -> 确认 sid 明文参与
  ```
- 你可以直接打印 `getSign` 的入参 `acc`，把拼接格式直接读出来，不用猜。

换句话说，**Patch 的正确用法是"作为逆向的观测手段"，而不是"最终的发请求方案"**。观测够了就换成 Rebuild，把补丁集整个扔掉。

这一条的实用价值：很多人卡在"补环境补到一半"，是因为把补环境当成了终点。它只是让你**看到**算法的望远镜。

---

## 0x07 检查清单

动手之前，按这个清单过一遍：

- [ ] 读了被加载代码的**最后一行**，确认全局对象怎么拿（`window` / `globalThis` / `this`）
- [ ] 需要时加了 `globalThis.window = globalThis` 自引用
- [ ] 写了 `resetEnv()`，每轮从零开始（含 `delete globalThis.navigator`）
- [ ] `freshLoad()` 每次都重新 `new Function`，不复用闭包
- [ ] 每轮**只修报错里的第一个 `undefined`**，不多补
- [ ] 补丁集是参数化的（UA / URL / sid 都是变量），不是写死的
- [ ] 拿到返回值后，做**差分实验**确认每个输入的参与方式
- [ ] 有负面对照：故意改错一个输入，确认结果会变（证明校验真的存在）
- [ ] 有 ground truth：至少一条"真实浏览器发出的请求"可以对账
- [ ] 问自己一次：**这个函数，我重写是不是比补环境更快？**

最后一条通常是"是"。

---