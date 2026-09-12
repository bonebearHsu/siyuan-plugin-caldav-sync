/**
 * ICS (RFC 5545) 解析与序列化
 * - 解析 VEVENT / VTODO（含 VALARM、RRULE、EXDATE、RECURRENCE-ID）
 * - 序列化时在原 ICS 基础上替换目标组件，尽量保留本插件不管理的属性（ORGANIZER / ATTENDEE 等）
 * - 写出的时间统一为 UTC（Z 后缀），避免时区歧义
 */
import type { Alarm, CalItem, CalKind, LocalStamp, Recurrence } from "./types";
import {
  dateStampOfMs, isDateOnly, parseLocalStamp, stampOfMs, zoneOffsetMs, weekdayIndexOfCode, padDate
} from "./date";
import { pad2 } from "./types";

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

// ---------- 基础解析 ----------

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

function parseProp(line: string): IcsProp {
  // NAME;PARAM=V;PARAM=V:value  （value 中可含冒号）
  let inQuote = false;
  let splitAt = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) { splitAt = i; break; }
  }
  if (splitAt < 0) return { name: line.toUpperCase(), params: {}, value: "" };
  const head = line.slice(0, splitAt);
  const value = line.slice(splitAt + 1);
  const segs = head.split(";");
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf("=");
    if (eq > 0) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function parseICS(text: string): IcsComponent {
  const root: IcsComponent = { type: "ROOT", props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const line of unfold(text)) {
    const m = /^(BEGIN|END):(.+)$/i.exec(line);
    if (m) {
      const type = m[2].trim().toUpperCase();
      if (m[1].toUpperCase() === "BEGIN") {
        const comp: IcsComponent = { type, props: [], children: [] };
        stack[stack.length - 1].children.push(comp);
        stack.push(comp);
      } else {
        while (stack.length > 1 && stack[stack.length - 1].type !== type) stack.pop();
        if (stack.length > 1) stack.pop();
      }
      continue;
    }
    stack[stack.length - 1].props.push(parseProp(line));
  }
  return root;
}

function findComponents(comp: IcsComponent, type: string, out: IcsComponent[] = []): IcsComponent[] {
  for (const c of comp.children) {
    if (c.type === type) out.push(c);
    findComponents(c, type, out);
  }
  return out;
}

function firstProp(comp: IcsComponent, name: string): IcsProp | undefined {
  return comp.props.find((p) => p.name === name);
}

// ---------- 时间值解析 ----------

function parseIcsStamp(prop: IcsProp): LocalStamp {
  const v = prop.value.trim();
  // DATE 值
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return stampOfMs(Date.now());
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (z === "Z") {
    const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
    return stampOfMs(ms);
  }
  const tzid = prop.params["TZID"];
  if (tzid) {
    const naive = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
    const guess = naive - zoneOffsetMs(tzid, naive);
    const ms = naive - zoneOffsetMs(tzid, guess);
    return stampOfMs(ms);
  }
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss}`; // 浮动时间按本地
}

// ---------- RRULE / EXDATE ----------

export function parseRRule(value: string): Recurrence | undefined {
  const parts: Record<string, string> = {};
  for (const seg of value.split(";")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  const freq = (parts["FREQ"] || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return undefined;
  const r: Recurrence = {
    freq: freq as Recurrence["freq"],
    interval: parts["INTERVAL"] ? Math.max(1, +parts["INTERVAL"] || 1) : 1
  };
  if (parts["BYDAY"]) r.byDay = parts["BYDAY"].split(",").map((s) => s.trim().slice(-2).toUpperCase());
  if (parts["BYMONTHDAY"]) r.byMonthDay = parts["BYMONTHDAY"].split(",").map((n) => +n).filter((n) => n);
  if (parts["COUNT"]) r.count = +parts["COUNT"];
  if (parts["UNTIL"]) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts["UNTIL"]);
    if (m) {
      r.until = m[4]
        ? stampOfMs(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
        : `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return r;
}

export function serializeRRule(r: Recurrence): string {
  const segs = [`FREQ=${r.freq}`];
  if (r.interval > 1) segs.push(`INTERVAL=${r.interval}`);
  if (r.byDay?.length) segs.push(`BYDAY=${r.byDay.join(",")}`);
  if (r.byMonthDay?.length) segs.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.count) segs.push(`COUNT=${r.count}`);
  if (r.until) {
    const d = parseLocalStamp(r.until);
    if (isDateOnly(r.until)) segs.push(`UNTIL=${r.until.replace(/-/g, "")}`);
    else segs.push(`UNTIL=${icsUtc(d.getTime())}`);
  }
  return segs.join(";");
}

function parseExdates(comp: IcsComponent): LocalStamp[] {
  const out: LocalStamp[] = [];
  for (const p of comp.props) {
    if (p.name === "EXDATE") {
      for (const v of p.value.split(",")) out.push(parseIcsStamp({ ...p, value: v.trim() }));
    }
  }
  return out;
}

// ---------- 组件 -> CalItem ----------

function itemFromComponent(comp: IcsComponent, kind: CalKind, calendarUrl: string, href: string, etag?: string): CalItem | undefined {
  const uid = firstProp(comp, "UID")?.value || href;
  const summary = unescapeText(firstProp(comp, "SUMMARY")?.value || "");
  const startProp = firstProp(comp, kind === "event" ? "DTSTART" : "DUE");
  if (!startProp && kind === "event") return undefined;
  const item: CalItem = {
    uid,
    kind,
    calendarUrl,
    href,
    etag,
    summary,
    allDay: kind === "event" ? !!(startProp && /^\d{8}$/.test(startProp.value.trim())) : false,
    start: startProp ? parseIcsStamp(startProp) : ""
  };
  const desc = firstProp(comp, "DESCRIPTION");
  if (desc?.value) item.description = unescapeText(desc.value);
  const loc = firstProp(comp, "LOCATION");
  if (loc?.value) item.location = unescapeText(loc.value);
  const cats = firstProp(comp, "CATEGORIES");
  if (cats?.value) item.categories = cats.value.split(",").map((s) => unescapeText(s.trim())).filter(Boolean);
  if (kind === "event") {
    const endProp = firstProp(comp, "DTEND");
    if (endProp) {
      const end = parseIcsStamp(endProp);
      // 无 DTEND 时按零时长
      item.end = end;
    } else {
      const dur = firstProp(comp, "DURATION");
      if (dur) {
        const mins = parseDurationMinutes(dur.value);
        item.end = addMinutesStamp(item.start, mins);
      } else {
        item.end = item.allDay ? addDaysStamp(item.start, 1) : item.start;
      }
    }
  } else {
    item.end = startProp ? parseIcsStamp(startProp) : undefined;
    const pr = firstProp(comp, "PRIORITY");
    if (pr?.value) item.priority = +pr.value || 0;
    const st = firstProp(comp, "STATUS");
    if (st?.value) item.status = st.value.toUpperCase();
    const pc = firstProp(comp, "PERCENT-COMPLETE");
    if (pc?.value) item.percent = Math.min(100, Math.max(0, +pc.value || 0));
    const cm = firstProp(comp, "COMPLETED");
    if (cm?.value) item.completedAt = parseIcsStamp(cm);
    if (item.status === "COMPLETED") item.percent = 100;
  }
  const rr = firstProp(comp, "RRULE");
  if (rr?.value) item.rrule = parseRRule(rr.value);
  const created = firstProp(comp, "CREATED");
  if (created?.value) item.createdAt = parseIcsStamp(created);
  const rid = firstProp(comp, "RECURRENCE-ID");
  if (rid) item.recurId = parseIcsStamp(rid);
  const ex = parseExdates(comp);
  if (ex.length) item.exdates = ex;
  const alarms: Alarm[] = [];
  for (const a of findComponents(comp, "VALARM")) {
    const trig = firstProp(a, "TRIGGER");
    if (!trig) continue;
    const m = /^-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(trig.value.trim().toUpperCase());
    if (m) {
      const mins = (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
      if (trig.value.trim().toUpperCase().startsWith("-P") || mins === 0) alarms.push({ minutesBefore: mins });
    }
  }
  if (alarms.length) item.alarms = alarms;
  return item;
}

function parseDurationMinutes(v: string): number {
  const m = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(v.toUpperCase());
  if (!m) return 0;
  return (+(m[1] || 0)) * 10080 + (+(m[2] || 0)) * 1440 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}

function addMinutesStamp(stamp: LocalStamp, mins: number): LocalStamp {
  if (isDateOnly(stamp)) return stamp;
  const d = parseLocalStamp(stamp);
  return stampOfMs(d.getTime() + mins * 60000);
}

function addDaysStamp(stamp: LocalStamp, days: number): LocalStamp {
  const d = parseLocalStamp(stamp);
  d.setDate(d.getDate() + days);
  return dateStampOfMs(d.getTime());
}

/** 解析一个 ICS 文本为条目列表（同文件多组件时各取一条，href 相同） */
export function itemsFromICS(text: string, calendarUrl: string, href: string, etag?: string): CalItem[] {
  const root = parseICS(text);
  const items: CalItem[] = [];
  for (const comp of findComponents(root, "VEVENT")) {
    const it = itemFromComponent(comp, "event", calendarUrl, href, etag);
    if (it) items.push(it);
  }
  for (const comp of findComponents(root, "VTODO")) {
    const it = itemFromComponent(comp, "todo", calendarUrl, href, etag);
    if (it) items.push(it);
  }
  return items;
}

// ---------- 文本转义 ----------

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function unescapeText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

// ---------- 序列化 ----------

function icsUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

function stampToIcs(stamp: LocalStamp, dateOnly: boolean): string {
  if (dateOnly) return stamp.replace(/-/g, "");
  return icsUtc(parseLocalStamp(stamp).getTime());
}

function foldLine(line: string): string {
  // 按 74 字节折叠（近似：按码元折叠，ASCII 场景精确）
  if (line.length <= 74) return line;
  const parts: string[] = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    parts.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

/** 本插件管理的属性名（编辑时重建，其余属性原样保留） */
const MANAGED = new Set([
  "SUMMARY", "DESCRIPTION", "LOCATION", "CATEGORIES",
  "DTSTART", "DTEND", "DUE", "DURATION", "RRULE", "EXDATE", "RECURRENCE-ID",
  "STATUS", "PRIORITY", "PERCENT-COMPLETE", "COMPLETED",
  "DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "TZID"
]);

function propLine(name: string, params: Record<string, string>, value: string): string {
  let head = name;
  for (const k of Object.keys(params)) head += `;${k}=${params[k]}`;
  return foldLine(`${head}:${value}`);
}

/** 重建目标组件的属性列表：保留未管理属性，重写受管理属性 */
function rebuildComponent(comp: IcsComponent, item: CalItem): IcsComponent {
  const kept = comp.props.filter((p) => !MANAGED.has(p.name));
  const props: IcsProp[] = [];
  const push = (name: string, value: string, params: Record<string, string> = {}) => {
    if (value !== "" && value !== undefined) props.push({ name, params, value });
  };
  push("UID", firstProp(comp, "UID")?.value || item.uid);
  // 保留的时间无关属性
  for (const p of kept) props.push(p);

  push("SUMMARY", escapeText(item.summary || ""));
  if (item.description) push("DESCRIPTION", escapeText(item.description));
  if (item.location) push("LOCATION", escapeText(item.location));
  if (item.categories?.length) push("CATEGORIES", item.categories.map(escapeText).join(","));

  const dateOnly = item.allDay;
  push("DTSTART", stampToIcs(item.start, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
  if (item.kind === "event") {
    const end = item.end || (dateOnly ? addDaysStamp(item.start, 1) : item.start);
    push("DTEND", stampToIcs(end, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
  } else {
    if (item.end) push("DUE", stampToIcs(item.end, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
    if (item.priority) push("PRIORITY", String(item.priority));
    push("STATUS", item.percent === 100 ? "COMPLETED" : item.status === "IN-PROCESS" ? "IN-PROCESS" : "NEEDS-ACTION");
    if (item.percent !== undefined && item.percent > 0) push("PERCENT-COMPLETE", String(item.percent));
    if (item.percent === 100) push("COMPLETED", icsUtc(Date.now()));
  }
  if (item.rrule) push("RRULE", serializeRRule(item.rrule));
  if (item.recurId) push("RECURRENCE-ID", stampToIcs(item.recurId, item.allDay), item.allDay ? { VALUE: "DATE" } : {});
  for (const ex of item.exdates || []) {
    push("EXDATE", stampToIcs(ex, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
  }
  const seq = firstProp(comp, "SEQUENCE");
  push("SEQUENCE", String((seq ? +seq.value || 0 : 0) + 1));
  push("DTSTAMP", icsUtc(Date.now()));
  push("LAST-MODIFIED", icsUtc(Date.now()));
  for (const a of item.alarms || []) {
    props.push({ name: "BEGIN", params: {}, value: "VALARM" });
    props.push({ name: "ACTION", params: {}, value: "DISPLAY" });
    props.push({ name: "DESCRIPTION", params: {}, value: escapeText(item.summary || "提醒") });
    props.push({ name: "TRIGGER", params: {}, value: `-PT${a.minutesBefore}M` });
    props.push({ name: "END", params: {}, value: "VALARM" });
  }
  return { type: comp.type, props, children: [] };
}

function compToLines(comp: IcsComponent): string[] {
  const lines = [`BEGIN:${comp.type}`];
  for (const p of comp.props) {
    const params = Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join("");
    lines.push(foldLine(`${p.name}${params}:${p.value}`));
  }
  for (const c of comp.children) lines.push(...compToLines(c));
  lines.push(`END:${comp.type}`);
  return lines;
}

/** 生成新建条目的 ICS */
export function itemToNewICS(item: CalItem): string {
  const comp = rebuildComponent(
    { type: item.kind === "event" ? "VEVENT" : "VTODO", props: [], children: [] },
    item
  );
  // 新建：无 SEQUENCE 递增需求，重置为 0
  comp.props = comp.props.filter((p) => p.name !== "SEQUENCE");
  comp.props.push({ name: "CREATED", params: {}, value: icsUtc(Date.now()) });
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WorkBuddy//SiYuan CalDAV//CN",
    ...compToLines(comp),
    "END:VCALENDAR"
  ];
  return lines.join("\r\n") + "\r\n";
}

/** 在原 ICS 基础上应用编辑（保留 ORGANIZER / ATTENDEE / VTIMEZONE 等） */
export function itemToEditedICS(item: CalItem): string {
  if (!item.raw) return itemToNewICS(item);
  const root = parseICS(item.raw);
  const target = item.kind === "event" ? "VEVENT" : "VTODO";
  const comps = findComponents(root, target);
  const match = comps.find((c) => firstProp(c, "UID")?.value === item.uid) || comps[0];
  const lines: string[] = [];
  const emit = (c: IcsComponent) => {
    if (c === match) {
      lines.push(...compToLines(rebuildComponent(c, item)));
    } else {
      lines.push(...compToLines(c));
    }
  };
  for (const c of root.children) emit(c);
  return lines.join("\r\n") + "\r\n";
}

/** RRULE 展开给定时间窗内的实例开始时间（不含 EXDATE 过滤） */
export function expandRepeats(item: CalItem, rangeStartMs: number, rangeEndMs: number): LocalStamp[] {
  if (!item.rrule) return [item.start];
  const r = item.rrule;
  const interval = Math.max(1, r.interval);
  const durMs = item.end ? parseLocalStamp(item.end).getTime() - parseLocalStamp(item.start).getTime() : 0;
  const out: LocalStamp[] = [];
  const untilMs = r.until ? parseLocalStamp(r.until).getTime() + (isDateOnly(r.until) ? 86399000 : 0) : Infinity;
  const hardUntil = Math.min(untilMs, rangeEndMs);
  const count = r.count && r.count > 0 ? r.count : Infinity;
  const base = parseLocalStamp(item.start);
  const baseMs = base.getTime();
  if (baseMs > hardUntil) return [item.start];

  const padD = (d: Date) => padDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  let produced = 0;
  const pushIfInRange = (d: Date) => {
    const ms = d.getTime();
    if (ms > hardUntil || produced >= count) return false;
    if (ms >= Math.max(rangeStartMs - durMs, baseMs)) {
      out.push(isDateOnly(item.start) ? padD(d) : stampOfMs(ms));
      produced++;
    }
    return ms <= hardUntil && produced <= count;
  };

  if (r.freq === "DAILY") {
    const d = new Date(base);
    for (let i = 0; ; i += interval) {
      d.setTime(baseMs + i * 86400000);
      if (d.getTime() > hardUntil || produced >= count) break;
      pushIfInRange(d);
      if (i * 86400000 > 366 * 86400000 * 5) break; // 安全阀
    }
  } else if (r.freq === "WEEKLY") {
    const byDay = r.byDay?.length ? r.byDay : null;
    const week0 = new Date(base);
    week0.setDate(week0.getDate() - ((week0.getDay() + 6) % 7)); // 周一起点
    // 统一转成「周一 = 0」的偏移，与 week0 对齐
    const toMondayOffset = (sundayBased: number) => (sundayBased + 6) % 7;
    for (let w = 0; ; w += interval) {
      if (produced >= count) break;
      const weekStart = new Date(week0);
      weekStart.setDate(week0.getDate() + w * 7);
      if (weekStart.getTime() - 7 * 86400000 > hardUntil) break;
      const offsets = byDay
        ? byDay.map((c) => toMondayOffset(weekdayIndexOfCode(c))).filter((i) => i >= 0).sort((a, b) => a - b)
        : [toMondayOffset(base.getDay())];
      for (const off of offsets) {
        const d2 = new Date(weekStart);
        d2.setDate(weekStart.getDate() + off);
        d2.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
        if (d2.getTime() < baseMs) continue;
        if (d2.getTime() > hardUntil || produced >= count) break;
        pushIfInRange(d2);
      }
      if (weekStart.getTime() > hardUntil) break;
      if (w > 520) break;
    }
  } else if (r.freq === "MONTHLY") {
    for (let m = 0; ; m += interval) {
      if (produced >= count) break;
      const d = new Date(base);
      d.setDate(1);
      d.setMonth(base.getMonth() + m);
      if (d.getFullYear() > base.getFullYear() + 20) break;
      const candidates: Date[] = [];
      if (r.byMonthDay?.length) {
        for (const md of r.byMonthDay) {
          const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          const dd = Math.min(md < 0 ? last + 1 + md : md, last);
          if (dd >= 1) candidates.push(new Date(d.getFullYear(), d.getMonth(), dd, base.getHours(), base.getMinutes(), base.getSeconds()));
        }
      } else {
        candidates.push(new Date(d));
        candidates[0].setDate(base.getDate());
      }
      candidates.sort((a, b) => a.getTime() - b.getTime());
      for (const c of candidates) {
        if (c.getTime() < baseMs) continue;
        if (c.getTime() > hardUntil || produced >= count) break;
        pushIfInRange(c);
      }
      if (new Date(d).setDate(28) > hardUntil && m > 0) break;
    }
  } else {
    // YEARLY
    for (let y = 0; ; y += interval) {
      if (produced >= count) break;
      const d = new Date(base);
      d.setFullYear(base.getFullYear() + y);
      if (d.getTime() > hardUntil || produced >= count) break;
      pushIfInRange(d);
      if (y > 30) break;
    }
  }
  return out.length ? out : [item.start];
}

/** 条目实例是否落在窗口内（展开重复并应用 EXDATE） */
export function occurrencesInRange(item: CalItem, rangeStartMs: number, rangeEndMs: number): LocalStamp[] {
  const ex = new Set((item.exdates || []).map((s) => (isDateOnly(s) ? s.slice(0, 10) : s.slice(0, 19))));
  return expandRepeats(item, rangeStartMs, rangeEndMs)
    .filter((s) => !ex.has(isDateOnly(s) ? s : s.slice(0, 19)));
}

export { padDate };
