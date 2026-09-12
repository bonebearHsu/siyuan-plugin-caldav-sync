/** 视图渲染公共类型 */
import type { CalItem, SortMode } from "../core/types";
import type { PanelCtx } from "./panel";

export interface ViewArgs {
  ctx: PanelCtx;
  viewEl: HTMLElement;
  occurrences: (startMs: number, endMs: number) => Map<CalItem, string[]>;
}

export function keyOfItem(it: CalItem): string {
  return it.recurId ? `${it.uid}|${it.recurId}|${it.kind}` : `${it.uid}|${it.kind}`;
}

/** 条目 chip 公共结构 */
export function chipHtml(it: CalItem, occ: string, calColor: string): string {
  const k = keyOfItem(it);
  const done = it.kind === "todo" && it.percent === 100;
  const timeLabel = it.allDay ? "" : `<span class="cal-chip-time">${occ.slice(11, 16)}</span>`;
  if (it.kind === "todo") {
    return `<div class="cal-chip cal-chip-todo ${done ? "is-done" : ""}" data-open="${k}" style="--cal-color:${calColor}">
      <button class="cal-chip-check" data-toggle="${k}" title="${done ? "标记未完成" : "标记完成"}">✓</button>
      <span class="cal-chip-title">${escape(it.summary || "(无标题)")}</span>
    </div>`;
  }
  return `<div class="cal-chip ${done ? "is-done" : ""}" data-open="${k}" style="--cal-color:${calColor}">
    ${timeLabel}<span class="cal-chip-title">${repeatMark(it)}${escape(it.summary || "(无标题)")}</span>
  </div>`;
}

export function repeatMark(it: CalItem): string {
  return it.rrule ? '<span class="cal-chip-repeat" title="重复">↻</span>' : "";
}

export function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function calColorOf(ctx: PanelCtx, it: CalItem): string {
  const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
  return cal?.color || "#64748b";
}

/** 条目某排序键的取值（用于比较；字符串统一字典序比较） */
function sortValueOf(mode: SortMode, it: CalItem, occ: string): string | number {
  switch (mode) {
    case "end":
      return it.end || occ;
    case "priority":
      return it.priority && it.priority > 0 ? it.priority : 9; // 无优先级视为最低（9）
    case "completed":
      return it.completedAt || "9999-12-31T23:59:59"; // 未完成/无完成时间排最后
    case "created":
      return it.createdAt || it.start;
    case "category":
      return (it.categories && it.categories[0]) || "";
    case "title":
      return (it.summary || "").toLowerCase();
    case "start":
    default:
      return occ;
  }
}

/**
 * 事件排序比较器，支持 7 种模式：
 * start 开始时间 / end 结束时间 / priority 优先级 / completed 完成时间 /
 * created 创建时间 / category 分类 / title 标题。
 * 用于月视图单元格、周视图全天行等列表；并列时回退展开实例开始时间。
 */
export function occComparator(mode: SortMode) {
  return (a: { it: CalItem; occ: string }, b: { it: CalItem; occ: string }): number => {
    const av = sortValueOf(mode, a.it, a.occ);
    const bv = sortValueOf(mode, b.it, b.occ);
    if (av < bv) return -1;
    if (av > bv) return 1;
    // 并列回退：开始时间 → 标题
    if (a.occ !== b.occ) return a.occ < b.occ ? -1 : 1;
    return (a.it.summary || "").localeCompare(b.it.summary || "", "zh");
  };
}
