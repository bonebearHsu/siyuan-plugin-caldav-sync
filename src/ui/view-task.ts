/**
 * 任务视图：模仿思源「任务笔记管理」插件的下拉筛选风格。
 * 顶部一个筛选下拉（12 个维度 + 计数），下方展示当前筛选下的待办列表。
 */
import { addDays, diffDays, parseLocalStamp, startOfWeek, todayStamp } from "../core/date";
import type { CalItem } from "../core/types";
import { calColorOf, escape, keyOfItem, type ViewArgs } from "./view-common";
import { occurrencesInRange } from "../core/ics";

type FilterKey =
  | "today"
  | "tomorrow"
  | "next7"
  | "thisweek"
  | "future"
  | "overdue"
  | "past7"
  | "allincomplete"
  | "nodate"
  | "todaydone"
  | "yesterdaydone"
  | "doneall";

interface TaskFilter {
  key: FilterKey;
  label: string;
  match: (it: CalItem, due: string) => boolean;
}

function completedOn(it: CalItem, dateStr: string): boolean {
  return it.percent === 100 && !!it.completedAt && it.completedAt.slice(0, 10) === dateStr;
}

export function renderTaskView({ ctx, viewEl, occurrences }: ViewArgs): void {
  const today = todayStamp();
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const in7 = addDays(today, 7);
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const past7Start = addDays(today, -7);

  const filters: TaskFilter[] = [
    { key: "today", label: "今日", match: (_it, d) => !done(_it) && d === today },
    { key: "tomorrow", label: "明日", match: (_it, d) => !done(_it) && d === tomorrow },
    {
      key: "next7",
      label: "未来七天",
      match: (_it, d) => !done(_it) && d > tomorrow && d <= in7
    },
    {
      key: "thisweek",
      label: "本周",
      match: (_it, d) => !done(_it) && d >= weekStart && d <= weekEnd
    },
    { key: "future", label: "未来", match: (_it, d) => !done(_it) && d > in7 },
    { key: "overdue", label: "过期", match: (_it, d) => !done(_it) && !!d && d < today },
    {
      key: "past7",
      label: "过去七天",
      match: (_it, d) => !done(_it) && !!d && d >= past7Start && d < today
    },
    { key: "allincomplete", label: "所有未完成", match: (_it) => !done(_it) },
    { key: "nodate", label: "无日期", match: (_it, d) => !done(_it) && !d },
    { key: "todaydone", label: "今日已完成", match: (it) => completedOn(it, today) },
    { key: "yesterdaydone", label: "昨日已完成", match: (it) => completedOn(it, yesterday) },
    { key: "doneall", label: "已完成", match: (it) => done(it) }
  ];

  // 收集启用日历下的待办（含重复展开的下次到期）
  const enabled = new Set(ctx.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
  const todos: { it: CalItem; due: string }[] = [];
  const endMs = parseLocalStamp(addDays(today, 400)).getTime();
  for (const it of ctx.store.getAll()) {
    if (it.kind !== "todo" || it.deleted) continue;
    if (!enabled.has(it.calendarUrl)) continue;
    // 到期口径与 Dock 列表一致：优先截止时间，无截止时用开始时间
    const dueSrc = it.end || it.start;
    if (!dueSrc) {
      todos.push({ it, due: "" });
      continue;
    }
    const occs = occurrencesInRangeForTodo(it, endMs);
    todos.push({ it, due: occs.length && occs[0] ? occs[0].slice(0, 10) : dueSrc.slice(0, 10) });
  }

  const countOf = (f: TaskFilter) => todos.filter((t) => f.match(t.it, t.due)).length;
  const current: FilterKey = ((viewEl.dataset.filter as FilterKey) || "allincomplete") as FilterKey;

  const priorityLabel = (p?: number) => (p === 1 ? "紧急" : p === 3 ? "高" : p === 5 ? "中" : p === 9 ? "低" : "");

  function listHtml(filterKey: FilterKey): string {
    const f = filters.find((x) => x.key === filterKey)!;
    const list = todos.filter((t) => f.match(t.it, t.due));
    if (!list.length) {
      return `<div class="cal-task-empty">该筛选下暂无任务</div>`;
    }
    return list
      .map(({ it, due }) => {
        const k = keyOfItem(it);
        const isDone = done(it);
        const overdue = !isDone && !!due && due < today;
        const pr = priorityLabel(it.priority);
        const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
        const dueText = isDone
          ? it.completedAt
            ? "完成于 " + it.completedAt.slice(5, 10)
            : "已完成"
          : !due
          ? "无日期"
          : due === today
          ? "今天"
          : due === tomorrow
          ? "明天"
          : overdue
          ? `逾期 ${Math.abs(diffDays(due, today))} 天`
          : due.slice(5);
        return `
<div class="cal-task ${isDone ? "is-done" : ""} ${overdue ? "is-overdue" : ""}" data-open="${k}" style="--cal-color:${cal?.color || "#64748b"}">
  <button class="cal-task-check" data-toggle="${k}" title="${isDone ? "标记未完成" : "标记完成"}">${isDone ? "✓" : ""}</button>
  <div class="cal-task-body">
    <div class="cal-task-title">${it.rrule ? "↻ " : ""}${escape(it.summary || "(无标题)")}
      ${pr ? `<span class="cal-task-priority">${pr}</span>` : ""}</div>
    <div class="cal-task-meta">
      <span class="${overdue ? "cal-task-overdue" : ""}">${dueText}</span>
      ${it.description ? `<span class="cal-task-desc" title="${escape(it.description)}">${escape(it.description).slice(0, 40)}</span>` : ""}
      <span class="cal-task-cal"><i style="background:${calColorOf(ctx, it)}"></i>${escape(cal?.displayName || "")}</span>
    </div>
  </div>
</div>`;
      })
      .join("");
  }

  const total = todos.filter((t) => !done(t.it) && t.due === today).length;
  const overdueCount = todos.filter((t) => !done(t.it) && t.due && t.due < today).length;
  const doneCount = todos.filter((t) => done(t.it)).length;

  const optsHtml = filters
    .map((f) => `<option value="${f.key}" ${f.key === current ? "selected" : ""}>${f.label} (${countOf(f)})</option>`)
    .join("");

  viewEl.innerHTML = `
<div class="cal-task-view">
  <div class="cal-task-summary">
    <div class="cal-task-stat"><b>${todos.length}</b><span>待办</span></div>
    <div class="cal-task-stat cal-stat-today"><b>${total}</b><span>今日到期</span></div>
    <div class="cal-task-stat cal-stat-overdue"><b>${overdueCount}</b><span>已逾期</span></div>
    <div class="cal-task-stat cal-stat-done"><b>${doneCount}</b><span>已完成</span></div>
  </div>
  <div class="cal-task-filterbar">
    <select class="cal-task-filter" data-filter title="按条件筛选">${optsHtml}</select>
    <input class="caldav-input cal-task-quick" placeholder="快速添加待办，回车保存（默认今天）…" data-quickadd/>
  </div>
  <div class="cal-task-list">${listHtml(current)}</div>
</div>`;

  const select = viewEl.querySelector<HTMLSelectElement>("[data-filter]");
  select?.addEventListener("change", () => {
    const val = select.value as FilterKey;
    viewEl.dataset.filter = val;
    const list = viewEl.querySelector(".cal-task-list");
    if (list) list.innerHTML = listHtml(val);
  });

  const input = viewEl.querySelector<HTMLInputElement>("[data-quickadd]");
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      const cal = ctx.store.settings.calendars.find((c) => c.enabled && c.supportsTodo !== false) || ctx.store.settings.calendars[0];
      void ctx.sync
        .createItem({
          uid: genUid(),
          kind: "todo",
          calendarUrl: cal.url,
          href: cal.url.replace(/\/+$/, "") + "/" + genUid() + ".ics",
          summary: title,
          allDay: false,
          start: today + "T09:00:00",
          end: today + "T09:00:00",
          priority: 0,
          status: "NEEDS-ACTION",
          percent: 0,
          createdAt: today + "T09:00:00",
          dirty: true
        })
        .then(() => {
          input.value = "";
        });
    }
  });
}

function done(it: CalItem): boolean {
  return it.percent === 100;
}

function occurrencesInRangeForTodo(it: CalItem, endMs: number): string[] {
  return occurrencesInRange(it, parseLocalStamp(todayStamp()).getTime(), endMs);
}

export function genUid(): string {
  return "sy-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
