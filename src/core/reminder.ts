/**
 * 提醒引擎：扫描本地条目，对「设置了提醒时间（VALARM / alarms）」的日程/待办，
 * 在「开始/到期时间 - 提前量」的时刻弹出系统通知（声音由系统通知自带）。
 *
 * 设计要点：
 * - 只提醒带 alarms 的条目（用户约定：没设提醒时间的条目不提醒）。
 * - 仅在提醒时刻晚于当前时才排程；错过的不补（避免一启动就轰炸历史条目）。
 * - 重复条目只排「下一个未来实例」，触发后由周期 rescan 推进到再下一个。
 * - 思源托盘运行时渲染进程不退出，setTimeout 照常触发；rescan 兜底防后台节流。
 */
import type { CalItem } from "./types";
import { occurrencesInRange } from "./ics";
import { parseLocalStamp, stampOfMs } from "./date";

/** 最多提前排程的 horizon，超过的等 rescan 推进 */
const HORIZON_MS = 24 * 86400000;
/** 周期重扫间隔，兜底捕捉新同步条目 / 后台节流漏掉的触发 */
const RESCAN_MS = 60_000;

export interface ReminderFire {
  (item: CalItem, anchorISO: string, alarmMin: number): void;
}

interface ReminderSlot {
  key: string;
  fireAt: number;
  item: CalItem;
  /** 触发所依据的实例开始/到期时刻（本地墙上时间，用作展示与去重 key） */
  anchorISO: string;
  alarmMin: number;
}

export class ReminderEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private rescan: ReturnType<typeof setInterval> | null = null;
  private now: () => number;

  constructor(
    private getItems: () => CalItem[],
    private fire: ReminderFire,
    now?: () => number
  ) {
    this.now = now || (() => Date.now());
  }

  start(): void {
    this.scheduleAll();
    this.rescan = setInterval(() => this.scheduleAll(), RESCAN_MS);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.rescan) {
      clearInterval(this.rescan);
      this.rescan = null;
    }
  }

  /** 外部数据变更后调用（同步完成 / 设置变更），重新排程 */
  reschedule(): void {
    this.scheduleAll();
  }

  /** 计算每个条目下一个未来提醒槽位 */
  private slots(): ReminderSlot[] {
    const now = this.now();
    const fromMs = now;
    const toMs = now + HORIZON_MS;
    const out: ReminderSlot[] = [];
    for (const item of this.getItems()) {
      if (!item.alarms?.length || item.deleted) continue;
      // 已完成的待办不再提醒
      if (item.kind === "todo" && item.percent === 100) continue;
      const occMs = this.nextOccurrences(item, fromMs, toMs);
      if (!occMs.length) continue;
      const anchorMs = Math.min(...occMs);
      const anchorISO = stampFromMs(anchorMs, item.allDay);
      for (const a of item.alarms) {
        const fireAt = anchorMs - a.minutesBefore * 60000;
        if (fireAt <= now + 1000) continue; // 只排未来；错过不补
        if (fireAt > now + HORIZON_MS) continue; // 太远等 rescan 推进
        const key = `${item.uid}|${item.recurId || ""}|${a.minutesBefore}|${anchorISO}`;
        out.push({ key, fireAt, item, anchorISO, alarmMin: a.minutesBefore });
      }
    }
    return out;
  }

  scheduleAll(): void {
    const want = new Map(this.slots().map((s) => [s.key, s]));
    // 移除不再需要 / 时点变化的旧 timer
    for (const [key, t] of Array.from(this.timers)) {
      if (!want.has(key)) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
    const now = this.now();
    for (const slot of want.values()) {
      if (this.timers.has(slot.key)) continue; // 已排程
      const delay = Math.max(0, slot.fireAt - now);
      const timer = setTimeout(() => {
        this.timers.delete(slot.key);
        try {
          this.fire(slot.item, slot.anchorISO, slot.alarmMin);
        } catch (e) {
          console.warn("[caldav] 提醒触发异常", e);
        }
      }, delay);
      this.timers.set(slot.key, timer);
    }
  }

  /** 返回条目的若干未来发生时刻（毫秒）：事件用 start，待办用 due(end) */
  private nextOccurrences(item: CalItem, fromMs: number, toMs: number): number[] {
    const anchor = item.kind === "todo" ? item.end || item.start : item.start;
    if (!anchor || !item.start) return [];
    if (!item.rrule) return [parseLocalStamp(anchor).getTime()];
    // 重复：以 start 展开，再按 start→anchor 的时差平移，得到 anchor 的实例时刻
    const delta = parseLocalStamp(anchor).getTime() - parseLocalStamp(item.start).getTime();
    return occurrencesInRange(item, fromMs - delta, toMs - delta)
      .map((s) => parseLocalStamp(s).getTime() + delta)
      .filter((ms) => ms >= fromMs);
  }
}

function stampFromMs(ms: number, allDay?: boolean): string {
  if (allDay) {
    const d = new Date(ms);
    const p = (n: number) => (n < 10 ? "0" + n : "" + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return stampOfMs(ms);
}
