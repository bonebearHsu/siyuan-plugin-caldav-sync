import { pad2, type LocalStamp } from "./types";

/** 本地时区某个 UTC 毫秒的墙上时间字段 */
interface WallFields {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: number; // 0=周日
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function wallOf(ms: number): WallFields {
  const dt = new Date(ms);
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    d: dt.getDate(),
    hh: dt.getHours(),
    mm: dt.getMinutes(),
    ss: dt.getSeconds(),
    weekday: dt.getDay()
  };
}

export function padDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** "YYYY-MM-DD" | "YYYY-MM-DDTHH:mm:ss" -> Date (本地时区) */
export function parseLocalStamp(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return new Date(NaN);
  return new Date(
    +m[1],
    +m[2] - 1,
    +m[3],
    m[4] ? +m[4] : 0,
    m[5] ? +m[5] : 0,
    m[6] ? +m[6] : 0
  );
}

export function stampOfMs(ms: number): LocalStamp {
  const w = wallOf(ms);
  return `${padDate(w.y, w.m, w.d)}T${pad2(w.hh)}:${pad2(w.mm)}:${pad2(w.ss)}`;
}

export function dateStampOfMs(ms: number): LocalStamp {
  const w = wallOf(ms);
  return padDate(w.y, w.m, w.d);
}

export function todayStamp(): LocalStamp {
  return dateStampOfMs(Date.now());
}

export function addDays(stamp: LocalStamp, days: number): LocalStamp {
  const d = parseLocalStamp(stamp);
  d.setDate(d.getDate() + days);
  return isDateOnly(stamp) ? dateStampOfMs(d.getTime()) : stampOfMs(d.getTime());
}

export function addMonths(stamp: LocalStamp, n: number): LocalStamp {
  const d = parseLocalStamp(stamp);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return isDateOnly(stamp) ? dateStampOfMs(d.getTime()) : stampOfMs(d.getTime());
}

export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function startOfDay(stamp: LocalStamp): LocalStamp {
  return stamp.slice(0, 10);
}

export function endOfDay(stamp: LocalStamp): LocalStamp {
  return isDateOnly(stamp) ? stamp : stamp.slice(0, 10) + "T23:59:59";
}

export function weekdayCode(d: Date): string {
  return WEEKDAYS[d.getDay()];
}

export function weekdayIndexOfCode(code: string): number {
  return WEEKDAYS.indexOf(code.toUpperCase());
}

/** 周一为一周开始的一周起点 */
export function startOfWeek(stamp: LocalStamp): LocalStamp {
  const d = parseLocalStamp(stamp);
  const wd = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - wd);
  return dateStampOfMs(d.getTime());
}

export function diffDays(a: LocalStamp, b: LocalStamp): number {
  return Math.round((parseLocalStamp(startOfDay(a)).getTime() - parseLocalStamp(startOfDay(b)).getTime()) / 86400000);
}

export function fmtTime(stamp: LocalStamp): string {
  if (isDateOnly(stamp)) return "全天";
  return stamp.slice(11, 16);
}

export function fmtDateCn(stamp: LocalStamp): string {
  return `${+stamp.slice(5, 7)}月${+stamp.slice(8, 10)}日`;
}

/**
 * 任意 IANA 时区下，把 UTC 毫秒映射为该时区的墙上时间毫秒差（用于解析 TZID）
 * 返回 zoneOffsetMs(tz, ms)：localWall = utc + offset
 */
const tzCache = new Map<string, Intl.DateTimeFormat>();
export function zoneOffsetMs(tz: string, ms: number): number {
  let fmt = tzCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      tzCache.set(tz, fmt);
    } catch {
      return -new Date().getTimezoneOffset() * 60000; // 未知时区按本地
    }
  }
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => +parts.find((p) => p.type === t)!.value;
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUTC - Math.floor(ms / 1000) * 1000;
}
