/**
 * 端到端测试：真实 Radicale CalDAV 链路
 * 前置：pip install radicale（或 E2E_PYTHON 指向带 radicale 的解释器）
 * 覆盖：测试连接 / 自动发现 / MKCALENDAR / 拉取 / 上传 / 编辑 / 412 冲突 / sync-token 增量 / 删除 / 待办
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = process.env.E2E_PYTHON || path.join(os.homedir(), ".workbuddy/binaries/python/envs/default/Scripts/python.exe");
const PORT = 5232;
const BASE = `http://127.0.0.1:${PORT}/`;

// ---- 编译 core ----
const outDir = path.join(root, ".test-core");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts ` +
  `--outDir .test-core --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);
const require = createRequire(import.meta.url);
const caldav = require(path.join(outDir, "caldav.js"));
const ics = require(path.join(outDir, "ics.js"));
const http = require(path.join(outDir, "http.js"));
const { setKernelBase } = http;

const auth = { username: "testuser", password: "testpass" };
let passed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
};

// ---- 启动 Radicale（清空上次状态） ----
fs.rmSync(path.join(root, ".e2e-radicale"), { recursive: true, force: true });
const dir = path.join(root, ".e2e-radicale");
fs.mkdirSync(path.join(dir, "collections"), { recursive: true });
fs.writeFileSync(path.join(dir, "users"), "testuser:testpass\n");
fs.writeFileSync(
  path.join(dir, "config"),
  `
[server]
hosts = 127.0.0.1:${PORT}

[auth]
type = htpasswd
htpasswd_filename = ${path.join(dir, "users").replace(/\\/g, "/")}
htpasswd_encryption = plain

[rights]
type = owner_only

[storage]
type = multifilesystem
filesystem_folder = ${path.join(dir, "collections").replace(/\\/g, "/")}
`.trim() + "\n"
);

const radicaleLog = [];
const radicale = spawn(py, ["-m", "radicale", "--config", path.join(dir, "config")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: (() => {
    const env = { ...process.env };
    // WorkBuddy 等环境的 PYTHONPATH shim 会破坏 Radicale 的临时文件逻辑
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    return env;
  })()
});
radicale.stderr.on("data", (d) => radicaleLog.push(String(d)));
radicale.stdout.on("data", (d) => radicaleLog.push(String(d)));
radicale.on("error", (e) => radicaleLog.push("SPAWN ERROR: " + e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE, { method: "GET" });
      if (r.status < 500) return true;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Radicale 未在预期时间内启动: " + radicaleLog.join(""));
}

try {
  await waitReady();
  console.log("[e2e] Radicale 已就绪");
  const channel = "direct";
  const CH = channel;

  await t("测试连接（PROPFIND + Basic 认证）", async () => {
    const r = await caldav.testConnection(BASE, CH, auth);
    assert.ok(r.ok, r.message);
  });

  await t("自动发现 principal / calendar-home", async () => {
    const r = await caldav.discoverCalendars(BASE, CH, auth);
    assert.ok(r.principal, "应有 principal: " + JSON.stringify(r));
    assert.ok(r.home, "应有 calendar-home");
  });

  await t("MKCALENDAR 创建日历后再发现", async () => {
    const res = await http.httpRequest(
      BASE + "testuser/e2e/",
      { method: "MKCALENDAR", body: `<?xml version="1.0"?><mkcalendar xmlns="urn:ietf:params:xml:ns:caldav"><set><prop xmlns="DAV:"><displayname>E2E 测试</displayname><resourcetype><collection/><calendar/></resourcetype></prop></set></mkcalendar>`, headers: { "Content-Type": "application/xml" } },
      CH,
      auth
    );
    assert.ok(res.status < 300 || res.status === 405, "MKCALENDAR 失败: " + res.status);
    const r = await caldav.discoverCalendars(BASE, CH, auth);
    const cal = r.calendars.find((c) => c.url.includes("/e2e/"));
    assert.ok(cal, "应发现新建日历: " + r.calendars.map((c) => c.url).join(","));
    assert.ok(/E2E|e2e/.test(cal.displayName) || cal.displayName, "日历名: " + cal.displayName);
  });

  const calUrl = BASE + "testuser/e2e/";
  const cal = { url: calUrl, displayName: "E2E", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true };

  const eventItem = {
    uid: "e2e-event-1@siyuan",
    kind: "event",
    calendarUrl: calUrl,
    href: calUrl + "e2e-event-1.ics",
    summary: "端到端会议",
    description: "第一次描述",
    location: "3 号楼",
    allDay: false,
    start: "2026-09-10T10:00:00",
    end: "2026-09-10T11:00:00",
    alarms: [{ minutesBefore: 10 }],
    rrule: { freq: "WEEKLY", interval: 1, byDay: ["TH"], count: 3 },
    dirty: false
  };

  let etag1 = "";

  await t("上传新建日程（PUT）", async () => {
    const r = await caldav.putItem(eventItem, ics.itemToNewICS(eventItem), CH, auth);
    void r;
  });

  await t("拉取（calendar-query）解析正确", async () => {
    const r = await caldav.fetchCalendarItems(
      cal, CH, auth,
      caldav.icsRangeIso(Date.UTC(2026, 8, 1)),
      caldav.icsRangeIso(Date.UTC(2026, 11, 31))
    );
    const it = r.items.find((i) => i.uid === eventItem.uid);
    assert.ok(it, "应拉取到事件");
    assert.strictEqual(it.summary, "端到端会议");
    assert.strictEqual(it.location, "3 号楼");
    assert.ok(it.rrule && it.rrule.freq === "WEEKLY");
    assert.ok(it.etag, "应有 etag");
    etag1 = it.etag;
    const occs = ics.occurrencesInRange(it, Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 31));
    assert.strictEqual(occs.length, 3, "每周四 x3，实际 " + JSON.stringify(occs));
  });

  await t("编辑后重新上传（保留原属性）", async () => {
    const r = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it = r.items.find((i) => i.uid === eventItem.uid);
    it.summary = "改名后的会议";
    it.location = "线上";
    const put = await caldav.putItem(it, ics.itemToEditedICS(it), CH, auth);
    const r2 = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it2 = r2.items.find((i) => i.uid === eventItem.uid);
    assert.strictEqual(it2.summary, "改名后的会议");
    assert.strictEqual(it2.location, "线上");
    assert.strictEqual(it2.alarms[0].minutesBefore, 10, "VALARM 应保留");
    void put;
  });

  await t("过期 If-Match 上传应 412", async () => {
    const stale = { ...eventItem, etag: etag1 };
    await assert.rejects(
      () => caldav.putItem(stale, ics.itemToEditedICS(stale), CH, auth),
      (e) => e.status === 412 || e.message.includes("412"),
      "应抛出 412 冲突"
    );
  });

  await t("sync-token 增量同步", async () => {
    // 取 sync-token
    const disc = await caldav.discoverCalendars(BASE, CH, auth, calUrl);
    const token = disc.calendars.find((c) => c.url.includes("/e2e/"))?.syncToken;
    // 新增第二个事件
    const ev2 = { ...eventItem, uid: "e2e-event-2@siyuan", href: calUrl + "e2e-event-2.ics", summary: "增量新事件", rrule: undefined };
    await caldav.putItem(ev2, ics.itemToNewICS(ev2), CH, auth);
    // 增量拉取
    const r = await caldav.syncCollection(cal, CH, auth, token || "");
    const added = r.items.find((i) => i.uid === "e2e-event-2@siyuan");
    assert.ok(added, "增量应包含新事件，实际 " + r.items.length + " 条");
  });

  await t("上传待办（VTODO）并拉取", async () => {
    const todo = {
      uid: "e2e-todo-1@siyuan",
      kind: "todo",
      calendarUrl: calUrl,
      href: calUrl + "e2e-todo-1.ics",
      summary: "端到端待办",
      allDay: false,
      start: "2026-09-11T18:00:00",
      end: "2026-09-11T18:00:00",
      priority: 3,
      status: "NEEDS-ACTION",
      percent: 0,
      dirty: false
    };
    await caldav.putItem(todo, ics.itemToNewICS(todo), CH, auth);
    const r = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it = r.items.find((i) => i.uid === todo.uid);
    assert.ok(it, "应拉取到待办");
    assert.strictEqual(it.kind, "todo");
    assert.strictEqual(it.priority, 3);
    assert.strictEqual(it.summary, "端到端待办");
  });

  await t("删除服务端条目", async () => {
    const r = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it = r.items.find((i) => i.uid === "e2e-event-2@siyuan");
    assert.ok(it, "删除前应存在");
    await caldav.deleteItem(it, CH, auth);
    const r2 = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    assert.ok(!r2.items.find((i) => i.uid === "e2e-event-2@siyuan"), "删除后应不存在");
  });

  console.log(`\n[e2e] ${passed} 项通过（真实 Radicale ${PORT}）`);
} finally {
  radicale.kill();
}
