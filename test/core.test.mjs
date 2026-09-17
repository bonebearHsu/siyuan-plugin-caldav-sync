/**
 * 核心逻辑单测：ICS 解析/序列化、RRULE 展开、日期工具
 * 运行前先用 tsc 把 src/core 编译到 .test-core
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-core");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts src/core/secret.ts ` +
  `--outDir .test-core --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
// .test-core 内声明 cjs，避免被根 package.json 的 type:module 影响
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const ics = require(path.join(outDir, "ics.js"));
const date = require(path.join(outDir, "date.js"));
const storeMod = require(path.join(outDir, "store.js"));

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
}

console.log("[core] ICS 解析");
const sample = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:evt-1@test",
  "SUMMARY:团队例会\\, 每周",
  "LOCATION:会议室\\n二楼",
  "DTSTART:20260910T100000Z",
  "DTEND:20260910T110000Z",
  "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=4",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VTODO",
  "UID:todo-1@test",
  "SUMMARY:提交报告",
  "DUE:20260911T180000Z",
  "PRIORITY:3",
  "STATUS:NEEDS-ACTION",
  "END:VTODO",
  "END:VCALENDAR"
].join("\r\n");

const items = ics.itemsFromICS(sample, "http://x/cal/", "http://x/cal/evt1.ics", "abc");
t("解析出 1 事件 + 1 待办", () => assert.strictEqual(items.length, 2));
t("事件字段", () => {
  const ev = items[0];
  assert.strictEqual(ev.kind, "event");
  assert.strictEqual(ev.summary, "团队例会, 每周");
  assert.strictEqual(ev.location, "会议室\n二楼");
  assert.strictEqual(ev.allDay, false);
  assert.ok(ev.start.endsWith(":10:00") || ev.start.includes("T18:00") || ev.start.includes("T10:00"));
});
t("RRULE 解析", () => {
  const ev = items[0];
  assert.strictEqual(ev.rrule.freq, "WEEKLY");
  assert.strictEqual(ev.rrule.interval, 2);
  assert.deepStrictEqual(ev.rrule.byDay, ["WE"]);
  assert.strictEqual(ev.rrule.count, 4);
});
t("VALARM 解析", () => assert.strictEqual(items[0].alarms[0].minutesBefore, 15));
t("待办优先级", () => assert.strictEqual(items[1].priority, 3));

console.log("[core] RRULE 展开");
const base = items[0];
// 2026-09-10 是周四？以起点展开未来窗口
const occs = ics.occurrencesInRange(base, date.parseLocalStamp("2026-09-01T00:00:00").getTime(), date.parseLocalStamp("2026-12-31T00:00:00").getTime());
t("双周周三展开 4 次", () => assert.strictEqual(occs.length, 4));
t("全部为周三", () => {
  for (const o of occs) assert.strictEqual(new Date(o.slice(0, 10) + "T00:00:00").getDay(), 3);
});

const daily = {
  uid: "d", kind: "event", calendarUrl: "", href: "", summary: "每日站会",
  allDay: false, start: "2026-09-01T09:00:00", end: "2026-09-01T09:15:00",
  rrule: { freq: "DAILY", interval: 1, count: 5 }
};
t("DAILY count=5 展开", () => {
  const o = ics.occurrencesInRange(daily, date.parseLocalStamp("2026-09-01T00:00:00").getTime(), date.parseLocalStamp("2026-09-30T00:00:00").getTime());
  assert.strictEqual(o.length, 5);
});

const exDate = {
  uid: "e", kind: "event", calendarUrl: "", href: "", summary: "排除测试",
  allDay: false, start: "2026-09-01T09:00:00", end: "2026-09-01T10:00:00",
  rrule: { freq: "DAILY", interval: 1 },
  exdates: ["2026-09-02T09:00:00"]
};
t("EXDATE 排除", () => {
  const o = ics.occurrencesInRange(exDate, date.parseLocalStamp("2026-09-01T00:00:00").getTime(), date.parseLocalStamp("2026-09-05T00:00:00").getTime());
  assert.deepStrictEqual(o.map((s) => s.slice(5, 10)), ["09-01", "09-03", "09-04"]);
});

console.log("[core] 序列化");
t("编辑保留原文属性", () => {
  const edited = { ...base, summary: "改名后的会议" };
  const out = ics.itemToEditedICS(edited);
  assert.ok(out.includes("SUMMARY:改名后的会议"));
  assert.ok(out.includes("UID:evt-1@test"));
  assert.ok(out.includes("BEGIN:VALARM"));
  assert.ok(out.includes("RRULE:FREQ=WEEKLY"));
});
t("新建生成完整 VCALENDAR", () => {
  const out = ics.itemToNewICS({ ...items[1], summary: "新待办" });
  assert.ok(out.includes("BEGIN:VCALENDAR"));
  assert.ok(out.includes("SUMMARY:新待办"));
  assert.ok(out.includes("PRIORITY:3"));
  assert.ok(/\r\n/.test(out));
});
t("折行还原（75 字符）", () => {
  const long = { ...items[0], summary: "很长的标题".repeat(40) };
  const out = ics.itemToEditedICS(long);
  const re = ics.itemsFromICS(out, "", "x", "");
  assert.strictEqual(re[0].summary, long.summary);
});

console.log("[core] Store");
t("mergeServerItems 保留脏数据", async () => {
  const saved = {};
  const st = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async (d) => { saved.data = d; }
  });
  await st.load();
  const remote = { ...base, etag: "v2" };
  st.put({ ...base, dirty: true, summary: "本地改动" });
  st.mergeServerItems([remote]);
  const all = st.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].summary, "本地改动");
  assert.strictEqual(all[0].dirty, true);
});
t("mergeServerItems 更新远端数据", async () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await st.load();
  st.put({ ...base, etag: "v1" });
  st.mergeServerItems([{ ...base, etag: "v2", summary: "服务端新标题" }]);
  assert.strictEqual(st.getAll()[0].summary, "服务端新标题");
});

console.log("[core] 待办开始/截止时间");
const todoIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTODO",
  "UID:t1@test",
  "SUMMARY:带开始和截止",
  "DTSTART:20260914T090000",
  "DUE:20260915T180000",
  "END:VTODO",
  "BEGIN:VTODO",
  "UID:t2@test",
  "SUMMARY:只有截止（旧数据）",
  "DUE:20260916T120000",
  "END:VTODO",
  "BEGIN:VTODO",
  "UID:t3@test",
  "SUMMARY:无任何日期",
  "STATUS:NEEDS-ACTION",
  "END:VTODO",
  "END:VCALENDAR"
].join("\r\n");
const todoItems = ics.itemsFromICS(todoIcs, "http://x/cal/", "http://x/cal/t.ics", "e1");
t("DTSTART 作为开始、DUE 作为截止", () => {
  const a = todoItems.find((x) => x.uid === "t1@test");
  assert.ok(a.start.includes("T09:00"), "start=" + a.start);
  assert.ok(a.end.includes("T18:00"), "end=" + a.end);
});
t("旧数据只有 DUE 时用 DUE 兜底开始", () => {
  const b = todoItems.find((x) => x.uid === "t2@test");
  assert.ok(b.end.includes("T12:00"), "end=" + b.end);
  assert.strictEqual(b.start, b.end);
});
t("无日期待办解析为空", () => {
  const c = todoItems.find((x) => x.uid === "t3@test");
  assert.strictEqual(c.start, "");
  assert.strictEqual(c.end, undefined);
});
t("序列化：无开始时间不写 DTSTART", () => {
  const c = todoItems.find((x) => x.uid === "t3@test");
  const out = ics.itemToNewICS(c);
  assert.ok(!/DTSTART/.test(out), out);
  assert.ok(!/DUE/.test(out), out);
});
t("往返后开始/截止不丢失", () => {
  const a = todoItems.find((x) => x.uid === "t1@test");
  const out = ics.itemToNewICS(a);
  const back = ics.itemsFromICS("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + out + "END:VCALENDAR", "http://x/cal/", "http://x/cal/t.ics");
  assert.strictEqual(back.length, 1);
  assert.ok(back[0].start.includes("T09:00"), "回读 start=" + back[0].start);
  assert.ok(back[0].end.includes("T18:00"), "回读 end=" + back[0].end);
});
t("编辑既有条目：改动写入 DTSTART/DUE 而非原样输出", () => {
  const a = todoItems.find((x) => x.uid === "t1@test");
  const edited = { ...a, raw: ics.itemToNewICS(a), start: "2026-09-20T09:00:00", end: "2026-09-21T10:00:00", summary: "改期后的标题" };
  const out = ics.itemToEditedICS(edited);
  const back = ics.itemsFromICS(out, "http://x/cal/", "http://x/cal/t.ics");
  assert.strictEqual(back.length, 1, "编辑后条目数应保持 1");
  assert.strictEqual(back[0].summary, "改期后的标题");
  assert.ok(back[0].start.startsWith("2026-09-20"), "改期未生效: " + back[0].start);
  assert.ok(back[0].end.startsWith("2026-09-21"), "改期未生效: " + back[0].end);
});
t("编辑保留原文的非管理属性（ORGANIZER/VTIMEZONE）", () => {
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "END:VTIMEZONE",
    "BEGIN:VTODO",
    "UID:t9@test",
    "SUMMARY:原标题",
    "DTSTART:20260914T090000",
    "ORGANIZER:mailto:a@b.c",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = ics.itemsFromICS(raw, "http://x/cal/", "http://x/cal/t9.ics")[0];
  const out = ics.itemToEditedICS({ ...it, raw, start: "2026-09-25T08:00:00", summary: "新标题" });
  assert.ok(out.includes("ORGANIZER:mailto:a@b.c"), "应保留 ORGANIZER\n" + out);
  assert.ok(out.includes("TZID:Asia/Shanghai"), "应保留 VTIMEZONE\n" + out);
  assert.ok(out.includes("SUMMARY:新标题"));
  const back = ics.itemsFromICS(out, "http://x/cal/", "http://x/cal/t9.ics");
  assert.strictEqual(back.length, 1);
  assert.ok(back[0].start.startsWith("2026-09-25"), "改期未生效: " + back[0].start);
});

console.log("[core] Secret（密码密文存储）");
const secret = require(path.join(outDir, "secret.js"));
async function ta(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e?.message || e);
    process.exitCode = 1;
  }
}
await ta("加解密往返一致", async () => {
  const cipher = await secret.encryptSecret("p@ss w0rd-中文");
  assert.ok(secret.isEncrypted(cipher), "应为密文格式: " + cipher);
  assert.ok(cipher.startsWith("enc:v1:"), "未设置设备标识时应走兼容格式: " + cipher.slice(0, 10));
  assert.ok(!cipher.includes("p@ss"), "密文不应包含明文片段");
  assert.strictEqual(await secret.decryptSecret(cipher), "p@ss w0rd-中文");
});
await ta("空值与非密文原样处理", async () => {
  assert.strictEqual(await secret.encryptSecret(""), "");
  assert.strictEqual(await secret.decryptSecret(""), "");
  assert.strictEqual(await secret.decryptSecret("legacy-plain-pwd"), "legacy-plain-pwd");
});
await ta("每次加密结果不同（随机 iv）", async () => {
  const a = await secret.encryptSecret("same");
  const b = await secret.encryptSecret("same");
  assert.notStrictEqual(a, b);
  assert.strictEqual(await secret.decryptSecret(a), await secret.decryptSecret(b));
});
await ta("Store 保存密文、读回明文", async () => {
  const saved = {};
  const st = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async (d) => { saved.data = d; }
  });
  await st.load();
  st.settings.password = "secret-123";
  await st.persist();
  assert.ok(secret.isEncrypted(saved.data.settings.password), "落盘应为密文");
  assert.ok(!JSON.stringify(saved.data).includes("secret-123"), "落盘数据不应包含明文");
  const st2 = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async () => {}
  });
  await st2.load();
  assert.strictEqual(st2.settings.password, "secret-123");
  assert.strictEqual(st2.secretBroken, false);
});
await ta("旧明文密码自动迁移为密文", async () => {
  const saved = { data: { settings: { serverUrl: "http://x/", username: "u", password: "old-plain" }, items: [] } };
  const st = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async (d) => { saved.data = d; }
  });
  await st.load();
  assert.strictEqual(st.settings.password, "old-plain");
  await st.persist();
  assert.ok(secret.isEncrypted(saved.data.settings.password), "迁移后应为密文");
});
await ta("设备标识（v2）：加解密往返且不受 iframe 端口影响", async () => {
  secret.setSecretSeed("sysid-abc|D:/SiYuan");
  const cipher = await secret.encryptSecret("pwd-中文-123");
  assert.ok(cipher.startsWith("enc:v2:"), "应使用设备标识密钥: " + cipher.slice(0, 12));
  assert.strictEqual(await secret.decryptSecret(cipher), "pwd-中文-123");
});
await ta("设备标识变更后旧密文解不开、改回后可解", async () => {
  const cipher = await secret.encryptSecret("secret-x");
  secret.setSecretSeed("sysid-other|D:/Other");
  assert.strictEqual(await secret.decryptSecret(cipher), "", "换设备后应解不开");
  secret.setSecretSeed("sysid-abc|D:/SiYuan");
  assert.strictEqual(await secret.decryptSecret(cipher), "secret-x");
});
await ta("凭据异常可被检出（用于界面提示）", async () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await st.load();
  st.settings.serverUrl = "http://x/";
  st.settings.password = "";
  assert.ok(st.credentialsIssue(), "空密码应能检出");
  st.settings.password = "p";
  assert.strictEqual(st.credentialsIssue(), undefined);
});

// ---- 新建时的默认开始时间：今天落在「下一个整点」，不再是固定 9:00 ----
t("defaultStartStamp：今天取下一个整点", () => {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const expectHH = `${String(d.getHours()).padStart(2, "0")}:00`;
  const val = date.defaultStartStamp(date.todayStamp());
  assert.strictEqual(val.slice(11, 16), expectHH, "今天的新建默认应为当前时间的下一个整点");
  assert.strictEqual(val.slice(14, 16), "00", "分钟必须是 00");
});
t("defaultStartStamp：非今天取 09:00、已带时间原样、空值按今天", () => {
  assert.strictEqual(date.defaultStartStamp("2099-01-01"), "2099-01-01T09:00:00", "非今天应为当天 09:00");
  assert.strictEqual(date.defaultStartStamp("2099-01-01T14:30:00"), "2099-01-01T14:30:00", "已带时间应原样返回");
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  assert.strictEqual(
    date.defaultStartStamp().slice(11, 16),
    `${String(d.getHours()).padStart(2, "0")}:00`,
    "不传参数时按今天处理"
  );
});

// ---- 服务器地址变更检测（改了「服务器地址」但没重新发现日历的场景）----
const syncMod = require(path.join(outDir, "sync.js"));
t("originOf：取协议 + 主机 + 端口", () => {
  assert.strictEqual(syncMod.originOf("http://127.0.0.1:5232/testuser/work/"), "http://127.0.0.1:5232");
  assert.strictEqual(syncMod.originOf("https://dav.example.com/cal/"), "https://dav.example.com");
  assert.strictEqual(syncMod.originOf("不是网址"), "", "解析失败应返回空串");
});
t("staleCalendarNames：改服务器地址后能检出仍指向旧地址的日历", () => {
  const cals = [
    { url: "http://127.0.0.1:5232/testuser/work/", displayName: "工作" },
    { url: "http://127.0.0.1:5232/testuser/personal/", displayName: "个人" }
  ];
  assert.deepStrictEqual(syncMod.staleCalendarNames("http://127.0.0.1:5232/", cals), [], "同源不应误报");
  assert.deepStrictEqual(
    syncMod.staleCalendarNames("http://new-host:5232/", cals),
    ["工作", "个人"],
    "换主机应全部检出（否则会静默连旧服务器并「同步成功」）"
  );
  assert.deepStrictEqual(
    syncMod.staleCalendarNames("http://127.0.0.1:5233/", cals),
    ["工作", "个人"],
    "只改端口也算换了服务器"
  );
  assert.deepStrictEqual(syncMod.staleCalendarNames("", cals), [], "服务器地址为空时不误报");
});

console.log(`\n[core] ${passed} 项通过`);
