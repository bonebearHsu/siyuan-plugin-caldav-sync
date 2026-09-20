/**
 * 勾选样式几何验证（手动跑）：注入 dist/index.css，构造月视图待办 chip（done / undone），
 * 量 .cal-chip-check 的计算样式，确认：
 *   - 未完成：透明背景（空心圆）
 *   - 完成：实心圆背景(= --cal-color) + 白字 ✓
 * 本机无 Edge/Chrome 时跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-wk");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

function chip(done) {
  return `<div class="cal-chip cal-chip-month ${done ? "is-done" : ""}" data-open="K" style="--cal-color:#3b82f6">
  <div class="cal-chip-row"><button class="cal-chip-check" data-toggle="K" title="x">✓</button><span class="cal-chip-title">标题</span></div>
  <div class="cal-chip-row cal-chip-row-time"><span class="cal-chip-time">10:30</span></div>
</div>`;
}
const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}"><style>html,body{margin:0;padding:0;font-family:system-ui,sans-serif}#box{width:400px}</style></head>
<body><div id="box">${chip(false)}<hr>${chip(true)}</div></body></html>`;
fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "check.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[check] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9353;
const proc = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--no-first-run", "--disable-extensions", "--disable-background-networking", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, "profile-check")}`, "about:blank"], { stdio: "ignore" });
let killed = false; const cleanup = () => { if (!killed) { killed = true; try { proc.kill(); } catch {} } };
process.on("exit", cleanup);
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) { await sleep(300); try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch {} }
if (!wsUrl) { console.log("[check] 连不上调试端口"); cleanup(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 400, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }

const MEASURE = `(() => {
  const pick = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor }; };
  const chips = [...document.querySelectorAll('.cal-chip-month')];
  const undone = chips.find(c => !c.classList.contains('is-done')).querySelector('.cal-chip-check');
  const done = chips.find(c => c.classList.contains('is-done')).querySelector('.cal-chip-check');
  return { undone: pick(undone), done: pick(done) };
})()`;
const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
const { undone, done } = r.result.value;
const okUndone = /^rgba?\(0, 0, 0, 0\)$/i.test(undone.bg) || undone.bg === "transparent";
const okDone = !/0, 0, 0, 0/i.test(done.bg) && /^rgb\(255, 255, 255\)$/i.test(done.color);
console.log(okUndone && okDone ? "PASS ✅ 月视图勾选：未完成空心圆、完成实心圆+白勾" : "FAIL ❌");
cleanup();
process.exit(okUndone && okDone ? 0 : 1);
