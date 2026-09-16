/**
 * 面板骨架：
 *  - 主窗口页签形态：顶部工具栏（年/月/周/日 切换 + 导航 + 新增 + 日历筛选）+ 视图容器
 *  - 左侧 Dock：标题「日历任务管理」+ 一行 5 个按钮（新增、排序、日历视图、任务视图、刷新）
 * Dock 负责导航与新增/排序/刷新，主面板只呈现日历视图。
 */
import type { CalStore } from "../core/store";
import { keyOf } from "../core/store";
import type { SyncEngine } from "../core/sync";
import type { CalItem, CalKind, SortMode } from "../core/types";
import { DEFAULT_CATEGORIES } from "../core/types";
import { occurrencesInRange } from "../core/ics";
import { parseLocalStamp, stampOfMs, todayStamp, startOfWeek, addDays, isDateOnly, fmtTime, fmtDateCn, diffDays } from "../core/date";
import { icons } from "./icons";
import { openEditor } from "./editor";
import { openSettingsDialog } from "./settings-dialog";
import { renderMonthView } from "./view-month";
import { renderWeekView } from "./view-week";
import { renderTaskView } from "./view-task";
import { renderYearView } from "./view-year";
import { todoDueOccurrences } from "./view-common";

export type ViewMode = "year" | "month" | "week" | "day" | "task";

export interface PanelCtx {
  store: CalStore;
  sync: SyncEngine;
  i18n: (key: string) => string;
  /** 把今日日程插入日记（由入口注入，依赖思源内核 API） */
  insertTodayToDiary: () => Promise<string>;
  unsaved: Set<string>; // 面板实例 key，防重复渲染
  viewMode: ViewMode;
  cursor: string; // 当前聚焦日期 YYYY-MM-DD
  statusText: string;
  /** 排序方式：开始/结束/优先级/完成/创建/分类/标题 */
  sortMode: SortMode;
  /** 视图内导航（年视图跳月/日用），由 renderPanel 注入 */
  navigate?: (mode: ViewMode, cursor?: string) => void;
}

export function renderPanel(root: HTMLElement, ctx: PanelCtx): { destroy: () => void; refresh: () => void } {
  root.classList.add("caldav-root");
  root.innerHTML = `
<div class="caldav-app caldav-app--flat">
  <main class="caldav-main">
    <header class="caldav-toolbar">
      <div class="caldav-toolbar-left">
        <button class="caldav-icon-btn" data-action="prev" title="上一页">${icons.prev}</button>
        <button class="caldav-btn" data-action="today">今天</button>
        <button class="caldav-icon-btn" data-action="next" title="下一页">${icons.next}</button>
        <span class="caldav-cursor-title"></span>
      </div>
      <div class="caldav-toolbar-center">
        <div class="caldav-seg" role="tablist" aria-label="视图切换">
          <button class="caldav-seg-btn" data-view="year">年</button>
          <button class="caldav-seg-btn" data-view="month">月</button>
          <button class="caldav-seg-btn" data-view="week">周</button>
          <button class="caldav-seg-btn" data-view="day">日</button>
        </div>
      </div>
      <div class="caldav-toolbar-right">
        <div class="caldav-calfilter-wrap">
          <button class="caldav-icon-btn" data-action="calfilter" title="日历筛选">${icons.layers}</button>
          <div class="caldav-calfilter-pop" data-pop="calfilter" hidden>
            <div class="caldav-cal-head">日历</div>
            <div class="caldav-cal-list"></div>
            <div class="caldav-calfilter-foot">
              <button class="caldav-link" data-action="settings">设置</button>
              <button class="caldav-link" data-action="insert-diary">把今日日程与待办插入日记</button>
            </div>
          </div>
        </div>
        <button class="caldav-btn caldav-btn-primary" data-action="new-event">${icons.plus} 日程</button>
        <button class="caldav-btn" data-action="new-todo">${icons.plus} 待办</button>
      </div>
    </header>
    <div class="caldav-view"></div>
  </main>
</div>
<div class="caldav-ctxmenu" hidden>
  <button class="caldav-ctxmenu-item" data-ctx="edit">${icons.pencil} 编辑</button>
  <button class="caldav-ctxmenu-item" data-ctx="delete">${icons.trash} 删除</button>
  <div class="caldav-ctxmenu-err" hidden></div>
</div>`;

  const app = root.querySelector(".caldav-app") as HTMLElement;
  const calListEl = root.querySelector(".caldav-cal-list") as HTMLElement;
  const calfilterPop = root.querySelector(".caldav-calfilter-pop") as HTMLElement;
  const viewEl = root.querySelector(".caldav-view") as HTMLElement;
  const cursorTitleEl = root.querySelector(".caldav-cursor-title") as HTMLElement;
  const ctxMenu = root.querySelector(".caldav-ctxmenu") as HTMLElement;
  const segBtns = Array.from(root.querySelectorAll(".caldav-seg-btn")) as HTMLElement[];
  let destroyed = false;
  /** 右键菜单当前指向的条目 key */
  let ctxMenuKey: string | null = null;

  function renderCalList(): void {
    const cals = ctx.store.settings.calendars;
    if (!cals.length) {
      calListEl.innerHTML = `<div class="caldav-cal-empty">尚未配置服务器<br><button class="caldav-link" data-action="settings">去配置 →</button></div>`;
      return;
    }
    calListEl.innerHTML = cals
      .map(
        (c, i) => `
      <div class="caldav-cal-item ${c.enabled ? "" : "is-off"}" data-cal="${i}">
        <span class="caldav-cal-dot" style="background:${c.color}"></span>
        <span class="caldav-cal-name" title="${escapeAttr(c.url)}">${escapeHtml(c.displayName)}</span>
        <button class="caldav-icon-btn caldav-cal-toggle" title="启用/禁用">${c.enabled ? icons.eye : icons.eyeOff}</button>
      </div>`
      )
      .join("");
  }

  function cursorTitle(): string {
    const c = ctx.cursor;
    if (ctx.viewMode === "year") return `${+c.slice(0, 4)} 年`;
    if (ctx.viewMode === "month") return `${+c.slice(0, 4)} 年 ${+c.slice(5, 7)} 月`;
    if (ctx.viewMode === "week") {
      const ws = startOfWeek(c);
      const we = addDays(ws, 6);
      return `${fmtDateCn(ws)} – ${fmtDateCn(we)}`;
    }
    if (ctx.viewMode === "day") return `${+c.slice(0, 4)} 年 ${+c.slice(5, 7)} 月 ${+c.slice(8, 10)} 日`;
    return "待办任务";
  }

  function renderToolbarState(): void {
    segBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.view === ctx.viewMode));
    app.classList.toggle("is-task", ctx.viewMode === "task");
    cursorTitleEl.textContent = cursorTitle();
  }

  /** 当前启用日历下、时间窗内的展开实例（待办按到期日，见 view-common.todoDueOccurrences） */
  function visibleOccurrences(startMs: number, endMs: number): Map<CalItem, string[]> {
    const enabled = new Set(ctx.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
    const out = new Map<CalItem, string[]>();
    for (const it of ctx.store.getAll()) {
      if (it.deleted || it.dirty) continue;
      if (!enabled.has(it.calendarUrl)) continue;
      const occ =
        it.kind === "todo" ? todoDueOccurrences(it, startMs, endMs) : occurrencesInRange(it, startMs, endMs);
      if (occ.length) out.set(it, occ);
    }
    return out;
  }

  function renderView(): void {
    renderToolbarState();
    const args = { ctx, viewEl, occurrences: visibleOccurrences };
    if (ctx.viewMode === "year") renderYearView(args);
    else if (ctx.viewMode === "month") renderMonthView(args);
    else if (ctx.viewMode === "week") renderWeekView(args, 7);
    else if (ctx.viewMode === "day") renderWeekView(args, 1);
    else renderTaskView(args);
  }

  function renderAll(): void {
    if (destroyed) return;
    hideCtxMenu();
    renderCalList();
    renderView();
  }

  // ---- 右键菜单（日历/任务视图上的条目） ----
  const ctxErrEl = ctxMenu.querySelector(".caldav-ctxmenu-err") as HTMLElement;
  const ctxDelBtn = ctxMenu.querySelector('[data-ctx="delete"]') as HTMLElement;
  let ctxDisarmTimer: ReturnType<typeof setTimeout> | null = null;

  function resetCtxDelete(): void {
    if (ctxDisarmTimer) {
      clearTimeout(ctxDisarmTimer);
      ctxDisarmTimer = null;
    }
    ctxDelBtn.classList.remove("is-armed");
    ctxDelBtn.innerHTML = `${icons.trash} 删除`;
  }

  function hideCtxMenu(): void {
    if (ctxMenu.hidden) return;
    ctxMenu.hidden = true;
    ctxMenuKey = null;
    resetCtxDelete();
    ctxErrEl.hidden = true;
    ctxErrEl.textContent = "";
  }

  /** 在鼠标位置展开菜单，并做视口边界收敛 */
  function showCtxMenu(key: string, x: number, y: number): void {
    ctxMenuKey = key;
    ctxErrEl.hidden = true;
    ctxErrEl.textContent = "";
    resetCtxDelete();
    ctxMenu.hidden = false;
    // 先显示再量尺寸，否则 offsetWidth 为 0
    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    ctxMenu.style.left = `${left}px`;
    ctxMenu.style.top = `${top}px`;
  }

  // 在条目上右键 → 展开菜单（阻止思源原生右键菜单）
  app.addEventListener("contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (!openEl || !app.contains(openEl)) {
      hideCtxMenu();
      return;
    }
    const key = openEl.dataset.open!;
    if (!ctx.store.get(key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    showCtxMenu(key, ev.clientX, ev.clientY);
  });

  ctxMenu.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("[data-ctx]") as HTMLElement | null;
    if (!btn || !ctxMenuKey) return;
    const key = ctxMenuKey;
    const item = ctx.store.get(key);
    if (!item) {
      hideCtxMenu();
      return;
    }
    ev.stopPropagation();

    if (btn.dataset.ctx === "edit") {
      hideCtxMenu();
      openEditor(ctx, { item });
      return;
    }
    if (btn.dataset.ctx !== "delete") return;

    // 二次点击确认：与编辑弹窗内删除保持一致，不用原生 confirm
    if (!btn.classList.contains("is-armed")) {
      btn.classList.add("is-armed");
      btn.innerHTML = `${icons.trash} 再点一次确认删除`;
      ctxDisarmTimer = setTimeout(resetCtxDelete, 4000);
      return;
    }
    resetCtxDelete();
    btn.setAttribute("disabled", "");
    btn.innerHTML = "删除中…";
    void ctx.sync
      .removeItem(item)
      .then(() => {
        if (ctx.store.get(key)) {
          // 仍留在本地 = 服务端 DELETE 未成功，会留待下次同步重试
          ctxErrEl.textContent = "服务器删除未成功，已记录，将在下次同步重试";
          ctxErrEl.hidden = false;
          btn.removeAttribute("disabled");
          btn.innerHTML = `${icons.trash} 删除`;
          return;
        }
        hideCtxMenu();
        renderCalList();
        renderView();
      })
      .catch((e: any) => {
        ctxErrEl.textContent = "删除失败：" + (e?.message || e);
        ctxErrEl.hidden = false;
        btn.removeAttribute("disabled");
        btn.innerHTML = `${icons.trash} 删除`;
      });
  });

  // 视图内导航（年视图跳月/日）
  ctx.navigate = (mode: ViewMode, cursor?: string) => {
    if (cursor) ctx.cursor = cursor;
    ctx.viewMode = mode;
    notifyViewChange(mode);
    renderAll();
  };

  // ---- 事件委托 ----
  app.addEventListener("click", (ev) => {
    const t0 = ev.target as HTMLElement;

    // 待办快速勾选
    const toggleEl = t0.closest("[data-toggle]") as HTMLElement | null;
    if (toggleEl && app.contains(toggleEl)) {
      const item = ctx.store.get(toggleEl.dataset.toggle!);
      if (item) toggleTodoDone(ctx, item);
      ev.stopPropagation();
      return;
    }
    // 打开编辑
    const openEl = t0.closest("[data-open]") as HTMLElement | null;
    if (openEl && app.contains(openEl)) {
      const item = ctx.store.get(openEl.dataset.open!);
      if (item) openEditor(ctx, { item });
      return;
    }

    const target = t0.closest("[data-view],[data-action],[data-cal]") as HTMLElement | null;
    if (!target || !app.contains(target)) return;

    const view = target.dataset.view;
    if (view) {
      ctx.viewMode = view as ViewMode;
      notifyViewChange(ctx.viewMode);
      renderAll();
      return;
    }
    const action = target.dataset.action;
    if (action === "prev" || action === "next") {
      const dir = action === "next" ? 1 : -1;
      ctx.cursor = stepCursor(ctx.cursor, ctx.viewMode, dir);
      renderAll();
      return;
    }
    if (action === "today") {
      ctx.cursor = todayStamp();
      renderAll();
      return;
    }
    if (action === "settings") {
      void openSettingsDialog(ctx).then(renderAll);
      return;
    }
    if (action === "insert-diary") {
      void ctx.insertTodayToDiary().then((msg) => {
        ctx.statusText = msg;
      });
      return;
    }
    if (action === "new-event" || action === "new-todo") {
      const kind: CalKind = action === "new-event" ? "event" : "todo";
      openEditor(ctx, { kind, start: ctx.cursor + (kind === "event" ? "T09:00:00" : "") });
      return;
    }
    if (action === "calfilter") {
      calfilterPop.hidden = !calfilterPop.hidden;
      return;
    }
    if (target.dataset.cal !== undefined) {
      if (target.classList.contains("caldav-cal-toggle")) {
        const cal = ctx.store.settings.calendars[+target.dataset.cal];
        cal.enabled = !cal.enabled;
        void ctx.store.persist();
        renderAll();
      }
    }
  });

  // 点击面板其它区域时收起浮层（日历筛选 + 右键菜单）
  const onDocClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (!ctxMenu.hidden && !t.closest(".caldav-ctxmenu")) hideCtxMenu();
    if (calfilterPop.hidden) return;
    if (t.closest(".caldav-calfilter-wrap")) return;
    calfilterPop.hidden = true;
  };
  document.addEventListener("click", onDocClick, true);

  // Esc 关闭；滚动/窗口尺寸变化时菜单会与条目错位，直接收起
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      hideCtxMenu();
      calfilterPop.hidden = true;
    }
  };
  const onReflow = () => hideCtxMenu();
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onReflow);
  // 捕获阶段监听滚动（视图容器自身也可滚）
  document.addEventListener("scroll", onReflow, true);

  const unsub = ctx.store.onChange(() => renderAll());
  renderAll();

  return {
    destroy() {
      destroyed = true;
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      unsub();
      root.innerHTML = "";
    },
    refresh: renderAll
  };
}

/** 视图切换事件：Dock 导航与主面板页签联动 */
export const VIEW_CHANGE_EVENT = "caldav-view-change";

export function notifyViewChange(mode: ViewMode): void {
  document.dispatchEvent(new CustomEvent(VIEW_CHANGE_EVENT, { detail: mode }));
}

/**
 * Dock 面板：标题「日历任务管理」+ 一行 5 个按钮。
 * 新增 / 排序 为下拉菜单；日历视图 / 任务视图 打开主窗口页签；刷新 触发重新同步。
 */
export interface DockPanelOpts {
  store: CalStore;
  onNav: (mode: ViewMode) => void;
  onSync: () => unknown;
  onSettings: () => void;
  onAddEvent: () => void;
  onAddTask: () => void;
  onSort: (mode: SortMode) => void;
  onOpenEditor: (item: CalItem) => void;
  onToggleDone: (item: CalItem) => void;
}

export function renderDockPanel(root: HTMLElement, opts: DockPanelOpts): { destroy: () => void } {
  root.classList.add("caldav-dock");
  root.innerHTML = `
<div class="caldav-dock-brand">
  <span class="caldav-brand-icon">${icons.calendar}</span>
  <span class="caldav-brand-title">日历任务管理</span>
</div>
<div class="caldav-dock-actions">
  <div class="caldav-dock-menu" data-menu="add">
    <button class="caldav-dock-act" data-toggle="add" title="新增事件、任务" aria-label="新增">${icons.plusThin}</button>
    <div class="caldav-dock-pop" data-pop="add" hidden>
      <button class="caldav-dock-popitem" data-action="add-event">新增事件</button>
      <button class="caldav-dock-popitem" data-action="add-task">新增任务</button>
    </div>
  </div>
  <div class="caldav-dock-menu" data-menu="sort">
    <button class="caldav-dock-act" data-toggle="sort" title="排序" aria-label="排序">${icons.sortDown}</button>
    <div class="caldav-dock-pop" data-pop="sort" hidden>
      <button class="caldav-dock-popitem" data-action="sort-priority">按优先级排序</button>
      <button class="caldav-dock-popitem" data-action="sort-start">按开始时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-end">按结束时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-completed">按完成时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-created">按创建时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-category">按分类排序</button>
      <button class="caldav-dock-popitem" data-action="sort-title">按标题排序</button>
    </div>
  </div>
  <button class="caldav-dock-act" data-action="cal-view" title="日历视图" aria-label="日历">${icons.calCheck}</button>
  <button class="caldav-dock-act" data-action="task-view" title="任务视图" aria-label="任务">${icons.taskList}</button>
  <button class="caldav-dock-act" data-action="sync" title="刷新（重新同步）" aria-label="刷新">${icons.refreshThin}</button>
</div>
<div class="caldav-dock-list">
  <div class="caldav-dock-list-head">
    <div class="caldav-dock-filter-wrap">
      <select class="caldav-dock-select" data-dock="filter">
        <option value="next7">未来七天</option>
        <option value="today">今日任务</option>
        <option value="tomorrow">明日任务</option>
        <option value="thisweek">本周任务</option>
        <option value="future">未来任务</option>
        <option value="overdue">过期任务</option>
        <option value="past7">过去七天</option>
        <option value="undone">所有未完成</option>
        <option value="nodate">无日期任务</option>
        <option value="doneToday">今日已完成</option>
        <option value="doneYesterday">昨日已完成</option>
        <option value="done">已完成</option>
      </select>
      <span class="caldav-dock-select-arrow">${icons.chevron}</span>
    </div>
    <button class="caldav-dock-filter-btn" data-dock="category">分类筛选</button>
    <div class="caldav-dock-cat-pop" data-pop="category" hidden>
      <div class="caldav-dock-cat-head">选择分类</div>
      <div class="caldav-dock-cat-list" data-cat-list></div>
      <div class="caldav-dock-cat-foot">
        <button class="caldav-foot-btn caldav-foot-btn--ghost" data-cat-action="cancel">取消</button>
        <button class="caldav-foot-btn caldav-foot-btn--primary" data-cat-action="ok">确定</button>
      </div>
    </div>
  </div>
  <div class="caldav-dock-search-wrap">
    <span class="caldav-dock-search-icon">${icons.search}</span>
    <input class="caldav-dock-search" data-dock="search" placeholder="搜索任务..." />
  </div>
  <div class="caldav-dock-items" data-dock="items"></div>
</div>
<div class="caldav-dock-foot">
  <button class="caldav-dock-status" data-action="sync">未同步</button>
  <div class="caldav-dock-error" data-dock="error" hidden></div>
</div>`;

  const statusEl = root.querySelector(".caldav-dock-status") as HTMLElement;
  const errorEl = root.querySelector("[data-dock='error']") as HTMLElement | null;
  const listEl = root.querySelector("[data-dock='items']") as HTMLElement;
  const pops = Array.from(root.querySelectorAll<HTMLElement>(".caldav-dock-pop"));
  let localSort: SortMode = "start";
  let destroyed = false;

  function closePops(): void {
    pops.forEach((p) => (p.hidden = true));
    const catPop = root.querySelector<HTMLElement>("[data-pop='category']");
    if (catPop) catPop.hidden = true;
    root.querySelectorAll(".caldav-dock-act.is-open").forEach((b) => b.classList.remove("is-open"));
  }

  function openCategoryPop(): void {
    pendingCategoryFilter = [...dockCategoryFilter];
    renderCategoryPop();
    const catPop = root.querySelector<HTMLElement>("[data-pop='category']");
    const btn = root.querySelector<HTMLElement>("[data-dock='category']");
    if (catPop) {
      catPop.hidden = false;
      if (btn) {
        const r = btn.getBoundingClientRect();
        catPop.style.top = `${r.top}px`;
        catPop.style.left = `${r.right + 8}px`;
      }
    }
  }

  function togglePop(name: string): void {
    const pop = pops.find((p) => p.dataset.pop === name);
    const open = !pop?.hidden;
    closePops();
    if (open) return;
    if (pop) pop.hidden = false;
    const btn = root.querySelector(`[data-toggle="${name}"]`);
    btn?.classList.add("is-open");
  }

  function renderSortActive(): void {
    root.querySelectorAll<HTMLElement>(".caldav-dock-popitem[data-action^='sort-']").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.action === `sort-${localSort}`);
    });
  }

  function renderStatus(): void {
    if (destroyed) return;
    const s = opts.store.settings;
    const err = opts.store.lastError;
    const cred = opts.store.credentialsIssue();
    const time = opts.store.lastSync || "—";

    // 凭据问题优先提示：这类错误原来只写在控制台，用户完全看不到
    if (cred) {
      statusEl.textContent = "同步不可用 · 凭据异常";
      statusEl.title = cred;
      statusEl.classList.add("has-error");
      showError(cred);
      return;
    }
    if (!s.serverUrl) {
      statusEl.textContent = "未配置服务器";
      statusEl.title = "点击打开设置";
      statusEl.classList.remove("has-error");
      showError("");
      return;
    }
    if (err) {
      statusEl.textContent = `同步失败 · ${time}`;
      statusEl.title = `错误: ${err}`;
      statusEl.classList.add("has-error");
      showError(err);
    } else {
      statusEl.textContent = `上次同步 ${time}`;
      statusEl.title = "点击立即同步";
      statusEl.classList.remove("has-error");
      showError("");
    }
  }

  /** 页脚错误行：把错误正文摊开显示，而不是只放在悬停提示里 */
  function showError(text: string): void {
    if (!errorEl) return;
    if (!text) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = text.length > 90 ? text.slice(0, 90) + "…" : text;
    errorEl.title = text;
  }

  type DockFilter =
    | "today" | "tomorrow" | "next7" | "thisweek" | "future"
    | "overdue" | "past7" | "undone" | "nodate"
    | "doneToday" | "doneYesterday" | "done";

  let dockFilter: DockFilter = "next7";
  let dockSearch = "";
  let dockCategoryFilter: string[] = []; // 空 = 所有分类；"__none__" = 无分类

  function isEnabledCalendar(it: CalItem): boolean {
    return opts.store.settings.calendars.some((c) => c.enabled && c.url === it.calendarUrl);
  }

  /** 条目用于「归属时间段」的日期：待办取到期日（DUE），事件取开始时间 */
  function dateKeyOf(it: CalItem): string {
    return (it.kind === "todo" ? it.end : it.start)?.slice(0, 10) || "";
  }

  function matchesDockFilter(it: CalItem, filter: DockFilter): boolean {
    if (it.deleted || it.dirty) return false;
    if (!isEnabledCalendar(it)) return false;

    const today = todayStamp();
    const date = dateKeyOf(it);
    const diff = diffDays(date, today);
    const weekStart = startOfWeek(today);
    const weekEnd = addDays(weekStart, 6).slice(0, 10);
    const isTodo = it.kind === "todo";
    const isDone = isTodo && it.percent === 100;

    switch (filter) {
      case "today":
        return date === today;
      case "tomorrow":
        return date === addDays(today, 1).slice(0, 10);
      case "next7":
        return diff >= 0 && diff <= 6;
      case "thisweek":
        return date >= weekStart && date <= weekEnd;
      case "future":
        return diff >= 0;
      case "overdue":
        return isTodo && !isDone && !!date && diff < 0;
      case "past7":
        return diff >= -6 && diff < 0;
      case "undone":
        return isTodo && !isDone;
      case "nodate":
        return isTodo && !date;
      case "doneToday":
        return isDone && !!it.completedAt && it.completedAt.slice(0, 10) === today;
      case "doneYesterday":
        return isDone && !!it.completedAt && it.completedAt.slice(0, 10) === addDays(today, -1).slice(0, 10);
      case "done":
        return isDone;
      default:
        return true;
    }
  }

  function matchesDockSearch(it: CalItem, q: string): boolean {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return (
      it.summary.toLowerCase().includes(s) ||
      (it.description || "").toLowerCase().includes(s) ||
      (it.location || "").toLowerCase().includes(s) ||
      (it.categories || []).some((c) => c.toLowerCase().includes(s))
    );
  }

  function matchesDockCategoryFilter(it: CalItem, filter: string[]): boolean {
    if (!filter.length) return true;
    const hasNone = filter.includes("__none__");
    const cats = filter.filter((f) => f !== "__none__");
    const itemCats = it.categories || [];
    if (hasNone && itemCats.length === 0) return true;
    if (cats.length && itemCats.some((c) => cats.includes(c))) return true;
    return false;
  }

  function formatDockTimeRange(it: CalItem): string {
    if (it.allDay) return "全天";
    if (it.kind === "event" && it.end) return `${fmtTime(it.start)} - ${fmtTime(it.end)}`;
    // 待办以到期时间为准，不再展示开始时间
    if (it.kind === "todo" && it.end) return isDateOnly(it.end) ? "" : fmtTime(it.end);
    if (!isDateOnly(it.start)) return fmtTime(it.start);
    return "";
  }

  function buildDockTags(it: CalItem): string {
    const tags: string[] = [];
    const today = todayStamp();
    const date = dateKeyOf(it);
    const diff = diffDays(date, today);

    // 主时间标签
    let timeLabel = "";
    if (it.kind === "todo" && it.percent === 100) timeLabel = "已完成";
    else if (!date) timeLabel = "无日期";
    else if (diff === 0) timeLabel = "今天";
    else if (diff === 1) timeLabel = "明天";
    else if (diff > 1) timeLabel = `${diff}天后开始`;
    else if (diff === -1) timeLabel = "昨天";
    else timeLabel = `${-diff}天前`;
    tags.push(`<span class="caldav-dock-tag caldav-dock-tag--primary">${timeLabel}</span>`);

    // 类型 / 优先级
    if (it.kind === "event") {
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.calendar}日程</span>`);
    } else if (it.priority) {
      const pMap: Record<number, string> = { 1: "紧急", 3: "高", 5: "中", 9: "低" };
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.flag}${pMap[it.priority] || "任务"}</span>`);
    } else {
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.tasks}任务</span>`);
    }

    // 自定义分类
    if (it.categories) {
      for (const c of it.categories) {
        tags.push(`<span class="caldav-dock-tag caldav-dock-tag--ghost">${icons.tag}${escapeHtml(c)}</span>`);
      }
    }

    return tags.join("");
  }

  let pendingCategoryFilter: string[] = [];

  function renderCategoryPop(): void {
    const pop = root.querySelector("[data-pop='category']") as HTMLElement;
    const listEl = pop.querySelector("[data-cat-list]") as HTMLElement;
    const cats = opts.store.settings.categories?.length ? opts.store.settings.categories : DEFAULT_CATEGORIES;
    const filter = pendingCategoryFilter;
    const isAll = filter.length === 0;

    const items = [
      { key: "__all__", label: "所有分类", icon: "", color: "" },
      { key: "__none__", label: "无分类", icon: "", color: "" },
      ...cats.map((c) => ({ key: c.name, label: c.name, icon: c.icon, color: c.color }))
    ];

    listEl.innerHTML = items
      .map((item) => {
        const checked = item.key === "__all__" ? isAll : filter.includes(item.key);
        const iconHtml = item.icon
          ? `<span class="caldav-dock-cat-icon" style="background:${escapeAttr(item.color)}">${escapeHtml(item.icon)}</span>`
          : "";
        return `<label class="caldav-dock-cat-item ${checked ? "is-active" : ""}" data-cat-key="${escapeAttr(item.key)}">
      <input type="checkbox" ${checked ? "checked" : ""}/>
      ${iconHtml}<span>${escapeHtml(item.label)}</span>
    </label>`;
      })
      .join("");
  }

  function dockSort(a: CalItem, b: CalItem): number {
    const sv = (it: CalItem): string | number => {
      switch (localSort) {
        case "end":
          // 待办以到期日为准；无到期日的排最后
          return it.kind === "todo" ? it.end || "9999-12-31T23:59:59" : it.end || it.start;
        case "priority":
          return it.priority && it.priority > 0 ? it.priority : 9; // 无优先级视为最低
        case "completed":
          return it.completedAt || "9999-12-31T23:59:59"; // 未完成排最后
        case "created":
          return it.createdAt || it.start;
        case "category":
          return (it.categories && it.categories[0]) || "";
        case "title":
          return (it.summary || "").toLowerCase();
        case "start":
        default:
          // 待办按到期时间排序（与时间归属口径一致）
          return dateKeyOf(it) + "T" + (it.kind === "todo" ? it.end || "" : it.start).slice(11);
      }
    };
    const av = sv(a);
    const bv = sv(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    // 并列回退：开始时间 → 标题
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return (a.summary || "").localeCompare(b.summary || "", "zh");
  }

  /**
   * 当前筛选下被隐藏的无日期未完成待办数量。
   * 用户在编辑弹窗里清空日期后，这类条目会落在「无日期」里，
   * 若不提示，看起来就像「记录消失了」（实测用户就是这么反馈的）。
   */
  function hiddenNodateCount(): number {
    if (dockFilter === "nodate" || dockFilter === "undone" || dockFilter.startsWith("done")) return 0;
    const q = dockSearch.toLowerCase().trim();
    return opts.store
      .getAll()
      .filter((it) => it.kind === "todo" && !it.deleted && !it.dirty && it.percent !== 100)
      .filter((it) => isEnabledCalendar(it))
      .filter((it) => !dateKeyOf(it))
      .filter((it) => matchesDockCategoryFilter(it, dockCategoryFilter))
      .filter((it) => matchesDockSearch(it, q)).length;
  }

  function renderDockList(): void {
    if (destroyed) return;
    const q = dockSearch.toLowerCase().trim();
    const items = opts.store
      .getAll()
      .filter((it) => matchesDockFilter(it, dockFilter))
      .filter((it) => matchesDockCategoryFilter(it, dockCategoryFilter))
      .filter((it) => matchesDockSearch(it, q))
      .sort(dockSort)
      .slice(0, 50);

    const nodateHidden = hiddenNodateCount();
    const nodateHint = nodateHidden
      ? `<button class="caldav-dock-hint" data-dock-action="show-nodate">另有 ${nodateHidden} 条无日期待办未显示 · 点此查看</button>`
      : "";

    if (!items.length) {
      listEl.innerHTML = `<div class="caldav-dock-empty">暂无匹配条目</div>${nodateHint}`;
      return;
    }

    listEl.innerHTML = items
      .map((it) => {
        const key = keyOf(it);
        const date = it.kind === "todo" ? it.end : it.start;
        const dateStr = date ? fmtDateCn(date) : "无日期";
        const timeStr = formatDockTimeRange(it);
        const tags = buildDockTags(it);
        const isDoneTodo = it.kind === "todo" && it.percent === 100;
        return `
      <div class="caldav-dock-item ${isDoneTodo ? "is-done" : ""}" data-open="${key}">
        <span class="caldav-dock-check" data-toggle="${key}">
          ${it.kind === "todo"
            ? `<input type="checkbox" ${isDoneTodo ? "checked" : ""}/>`
            : `<span class="caldav-dock-kind">${icons.calendar}</span>`}
        </span>
        <div class="caldav-dock-item-main">
          <div class="caldav-dock-item-title">${escapeHtml(it.summary)}</div>
          <div class="caldav-dock-item-meta">
            <span class="caldav-dock-item-date">
              ${it.kind === "todo" ? icons.tasks : icons.calendar}
              ${dateStr}${timeStr ? " " + timeStr : ""}
            </span>
          </div>
          <div class="caldav-dock-item-tags">${tags}</div>
        </div>
      </div>`;
      })
      .join("") + nodateHint;
  }

  root.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;

    // 「另有 N 条无日期待办」提示：直接切到无日期筛选
    const nodateBtn = t.closest("[data-dock-action='show-nodate']");
    if (nodateBtn) {
      dockFilter = "nodate";
      const sel = root.querySelector<HTMLSelectElement>("[data-dock='filter']");
      if (sel) sel.value = "nodate";
      renderDockList();
      ev.stopPropagation();
      return;
    }

    // Dock 列表内部：复选框 / 卡片打开
    const toggleEl = t.closest("[data-toggle]") as HTMLElement | null;
    if (toggleEl && listEl.contains(toggleEl)) {
      const item = opts.store.get(toggleEl.dataset.toggle!);
      if (item) opts.onToggleDone(item);
      ev.stopPropagation();
      return;
    }
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (openEl && listEl.contains(openEl)) {
      const item = opts.store.get(openEl.dataset.open!);
      if (item) opts.onOpenEditor(item);
      return;
    }

    // 下拉内的动作
    const popItem = t.closest("[data-action]") as HTMLElement | null;
    if (popItem && root.contains(popItem)) {
      const a = popItem.dataset.action!;
      closePops();
      if (a === "add-event") return opts.onAddEvent();
      if (a === "add-task") return opts.onAddTask();
      if (a.startsWith("sort-")) {
        localSort = a.slice(5) as SortMode;
        renderSortActive();
        renderDockList();
        return opts.onSort(localSort);
      }
      if (a === "cal-view") return opts.onNav("month");
      if (a === "task-view") return opts.onNav("task");
      if (a === "sync") {
        statusEl.textContent = "同步中…";
        void opts.onSync().finally(() => {
          renderStatus();
          renderDockList();
        });
        return;
      }
    }

    // 分类筛选弹层
    const catPopEl = root.querySelector<HTMLElement>("[data-pop='category']");
    const catItem = t.closest(".caldav-dock-cat-item") as HTMLElement | null;
    const catAction = t.closest("[data-cat-action]") as HTMLElement | null;
    if (catPopEl && !catPopEl.hidden && (catItem || catAction)) {
      if (catAction) {
        if (catAction.dataset.catAction === "ok") {
          dockCategoryFilter = pendingCategoryFilter;
          renderDockList();
        }
        closePops();
        return;
      }
      if (catItem) {
        const key = catItem.dataset.catKey!;
        if (key === "__all__") {
          pendingCategoryFilter = [];
        } else {
          const set = new Set(pendingCategoryFilter);
          if (set.has(key)) set.delete(key);
          else set.add(key);
          pendingCategoryFilter = Array.from(set);
        }
        renderCategoryPop();
        return;
      }
    }
    if (t.closest("[data-dock='category']")) {
      const catPopEl2 = root.querySelector<HTMLElement>("[data-pop='category']");
      if (catPopEl2?.hidden) openCategoryPop();
      else closePops();
      return;
    }

    // 菜单展开/收起
    const toggle = t.closest("[data-toggle]") as HTMLElement | null;
    if (toggle && root.contains(toggle)) {
      togglePop(toggle.dataset.toggle!);
      return;
    }
  });

  root.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.dataset.dock === "filter") {
      dockFilter = (target as HTMLSelectElement).value as DockFilter;
      renderDockList();
    }
  });

  root.addEventListener("input", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.dataset.dock === "search") {
      dockSearch = (target as HTMLInputElement).value;
      renderDockList();
    }
  });

  const onDocClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (!root.contains(t)) closePops();
  };
  document.addEventListener("click", onDocClick, true);

  const listScrollEl = root.querySelector<HTMLElement>(".caldav-dock-list");
  const onScrollClose = () => closePops();
  listScrollEl?.addEventListener("scroll", onScrollClose);
  window.addEventListener("resize", onScrollClose);

  const unsub = opts.store.onChange(() => {
    renderStatus();
    renderDockList();
  });
  renderStatus();
  renderSortActive();
  renderDockList();

  return {
    destroy() {
      destroyed = true;
      document.removeEventListener("click", onDocClick, true);
      listScrollEl?.removeEventListener("scroll", onScrollClose);
      window.removeEventListener("resize", onScrollClose);
      unsub();
      root.innerHTML = "";
    }
  };
}

export function toggleTodoDone(ctx: PanelCtx, item: CalItem): void {
  if (item.kind !== "todo") return;
  const done = item.percent === 100;
  item.percent = done ? 0 : 100;
  item.status = done ? "NEEDS-ACTION" : "COMPLETED";
  if (!done) item.completedAt = new Date().toISOString().slice(0, 19);
  else item.completedAt = undefined;
  void ctx.sync.updateItem(item);
}

export function stepCursor(cursor: string, mode: ViewMode, dir: number): string {
  const d = parseLocalStamp(cursor);
  if (mode === "year") {
    d.setFullYear(d.getFullYear() + dir);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (mode === "month") {
    d.setDate(1);
    d.setMonth(d.getMonth() + dir);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (mode === "week") return addDays(cursor, dir * 7);
  return addDays(cursor, dir);
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export { fmtTime, isDateOnly, parseLocalStamp };
