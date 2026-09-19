/**
 * 「把今日日程与待办插入日记」回归测试。
 *
 * 守三件曾经出问题的事：
 * 1) 不能把「不是今天」的条目写进日记 —— `occurrencesInRange()` 对无重复规则的条目会
 *    回退返回 `item.start`（可能不在窗口内），视图侧按日期落格会被自然丢掉，直接照单全收就会漏进来；
 * 2) 待办一律按到期日（DUE）归属，与视图/统计口径一致；
 * 3) 写入后必须有反馈并打开日记文档成为当前活动页签，重复点击是「替换」而非无限追加。
 */
import assert from "node:assert";
import { setupBrowserDom, loadBuiltPlugin, seedStore } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin); // 种子数据里含昨天的会议 / 逾期待办 / 跨日待办 / 无日期待办等干扰项

const d = new Date();
const p2 = (n) => (n < 10 ? "0" + n : String(n));
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

// ---- 桩掉内核接口，捕获实际写入的 markdown ----
const calls = [];
let docRows = [{ id: "doc-today", content: today, hpath: `/${today}` }];
let existingChildren = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const reply = (data) => ({ ok: true, json: async () => ({ code: 0, msg: "", data }) });
  if (url === "/api/query/sql") {
    return reply(String(body.stmt).includes("parent_id") ? existingChildren : docRows);
  }
  if (url === "/api/notebook/lsNotebooks") return reply({ notebooks: [{ id: "nb-1", closed: false }] });
  if (url === "/api/filetree/createDocWithMd") return reply("doc-created");
  return reply(null);
};
globalThis.__syMessages = [];

const msg = await plugin.insertTodayToDiary();
const ins = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(ins, "应调用 insertBlock 写入日记");
const md = String(ins.body.data);
assert.strictEqual(ins.body.parentID, "doc-today", "应写入今天的日记文档");
assert.ok(md.startsWith("## 今日日程与待办"), "小节标题应为「今日日程与待办」");

// 今天的条目：日程按开始时间、待办按到期日、全天单独标注
assert.ok(md.includes("测试条目 1"), "今天的日程应写入");
assert.ok(md.includes("测试条目 7"), "今天的日程应写入");
assert.ok(/全天 测试条目 4/.test(md), "全天条目应标注「全天」而不是空时间");

// 干扰项一律不得出现
for (const bad of ["昨天的会议", "逾期待办", "跨日待办", "测试条目 5", "无截止任务", "仅开始时间任务"]) {
  assert.ok(!md.includes(bad), `「${bad}」不属于今天，不应写入日记`);
}

// 时间序：09:00 之前的条目不能排在全天之后乱序
const times = md.split("\n").filter((l) => l.startsWith("- "));
assert.ok(times.length >= 4, "应写入多条今日条目");

// ---- 反馈 + 打开日记成为活动页签 ----
assert.ok(msg.includes("今日日程与待办"), "返回值应带结果文案");
assert.ok(
  globalThis.__syMessages.some((m) => m.text.includes("今日日程与待办")),
  "应弹出站内提示（否则用户不知道插到哪去了，会重复点击）"
);
assert.ok(globalThis.__syRegistrations.lastOpenTab, "应打开日记文档");
assert.strictEqual(globalThis.__syRegistrations.lastOpenTab.doc.id, "doc-today", "打开的应是今天的日记");

// ---- 重复点击 = 替换，而不是追加 ----
existingChildren = [
  { id: "h-1", type: "h", content: "今日日程与待办" },
  { id: "l-1", type: "l", content: "- 📅 09:00 上次写的" },
  { id: "p-1", type: "p", content: "用户自己写的段落" }
];
calls.length = 0;
const msg2 = await plugin.insertTodayToDiary();
assert.deepStrictEqual(
  calls.filter((c) => c.url === "/api/block/deleteBlock").map((c) => c.body.id),
  ["h-1", "l-1"],
  "应删除上一次的小节（标题 + 紧随的列表），且不能碰用户自己的段落"
);
assert.ok(msg2.includes("已更新"), "第二次点击应是「更新」而非「写入」");

// ---- 找不到今天的日记时：新建文档再写入 ----
docRows = [];
calls.length = 0;
globalThis.__syRegistrations.lastOpenTab = undefined;
await plugin.insertTodayToDiary();
const created = calls.find((c) => c.url === "/api/filetree/createDocWithMd");
assert.ok(created, "找不到今日日记应新建");
assert.strictEqual(created.body.path, "/" + today, "新建文档路径应为当天日期");
assert.strictEqual(
  calls.find((c) => c.url === "/api/block/insertBlock").body.parentID,
  "doc-created",
  "应写入新建的文档"
);
assert.strictEqual(globalThis.__syRegistrations.lastOpenTab.doc.id, "doc-created", "应打开新建的日记");

// ---- 无今日条目：只提示，不写日记 ----
existingChildren = [];
calls.length = 0;
const empty = await plugin.insertTodayToDiary.call({
  store: { getAll: () => [], settings: { calendars: [] } },
  notify: (text) => text
});
assert.strictEqual(empty, "今天没有日程或待办", "没有今日条目时应仅提示、不写入");
assert.ok(!calls.some((c) => c.url === "/api/block/insertBlock"), "没有今日条目时不应写入日记");

console.log("[diary] 插入日记链路全部通过（仅今日条目 / 待办按到期日 / 有反馈并打开日记 / 重复点击为更新）");
