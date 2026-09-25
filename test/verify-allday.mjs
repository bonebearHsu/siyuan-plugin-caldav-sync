/**
 * 全天区高度几何验证（手动跑，不进正式 npm test）：
 *   注入 dist/index.css，用 Edge CDP 量：
 *   场景 A（无全天事件）：.cal-wk-main 不渲染全天区；grid 紧贴 main 顶（无空行）。
 *   场景 B（有全天事件）：.cal-wk-allday-cells 高度 == 44px == 单个 .cal-wk-hour 行高。
 *   本机无 Edge 时打印提示并退出 0。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-wk");

const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DAYS = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"];
const dayHead = DAYS.map((d, i) =>
  `<div class="cal-wk-dayhead ${d === "2026-09-20" ? "is-today" : ""}" data-day="${d}">
     <span class="cal-wk-wd">${WEEK[i]}</span><span class="cal-wk-num">${+d.slice(8, 10)}</span></div>`
).join("");
const hours = [];
for (let h = 0; h < 24; h++) hours.push(`<div class="cal-wk-hour" style="height:44px"><span>${String(h).padStart(2, "0")}:00</span></div>`);
const cols = DAYS.map((d) => `<div class="cal-wk-col" data-day="${d}"></div>`).join("");

const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

function page(withAllDay) {
  const alldayHtml = withAllDay
    ? `<div class="cal-wk-allday-label">全天</div>
       <div class="cal-wk-allday-cells">${DAYS.map((d) =>
           d === "2026-09-14" ? `<div class="cal-wk-allday-cell" data-day="${d}"><div class="cal-chip cal-chip-allday" data-open="x" style="--cal-color:#3b82f6"><span class="cal-chip-title">全天示例</span></div></div>`
           : `<div class="cal-wk-allday-cell" data-day="${d}"></div>`).join("")}</div>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>html,body{margin:0;padding:0;font-family:system-ui,"Microsoft YaHei",sans-serif}
#box{width:1000px;height:720px}</style></head><body>
<div id="box"><div class="cal-wk" style="--cols:7">
  <div class="cal-wk-header"><div class="cal-wk-gutterhead"></div><div class="cal-wk-days">${dayHead}</div></div>
  <div class="cal-wk-main ${withAllDay ? "has-allday" : ""}">
    ${alldayHtml}
    <div class="cal-wk-gutter">${hours.join("")}</div>
    <div class="cal-wk-grid" style="height:${24 * 44}px">${cols}</div>
  </div>
</div></div></body></html>`;
}

fs.mkdirSync(outDir, { recursive: true });
const aPath = path.join(outDir, "allday-none.html");
const bPath = path.join(outDir, "allday-yes.html");
fs.writeFileSync(aPath, page(false), "utf8");
fs.writeFileSync(bPath, page(true), "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[allday] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, "profile-allday")}`, "about:blank"
], { stdio: "ignore" });
let killed = false;
const cleanup = () => { if (!killed) { killed = true; try { proc.kill(); } catch {} } };
process.on("exit", cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch {}
}
if (!wsUrl) { console.log("[allday] 连不上调试端口"); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 820, deviceScaleFactor: 1, mobile: false });

const MEASURE = `(() => {
  const main = document.querySelector('.cal-wk-main');
  const grid = document.querySelector('.cal-wk-grid');
  const alldayCells = document.querySelector('.cal-wk-allday-cells');
  const mainTop = main.getBoundingClientRect().top;
  const gridTop = grid.getBoundingClientRect().top;
  const rows = getComputedStyle(main).gridTemplateRows;
  const hasAllDayEls = !!alldayCells;
  let alldayH = null, hourH = null;
  if (alldayCells) alldayH = +alldayCells.getBoundingClientRect().height.toFixed(1);
  const h0 = document.querySelector('.cal-wk-hour');
  if (h0) hourH = +h0.getBoundingClientRect().height.toFixed(1);
  return { gridRows: rows, hasAllDayEls, gapMainToGrid: +(gridTop - mainTop).toFixed(1), alldayH, hourH };
})()`;

async function measure(file) {
  await send("Page.navigate", { url: "file:///" + file.replace(/\\/g, "/") });
  for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
  const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  return r.result.value;
}

const ra = await measure(aPath);
const rb = await measure(bPath);
console.log("场景A(无全天):", JSON.stringify(ra));
console.log("场景B(有全天):", JSON.stringify(rb));

const okA = !ra.hasAllDayEls && Math.abs(ra.gapMainToGrid) < 1.5;
const okB = rb.hasAllDayEls && rb.alldayH === 44 && rb.hourH === 44;
console.log(okA && okB ? "PASS ✅ 全天区：无事件整行隐藏；有事件行高==44px==单行" : "FAIL ❌");
cleanup();
process.exit(okA && okB ? 0 : 1);
