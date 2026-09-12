/** siyuan 模块桩：模拟思源插件 API 的运行时行为（CJS） */
class EventBus {
  constructor() { this.h = {}; }
  on(t, fn) { (this.h[t] ||= []).push(fn); }
  off() {}
  emit(t, d) { (this.h[t] || []).forEach((f) => f(d)); }
}

class Plugin {
  constructor(options = {}) {
    this.app = options.app || { appId: "test" };
    this.name = options.name || "test-plugin";
    this.i18n = options.i18n || {};
    this.data = {};
    this.eventBus = new EventBus();
    this.commands = [];
    this.__stores = new Map();
    globalThis.__syRegistrations = { topbar: [], dock: [], tab: [], commands: [], icons: [] };
  }
  addIcons(svg) { globalThis.__syRegistrations.icons.push(svg); }
  addTopBar(o) { globalThis.__syRegistrations.topbar.push(o); }
  addDock(o) { globalThis.__syRegistrations.dock.push(o); }
  addTab(o) { globalThis.__syRegistrations.tab.push(o); }
  addCommand(o) { globalThis.__syRegistrations.commands.push(o); }
  async loadData(k) { return this.__stores.get(k); }
  async saveData(k, d) { this.__stores.set(k, JSON.parse(JSON.stringify(d))); }
  async removeData(k) { this.__stores.delete(k); }
  getOpenedTab() { return []; }
}

class Dialog {
  constructor(options = {}) {
    const wrap = document.createElement("div");
    wrap.className = "b3-dialog";
    const container = document.createElement("div");
    container.className = "b3-dialog--container";
    container.innerHTML = `<div class="b3-dialog__title">${options.title || ""}</div><div class="b3-dialog__content">${options.content || ""}</div>`;
    wrap.appendChild(container);
    document.body.appendChild(wrap);
    this.element = wrap;
    this.container = container;
  }
  open() {}
  destroy() { this.element.remove(); }
}

module.exports = {
  Plugin,
  Dialog,
  Menu: class {},
  Setting: class {},
  openTab(o) { globalThis.__syRegistrations.lastOpenTab = o; },
  getFrontend: () => "desktop",
  getBackend: () => "desktop",
  fetchPost: async () => {},
  fetchSyncPost: async () => ({ code: 0 }),
  showMessage: () => {},
  confirm: async () => true,
  openDock: () => {},
  platformUtils: {},
  Constants: {}
};
