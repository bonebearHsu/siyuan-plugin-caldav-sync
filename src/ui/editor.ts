/**
 * 日程 / 待办编辑弹窗（基于思源 Dialog）
 */
import { Dialog } from "siyuan";
import type { CalItem, CalKind, CategoryDef, Recurrence } from "../core/types";
import { DEFAULT_CATEGORIES } from "../core/types";
import { keyOf } from "../core/store";
import { addDays, isDateOnly, parseLocalStamp, todayStamp } from "../core/date";
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
  const it: CalItem = editing
    ? { ...editing }
    : {
        uid: genUid(),
        kind,
        calendarUrl: defaultCal.url,
        href: defaultCal.url.replace(/\/+$/, "") + "/" + genUid() + ".ics",
        summary: "",
        allDay: false,
        start: preset.start || todayStamp() + "T09:00:00",
        end: preset.end || addHoursStr(preset.start || todayStamp() + "T09:00:00", 1),
        priority: 0,
        status: "NEEDS-ACTION",
        percent: 0,
        createdAt: todayStamp() + "T" + new Date().toTimeString().slice(0, 8)
      };
  if (kind === "todo" && isNew) it.end = undefined; // 待办默认无截止，由用户按需填写

  const isTodo = it.kind === "todo";

  const dialog = new Dialog({
    title: isNew ? (isTodo ? "新建待办" : "新建日程") : "编辑" + (isTodo ? "待办" : "日程"),
    content: `<div class="caldav-editor">${editorHtml(it, cals, ctx.store.settings.categories?.length ? ctx.store.settings.categories : DEFAULT_CATEGORIES, !!ctx.store.settings.categoryMulti, isNew)}</div>`,
    width: isTodo ? "560px" : "520px",
    height: "86vh",
    destroyCallback: () => {}
  });
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

function calColorOf(cals: { url: string; color: string }[], selected: string): string {
  return cals.find((c) => c.url === selected)?.color || "#64748b";
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

function alarmSelect(it: CalItem): string {
  const opts = [0, 5, 10, 15, 30, 60, 1440]
    .map(
      (m) =>
        `<option value="${m}" ${it.alarms?.[0]?.minutesBefore === m ? "selected" : ""}>${
          m === 0 ? "到点时" : m < 60 ? `提前 ${m} 分钟` : m === 60 ? "提前 1 小时" : "提前 1 天"
        }</option>`
    )
    .join("");
  return `<option value="">无</option>${opts}`;
}

function editorHtml(
  it: CalItem,
  cals: { url: string; displayName: string; color: string }[],
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
      <label class="caldav-field-label caldav-title-label">${isTodo ? "待办标题" : "事件标题"}</label>
      <div class="caldav-title-row">
        <div class="caldav-input-wrap caldav-title-wrap">
          <input class="caldav-input caldav-title-input" data-f="summary" placeholder="${isTodo ? "请输入待办标题" : "请输入事件标题"}" value="${escape(it.summary)}"/>
          <button type="button" class="caldav-input-suffix caldav-title-action" data-action="ai-parse" title="自动识别标题中的日期时间">${icons.sparkle}</button>
        </div>
      </div>
      <label class="caldav-switch-line">
        <span class="caldav-switch-label">粘贴自动识别日期</span>
        <span class="caldav-switch">
          <input type="checkbox" data-f="aiParse"/>
          <span class="caldav-switch-track"></span>
        </span>
      </label>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.calendar}</span>基本信息</div>
      <div class="caldav-field">
        <label class="caldav-field-label">日历</label>
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
                  `<button type="button" class="caldav-cal-option ${c.url === it.calendarUrl ? "is-active" : ""}" data-cal-url="${escape(c.url)}"><span class="caldav-cal-dot" style="background:${escape(c.color)}"></span>${escape(c.displayName)}</button>`
              )
              .join("")}
          </div>
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
            <span class="caldav-input-icon">${icons.clock}</span>
            <input class="caldav-input caldav-time-input" data-f="startTime" type="time" value="${startTime}"/>
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
            <span class="caldav-input-icon">${icons.clock}</span>
            <input class="caldav-input caldav-time-input" data-f="endTime" type="time" value="${endTime}"/>
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
      <div class="caldav-alarm-row">
        <div class="caldav-field caldav-field-icon caldav-alarm-field">
          <div class="caldav-input-wrap">
            <span class="caldav-input-icon">${icons.bell}</span>
            <select class="caldav-input" data-f="alarm">${alarmSelect(it)}</select>
            <span class="caldav-input-suffix">${icons.chevron}</span>
          </div>
        </div>
      </div>
      <div class="caldav-alarm-actions">
        <button type="button" class="caldav-add-btn" data-action="add-alarm">${icons.plus} 添加提醒时间</button>
        <button type="button" class="caldav-add-btn" data-action="add-preset">${icons.layers} 添加预设</button>
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

  // 全天切换显示/隐藏时间输入
  const timeWraps = Array.from(el.querySelectorAll<HTMLElement>(".caldav-input-wrap--time"));
  const timeClears = Array.from(el.querySelectorAll<HTMLElement>(".caldav-input-clear--time"));
  const durationRow = el.querySelector<HTMLElement>(".caldav-duration-row");

  // 日历自定义下拉：图标颜色随所选日历，弹层为暖色浅底（原生 select 弹层无法去除系统蓝高亮）
  const calInput = f("calendar");
  const calWrap = calInput.closest<HTMLElement>(".caldav-input-wrap");
  const calPop = calWrap?.querySelector<HTMLElement>("[data-cal-pop]");
  const applyCalendar = (url: string) => {
    calInput.value = url;
    const cal = cals.find((c) => c.url === url);
    calWrap?.style.setProperty("--cal-color", cal?.color || "#64748b");
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
  // 点击弹层外部收起（点在各自 wrap 内不收，便于输入框聚焦/点选）
  el.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (calPop && !calPop.hidden && !calWrap?.contains(t)) calPop.hidden = true;
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
      if (!f("startTime").value) f("startTime").value = "09:00";
      if (!f("endTime").value) f("endTime").value = "10:00";
    }
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

  // AI 识别占位：聚焦标题并给出提示
  el.querySelector('[data-action="ai-parse"]')?.addEventListener("click", () => {
    errEl.textContent = "AI 自动识别功能需接入思源 AI 能力，当前为占位入口。";
    setTimeout(() => (errEl.textContent = ""), 2500);
  });

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
  // 提醒
  const alarmV = v("alarm");
  it.alarms = alarmV === "" ? undefined : [{ minutesBefore: +alarmV }];
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
