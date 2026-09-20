/**
 * 勾选待办「连点」回归（npm run test:toggle）。
 *
 * 背景：勾选改成就地更新后，如果处理链路里出现「一次性」状态（抑制重渲染的 flag 没复位、
 * store 里查不到条目等），表现就是「第一次点生效、之后点不动」。
 * 这里用 jsdom 走真实加载链路打开主日历页签，对同一个待办圆圈连点三次，
 * 断言 UI 与 store 每次都交替翻转（完成 ↔ 未完成）。
 */
import assert from "node:assert";
import { setupBrowserDom, loadBuiltPlugin, seedStore, settle } from "./helpers.mjs";

setupBrowserDom();

// 网络桩：CalDAV 推送必然发生，别让它真去连 127.0.0.1:5232
globalThis.fetch = async () => ({
  ok: true,
  status: 204,
  statusText: "No Content",
  headers: new Map(),
  text: async () => "",
  json: async () => ({})
});

const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();

const reg = globalThis.__syRegistrations;
seedStore(plugin);

const dockEl = document.createElement("div");
document.body.appendChild(dockEl);
const dockCustom = { element: dockEl, data: { key: "dock" } };
reg.dock[0].init.call(dockCustom, dockCustom);
await new Promise((r) => setTimeout(r, 450));

const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: { id: "siyuan-plugin-caldav-synccaldav-sync-tab", title: "日历" } };
reg.tab[0].init.call(tabCustom, tabCustom);

const app = tabEl.querySelector(".caldav-app");
assert.ok(app, "应渲染完整日历面板");
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

const monthBtn = app.querySelector('[data-view="month"]');
if (monthBtn) click(monthBtn);
await settle();

const chip = Array.from(app.querySelectorAll(".cal-chip-month")).find((c) => c.querySelector("[data-toggle]"));
assert.ok(chip, "月视图里应有可勾选的待办卡片");
const key = chip.querySelector("[data-toggle]").dataset.toggle;

const snap = () => {
  const el = app.querySelector(`[data-open="${key}"]`);
  const it = plugin.store.get(key);
  return { done: el ? el.classList.contains("is-done") : null, percent: it ? it.percent : null };
};

assert.deepStrictEqual(snap(), { done: false, percent: 0 }, "初始应为未完成");

click(app.querySelector(`[data-toggle="${key}"]`));
await settle(8);
assert.deepStrictEqual(snap(), { done: true, percent: 100 }, "第 1 次点击应标记完成");

click(app.querySelector(`[data-toggle="${key}"]`));
await settle(8);
assert.deepStrictEqual(snap(), { done: false, percent: 0 }, "第 2 次点击应恢复未完成（回归：只能点一次）");

click(app.querySelector(`[data-toggle="${key}"]`));
await settle(8);
assert.deepStrictEqual(snap(), { done: true, percent: 100 }, "第 3 次点击应再次标记完成");

console.log("[toggle] 月视图待办圆圈连点三次均正常翻转（完成↔未完成）");
