#!/usr/bin/env node
/* ============================================================================
 * run-all.js —— 一条命令跑完整套实验，全绿才退出 0
 *
 *   node run-all.js              # 依次跑 5 个阶段，任一步失败立刻停
 *   node run-all.js --no-live    # 跳过起 Chrome 的环节（CI 无 GUI 时用）
 *
 * 退出码 0 = 全部通过，可直接当 CI 门禁。
 * ==========================================================================*/
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = __dirname;
const NO_LIVE = process.argv.indexOf("--no-live") >= 0;

const STEPS = [
  { name: "0 MD5 基础件自测",      cmd: ["target/md5_check.js"] },
  { name: "1 混淆构建 + 语义自校验", cmd: ["target/build.js"] },
  { name: "2 CDP 抓包（ground truth）", cmd: ["harness/cdp.js"], live: true },
  { name: "3 Rebuild 复刻 + 实网",   cmd: ["solve/sign.js"] },
  { name: "4 负面对照（UA/时间窗绑定）", cmd: ["target/negative.js"] },
].filter(s => !s.live || !NO_LIVE);

let fail = 0;
for (const s of STEPS) {
  console.log("\n============================================================");
  console.log(">>> " + s.name + "   (node " + s.cmd.join(" ") + ")");
  console.log("============================================================");
  const r = spawnSync(process.execPath, s.cmd, { cwd: ROOT, stdio: "inherit", shell: false });
  const ok = !r.error && r.status === 0;
  console.log("<<< " + (ok ? "PASS" : "FAIL") + "  " + s.name);
  if (!ok) { fail++; console.error("!! 中断：上一步失败"); break; }
}

console.log("\n============================================================");
console.log(fail === 0 ? "ALL PASS (" + STEPS.length + "/" + STEPS.length + ")" : "FAILED");
console.log("============================================================");
process.exit(fail === 0 ? 0 : 1);