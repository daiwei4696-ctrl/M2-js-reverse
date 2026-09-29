# M2 — JS 逆向 + Node 补环境（r2pay-lab）

自建支付签名 SDK 靶场，**从混淆产物一路打到服务端 200**，全流程可自动判定 pass/fail。

```
┌─────────────┐   hook    ┌──────────────┐   复算一致    ┌──────────────┐
│ headless    │ ────────> │ evidence/    │ ───────────> │ solve/sign.js │
│ Chrome      │ 抓真实请求 │ capture.json │              │ 纯 Node 复刻  │
└─────────────┘           └──────────────┘              └──────┬───────┘
       ^                                                       │ 带对 UA/Referer
       │ 加 ?nodbg=1 关反调试                                   v
┌─────────────┐            ┌──────────────┐            ┌──────────────┐
│ build.js    │ ──混淆──> │ app.obf.js   │ ──验签──> │ 200 token    │
│ 六阶段混淆器│  自校验    │ (6.5 KB)     │   recv==calc│  granted     │
└─────────────┘           └──────────────┘            └──────────────┘
```

## 快速开始

要求：Node >= 18（用的是 Node 22 原生全局 `WebSocket`，**零 npm 依赖**）、Chrome。

```bash
node run-all.js            # 一键跑完 5 步，全绿退出 0（可直接进 CI）
node run-all.js --no-live  # 跳过起 Chrome 的环节
```

分步跑（每步都有明确的判定标准）：

```bash
node target/md5_check.js   # ① MD5 基础件自测（9 个 killer 用例）        -> MD5 SELF-TEST PASSED
node target/build.js       # ② 六阶段混淆 + 语义自校验                     -> [verify] PASS
node harness/cdp.js        # ③ 起 Chrome + 注入 hook，抓真实签名请求        -> 抓到 x-sign
node solve/sign.js         # ④ Rebuild 复刻 + 实网请求                     -> RESULT: PASS
node target/negative.js    # ⑤ 负面对照：证明签名真绑死了 UA 和时间窗       -> t1/t3/t4 全 401
```

退出码约定：**0 = 通过，1 = 失败**（`run-all.js` / `build.js` / `sign.js` 都遵守）。

## 目录

```
M2-js-reverse/
├── run-all.js                 # 一键跑完整套实验
├── README.md
├── harness/
│   ├── cdp.js                 # CDP harness：起 server + 起 Chrome + 注入 hook + 截图归档
│   └── hook.js                # 注入的 hook 源码（fetch / XHR，含调用栈）
├── target/
│   ├── src/app.src.js         # 可读源码：签名算法 + 环境指纹的真相
│   ├── build.js               # 六阶段混淆器（控制流平坦化/字符串表/重命名/反调试）+ 语义自校验
│   ├── probe.js               # first-divergence 补环境四轮实验
│   ├── md5_check.js           # MD5 marker 抽取式自测（拿 crypto 当标尺）
│   ├── test_md5.js            # MD5 自研实现自测（ref 写死在用例里）
│   ├── negative.js            # 负面对照（bad sign / UA 不一致 / ts 过期）
│   ├── server.js              # 静态托管 + POST /api/pay 验签
│   └── public/
│       ├── index.html
│       └── app.obf.js         # 混淆产物（6.5 KB，四板斧全上）
├── solve/
│   └── sign.js                # Rebuild 产物：纯 Node 复刻 + 复算抓包 + 实网
├── evidence/
│   ├── capture.json           # 抓包全量记录（headers/body/stack/UA/referrer）
│   ├── page.png               # 支付页截图（含 {"ok":true,...,"note":"token granted"}）
│   └── server.log             # 服务端 recv == calc 的验签日志
└── writeup/
    ├── Writeup-02-JS逆向五阶段实战.md                  # 五阶段方法论全记录
    └── Writeup-03-补环境避坑指南-first-divergence.md    # 补环境专项：怎么补、什么时候别补
```

## 被逆向的对象

`r2coin-sdk v2.4.1`，一个支付签名 SDK：

```js
function getSign(path, ts, body) {
  var nonce = Math.floor(ts / 30000);                        // 30 秒一个 nonce
  var acc = [path, String(ts), String(nonce), body,
             envFingerprint(), CONFIG.secret, CONFIG.salt].join("&");
  for (var r = 0; r < CONFIG.rounds; r++) acc = MD5(acc + CONFIG.secret);
  return acc;                                               // 3 轮 MD5，hex 小写
}
function envFingerprint() {
  return [CONFIG.keyId,
          localStorage.getItem("sid"),
          location.href,
          navigator.userAgent.length,
          navigator.userAgent.charCodeAt(0)].join("|");
}
```

注意 `ua` 只取**长度和首字符**（降采样）——想靠替换 `navigator.userAgent` 绕过是没用的，长度或首字符一变，签名就对不上（`target/negative.js` 的 t2/t3 就是证据）。

服务端 `POST /api/pay` 用**同一套算法**复算，`recv === calc` 才返回 200，`x-ts` 超出 ±60s 直接拒。所以"复刻正确"和"环境补齐正确"是同一个可自动判定的信号。

## 五阶段方法论

```
Observe  静态通读 + 基础件自测        产物：算法草图、MD5 自测
Capture  CDP hook 抓真实请求          产物：evidence/capture.json（ground truth）
Rebuild  脱离浏览器重写算法 + 复算    产物：solve/sign.js，MATCH + 实网 200
Patch    first-divergence 法补环境    产物：target/probe.js，最小补丁集
DeepDive 自己写混淆器                 产物：target/build.js + 语义自校验
```

**Rebuild 通常比 Patch 便宜**：目标是"能发请求"时，重写算法半小时，补环境补到第三个 DOM API 就开始怀疑人生。补环境只在必须复用一大坨现有代码时才划算。

细节见 `writeup/` 下两篇。

## 关键结论（可直接抄的坑）

| # | 坑 | 结论 |
|---|---|---|
| 1 | Node 21+ 的 `globalThis.navigator` 是**只读 getter** | 非严格模式下 `globalThis.navigator = {...}` **静默失败**，拿到的是 `"Node.js/22"`。必须先 `delete` 再赋值 |
| 2 | 自校验只比"两边相等"不够 | 相等不代表对。必须有**外部 ground truth** 锚定（verify 里断言期望指纹） |
| 3 | 混淆 rename 无脑全局替换 | 会把对象字面量 key 也换掉 → 请求体字段名错 → 服务端 `bad json`。要判上下文（`prev` 是 `.` 或 `prev∈{,}` 且 `next===":"` 都不动） |
| 4 | `document.referrer` vs `Referer` 头 | 直接导航时前者是空串、后者是页面 URL，两端不一致 → 签名永远对不上。改用 `location.href` 对齐 |
| 5 | 补丁挂错宿主 | 代码里写死 `globalThis`，传进 `new Function` 形参的沙箱对象无效，且**不报错** |
| 6 | 别用体积变化当混淆/反混淆指标 | 混淆后体积几乎不变（6495 → 6518 B），string-array 本体把省下的吃回去了 |
| 7 | 反调试 | URL 加 `?nodbg=1` + `Debugger.setSkipAllPauses`（导航后要再补一次） |

## 证据索引

| 文件 | 内容 |
|---|---|
| `evidence/capture.json` | 页面 UA / sid / referrer / 全部请求（含 `x-sign`、`x-ts`、body、调用栈） |
| `evidence/page.png` | 支付页截图，`#result` = `{"ok":true,...,"note":"token granted"}` |
| `evidence/server.log` | `recv == calc` 的服务端验签日志 |

## 已知边界

- 靶场是**自建的**，混淆器也是自己写的，强度远不如商业 obfuscator（无 VM 保护、无自校验完整性、无 RASP）。目的是**练方法和固化流程**，不是模拟工业级对抗。
- `evidence/` 是一次运行的结果快照，重跑 `harness/cdp.js` 会被覆盖。
- `app.obf.js` 是构建产物，改了 `src/app.src.js` 或 `build.js` 后必须重跑 `node target/build.js`。