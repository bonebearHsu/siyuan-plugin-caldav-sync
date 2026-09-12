/** 月视图：6 行 x 7 列（周一起始） */
import { addDays, dateStampOfMs, todayStamp } from "../core/date";
import { chipHtml, calColorOf, occComparator, type ViewArgs } from "./view-common";
import { openDateAddMenu } from "./date-add-menu";

const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function renderMonthView({ ctx, viewEl, occurrences }: ViewArgs): void {
  const cursor = ctx.cursor;
  const y = +cursor.slice(0, 4);
  const m = +cursor.slice(5, 7);
  const first = new Date(y, m - 1, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7));

  const startMs = gridStart.getTime();
  const endMs = startMs + 42 * 86400000;
  const occMap = occurrences(startMs, endMs);
  const today = todayStamp();

  // 按日期分桶
  const buckets = new Map<string, { it: import("../core/types").CalItem; occ: string }[]>();
  for (const [it, occs] of occMap) {
    for (const occ of occs) {
      const day = occ.slice(0, 10);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day)!.push({ it, occ });
    }
  }

  const html: string[] = [];
  html.push(`<div class="cal-month"><div class="cal-month-weeks">${WEEK_LABELS.map((w) => `<div class="cal-month-weeklabel">${w}</div>`).join("")}</div><div class="cal-month-grid">`);
  for (let i = 0; i < 42; i++) {
    const day = addDays(dateStampOfMs(startMs), i);
    const inMonth = +day.slice(5, 7) === m;
    const isToday = day === today;
    const chips = (buckets.get(day) || [])
      .sort(occComparator(ctx.sortMode))
      .slice(0, 6)
      .map(({ it, occ }) => chipHtml(it, occ, calColorOf(ctx, it)))
      .join("");
    const more = (buckets.get(day) || []).length - 6;
    html.push(`<div class="cal-month-cell ${inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""}" data-day="${day}">
      <div class="cal-month-daynum">${isToday ? `<span class="cal-today-badge">${+day.slice(8, 10)}</span>` : +day.slice(8, 10)}</div>
      <div class="cal-month-chips">${chips}${more > 0 ? `<div class="cal-chip-more">还有 ${more} 项…</div>` : ""}</div>
    </div>`);
  }
  html.push(`</div></div>`);
  viewEl.innerHTML = html.join("");

  // 日期单元格双击：弹出新增事件/任务
  viewEl.querySelectorAll<HTMLElement>(".cal-month-cell").forEach((cell) => {
    cell.addEventListener("dblclick", (ev) => {
      if ((ev.target as HTMLElement).closest(".cal-chip")) return; // 双击已有事件本身则不新建
      openDateAddMenu(ctx, ev.clientX, ev.clientY, cell.dataset.day!);
    });
  });
}
