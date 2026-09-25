/**
 * 勾选圆圈「三态可区分」验证（手动跑）：
 *   未完成 / 未完成+hover / 完成 / 完成+hover
 *
 * 为什么必须验：鼠标点完会停在圆圈上，hover 一直生效。若 hover 与完成态长得一样，
 * 用户再点（期望取消完成）就会看到圆圈「还是实心的」，表现为「第一次生效、后来点不动」。
 * 用 CDP 的 CSS.forcePseudoState 强制 :hover，取真实计算样式比对。
 * 本机无 Edge/Chrome 时跳过。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-hover");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

const chip = (done, id) =>
  `<div class="cal-chip cal-chip-month ${done ? "is-done" : ""}" data-open="K${id}" style="--cal-color:#3b82f6">
  <div class="cal-chip-row"><button class="cal-chip-check" id="${id}" data-toggle="K${id}" title="x">✓</button><span class="cal-chip-title">标题</span></div>
</div>`;

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}"><style>html,body{margin:0;padding:0;font-family:system-ui,sans-serif}#box{width:420px;padding:12px}</style></head>
<body><div id="box">${chip(false, "u")}${chip(true, "d")}</div></body></html>`;
fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "hover.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[hover] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--no-first-run", "--disable-extensions", "--disable-background-networking", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, "profile-hover")}`, "about:blank"], { stdio: "ignore" });
let killed = false; const cleanup = () => { if (!killed) { killed = true; try { proc.kill(); } catch {} } };
process.on("exit", cleanup);
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) { await sleep(300); try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch {} }
if (!wsUrl) { console.log("[hover] 连不上调试端口"); cleanup(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable"); await send("CSS.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 300, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }

// 只取一次 document：CDP 的 nodeId 绑定在本次 getDocument 上，重复调用会让旧 id 失效
const { root: docRoot } = await send("DOM.getDocument");
const nodeIdOf = async (sel) => (await send("DOM.querySelector", { nodeId: docRoot.nodeId, selector: sel })).nodeId;
const PICK = (sel) => `(() => { const s = getComputedStyle(document.querySelector('${sel}')); return { bg: s.backgroundColor, color: s.color, filter: s.filter }; })()`;
const pick = async (sel) => (await send("Runtime.evaluate", { expression: PICK(sel), returnByValue: true })).result.value;

const uId = await nodeIdOf("#u");
const dId = await nodeIdOf("#d");

const undone = await pick("#u");
const done = await pick("#d");

await send("CSS.forcePseudoState", { nodeId: uId, forcedPseudoClasses: ["hover"] });
const undoneHover = await pick("#u");
await send("CSS.forcePseudoState", { nodeId: uId, forcedPseudoClasses: [] });

await send("CSS.forcePseudoState", { nodeId: dId, forcedPseudoClasses: ["hover"] });
const doneHover = await pick("#d");
await send("CSS.forcePseudoState", { nodeId: dId, forcedPseudoClasses: [] });

console.log("未完成        :", JSON.stringify(undone));
console.log("未完成 + hover:", JSON.stringify(undoneHover));
console.log("完成          :", JSON.stringify(done));
console.log("完成 + hover  :", JSON.stringify(doneHover));

const isTransparent = (v) => /^rgba\(0, 0, 0, 0\)$/i.test(v) || v === "transparent";
const alpha = (v) => { const m = /^rgba?\(([^)]+)\)$/i.exec(v); if (!m) return 1; const p = m[1].split(",").map((s) => parseFloat(s)); return p.length > 3 ? p[3] : 1; };
const same = (a, b) => a === b;

const checks = [
  ["未完成=空心（透明底）", isTransparent(undone.bg)],
  ["完成=实心圆（不透明底）", !isTransparent(done.bg) && alpha(done.bg) === 1],
  ["完成=白勾", /^rgb\(255, 255, 255\)$/i.test(done.color)],
  ["未完成+hover 仍不是纯白勾", !/^rgb\(255, 255, 255\)$/i.test(undoneHover.color)],
  ["未完成+hover 底色≠完成态底色", !same(undoneHover.bg, done.bg)],
  ["完成+hover 有区分（压暗）", !same(doneHover.filter, done.filter)]
];
let pass = true;
for (const [name, ok] of checks) { console.log(`${ok ? "✅" : "❌"} ${name}`); if (!ok) pass = false; }
console.log(pass ? "PASS ✅ 三态可区分：hover 不再伪装成已完成" : "FAIL ❌");
cleanup();
process.exit(pass ? 0 : 1);
