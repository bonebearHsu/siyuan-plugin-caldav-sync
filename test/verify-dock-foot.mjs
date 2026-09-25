/**
 * Dock 页脚（上次同步那一条）的真实渲染验证（手动跑）。
 *
 * 验的是「去掉分割线 + 低调状态条」这一版：
 *   1. 页脚不再有 border-top 分割线；
 *   2. 状态条默认无底色、整体压低不透明度（不抢眼），只有一行浅灰小字 + 一颗小暗点；
 *   3. 鼠标悬停才显出胶囊底、回到不透明、状态灯点亮；
 *   4. 同步失败时只转红字红点（不铺红底），仍保持低调。
 * 截图留在 .test-dock-foot/preview.png 供人工比对。
 *
 * 用法：node test/verify-dock-foot.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-dock-foot");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

const card = (title, when, tags) => `
  <div class="caldav-dock-item">
    <div class="caldav-dock-item-main">
      <div class="caldav-dock-item-title">${title}</div>
      <div class="caldav-dock-item-meta">
        <span class="caldav-dock-item-date">${when}</span>
      </div>
      <div class="caldav-dock-item-tags">${tags}</div>
    </div>
  </div>`;

const panel = (status, cls = "") => `
  <div class="caldav-root caldav-dock" style="width:300px;height:480px">
    <div class="caldav-dock-list">
      <div class="caldav-dock-items">
        ${card("【行内】外包入围和采购方案", "9月15日 16:30", '<i class="caldav-tag is-overdue">逾期 10 天</i>')}
        ${card("【行内】三年规划", "9月18日 15:30", '<i class="caldav-tag is-overdue">逾期 7 天</i><i class="caldav-tag">任务</i>')}
        ${card("【行内】金科创新社——案例", "9月21日 09:00", '<i class="caldav-tag is-overdue">逾期 4 天</i>')}
      </div>
    </div>
    <div class="caldav-dock-foot">
      <button class="caldav-dock-status ${cls}">${status}</button>
    </div>
  </div>`;

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;background:#eff1f4;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{display:flex;gap:14px;padding:14px;align-items:flex-start}
</style></head>
<body>
<div id="stage">
  ${panel("上次同步 2026-09-25 17:16:57")}
  ${panel("同步失败 · 2026-09-25 17:16:57", "has-error")}
  ${panel("未配置服务器")}
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "dock-foot.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[dock-foot] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9365;
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-dock-foot")}`,
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
if (!wsUrl) { console.log("[dock-foot] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", { width: 980, height: 540, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}

const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const probe = await evalJs(`(() => {
  const panels = Array.from(document.querySelectorAll('.caldav-dock'));
  const alpha = (v) => { const m = /^rgba?\\(([^)]+)\\)$/i.exec(v); if (!m) return v === 'transparent' ? 0 : 1; const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; };
  return panels.map((p) => {
    const foot = p.querySelector('.caldav-dock-foot');
    const st = p.querySelector('.caldav-dock-status');
    const fs = getComputedStyle(foot);
    const ss = getComputedStyle(st);
    const dot = getComputedStyle(st, '::before');
    return {
      text: st.textContent.trim(),
      footBorderTop: fs.borderTopWidth,
      footBorderTopStyle: fs.borderTopStyle,
      statusRadius: ss.borderRadius,
      statusBg: ss.backgroundColor,
      statusBgOpaque: alpha(ss.backgroundColor) > 0.02,
      statusColor: ss.color,
      statusOpacity: ss.opacity,
      statusNowrap: ss.whiteSpace,
      statusFits: st.scrollWidth <= st.clientWidth + 1,
      dotW: dot.width,
      dotRadius: dot.borderRadius,
      dotBg: dot.backgroundColor,
      dotOpacity: dot.opacity,
      isError: st.classList.contains('has-error')
    };
  });
})()`);

console.log("=== Dock 页脚渲染 ===");
console.log(JSON.stringify(probe, null, 2));

// 悬停态：用 CDP 强制 :hover 后取计算样式（DOM.getDocument 只能调一次）
await send("DOM.enable");
await send("CSS.enable");
const { root: docNode } = await send("DOM.getDocument");
const firstStatusNodeId = (
  await send("DOM.querySelector", { nodeId: docNode.nodeId, selector: ".caldav-dock-status" })
).nodeId;
await send("CSS.forcePseudoState", { nodeId: firstStatusNodeId, forcedPseudoClasses: ["hover"] });
await sleep(250);
const hover = await evalJs(`(() => {
  const st = document.querySelector('.caldav-dock-status');
  const s = getComputedStyle(st);
  return { bg: s.backgroundColor, color: s.color, opacity: s.opacity, dot: getComputedStyle(st, '::before').opacity };
})()`);
await send("CSS.forcePseudoState", { nodeId: firstStatusNodeId, forcedPseudoClasses: [] });
console.log("=== 悬停态 ===");
console.log(JSON.stringify(hover, null, 2));

const alpha = (v) => { const m = /^rgba?\(([^)]+)\)$/i.exec(v); if (!m) return v === "transparent" ? 0 : 1; const p = m[1].split(",").map(Number); return p.length > 3 ? p[3] : 1; };
const [ok, err, plain] = probe;
const checks = [
  ["页脚无分割线（border-top = 0）", probe.every((p) => p.footBorderTop === "0px" || p.footBorderTopStyle === "none")],
  ["状态条形状是胶囊（圆角 999px）", probe.every((p) => p.statusRadius === "999px")],
  ["默认无底色（不抢眼）", probe.every((p) => !p.statusBgOpaque)],
  [
    "默认整体压低不透明度（正常 < 0.8、失败 ≤ 0.92）",
    probe.filter((p) => !p.isError).every((p) => Number(p.statusOpacity) < 0.8) &&
      probe.filter((p) => p.isError).every((p) => Number(p.statusOpacity) <= 0.92)
  ],
  [
    "状态灯是 5px 小圆（正常态暗灰、失败态红）",
    probe.every((p) => p.dotW === "5px" && p.dotRadius === "50%") &&
      ok.dotBg === "rgb(100, 106, 115)" &&
      err.dotBg === "rgb(210, 63, 49)"
  ],
  ["悬停才显出胶囊底", alpha(hover.bg) > 0.02],
  ["悬停时整体回到不透明并点亮状态灯", Number(hover.opacity) === 1 && Number(hover.dot) > 0.8],
  ["同步失败时文字转红", err.isError && /^(rgb\(210, 63, 49\)|rgb\(211, 47, 47\))/.test(err.statusColor)],
  ["同步失败时状态灯转红并点亮", err.dotBg === "rgb(210, 63, 49)" && err.dotOpacity === "1"],
  ["失败态不铺红底（仍低调）", !err.statusBgOpaque],
  ["长文本单行不溢出卡片", probe.every((p) => p.statusNowrap === "nowrap" && p.statusFits)]
];

let pass = true;
console.log("=== 断言 ===");
for (const [name, good] of checks) {
  console.log(`${good ? "✅" : "❌"} ${name}`);
  if (!good) pass = false;
}

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(outDir, "preview.png"), Buffer.from(shot.data, "base64"));
console.log(`==> 渲染截图: ${path.join(outDir, "preview.png")}`);
console.log(pass ? "PASS ✅ Dock 页脚去线 + 胶囊状态条渲染符合预期" : "FAIL ❌");
cleanup();
process.exit(pass ? 0 : 1);
