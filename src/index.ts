/**
 * CalDAV日历任务 —— 思源笔记插件入口
 * 左侧 Dock：精简导航（视图切换 + 设置）；主日历视图：主窗口页签
 */
import { Plugin, openTab, getFrontend, type Custom, type MobileCustom, type Tab } from "siyuan";
import "@/index.css";
import { CalStore } from "@/core/store";
import { SyncEngine } from "@/core/sync";
import { setSecretSeed } from "@/core/secret";
import { occurrencesInRange } from "@/core/ics";
import { todayStamp } from "@/core/date";
import { renderPanel, renderDockPanel, notifyViewChange, toggleTodoDone, VIEW_CHANGE_EVENT, type PanelCtx, type ViewMode } from "@/ui/panel";
import { openEditor } from "@/ui/editor";
import { openSettingsDialog } from "@/ui/settings-dialog";

const DOCK_TYPE = "caldav-sync-dock";
const TAB_TYPE = "caldav-sync-tab";

const ICONS = `<symbol id="iconCalDavSync" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/></symbol>`;

export default class CalDavPlugin extends Plugin {
  store!: CalStore;
  sync!: SyncEngine;
  /** 主窗口页签共享状态（单例，Dock 导航与页签共用） */
  mainCtx!: PanelCtx;
  private disposers = new Map<string, () => void>();
  private tabPanel: { refresh: () => void } | null = null;
  private tab: Tab | null = null;
  private viewChangeHandler: ((e: Event) => void) | null = null;

  async onload(): Promise<void> {
    const self = this;
    this.addIcons(ICONS);

    // 先拿到设备标识（思源 conf.system.id + 工作空间路径）作为凭据加密密钥来源，
    // 再加载 store —— 顺序不能反，否则密文解不开会被当成「密码丢失」。
    await this.ensureSecretSeed();

    this.store = new CalStore({
      loadData: () => this.loadData(DOCK_TYPE),
      saveData: (d) => this.saveData(DOCK_TYPE, d)
    });
    await this.store.load();
    this.sync = new SyncEngine(this.store, () => this.store.settings.channel);
    this.mainCtx = this.createCtx();

    // 左侧 Dock：精简导航（视图按钮在主窗口打开/切换日历页签）
    this.addDock({
      config: {
        position: "LeftBottom",
        size: { width: 240, height: 0 },
        icon: "iconCalDavSync",
        title: "日历任务管理",
        hotkey: "⌥⇧C"
      },
      data: { key: "dock" },
      type: DOCK_TYPE,
      init: function (this: Custom | MobileCustom) {
        if (self.disposers.has("dock")) return;
        self.disposers.set(
          "dock",
          renderDockPanel(this.element as HTMLElement, {
            store: self.store,
            onNav: (m) => self.openPanelTab(m),
            onSync: () => self.sync.syncAll(),
            onSettings: () => self.openSetting(),
            onAddEvent: () => openEditor(self.mainCtx, { kind: "event", start: self.mainCtx.cursor + "T09:00:00" }),
            onAddTask: () => openEditor(self.mainCtx, { kind: "todo" }),
            onSort: (mode) => {
              self.mainCtx.sortMode = mode;
              self.tabPanel?.refresh();
            },
            onOpenEditor: (item) => openEditor(self.mainCtx, { item }),
            onToggleDone: (item) => toggleTodoDone(self.mainCtx, item)
          }).destroy
        );
        // 点击插件图标展开 Dock 时，默认在主窗口打开日历视图
        // 延迟执行：init 阶段 SiYuan 布局尚未完全就绪，立即 openTab 可能被忽略；
        // 等布局稳定（约 350ms）后再开，确保「日历」页签稳定弹出。
        setTimeout(() => self.openPanelTab("month"), 350);
      },
      destroy: () => {
        self.disposers.get("dock")?.();
        self.disposers.delete("dock");
      }
    });

    // 主窗口日历页签（单例）
    this.addTab({
      type: TAB_TYPE,
      init: function (this: Custom) {
        if (self.disposers.has("tab")) return;
        const panel = renderPanel(this.element as HTMLElement, self.mainCtx);
        self.tabPanel = panel;
        self.disposers.set("tab", () => {
          panel.destroy();
          self.tabPanel = null;
        });
        notifyViewChange(self.mainCtx.viewMode);
      },
      beforeDestroy: function () {
        self.disposers.get("tab")?.();
        self.disposers.delete("tab");
      }
    });

    // 监听视图切换，同步更新已打开页签的标题
    this.viewChangeHandler = (e: Event) => {
      const mode = (e as CustomEvent).detail as ViewMode;
      if (self.tab) {
        self.tab.updateTitle(mode === "task" ? "任务" : "日历");
      }
    };
    document.addEventListener(VIEW_CHANGE_EVENT, this.viewChangeHandler);

    // 命令（可在「设置 → 快捷键」中绑定）
    this.addCommand({
      langKey: "syncNow",
      langText: "立即同步 CalDAV",
      hotkey: "",
      callback: () => void this.sync.syncAll()
    });
    this.addCommand({
      langKey: "addTask",
      langText: "新建待办",
      hotkey: "",
      callback: () => openEditor(this.mainCtx, { kind: "todo" })
    });
    this.addCommand({
      langKey: "openPanel",
      langText: "打开日历与任务",
      hotkey: "",
      callback: () => this.openPanelTab()
    });
    this.addCommand({
      langKey: "insertToday",
      langText: "把今日日程与待办插入日记",
      hotkey: "",
      callback: () => void this.insertTodayToDiary()
    });

    if (this.store.isConfigured()) {
      this.sync.startAutoSync();
      setTimeout(() => void this.sync.syncAll(), 3000);
    }
  }

  onunload(): void {
    this.sync.stopAutoSync();
    for (const d of this.disposers.values()) d();
    this.disposers.clear();
    if (this.viewChangeHandler) {
      document.removeEventListener(VIEW_CHANGE_EVENT, this.viewChangeHandler);
      this.viewChangeHandler = null;
    }
    this.tabPanel = null;
    this.tab = null;
  }

  /**
   * 在主窗口打开日历页签；已打开则聚焦并切换到指定视图。
   * 同一 id 的 custom 页签思源会自动聚焦已存在的实例（不再新建）。
   */
  openPanelTab(mode?: ViewMode): void {
    if (getFrontend() === "mobile") {
      // 移动端暂未适配（plugin.json 已限制桌面端）
    }
    if (mode) {
      this.mainCtx.viewMode = mode;
      notifyViewChange(mode);
      this.tabPanel?.refresh();
    }
    const title = mode && mode !== "task" ? "日历" : mode === "task" ? "任务" : "日历与任务";
    const tabPromise = openTab({
      app: this.app,
      custom: {
        icon: "iconCalDavSync",
        title,
        // 注意：data 会被 SiYuan 序列化进布局，必须可 JSON 序列化；
        // 插件实例（含 app/store/循环引用）不可放入，改用闭包 self 访问。
        data: { type: TAB_TYPE },
        id: this.name + TAB_TYPE
      },
      keepCursor: false
    });
    if (tabPromise && typeof tabPromise.then === "function") {
      void tabPromise.then((tab) => {
        this.tab = tab;
        tab.updateTitle(title);
      });
    }
  }

  /** 打开 Dock 面板（聚焦已开面板） */
  openDockPanel(): void {
    document.querySelector(`[data-type="${DOCK_TYPE}"]`)?.dispatchEvent(new MouseEvent("click"));
  }

  /**
   * 取思源 conf 里的设备/工作空间标识，作为凭据加密的密钥来源。
   * conf 不参与云同步，且与插件 iframe 端口无关，因此换端口/重启都不会导致密码解不开。
   */
  private async ensureSecretSeed(): Promise<void> {
    // 非浏览器环境（单元测试）没有可用的同源根，直接跳过，走兼容密钥
    if (typeof location === "undefined" || !location.origin) return;
    try {
      const res = await fetch(location.origin + "/api/system/getConf", { method: "POST" });
      const j: any = await res.json();
      const conf = j?.data?.conf || j?.data || {};
      const id = conf?.system?.id || "";
      const ws = conf?.system?.workspaceDir || "";
      if (id) {
        setSecretSeed(`${id}|${ws}`);
      } else {
        console.warn("[caldav] 未取到设备标识，凭据将使用兼容密钥");
      }
    } catch (e) {
      console.warn("[caldav] 读取设备标识失败，凭据将使用兼容密钥:", e);
    }
  }

  private createCtx(): PanelCtx {
    return {
      store: this.store,
      sync: this.sync,
      i18n: (k) => (this.i18n as any)?.[k] || k,
      insertTodayToDiary: () => this.insertTodayToDiary(),
      unsaved: new Set(),
      viewMode: "month" as ViewMode,
      cursor: todayStamp(),
      statusText: "",
      sortMode: "start"
    };
  }

  /** 设置入口 */
  openSetting(): void {
    void openSettingsDialog(this.mainCtx);
  }

  /** 把今日日程与待办汇总插入当天日记 */
  async insertTodayToDiary(): Promise<string> {
    const today = todayStamp();
    const lines: string[] = [];
    const enabled = new Set(this.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
    const startMs = new Date(today + "T00:00:00").getTime();
    const endMs = startMs + 86400000;
    for (const it of this.store.getAll()) {
      if (it.deleted || it.dirty || !enabled.has(it.calendarUrl)) continue;
      if (it.kind === "todo" && it.percent === 100) continue;
      for (const occ of occurrencesInRange(it, startMs, endMs)) {
        const time = it.allDay ? "全天" : occ.slice(11, 16);
        const mark = it.kind === "todo" ? "☑️" : "📅";
        lines.push(`- ${mark} ${time} ${it.summary}`);
      }
    }
    if (!lines.length) return "今天没有日程或待办";
    const md = `## 今日日程与待办\n${lines.join("\n")}\n`;

    // 找今天的日记文档块
    const sql = `select id, content, hpath from blocks where type = 'd' and (content like '%${today}%' or hpath like '%${today}%') limit 10`;
    const res = await fetch("/api/query/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stmt: sql })
    });
    const data = await res.json();
    const rows: any[] = data.data || [];
    const doc = rows.find((r) => (r.content || "").includes(today)) || rows[0];
    if (!doc) {
      const nbRes = await (await fetch("/api/notebook/lsNotebooks", { method: "POST", body: "{}" })).json();
      const nb = (nbRes.data?.notebooks || []).find((n: any) => !n.closed);
      if (!nb) return "没有打开的笔记本，无法创建日记";
      await fetch("/api/filetree/createDocWithMd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook: nb.id, path: "/" + today, markdown: md })
      });
      return `已创建今日日记并写入 ${lines.length} 条日程与待办`;
    }
    await fetch("/api/block/insertBlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentID: doc.id, dataType: "markdown", data: md })
    });
    return `已把 ${lines.length} 条日程与待办插入今日日记`;
  }
}
