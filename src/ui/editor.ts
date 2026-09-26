/**
 * 日程 / 待办编辑弹窗（基于思源 Dialog）
 */
import { Dialog } from "siyuan";
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import { adoptMobileLayer } from "./mobile-layers";
import type { Alarm, CalCalendar, CalItem, CalKind, CategoryDef, Recurrence } from "../core/types";
import { DEFAULT_CATEGORIES, calEventColor } from "../core/types";
import { keyOf } from "../core/store";
import { addDays, defaultStartStamp, isDateOnly, parseLocalStamp, stampOfMs, todayStamp } from "../core/date";
import type { PanelCtx } from "./panel";
import { escape } from "./view-common";
import { icons } from "./icons";
import { enableDialogResize } from "./dialog-resize";
import { openCategoryManager } from "./category-manager";

export interface EditorPreset {
  item?: CalItem; // 编辑现有条目
  kind?: CalKind; // 新建时的种类
  start?: string; // 新建时的开始
  end?: string;
}

export function openEditor(ctx: PanelCtx, preset: EditorPreset): void {
  const editing = preset.item;
  const kind: CalKind = editing ? editing.kind : preset.kind || "event";
  const cals = ctx.store.settings.calendars;
  if (!cals.length) {
    alert("请先在设置中配置并发现 CalDAV 日历");
    return;
  }
  const defaultCal =
    cals.find((c) => c.url === ctx.store.settings.defaultCalendarUrl) ||
    cals.find((c) => c.enabled) ||
    cals[0];

  const isNew = !editing;
  // 新建时的默认开始时间：日期是今天就落在「下一个整点」，其它日期落在当天 09:00
  const newStart = defaultStartStamp(preset.start || todayStamp());
  const it: CalItem = editing
    ? { ...editing }
    : {
        uid: genUid(),
        kind,
        calendarUrl: defaultCal.url,
        href: defaultCal.url.replace(/\/+$/, "") + "/" + genUid() + ".ics",
        summary: "",
        allDay: false,
        start: newStart,
        end: preset.end || addHoursStr(newStart, 1),
        priority: 0,
        status: "NEEDS-ACTION",
        percent: 0,
        createdAt: todayStamp() + "T" + new Date().toTimeString().slice(0, 8)
      };
  if (kind === "todo" && isNew) it.end = undefined; // 待办默认无截止，由用户按需填写

  const isTodo = it.kind === "todo";
  // 移动端竖屏（375~430px）放不下 520/560px 定宽弹窗，改为占满视口
  const mobile = isMobile();

  const dialog = newDialog({
    title: isNew ? (isTodo ? "新建待办" : "新建日程") : "编辑" + (isTodo ? "待办" : "日程"),
    content: `<div class="caldav-editor">${editorHtml(it, cals, ctx.store.settings.categories?.length ? ctx.store.settings.categories : DEFAULT_CATEGORIES, !!ctx.store.settings.categoryMulti, isNew)}</div>`,
    width: mobile ? "100vw" : isTodo ? "560px" : "520px",
    height: mobile ? "100vh" : "86vh",
    containerClassName: mobile ? "caldav-mobile-dialog" : undefined
  });
  // 移动端：编辑弹窗是「叠在当前页面之上」的一层，同时只留一个。
  // 层的收放一律以 DOM 为准（见 ui/mobile-layers.ts），关闭时不需要再回账。
  adoptMobileLayer(dialog, "sheet");
  const el = dialog.element.querySelector(".caldav-editor") as HTMLElement;
  enableDialogResize(dialog);
  bindEvents(ctx, dialog, el, it, isNew);
}

function addHoursStr(stamp: string, hours: number): string {
  const d = parseLocalStamp(stamp);
  if (isDateOnly(stamp)) return stamp;
  return stampOfMsLocal(d.getTime() + hours * 3600000);
}

function stampOfMsLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function genUid(): string {
  return "sy-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 编辑器里的「日历身份色」= 该日历的日程默认色（拿不到就中性灰） */
function calColorOf(cals: CalCalendar[], selected: string): string {
  return calEventColor(cals.find((c) => c.url === selected));
}

function inputToInputValue(stamp: string, allDay: boolean): string {
  return allDay ? stamp.slice(0, 10) : stamp.slice(0, 16);
}

function computeDurationLabel(start: string, end: string | undefined, allDay: boolean): string {
  if (!end) return allDay ? "1 天" : "60 分钟";
  const s = parseLocalStamp(start).getTime();
  const e = parseLocalStamp(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  if (allDay) {
    const days = Math.round((e - s) / 86400000);
    return `${Math.max(1, days)} 天`;
  }
  const mins = Math.max(0, Math.round((e - s) / 60000));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  return `${mins} 分钟`;
}

function repeatSummary(r: Recurrence | undefined): string {
  if (!r) return "不重复";
  const freqText: Record<string, string> = { DAILY: "每天", WEEKLY: "每周", MONTHLY: "每月", YEARLY: "每年" };
  const base = freqText[r.freq] || r.freq;
  const interval = r.interval && r.interval > 1 ? `每 ${r.interval} ${r.freq === "DAILY" ? "天" : r.freq === "WEEKLY" ? "周" : r.freq === "MONTHLY" ? "月" : "年"}` : base;
  let end = "";
  if (r.count) end = `，共 ${r.count} 次`;
  if (r.until) end = `，至 ${r.until.slice(0, 10)}`;
  return interval + end;
}

/** 可选提醒提前量（分钟）。0 = 到点时 */
const ALARM_CHOICES = [0, 5, 10, 15, 30, 60, 1440];
/** 提醒最多几个：再多也没人看，顺带避免界面失控 */
const MAX_ALARMS = 8;

function alarmLabel(m: number): string {
  if (m === 0) return "到点时";
  if (m === 1440) return "提前 1 天";
  if (m === 60) return "提前 1 小时";
  return `提前 ${m} 分钟`;
}

/** 单个提醒行：下拉（沿用输入框包裹层，外观与其它字段一致）+ 行尾删除 */
function alarmRowHtml(m: number): string {
  const opts = ALARM_CHOICES.map(
    (v) => `<option value="${v}" ${v === m ? "selected" : ""}>${alarmLabel(v)}</option>`
  ).join("");
  return `<div class="caldav-alarm-row">
      <div class="caldav-field caldav-field-icon caldav-alarm-field">
        <div class="caldav-input-wrap">
          <span class="caldav-input-icon">${icons.bell}</span>
          <select class="caldav-input" data-alarm>${opts}</select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
      <button type="button" class="caldav-alarm-del" data-action="del-alarm" title="删除这个提醒">${icons.trash}</button>
    </div>`;
}

/** 常用组合：点一下整组加入（已存在的自动跳过） */
const ALARM_PRESETS: { label: string; values: number[] }[] = [
  { label: "提前 1 天 + 提前 1 小时 + 到点时", values: [1440, 60, 0] },
  { label: "提前 15 分钟 + 到点时", values: [15, 0] },
  { label: "提前 1 天 + 提前 30 分钟", values: [1440, 30] }
];

/**
 * 提醒列表的交互：加一行 / 删一行 / 展开预设组合。
 *
 * 背景：这两个按钮（添加提醒时间、添加预设）从首个版本起就只有 HTML、**没有任何处理器**，
 * 点了必然没反应。底层数据模型与提醒引擎一直支持多个提醒，这里把编辑器补齐。
 */
function wireAlarms(el: HTMLElement, errEl: HTMLElement): void {
  const list = el.querySelector<HTMLElement>("[data-alarm-list]");
  const addBtn = el.querySelector<HTMLButtonElement>('[data-action="add-alarm"]');
  const presetBtn = el.querySelector<HTMLButtonElement>('[data-action="add-preset"]');
  const presetPop = el.querySelector<HTMLElement>("[data-alarm-presets]");
  if (!list || !addBtn) return;
  const empty = el.querySelector<HTMLElement>("[data-alarm-empty]");

  const usedValues = () =>
    Array.from(list.querySelectorAll<HTMLSelectElement>("select[data-alarm]")).map((s) => +s.value);
  const syncEmpty = () => {
    if (empty) empty.hidden = list.children.length > 0;
  };
  const flashError = (msg: string) => {
    errEl.textContent = msg;
    setTimeout(() => {
      if (errEl.textContent === msg) errEl.textContent = "";
    }, 2500);
  };
  /** 新行默认值：优先「提前 15 分钟」，已被占用则依次退让，避免一加就重复 */
  const pickDefault = () => {
    const u = new Set(usedValues());
    return [15, 60, 1440, 5, 30, 10, 0].find((m) => !u.has(m)) ?? 15;
  };
  const appendRow = (m: number): boolean => {
    if (list.children.length >= MAX_ALARMS) {
      flashError(`最多添加 ${MAX_ALARMS} 个提醒`);
      return false;
    }
    list.insertAdjacentHTML("beforeend", alarmRowHtml(m));
    syncEmpty();
    return true;
  };

  addBtn.addEventListener("click", () => {
    if (presetPop) presetPop.hidden = true;
    if (appendRow(pickDefault())) list.lastElementChild?.querySelector("select")?.focus();
  });

  presetBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation(); // 别让下面「点别处收起」的监听立刻把它关掉
    if (presetPop) presetPop.hidden = !presetPop.hidden;
  });

  presetPop?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-preset]");
    if (!btn) return;
    const preset = ALARM_PRESETS[+btn.dataset.preset!];
    for (const m of preset?.values || []) {
      if (usedValues().includes(m)) continue; // 已有的不重复加
      if (!appendRow(m)) break;
    }
    presetPop.hidden = true;
  });

  list.addEventListener("click", (ev) => {
    const del = (ev.target as HTMLElement).closest<HTMLElement>('[data-action="del-alarm"]');
    if (!del) return;
    del.closest(".caldav-alarm-row")?.remove();
    syncEmpty();
  });

  // 点卡片里别的地方收起预设浮层（el 随弹窗创建、销毁时一起丢弃，不会累积监听）
  el.addEventListener("click", () => {
    if (presetPop) presetPop.hidden = true;
  });

  syncEmpty();
}

function editorHtml(
  it: CalItem,
  cals: CalCalendar[],
  cats: CategoryDef[],
  catMulti: boolean,
  isNew: boolean
): string {
  const isTodo = it.kind === "todo";
  const r = it.rrule;
  const startDate = it.start.slice(0, 10);
  const startTime = it.allDay ? "" : it.start.slice(11, 16);
  const endDate = it.end ? it.end.slice(0, 10) : "";
  const endTime = it.end && !it.allDay ? it.end.slice(11, 16) : "";
  const initialDuration = computeDurationLabel(it.start, it.end || it.start, it.allDay);
  const alarmRows = (it.alarms || []).map((a) => alarmRowHtml(a.minutesBefore)).join("");

  return `
<div class="caldav-editor-head">
  <div class="caldav-tabs">
    <button class="caldav-tab is-active" data-tab="basic">${isTodo ? "任务设置" : "日程设置"}</button>
    <button class="caldav-tab" data-tab="note">${isTodo ? "任务备注" : "日程备注"}</button>
  </div>
</div>

<div class="caldav-editor-form">
  <div class="caldav-tab-panel" data-panel="basic">
    <div class="caldav-section">
      <div class="caldav-title-head">
        <label class="caldav-field-label caldav-title-label">${isTodo ? "待办标题" : "事件标题"}</label>
        <label class="caldav-switch-line caldav-title-aiparse">
          <span class="caldav-switch-label">粘贴自动识别日期</span>
          <span class="caldav-switch">
            <input type="checkbox" data-f="aiParse"/>
            <span class="caldav-switch-track"></span>
          </span>
        </label>
      </div>
      <div class="caldav-title-row">
        <div class="caldav-input-wrap caldav-title-wrap">
          <input class="caldav-input caldav-title-input" data-f="summary" placeholder="${isTodo ? "请输入待办标题" : "请输入事件标题"}" value="${escape(it.summary)}"/>
          <button type="button" class="caldav-input-suffix caldav-title-action" data-action="ai-parse" title="自动识别标题中的日期时间">${icons.sparkle}</button>
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title caldav-cal-head"><span class="caldav-section-icon">${icons.calendar}</span>日历选择</div>
      <div class="caldav-input-wrap" style="--cal-color:${escape(calColorOf(cals, it.calendarUrl))}">
        <span class="caldav-input-icon caldav-input-icon--static caldav-cal-icon">${icons.calendar}</span>
        <input type="hidden" data-f="calendar" value="${escape(it.calendarUrl)}"/>
        <button type="button" class="caldav-input caldav-cal-trigger" data-action="cal-toggle">
          <span class="caldav-cal-name">${escape(cals.find((c) => c.url === it.calendarUrl)?.displayName || it.calendarUrl)}</span>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </button>
        <div class="caldav-cal-pop" data-cal-pop hidden>
          ${cals
            .map(
              (c) =>
                `<button type="button" class="caldav-cal-option ${c.url === it.calendarUrl ? "is-active" : ""}" data-cal-url="${escape(c.url)}"><span class="caldav-cal-dot" style="background:${escape(calEventColor(c))}"></span>${escape(c.displayName)}</button>`
            )
            .join("")}
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.clock}</span>日期时间</div>
      <label class="caldav-switch-line">
        <span class="caldav-switch-label">全天</span>
        <span class="caldav-switch">
          <input type="checkbox" data-f="allDay" ${it.allDay ? "checked" : ""}/>
          <span class="caldav-switch-track"></span>
        </span>
      </label>

      <div class="caldav-datetime-row">
        <span class="caldav-datetime-label">开始</span>
        <div class="caldav-datetime-inputs">
          <div class="caldav-input-wrap caldav-input-wrap--date">
            <span class="caldav-input-icon">${icons.calendar}</span>
            <input class="caldav-input caldav-date-input" data-f="startDate" type="date" value="${startDate}"/>
          </div>
          <button type="button" class="caldav-input-clear" data-clear="startDate" title="清除日期">${icons.trash}</button>
          <div class="caldav-input-wrap caldav-input-wrap--time" ${it.allDay ? 'style="display:none"' : ""}>
            <input type="hidden" data-f="startTime" value="${startTime}"/>
            <button type="button" class="caldav-input caldav-time-trigger" data-time="startTime">
              <span class="caldav-input-icon">${icons.clock}</span>
              <span class="caldav-time-text" data-time-text="startTime">${startTime || "--:--"}</span>
            </button>
            <div class="caldav-time-pop" data-time-pop="startTime" hidden></div>
          </div>
          <button class="caldav-input-clear caldav-input-clear--time" data-clear="startTime" title="清除时间" ${it.allDay ? 'style="display:none"' : ""}>${icons.trash}</button>
        </div>
      </div>

      <div class="caldav-duration-row" ${isTodo || it.allDay ? 'style="display:none"' : ""}>
        <span class="caldav-datetime-label">持续</span>
        <span class="caldav-duration-val" data-duration>${initialDuration}</span>
      </div>

      <div class="caldav-datetime-row">
        <span class="caldav-datetime-label">结束</span>
        <div class="caldav-datetime-inputs">
          <div class="caldav-input-wrap caldav-input-wrap--date">
            <span class="caldav-input-icon">${icons.calendar}</span>
            <input class="caldav-input caldav-date-input" data-f="endDate" type="date" value="${endDate}"/>
          </div>
          <button type="button" class="caldav-input-clear" data-clear="endDate" title="清除日期">${icons.trash}</button>
          <div class="caldav-input-wrap caldav-input-wrap--time" ${it.allDay ? 'style="display:none"' : ""}>
            <input type="hidden" data-f="endTime" value="${endTime}"/>
            <button type="button" class="caldav-input caldav-time-trigger" data-time="endTime">
              <span class="caldav-input-icon">${icons.clock}</span>
              <span class="caldav-time-text" data-time-text="endTime">${endTime || "--:--"}</span>
            </button>
            <div class="caldav-time-pop" data-time-pop="endTime" hidden></div>
          </div>
          <button class="caldav-input-clear caldav-input-clear--time" data-clear="endTime" title="清除时间" ${it.allDay ? 'style="display:none"' : ""}>${icons.trash}</button>
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.repeat}</span>重复设置</div>
      <button type="button" class="caldav-row-btn" data-action="toggle-repeat-detail">
        <span class="caldav-row-btn-text">${repeatSummary(r)}</span>
        <span class="caldav-row-btn-arrow">${icons.chevron}</span>
      </button>
      <div class="caldav-row-detail" data-detail="repeat" style="display:${r ? "block" : "none"}">
        <label class="caldav-switch-line caldav-switch-line--inline">
          <span class="caldav-switch-label">启用重复</span>
          <span class="caldav-switch">
            <input type="checkbox" data-f="repeatOn" ${r ? "checked" : ""}/>
            <span class="caldav-switch-track"></span>
          </span>
        </label>
        <div class="caldav-repeat-fields" style="display:${r ? "flex" : "none"}">
          <select class="caldav-input" data-f="freq">
            <option value="DAILY" ${r?.freq === "DAILY" ? "selected" : ""}>每天</option>
            <option value="WEEKLY" ${r?.freq === "WEEKLY" || !r ? "selected" : ""}>每周</option>
            <option value="MONTHLY" ${r?.freq === "MONTHLY" ? "selected" : ""}>每月</option>
            <option value="YEARLY" ${r?.freq === "YEARLY" ? "selected" : ""}>每年</option>
          </select>
          <input class="caldav-input caldav-num" data-f="interval" type="number" min="1" value="${r?.interval || 1}" title="间隔"/>
          <div class="caldav-weekdays">${["一", "二", "三", "四", "五", "六", "日"]
            .map((l, i) => {
              const code = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][i];
              return `<label class="caldav-wd ${r?.byDay?.includes(code) ? "is-on" : ""}" data-wd="${code}">${l}</label>`;
            })
            .join("")}</div>
          <select class="caldav-input" data-f="endMode">
            <option value="never" ${!r?.count && !r?.until ? "selected" : ""}>永不结束</option>
            <option value="count" ${r?.count ? "selected" : ""}>次数</option>
            <option value="until" ${r?.until ? "selected" : ""}>日期</option>
          </select>
          <input class="caldav-input caldav-num" data-f="count" type="number" min="1" value="${r?.count || 10}" style="display:${r?.count ? "" : "none"}"/>
          <input class="caldav-input" data-f="until" type="date" value="${r?.until ? r.until.slice(0, 10) : ""}" style="display:${r?.until ? "" : "none"}"/>
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.bell}</span>自定义提醒时间</div>
      <div class="caldav-alarm-list" data-alarm-list>${alarmRows}</div>
      <div class="caldav-alarm-empty" data-alarm-empty ${alarmRows ? "hidden" : ""}>未设置提醒时间（到点时不会提醒）</div>
      <div class="caldav-alarm-actions">
        <button type="button" class="caldav-add-btn" data-action="add-alarm">${icons.plus} 添加提醒时间</button>
        <button type="button" class="caldav-add-btn" data-action="add-preset">${icons.layers} 添加预设</button>
        <div class="caldav-alarm-presets" data-alarm-presets hidden>
          <div class="caldav-alarm-presets-hint">常用组合，点一下整组加入</div>
          ${ALARM_PRESETS.map(
            (p, i) =>
              `<button type="button" class="caldav-alarm-preset" data-preset="${i}">${escape(p.label)}<span>加 ${p.values.length} 个</span></button>`
          ).join("")}
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.layers}</span>更多信息</div>
      <div class="caldav-field caldav-field-icon">
        <label class="caldav-field-label">${icons.pin} 地点</label>
        <div class="caldav-input-wrap">
          <span class="caldav-input-icon">${icons.pin}</span>
          <input class="caldav-input" data-f="location" value="${escape(it.location || "")}" placeholder="可选"/>
        </div>
      </div>
      ${
        isTodo
          ? `<div class="caldav-field-row">
        <div class="caldav-field caldav-field-icon">
          <label class="caldav-field-label">${icons.flag} 优先级</label>
          <div class="caldav-input-wrap">
            <span class="caldav-input-icon">${icons.flag}</span>
            <select class="caldav-input" data-f="priority">
              <option value="0" ${!it.priority ? "selected" : ""}>无</option>
              <option value="9" ${it.priority === 9 ? "selected" : ""}>低</option>
              <option value="5" ${it.priority === 5 ? "selected" : ""}>中</option>
              <option value="3" ${it.priority === 3 ? "selected" : ""}>高</option>
              <option value="1" ${it.priority === 1 ? "selected" : ""}>紧急</option>
            </select>
            <span class="caldav-input-suffix">${icons.chevron}</span>
          </div>
        </div>
        <div class="caldav-field">
          <label class="caldav-field-label">进度</label>
          <div class="caldav-progress-row">
            <input type="range" data-f="percent" min="0" max="100" step="10" value="${it.percent ?? 0}"/>
            <span class="caldav-progress-val">${it.percent ?? 0}%</span>
          </div>
        </div>
      </div>`
          : ""
      }
      <div class="caldav-field">
        <div class="caldav-cat-head">
          <label class="caldav-field-label">${icons.tag} 任务分类</label>
          <button type="button" class="caldav-cat-manage" data-action="cat-manage" title="管理分类">${icons.gear}</button>
          <label class="caldav-cat-multi" title="允许多选">
            <span class="caldav-switch">
              <input type="checkbox" data-f="catMulti" ${catMulti ? "checked" : ""}/>
              <span class="caldav-switch-track"></span>
            </span>
            多选
          </label>
        </div>
        <input type="hidden" data-f="categories" value="${escape((it.categories || []).join(","))}"/>
        <div class="caldav-cat-pills" data-cat-pills>
          <button type="button" class="caldav-cat-pill caldav-cat-pill--none" data-cat="">
            <span class="caldav-cat-check">${icons.check}</span>无分类
          </button>
          ${cats
            .map(
              (c) =>
                `<button type="button" class="caldav-cat-pill" data-cat="${escape(c.name)}" style="--cat-color:${escape(c.color)}"><span class="caldav-cat-emoji">${escape(c.icon)}</span>${escape(c.name)}</button>`
            )
            .join("")}
        </div>
      </div>
    </div>
  </div>

  <div class="caldav-tab-panel" data-panel="note" style="display:none">
    <div class="caldav-section caldav-section--card">
      <textarea class="caldav-input caldav-textarea" data-f="description" rows="8" placeholder="添加备注...">${escape(it.description || "")}</textarea>
    </div>
  </div>
</div>

<div class="caldav-editor-foot">
  <div class="caldav-editor-error" data-error></div>
  ${!isNew ? `<button type="button" class="caldav-foot-btn caldav-foot-btn--danger" data-action="delete">${icons.trash} 删除</button>` : ""}
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-action="cancel">${icons.close} 取消</button>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-action="save">${icons.check} 保存</button>
</div>
</div>`;
}

function bindEvents(ctx: PanelCtx, dialog: Dialog, el: HTMLElement, it: CalItem, isNew: boolean): void {
  const isTodo = it.kind === "todo";
  const cals = ctx.store.settings.calendars;
  const f = (name: string) => el.querySelector(`[data-f="${name}"]`) as HTMLInputElement;
  const errEl = el.querySelector("[data-error]") as HTMLElement;

  // Tab 切换
  el.querySelectorAll<HTMLElement>(".caldav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab!;
      el.querySelectorAll<HTMLElement>(".caldav-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === target));
      el.querySelectorAll<HTMLElement>(".caldav-tab-panel").forEach((p) => {
        (p as HTMLElement).style.display = p.dataset.panel === target ? "block" : "none";
      });
    });
  });

  // 日历自定义下拉：图标颜色随所选日历，弹层为暖色浅底（原生 select 弹层无法去除系统蓝高亮）
  const calInput = f("calendar");
  const calWrap = calInput.closest<HTMLElement>(".caldav-input-wrap");
  const calPop = calWrap?.querySelector<HTMLElement>("[data-cal-pop]");
  const applyCalendar = (url: string) => {
    calInput.value = url;
    const cal = cals.find((c) => c.url === url);
    calWrap?.style.setProperty("--cal-color", calEventColor(cal));
    const nameEl = calWrap?.querySelector<HTMLElement>(".caldav-cal-name");
    if (nameEl && cal) nameEl.textContent = cal.displayName;
    calPop?.querySelectorAll(".caldav-cal-option").forEach((o) => o.classList.toggle("is-active", (o as HTMLElement).dataset.calUrl === url));
  };
  calWrap?.querySelector<HTMLElement>('[data-action="cal-toggle"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (calPop) calPop.hidden = !calPop.hidden;
  });
  calPop?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const opt = (ev.target as HTMLElement).closest<HTMLElement>(".caldav-cal-option");
    if (!opt) return;
    applyCalendar(opt.dataset.calUrl || "");
    if (calPop) calPop.hidden = true;
  });

  // 全天切换显示/隐藏时间输入
  const timeWraps = Array.from(el.querySelectorAll<HTMLElement>(".caldav-input-wrap--time"));
  const timeClears = Array.from(el.querySelectorAll<HTMLElement>(".caldav-input-clear--time"));
  const durationRow = el.querySelector<HTMLElement>(".caldav-duration-row");

  // ---- 自定义时间选择器 ----
  // 原生 <input type="time"> 的弹出面板由浏览器绘制，选中项固定是系统高亮色（蓝），
  // 换主题也不会变（CSS 改不动它），所以改成自绘的「时 / 分」两列弹层，配色全走主题变量。
  const timePops = Array.from(el.querySelectorAll<HTMLElement>("[data-time-pop]"));

  function closeTimePops(): void {
    timePops.forEach((p) => (p.hidden = true));
  }

  /** 把 hidden input 的值同步到触发按钮上的文字（清空时显示 --:--） */
  function syncTimeText(name: string): void {
    const inp = f(name);
    const textEl = el.querySelector<HTMLElement>(`[data-time-text="${name}"]`);
    if (textEl) textEl.textContent = inp.value || "--:--";
  }

  function renderTimePop(pop: HTMLElement, name: string): void {
    const raw = f(name).value;
    const cur = /^\d{2}:\d{2}$/.test(raw) ? raw : "09:00";
    const [ch, cm] = cur.split(":");
    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    const minutes: string[] = [];
    for (let m = 0; m < 60; m += 5) minutes.push(String(m).padStart(2, "0"));
    if (!minutes.includes(cm)) minutes.push(cm); // 已有值不在 5 分钟刻度上时保留，避免一打开就被改掉
    minutes.sort();
    const col = (key: string, values: string[], active: string) =>
      `<div class="caldav-time-col" data-col="${key}">${values
        .map(
          (v) =>
            `<button type="button" class="caldav-time-item${
              v === active ? " is-active" : ""
            }" data-time-val="${v}">${v}</button>`
        )
        .join("")}</div>`;
    pop.innerHTML = col("h", hours, ch) + col("m", minutes, cm);
    pop.querySelector(".caldav-time-item.is-active")?.scrollIntoView?.({ block: "center" });
  }

  /** "YYYY-MM-DDTHH:mm" 加一小时，返回同格式（跨天会进位到次日） */
  function plusHour(stamp: string): string {
    const d = parseLocalStamp(stamp);
    d.setHours(d.getHours() + 1);
    return stampOfMs(d.getTime()).slice(0, 16);
  }

  /**
   * 开始时间变化后的结束时间联动：
   *  - 日程：结束时间为空、或早于开始时间 → 置为「开始 + 1 小时」
   *  - 待办：开始/结束都允许为空；仅当已有结束时间早于开始时间时才置为「开始 + 1 小时」
   * 比较用完整的「日期 + 时间」，因此跨天的结束时间（如 17 日 23:00 → 18 日 10:00）
   * 不会被误判成「早于开始」而遭到改写。
   */
  function syncEndAfterStartChange(): void {
    const sd = f("startDate").value;
    const st = f("startTime").value;
    if (!sd || !st) return; // 开始时间被清空或未选择时不做联动
    const startStamp = `${sd}T${st}`;
    const ed = f("endDate").value;
    const et = f("endTime").value;
    const endStamp = ed && et ? `${ed}T${et}` : "";
    if (!endStamp && isTodo) return; // 待办允许结束留空
    if (endStamp && endStamp >= startStamp) return; // 结束不早于开始，保持原值
    const next = plusHour(startStamp);
    f("endDate").value = next.slice(0, 10);
    f("endTime").value = next.slice(11, 16);
    syncTimeText("endTime");
    f("endTime").dispatchEvent(new Event("input")); // 让「持续」时长跟着重算
  }

  function toggleTimePop(name: string): void {
    const pop = timePops.find((p) => p.dataset.timePop === name);
    if (!pop) return;
    const open = !pop.hidden;
    closeTimePops();
    if (open) return;
    renderTimePop(pop, name);
    pop.hidden = false;
  }

  // 点击弹层外部收起（点在各自 wrap 内不收，便于输入框聚焦/点选）
  el.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (calPop && !calPop.hidden && !calWrap?.contains(t)) calPop.hidden = true;

    // 时间选择器：触发按钮展开/收起，选项落值（弹层内容每次打开时重建，故用事件委托）
    const timeTrigger = t.closest<HTMLElement>("[data-time]");
    if (timeTrigger) {
      toggleTimePop(timeTrigger.dataset.time!);
      return;
    }
    const timeItem = t.closest<HTMLElement>("[data-time-val]");
    if (timeItem) {
      const pop = timeItem.closest<HTMLElement>("[data-time-pop]");
      const name = pop?.dataset.timePop || "";
      const colKey = timeItem.closest<HTMLElement>(".caldav-time-col")?.dataset.col || "h";
      const inp = f(name);
      const raw = inp.value;
      const [h, m] = (/^\d{2}:\d{2}$/.test(raw) ? raw : "09:00").split(":");
      inp.value = colKey === "h" ? `${timeItem.dataset.timeVal}:${m}` : `${h}:${timeItem.dataset.timeVal}`;
      syncTimeText(name);
      if (name === "startTime") syncEndAfterStartChange(); // 开始时间变了 → 按规则联动结束时间
      inp.dispatchEvent(new Event("input")); // 让「持续」时长跟着重算
      pop
        ?.querySelectorAll<HTMLElement>(`.caldav-time-col[data-col="${colKey}"] .caldav-time-item`)
        .forEach((b) => b.classList.toggle("is-active", b === timeItem));
      return;
    }
    if (!t.closest(".caldav-input-wrap--time")) closeTimePops();
  });

  // 任务分类药丸：单选/多选，点「无分类」清空
  const catHidden = f("categories");
  const pillsWrap = el.querySelector<HTMLElement>("[data-cat-pills]");
  const multiInput = f("catMulti");
  const syncPills = () => {
    const picked = catHidden.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    pillsWrap?.querySelectorAll<HTMLElement>(".caldav-cat-pill").forEach((p) => {
      const name = p.dataset.cat || "";
      p.classList.toggle("is-active", name ? picked.includes(name) : !picked.length);
    });
  };
  pillsWrap?.addEventListener("click", (ev) => {
    const pill = (ev.target as HTMLElement).closest<HTMLElement>(".caldav-cat-pill");
    if (!pill) return;
    const name = pill.dataset.cat || "";
    const picked = catHidden.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!name) {
      catHidden.value = "";
    } else if (multiInput.checked) {
      const i = picked.indexOf(name);
      if (i >= 0) picked.splice(i, 1);
      else picked.push(name);
      catHidden.value = picked.join(",");
    } else {
      catHidden.value = picked.length === 1 && picked[0] === name ? "" : name;
    }
    syncPills();
  });
  multiInput.addEventListener("change", () => {
    // 关闭多选时只保留第一个已选分类
    if (!multiInput.checked && catHidden.value.includes(",")) {
      catHidden.value = catHidden.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)[0] || "";
    }
    ctx.store.settings.categoryMulti = multiInput.checked;
    ctx.store.saveSettings();
    syncPills();
  });
  el.querySelector<HTMLElement>('[data-action="cat-manage"]')?.addEventListener("click", () => {
    openCategoryManager(ctx);
  });
  syncPills();

  const updateDuration = () => {
    const durEl = el.querySelector<HTMLElement>("[data-duration]");
    if (!durEl) return;
    const allDay = f("allDay").checked;
    const start = f("startDate").value + (allDay ? "" : "T" + f("startTime").value + ":00");
    const end = f("endDate").value ? f("endDate").value + (allDay ? "" : "T" + f("endTime").value + ":00") : undefined;
    durEl.textContent = computeDurationLabel(start, end, allDay);
  };
  f("allDay").addEventListener("change", () => {
    const allDay = f("allDay").checked;
    timeWraps.forEach((w) => (w.style.display = allDay ? "none" : ""));
    timeClears.forEach((c) => (c.style.display = allDay ? "none" : ""));
    if (durationRow) durationRow.style.display = allDay || isTodo ? "none" : "";
    if (!allDay) {
      // 取消「全天」时补默认时间，与新建默认一致：落在下一个整点，而不是固定 9:00
      const ds = defaultStartStamp(f("startDate").value);
      if (!f("startTime").value) f("startTime").value = ds.slice(11, 16);
      if (!f("endTime").value) f("endTime").value = addHoursStr(ds, 1).slice(11, 16);
    }
    syncTimeText("startTime");
    syncTimeText("endTime");
    updateDuration();
  });

  // 日期/时间变化时更新持续时长
  for (const name of ["startDate", "startTime", "endDate", "endTime"]) {
    f(name).addEventListener("input", updateDuration);
  }

  // 清空日期/时间按钮
  el.querySelectorAll<HTMLElement>("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.clear!;
      const inp = f(target);
      inp.value = "";
      inp.dispatchEvent(new Event("input"));
      syncTimeText(target); // 日期没有配套文字节点，命中不到时静默跳过
    });
  });

  // 重复详情展开 / 折叠
  const repeatDetail = el.querySelector<HTMLElement>("[data-detail='repeat']")!;
  const repeatBtn = el.querySelector<HTMLElement>("[data-action='toggle-repeat-detail']")!;
  const repeatBtnText = repeatBtn.querySelector<HTMLElement>(".caldav-row-btn-text")!;
  const toggleRepeat = () => {
    const open = repeatDetail.style.display !== "none";
    repeatDetail.style.display = open ? "none" : "block";
    repeatBtn.classList.toggle("is-open", !open);
  };
  repeatBtn.addEventListener("click", toggleRepeat);

  // 重复开关
  const repeatFields = el.querySelector<HTMLElement>(".caldav-repeat-fields")!;
  f("repeatOn").addEventListener("change", () => {
    const on = f("repeatOn").checked;
    repeatFields.style.display = on ? "flex" : "none";
    repeatBtnText.textContent = on ? repeatSummary(collectRepeat(el)) : "不重复";
  });

  // 星期选择
  el.querySelectorAll<HTMLElement>(".caldav-wd").forEach((wd) => {
    wd.addEventListener("click", () => wd.classList.toggle("is-on"));
  });
  // 结束模式
  f("endMode").addEventListener("change", () => {
    const mode = f("endMode").value;
    f("count").style.display = mode === "count" ? "" : "none";
    f("until").style.display = mode === "until" ? "" : "none";
  });

  // 进度
  const percent = el.querySelector('[data-f="percent"]') as HTMLInputElement | null;
  percent?.addEventListener("input", () => {
    (el.querySelector(".caldav-progress-val") as HTMLElement).textContent = percent.value + "%";
  });

  // 把识别结果写入日期/时间字段并同步显示
  const applyParsed = (p: ParsedDateTime): void => {
    f("startDate").value = p.startDate;
    f("startDate").dispatchEvent(new Event("input"));
    if (p.startTime) { f("startTime").value = p.startTime; syncTimeText("startTime"); }
    if (p.endDate) { f("endDate").value = p.endDate; f("endDate").dispatchEvent(new Event("input")); }
    if (p.endTime) { f("endTime").value = p.endTime; syncTimeText("endTime"); }
  };

  // 粘贴自动识别日期：勾选开关后，在标题框粘贴含日期文本即抽取填入对应字段
  const summaryInput = f("summary");
  summaryInput.addEventListener("paste", (e: ClipboardEvent) => {
    if (!f("aiParse").checked) return; // 未勾选 → 走原生粘贴
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const inp = e.target as HTMLInputElement;
    const s = inp.selectionStart ?? inp.value.length;
    const en = inp.selectionEnd ?? inp.value.length;
    inp.setRangeText(text, s, en, "end"); // 标题保留原文，仅抽取日期填入字段
    e.preventDefault();
    const p = parseDateTimeFromText(text);
    if (p) applyParsed(p);
  });

  // ✨ 按钮：手动对当前标题触发一次识别（不依赖开关）
  el.querySelector('[data-action="ai-parse"]')?.addEventListener("click", () => {
    const p = parseDateTimeFromText(f("summary").value);
    if (!p) {
      errEl.textContent = "未在标题中识别到日期时间。";
      setTimeout(() => (errEl.textContent = ""), 2500);
      return;
    }
    applyParsed(p);
  });

  // 自定义提醒时间：多行列表 + 常用组合预设
  wireAlarms(el, errEl);

  el.querySelector('[data-action="cancel"]')?.addEventListener("click", () => dialog.destroy());

  // 删除：改为弹窗内二次确认（思源原生 confirm 在本插件 iframe 里点击无响应，
  // 且失败时无法反馈，这里不依赖它，同时保留失败提示）
  const delBtn = el.querySelector<HTMLButtonElement>('[data-action="delete"]');
  if (delBtn) {
    const idleHtml = delBtn.innerHTML;
    let armed = false;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      armed = false;
      if (armTimer) clearTimeout(armTimer);
      armTimer = null;
      delBtn.innerHTML = idleHtml;
      delBtn.classList.remove("is-armed");
    };
    delBtn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        delBtn.innerHTML = `${icons.trash} 再点一次确认删除`;
        delBtn.classList.add("is-armed");
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      delBtn.disabled = true;
      delBtn.innerHTML = "删除中…";
      const key = keyOf(it);
      try {
        await ctx.sync.removeItem(it);
        if (ctx.store.get(key)) {
          // 仍留在本地 = 服务端删除未成功，会留待下次同步重试
          errEl.textContent = "服务器删除未成功，已记录，将在下次同步重试";
          delBtn.disabled = false;
          delBtn.innerHTML = idleHtml;
          return;
        }
        dialog.destroy();
      } catch (e: any) {
        errEl.textContent = "删除失败：" + (e?.message || e);
        delBtn.disabled = false;
        delBtn.innerHTML = idleHtml;
      }
    });
  }
  el.querySelector('[data-action="save"]')?.addEventListener("click", () => {
    try {
      const saved = collect(ctx, el, it);
      void (isNew ? ctx.sync.createItem(saved) : ctx.sync.updateItem(saved)).then(() => dialog.destroy());
    } catch (e: any) {
      errEl.textContent = e?.message || String(e);
    }
  });
}

function collectRepeat(el: HTMLElement): Recurrence {
  const f = (name: string) => el.querySelector(`[data-f="${name}"]`) as HTMLInputElement;
  const v = (name: string) => f(name).value.trim();
  const r: Recurrence = {
    freq: f("freq").value as Recurrence["freq"],
    interval: Math.max(1, +f("interval").value || 1)
  };
  if (r.freq === "WEEKLY" || r.freq === "MONTHLY") {
    const on = Array.from(el.querySelectorAll(".caldav-wd.is-on")).map((e) => (e as HTMLElement).dataset.wd!);
    if (on.length) r.byDay = on;
  }
  const mode = f("endMode").value;
  if (mode === "count") r.count = Math.max(1, +f("count").value || 1);
  if (mode === "until") r.until = v("until");
  return r;
}

function collect(ctx: PanelCtx, el: HTMLElement, it: CalItem): CalItem {
  const f = (name: string) => el.querySelector(`[data-f="${name}"]`) as HTMLInputElement;
  const v = (name: string) => f(name).value.trim();

  it.summary = v("summary");
  if (!it.summary) throw new Error("标题不能为空");
  it.calendarUrl = v("calendar");
  const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
  // 更换日历 = 移动资源
  if (cal && !it.href.startsWith(cal.url.replace(/\/+$/, ""))) {
    it.href = cal.url.replace(/\/+$/, "") + "/" + it.uid + ".ics";
    it.etag = undefined; // 新资源无 etag
  }
  it.allDay = f("allDay").checked;
  const startDate = v("startDate");
  const startTime = v("startTime");
  const endDate = v("endDate");
  const endTime = v("endTime");
  const stampOf = (d: string, t: string) => (!d ? "" : it.allDay ? d : `${d}T${t || "00:00"}:00`);
  if (it.kind === "todo") {
    // 待办的开始/截止时间均可留空
    it.start = stampOf(startDate, startTime);
    it.end = stampOf(endDate, endTime);
    if (it.start && it.end && parseLocalStamp(it.end).getTime() < parseLocalStamp(it.start).getTime()) {
      throw new Error("结束时间不能早于开始时间");
    }
  } else if (it.allDay) {
    if (!startDate) throw new Error("请填写开始日期");
    it.start = startDate;
    it.end = endDate || addDays(startDate, 1);
  } else {
    if (!startDate) throw new Error("请填写开始日期");
    if (!startTime) throw new Error("请填写开始时间");
    it.start = `${startDate}T${startTime}:00`;
    if (!endDate || !endTime) throw new Error("请填写结束日期和时间");
    it.end = `${endDate}T${endTime}:00`;
    if (parseLocalStamp(it.end).getTime() <= parseLocalStamp(it.start).getTime()) throw new Error("结束时间需晚于开始时间");
  }
  // 重复
  if (f("repeatOn").checked) {
    it.rrule = collectRepeat(el);
  } else {
    it.rrule = undefined;
  }
  // 提醒：列表里一行一个，按提前量去重后写回。
  // （曾经只写 alarms[0]，且前端只有一个下拉 —— 从别处同步来的多个提醒一保存就被丢掉）
  const alarms: Alarm[] = [];
  el.querySelectorAll<HTMLSelectElement>("select[data-alarm]").forEach((s) => {
    const m = Math.max(0, Math.round(+s.value || 0));
    if (!alarms.some((a) => a.minutesBefore === m)) alarms.push({ minutesBefore: m });
  });
  it.alarms = alarms.length ? alarms : undefined;
  it.location = v("location") || undefined;
  it.categories = v("categories")
    ? v("categories").split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  it.description = v("description") || undefined;
  if (it.kind === "todo") {
    it.priority = +f("priority").value || 0;
    it.percent = Math.min(100, Math.max(0, +f("percent").value || 0));
    it.status = it.percent === 100 ? "COMPLETED" : it.percent > 0 ? "IN-PROCESS" : "NEEDS-ACTION";
    if (it.percent === 100 && !it.completedAt) it.completedAt = stampNow();
    if (it.percent < 100) it.completedAt = undefined;
  }
  return it;
}

function stampNow(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface ParsedDateTime {
  startDate: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
}

const WEEKDAY_NUM: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function ymdStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDaysDate(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * 从自由文本识别日期时间（中文常见表达），用于编辑器「粘贴自动识别日期」。
 * 支持：今天/明天/后天、周几（含下周/本周，排除「每」前缀的重复表达）、
 *       年月日 / 月日 / 公历节日；时间支持 14:00、9点、9点半、下午3点 等。
 * 仅识别到日期则只填日期；识别到时间则填开始（结束默认 +1 小时）；
 * 若一段文本含两个时间（如「14点到16点」）则分别作为起止。返回 null 表示啥都没识别到。
 */
function parseDateTimeFromText(text: string): ParsedDateTime | null {
  const base = new Date();
  const startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  let dateObj: Date | null = null;

  // 1) 相对日词
  const REL: [string, number][] = [
    ["今天", 0], ["今日", 0], ["明日", 1], ["明天", 1], ["大后天", 3], ["后天", 2],
    ["昨日", -1], ["昨天", -1], ["今", 0],
  ];
  for (const [k, off] of REL) {
    if (text.includes(k)) { dateObj = addDaysDate(base, off); break; }
  }

  // 2) 周几（排除「每」前缀的重复表达）
  if (!dateObj) {
    const WD = /(每)?\s*(下|本|这|上)?\s*(周|星期|礼拜)\s*([0-6一二三四五六日])/g;
    let m: RegExpExecArray | null;
    while ((m = WD.exec(text))) {
      if (m[1] === "每") continue;
      const raw = m[4];
      let w: number;
      if (WEEKDAY_NUM[raw] !== undefined) w = WEEKDAY_NUM[raw];
      else { const n = +raw; w = n === 7 ? 0 : n; }
      const days = (w - base.getDay() + 7) % 7; // 未来最近的该星期几
      dateObj = addDaysDate(base, days);
      break;
    }
  }

  // 3) 年月日
  if (!dateObj) {
    const y = /(\d{4})[年./\-](\d{1,2})[月./\-](\d{1,2})(?:日|号)?/.exec(text);
    if (y) dateObj = new Date(+y[1], +y[2] - 1, +y[3]);
  }
  // 4) 月日（今年；已过则顺延明年）
  if (!dateObj) {
    const md = /(\d{1,2})[月./\-](\d{1,2})(?:日|号)?/.exec(text);
    if (md) {
      const d = new Date(base.getFullYear(), +md[1] - 1, +md[2]);
      if (d.getTime() < startOfToday.getTime()) d.setFullYear(base.getFullYear() + 1);
      dateObj = d;
    }
  }
  // 5) 公历节日
  if (!dateObj) {
    const FEST: [string, number, number][] = [
      ["元旦", 1, 1], ["情人节", 2, 14], ["妇女节", 3, 8], ["劳动节", 5, 1],
      ["儿童节", 6, 1], ["国庆", 10, 1], ["圣诞节", 12, 25],
    ];
    for (const [k, mm, dd] of FEST) {
      if (text.includes(k)) {
        const d = new Date(base.getFullYear(), mm - 1, dd);
        if (d.getTime() < startOfToday.getTime()) d.setFullYear(base.getFullYear() + 1);
        dateObj = d;
        break;
      }
    }
  }

  // 时间（必须带 点/时/:/半 之一，避免误判纯数字；后续时间继承前一时段）
  const times: { h: number; m: number }[] = [];
  let lastPeriod: "am" | "pm" | null = null;
  const TIME = /(上午|早上|早晨|凌晨|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,2})(?:(?:[:：](\d{1,2}))|点\s*(半|(\d{1,2})\s*分)?|时\s*(半|(\d{1,2})\s*分)?)/g;
  let tm: RegExpExecArray | null;
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

  const fmt = (t: { h: number; m: number }) =>
    `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
  const t0 = times[0];
  if (times.length >= 2) {
    return { startDate, startTime: fmt(t0), endDate: startDate, endTime: fmt(times[1]) };
  }
  const end = addDaysDate(date, 0);
  end.setHours(t0.h, t0.m + 60, 0, 0);
  return {
    startDate,
    startTime: fmt(t0),
    endDate: ymdStr(end),
    endTime: fmt({ h: end.getHours(), m: end.getMinutes() }),
  };
}
