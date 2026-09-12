/** 测试公共工具：jsdom 环境 + 加载 dist 产物（带 siyuan 桩） */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

export function setupBrowserDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  try { globalThis.navigator = w.navigator; } catch {}
  globalThis.MouseEvent = w.MouseEvent;
  globalThis.Event = w.Event;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.Element = w.Element;
  globalThis.Node = w.Node;
  globalThis.CustomEvent = w.CustomEvent;
}

export function loadBuiltPlugin() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dist = path.join(root, "dist", "index.js");
  if (!fs.existsSync(dist)) throw new Error("dist/index.js 不存在，请先构建");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-loader-"));
  fs.mkdirSync(path.join(tmp, "node_modules", "siyuan"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "node_modules", "siyuan", "package.json"), JSON.stringify({ name: "siyuan", main: "index.js" }));
  fs.copyFileSync(path.join(root, "test", "stubs", "siyuan-stub.cjs"), path.join(tmp, "node_modules", "siyuan", "index.js"));
  fs.copyFileSync(dist, path.join(tmp, "index.js"));

  const require = createRequire(path.join(tmp, "index.js"));
  const Mod = require(path.join(tmp, "index.js"));
  return Mod;
}

/** 组装测试数据 */
export function seedStore(plugin) {
  const store = plugin.store;
  store.settings = {
    serverUrl: "http://127.0.0.1:5232/",
    username: "testuser",
    password: "testpass",
    calendarPath: "",
    channel: "direct",
    syncIntervalMin: 0,
    conflict: "server",
    pastDays: 90,
    futureDays: 370,
    defaultCalendarUrl: "http://127.0.0.1:5232/testuser/work/",
    calendars: [
      { url: "http://127.0.0.1:5232/testuser/work/", displayName: "工作", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true },
      { url: "http://127.0.0.1:5232/testuser/personal/", displayName: "个人", color: "#10b981", enabled: true, supportsEvent: true, supportsTodo: true }
    ]
  };
  const today = new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  const todayStamp = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const mk = (i, over) => ({
    uid: `seed-${i}@test`,
    kind: "event",
    calendarUrl: "http://127.0.0.1:5232/testuser/work/",
    href: `http://127.0.0.1:5232/testuser/work/seed-${i}.ics`,
    etag: `"v${i}"`,
    summary: `测试条目 ${i}`,
    allDay: false,
    start: `${todayStamp}T0${i}:00:00`,
    end: `${todayStamp}T0${i}:30:00`,
    dirty: false,
    deleted: false,
    ...over
  });
  store.put(mk(1, {}));
  store.put(mk(2, { kind: "todo", status: "NEEDS-ACTION", percent: 0, priority: 3, end: `${todayStamp}T18:00:00` }));
  store.put(mk(3, { kind: "todo", end: `${todayStamp}T09:00:00`, summary: "逾期任务" }));
  store.put(mk(4, { allDay: true, start: todayStamp, end: todayStamp }));
  store.put(mk(5, { kind: "todo", percent: 100, status: "COMPLETED", end: `${todayStamp}T12:00:00` }));
  store.put(mk(6, { summary: "无截止任务", kind: "todo", end: undefined }));
  store.put(mk(7, { start: `${todayStamp}T14:00:00`, end: `${todayStamp}T15:00:00`, location: "线上会议" }));
}
