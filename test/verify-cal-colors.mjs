/**
 * 设置页「日程 / 任务」颜色药丸的真实渲染验证（手动跑）。
 *
 * 为什么必须用真浏览器：这套交互的关键是「点药丸 = 直接点在铺满药丸的透明原生
 * input[type=color] 上」—— jsdom 既不做布局也不算层叠，验不了「点到的到底是谁」。
 * 这里用 elementFromPoint 直接问浏览器：药丸中心的那个点，命中的元素是不是取色输入。
 * 本机无 Edge/Chrome 时跳过。
 *
 * 覆盖：
 *   1. 原来左侧那个独立的日历颜色方块已消失，一行只剩 任务/日程 两个药丸；
 *   2. 药丸底色 = 该日历对应类型的默认色；
 *   3. 浅色底自动配深色字、深色底配白字（对比度不看运气）；
 *   4. 取色输入铺满药丸，药丸中心命中它（点哪儿都弹系统取色器）；
 *   5. 药丸贴在名字输入框右侧，行不溢出、不换行。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-cal-colors");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

/** 一行日历：日程色/待办色故意取一深一浅，用来验文字自动对比 */
const row = (idx, name, todo, event) => `
  <div class="caldav-set-cal" data-idx="${idx}">
    <input type="checkbox" checked/>
    <input class="caldav-input" data-role="name" value="${name}"/>
    <span class="caldav-set-cal-tags">
      <label class="caldav-set-cal-tag" data-role-pill="eventColor"
             style="--tag-color:${event};--tag-fg:${luma(event) > 0.42 ? "#1f2937" : "#ffffff"}">
        <input type="color" data-role="eventColor" value="${event}"/>
        <span>日程</span>
      </label>
      <label class="caldav-set-cal-tag" data-role-pill="todoColor"
             style="--tag-color:${todo};--tag-fg:${luma(todo) > 0.42 ? "#1f2937" : "#ffffff"}">
        <input type="color" data-role="todoColor" value="${todo}"/>
        <span>任务</span>
      </label>
    </span>
  </div>`;

// 与 ui/settings-dialog.ts 的 contrastText() 同一套算法，此处只用于生成期望值的对照
function luma(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{width:600px;padding:16px}
</style></head>
<body>
<div id="stage" class="caldav-root caldav-app caldav-settings">
  <div class="caldav-set-cals" data-cals>
    ${row(0, "CalDAV", "#f59e0b", "#f59e0b")}
    ${row(1, "CalDAV2", "#10b981", "#ef4444")}
    ${row(2, "很长的日历名称用来挤一挤布局看看会不会把药丸顶出去", "#84cc16", "#1e293b")}
  </div>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "cal-colors.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[cal-colors] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-cal-colors")}`,
  "about:blank"
], { stdio: "ignore" });
let killed = false;
const cleanup = () => { if (!killed) { killed = true; try { proc.kill(); } catch {} } };
process.on("exit", cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
    if (t) wsUrl = t.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.log("[cal-colors] 连不上调试端口"); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 460, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}

const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const probe = await evalJs(`(() => {
  const rows = Array.from(document.querySelectorAll('.caldav-set-cal'));
  return rows.map((r) => {
    const rr = r.getBoundingClientRect();
    const name = r.querySelector("input[data-role='name']");
    const pills = Array.from(r.querySelectorAll('.caldav-set-cal-tag'));
    return {
      rowOverflowX: r.scrollWidth - r.clientWidth,
      nameW: name.getBoundingClientRect().width,
      standaloneColorInputs: Array.from(r.children).filter((e) => e.tagName === 'INPUT' && e.type === 'color').length,
      pills: pills.map((p) => {
        const input = p.querySelector('input[type=color]');
        const label = p.querySelector('span');
        const pr = p.getBoundingClientRect();
        const ir = input.getBoundingClientRect();
        const cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          role: input.dataset.role,
          text: label.textContent,
          bg: getComputedStyle(p).backgroundColor,
          fg: getComputedStyle(label).color,
          inputValue: input.value,
          covers: Math.abs(ir.left - pr.left) < 0.6 && Math.abs(ir.top - pr.top) < 0.6 &&
                  Math.abs(ir.width - pr.width) < 0.6 && Math.abs(ir.height - pr.height) < 0.6,
          hitsInput: hit === input,
          // 药丸右边缘是否在行内（不被顶出去）
          rightGap: Math.round(rr.right - pr.right),
          h: Math.round(pr.height)
        };
      })
    };
  });
})()`);

console.log("=== 药丸渲染 ===");
console.log(JSON.stringify(probe, null, 2));

const flat = probe.flatMap((r, i) => r.pills.map((p) => ({ ...p, row: i })));
const r0 = probe[0].pills;
const r1 = probe[1].pills;
const r2 = probe[2].pills;
const byRole = (arr, role) => arr.find((p) => p.role === role);

const checks = [
  ["每行两个颜色输入都渲染出来", flat.length === 6],
  ["左侧独立的日历颜色方块已移除", probe.every((r) => r.standaloneColorInputs === 0)],
  ["药丸顺序为 日程 → 任务", r0.map((p) => p.text).join(",") === "日程,任务"],
  ["日程药丸绑 eventColor、任务绑 todoColor", r0[0].role === "eventColor" && r0[1].role === "todoColor"],
  ["药丸底色 = 对应默认色（橙）", r0[0].bg === "rgb(245, 158, 11)"],
  ["日程色与待办色可不同（行1：红 vs 绿）", r1[0].bg === "rgb(239, 68, 68)" && r1[1].bg === "rgb(16, 185, 129)"],
  ["浅色底自动配深色字（#84cc16 任务色）", r2[1].fg === "rgb(31, 41, 55)"],
  ["深色底自动配白字（#1e293b 日程色）", r2[0].fg === "rgb(255, 255, 255)"],
  ["取色输入铺满整块药丸", flat.every((p) => p.covers)],
  ["药丸中心命中的是原生取色输入（点哪儿都弹系统取色器）", flat.every((p) => p.hitsInput)],
  ["药丸留在行内不溢出（右间隙 ≥ 0）", probe.every((r) => r.pills.every((p) => p.rightGap >= -0.5))],
  ["行无横向溢出（长名字也不顶出药丸）", probe.every((r) => r.rowOverflowX <= 1)],
  ["名字输入框仍留有可用宽度（≥80px）", probe.every((r) => r.nameW >= 80)],
  ["药丸是单行小圆角块（高 ≤ 26px）", flat.every((p) => p.h > 0 && p.h <= 26)]
];

let pass = true;
console.log("=== 断言 ===");
for (const [name, ok] of checks) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) pass = false;
}
// 顺手留一张真机渲染图，方便人工比对（图随 .test-cal-colors/ 一起被 gitignore）
const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(outDir, "preview.png"), Buffer.from(shot.data, "base64"));
console.log(`==> 渲染截图: ${path.join(outDir, "preview.png")}`);
console.log(pass ? "PASS ✅ 设置页任务/日程颜色药丸渲染符合预期" : "FAIL ❌");
cleanup();
process.exit(pass ? 0 : 1);
