// 验证 parseDateTimeFromText 的解析逻辑（与 editor.ts 将写入的实现保持一致）
// 仅用于开发期自测，不参与插件运行。

const WEEKDAY_NUM = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function ymdStr(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDaysDate(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function parseDateTimeFromText(text) {
  const base = new Date();
  const startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  let dateObj = null;

  const REL = [
    ["今天", 0], ["今日", 0], ["明日", 1], ["明天", 1], ["大后天", 3], ["后天", 2],
    ["昨日", -1], ["昨天", -1], ["今", 0],
  ];
  for (const [k, off] of REL) {
    if (text.includes(k)) { dateObj = addDaysDate(base, off); break; }
  }

  if (!dateObj) {
    const WD = /(每)?\s*(下|本|这|上)?\s*(周|星期|礼拜)\s*([0-6一二三四五六日])/g;
    let m;
    while ((m = WD.exec(text))) {
      if (m[1] === "每") continue;
      const raw = m[4];
      let w;
      if (WEEKDAY_NUM[raw] !== undefined) w = WEEKDAY_NUM[raw];
      else { const n = +raw; w = n === 7 ? 0 : n; }
      const days = (w - base.getDay() + 7) % 7; // 未来最近的该星期几
      dateObj = addDaysDate(base, days);
      break;
    }
  }

  if (!dateObj) {
    const y = /(\d{4})[年./\-](\d{1,2})[月./\-](\d{1,2})(?:日|号)?/.exec(text);
    if (y) dateObj = new Date(+y[1], +y[2] - 1, +y[3]);
  }
  if (!dateObj) {
    const md = /(\d{1,2})[月./\-](\d{1,2})(?:日|号)?/.exec(text);
    if (md) {
      const d = new Date(base.getFullYear(), +md[1] - 1, +md[2]);
      if (d.getTime() < startOfToday.getTime()) d.setFullYear(base.getFullYear() + 1);
      dateObj = d;
    }
  }
  if (!dateObj) {
    const FEST = [["元旦", 1, 1], ["情人节", 2, 14], ["妇女节", 3, 8], ["劳动节", 5, 1], ["儿童节", 6, 1], ["国庆", 10, 1], ["圣诞节", 12, 25]];
    for (const [k, mm, dd] of FEST) {
      if (text.includes(k)) {
        const d = new Date(base.getFullYear(), mm - 1, dd);
        if (d.getTime() < startOfToday.getTime()) d.setFullYear(base.getFullYear() + 1);
        dateObj = d;
        break;
      }
    }
  }

  const times = [];
  let lastPeriod = null; // 'am' | 'pm'，无修饰的后续时间继承时段
  const TIME = /(上午|早上|早晨|凌晨|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,2})(?:(?:[:：](\d{1,2}))|点\s*(半|(\d{1,2})\s*分)?|时\s*(半|(\d{1,2})\s*分)?)/g;
  let tm;
  while ((tm = TIME.exec(text))) {
    let h = +tm[2];
    let m = 0;
    if (tm[3] !== undefined && tm[3] !== "") m = +tm[3];
    else if (tm[4] === "半") m = 30;
    else if (tm[5] !== undefined && tm[5] !== "") m = +tm[5];
    const mod = tm[1];
    if (mod === "上午" || mod === "早上" || mod === "早晨" || mod === "凌晨") { if (h === 12) h = 0; lastPeriod = "am"; }
    else if (mod === "中午") { if (h < 12) h += 12; lastPeriod = "pm"; }
    else if (mod === "下午" || mod === "傍晚" || mod === "晚上" || mod === "夜里") { if (h < 12) h += 12; lastPeriod = "pm"; }
    else if (mod === "半夜") { if (h === 12) h = 0; lastPeriod = "am"; }
    else {
      if (lastPeriod === "pm" && h < 12) h += 12;
      else if (lastPeriod === "am" && h === 12) h = 0;
    }
    h = Math.max(0, Math.min(23, h));
    m = Math.max(0, Math.min(59, m));
    times.push({ h, m });
  }

  if (!dateObj && times.length === 0) return null;
  const date = dateObj ?? base;
  const startDate = ymdStr(date);
  if (times.length === 0) return { startDate };
  const fmt = (t) => `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
  const t0 = times[0];
  if (times.length >= 2) {
    return { startDate, startTime: fmt(t0), endDate: startDate, endTime: fmt(times[1]) };
  }
  const end = addDaysDate(date, 0);
  end.setHours(t0.h, t0.m + 60, 0, 0);
  return { startDate, startTime: fmt(t0), endDate: ymdStr(end), endTime: fmt({ h: end.getHours(), m: end.getMinutes() }) };
}

// ---- 断言 ----
const cases = [
  ["周会 9月30日 14:00", { startDate: "2026-09-30", startTime: "14:00", endDate: "2026-09-30", endTime: "15:00" }],
  ["明天上午9点半开会", { startDate: "2026-09-26", startTime: "09:30", endDate: "2026-09-26", endTime: "10:30" }],
  ["下周一汇报", { startDate: "2026-09-28" }],
  ["今天14:00", { startDate: "2026-09-25", startTime: "14:00", endDate: "2026-09-25", endTime: "15:00" }],
  ["国庆放假", { startDate: "2026-10-01" }],
  ["2026年10月1日 08:30", { startDate: "2026-10-01", startTime: "08:30", endDate: "2026-10-01", endTime: "09:30" }],
  ["3月5日面试", { startDate: "2027-03-05" }],
  ["每周三例会", null],
  ["双11促销", null],
  ["下午3点到5点评审", { startDate: "2026-09-25", startTime: "15:00", endDate: "2026-09-25", endTime: "17:00" }],
  ["后天晚上8点", { startDate: "2026-09-27", startTime: "20:00", endDate: "2026-09-27", endTime: "21:00" }],
  ["提前15分钟提醒", null],
  ["周日下午3点碰头", { startDate: "2026-09-27", startTime: "15:00", endDate: "2026-09-27", endTime: "16:00" }],
];

let fail = 0;
for (const [input, expected] of cases) {
  const got = parseDateTimeFromText(input);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${JSON.stringify(input)} => ${JSON.stringify(got)}${ok ? "" : "  (期望 " + JSON.stringify(expected) + ")"}`);
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
