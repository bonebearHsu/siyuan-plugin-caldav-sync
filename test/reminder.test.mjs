/**
 * 提醒投递链路回归（v0.1.7 的失效点）：
 *  1) 到点触发必须落到「应用内提醒卡片」——这是不依赖系统权限的主通道
 *  2) 站内提示同时下发（showMessage / pushMsg），窗口在后台时也能留下记录
 *  3) 系统通知是尽力而为，不构成提醒生效的前提
 *  4) ReminderEngine 只对带 alarms 的条目排程
 *
 * 之所以把这三条通道都断言一遍：v0.1.7 只依赖系统通知，且站内兜底调用了
 * 运行时并不存在的 window.siyuan.pushMsg —— 结果是「什么都没弹」。
 */
import assert from "node:assert";
import { setupBrowserDom, loadBuiltPlugin, seedStore } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;

// ---- 系统通知桩：Electron 里它可能被静默丢弃，测试中只记录是否被尝试调用 ----
const notified = [];
class NotificationStub {
  constructor(title, opts) {
    notified.push({ title, opts });
  }
  close() {}
}
NotificationStub.permission = "granted";
NotificationStub.requestPermission = async () => "granted";
globalThis.Notification = NotificationStub;

globalThis.__syMessages = [];
globalThis.__syPushes = [];

const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin);

const p2 = (n) => (n < 10 ? "0" + n : String(n));
const localStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 排程：只认带提醒时间的条目 ----
const soon = Date.now() + 30 * 60000;
plugin.store.settings.enableReminders = true;
plugin.store.putAndEmit({
  uid: "remind-1@test",
  kind: "event",
  calendarUrl: "http://127.0.0.1:5232/testuser/work/",
  href: "http://127.0.0.1:5232/testuser/work/remind-1.ics",
  summary: "带提醒的会议",
  allDay: false,
  start: localStamp(soon),
  end: localStamp(soon + 3600000),
  alarms: [{ minutesBefore: 10 }],
  dirty: false,
  deleted: false
});

assert.ok(plugin.reminder, "开启提醒后应创建提醒引擎");
assert.strictEqual(plugin.reminder.count(), 1, "只有带 alarms 的条目应被排程");
assert.strictEqual(plugin.reminder.armedCount(), 1, "带提醒时间的条目数应为 1");
assert.strictEqual(
  plugin.reminderStatus(),
  "已排程 1 条 · 带提醒时间的条目 1 个",
  "提醒状态摘要应能反映排程与数据侧情况"
);

// ---- 投递：一次触发三通道同时下发 ----
globalThis.__syMessages.length = 0;
globalThis.__syPushes.length = 0;
notified.length = 0;

const msg = await plugin.testReminder();
assert.ok(typeof msg === "string" && msg.length > 0, "测试提醒应返回可展示的结果文案");

await sleep(30); // 等 rAF 兜底的下一帧
const card = document.querySelector(".caldav-reminder-card");
assert.ok(card, "到点必须出现应用内提醒卡片（主通道）");
assert.strictEqual(
  card.querySelector(".caldav-reminder-title").textContent,
  "提醒功能测试",
  "卡片标题应为条目标题"
);
assert.ok(card.querySelector("[data-act='open']"), "卡片应提供「打开」按钮");
assert.ok(card.querySelector("[data-act='snooze']"), "卡片应提供「稍后提醒」按钮");

assert.strictEqual(globalThis.__syMessages.length, 1, "应下发一条站内提示");
assert.match(globalThis.__syMessages[0].text, /提醒功能测试/, "站内提示应含条目标题");
assert.strictEqual(globalThis.__syPushes.length, 1, "应通过 pushMsg 投递到思源通知中心");
assert.strictEqual(notified.length, 1, "应尝试系统通知（是否显示由运行环境决定）");

// ---- 多条并排：不做去重，逐条都要看得见 ----
await plugin.testReminder();
await sleep(30);
assert.strictEqual(document.querySelectorAll(".caldav-reminder-card").length, 2, "两次提醒应叠两张卡片");

// ---- 关闭按钮：可手动收起 ----
const firstCard = document.querySelector(".caldav-reminder-card");
firstCard.querySelector("[data-act='close']").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(220);
assert.strictEqual(
  document.querySelectorAll(".caldav-reminder-card").length,
  1,
  "点击关闭后卡片应被移除"
);

// ---- 未开启提醒时不排程 ----
plugin.store.settings.enableReminders = false;
plugin.store.putAndEmit(plugin.store.getAll()[0]);
assert.strictEqual(plugin.reminder, undefined, "关闭提醒后引擎应被销毁");

// ---- 卸载：清理卡片与计时器（否则 60s rescan / 5min snooze 会挂住进程） ----
plugin.onunload();
assert.strictEqual(document.querySelectorAll(".caldav-reminder-card").length, 0, "卸载应清空残留卡片");

console.log("[reminder] 提醒投递链路回归通过");
