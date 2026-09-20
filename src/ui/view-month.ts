/** 月视图：6 行 x 7 列（周一起始） */
import { addDays, dateStampOfMs, todayStamp } from "../core/date";
import { monthChipHtml, calColorOf, type ViewArgs } from "./view-common";
import { openDateAddMenu } from "./date-add-menu";
import { isMobile } from "./device";

const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function renderMonthView({ ctx, viewEl, occurrences }: ViewArgs): void {
  const cursor = ctx.cursor;
  const y = +cursor.slice(0, 4);
  const m = +cursor.slice(5, 7);
  const first = new Date(y, m - 1, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7));

  // PC 端优先 5 行(35天)；若当月天数跨到第 6 行，则扩展到 6 行(42天)。
  // 移动端保持 6 行，便于瘦身逻辑。
  const firstDayOffset = (first.getDay() + 6) % 7; // 周一=0 ... 周日=6
  const daysInMonth = new Date(y, m, 0).getDate();
  const needsSixRows = firstDayOffset + daysInMonth > 35;
  const totalCells = isMobile() || needsSixRows ? 42 : 35;
  const totalWeeks = totalCells / 7;

  const startMs = gridStart.getTime();
  const endMs = startMs + totalCells * 86400000;
  const occMap = occurrences(startMs, endMs);
  const today = todayStamp();

  // 当前本地时间戳，用于「超过 3 个时优先显示当前时间之后最靠前的条目」
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const nowStamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  // 按日期分桶
  const buckets = new Map<string, { it: import("../core/types").CalItem; occ: string }[]>();
  for (const [it, occs] of occMap) {
    for (const occ of occs) {
      const day = occ.slice(0, 10);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day)!.push({ it, occ });
    }
  }

  // 移动端：按周统计是否有事件/任务，无事件周减少行高；PC 端固定等分。
  const rowTemplate = (() => {
    if (isMobile()) {
      const weekHasEvents: boolean[] = [];
      for (let w = 0; w < totalWeeks; w++) {
        let has = false;
        for (let d = 0; d < 7; d++) {
          const day = addDays(dateStampOfMs(startMs), w * 7 + d);
          if ((buckets.get(day) || []).length > 0) { has = true; break; }
        }
        weekHasEvents.push(has);
      }
      return `grid-template-rows: ${weekHasEvents.map((has) => (has ? "1.45fr" : "0.72fr")).join(" ")};`;
    }
    return `grid-template-rows: repeat(${totalWeeks}, 1fr);`;
  })();

  const MAX_CHIPS = 3;
  const html: string[] = [];
  html.push(`<div class="cal-month"><div class="cal-month-weeks">${WEEK_LABELS.map((w) => `<div class="cal-month-weeklabel">${w}</div>`).join("")}</div><div class="cal-month-grid" ${rowTemplate ? `style="${rowTemplate}"` : ""}>`);
  for (let i = 0; i < totalCells; i++) {
    const day = addDays(dateStampOfMs(startMs), i);
    const inMonth = +day.slice(5, 7) === m;
    const isToday = day === today;
    const fullList = (buckets.get(day) || []).sort((a, b) => a.occ.localeCompare(b.occ));
    // 超过 3 个时，优先显示当前时间之后最靠前的 3 个；
    // 若当前时间之后不足 3 个，则回退到当天最靠前的 3 个，保证格子始终尽量填满。
    let shown = fullList;
    if (fullList.length > MAX_CHIPS) {
      const future = fullList.filter(({ occ }) => occ >= nowStamp);
      shown = future.length >= MAX_CHIPS ? future.slice(0, MAX_CHIPS) : fullList.slice(0, MAX_CHIPS);
    }
    const chips = shown
      .slice(0, MAX_CHIPS)
      .map(({ it, occ }) => monthChipHtml(it, occ, calColorOf(ctx, it)))
      .join("");
    const more = fullList.length - shown.length;
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
