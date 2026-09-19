/**
 * 移动端「全屏层」管理 —— 保证插件打开的页面不会越叠越多。
 *
 * 背景：移动端没有页签栏，日历面板与编辑弹窗都用思源的 Dialog 承载。
 * 而思源的每个 Dialog 都是**独立元素 + 独立遮罩 + 递增 z-index**
 * （移动端产物里 `this.element.innerHTML = '<div class="b3-dialog" style="z-index: ' + (++window.siyuan.zIndex) + '">…'`
 * 之后 append 到 body），彼此之间没有任何互斥。于是从 Dock 上连点
 * 「新增 / 日历 / 任务」这类入口，就会叠出好几层全屏页面，用户得连点好几次
 * 右上角关闭才退得回 Dock。
 *
 * 收口语义（三层，按「打开它时下面允许留什么」定）：
 *  - page（日历、任务、设置等页面）——**替换**：打开前收掉所有已有层；
 *  - sheet（条目编辑弹窗）——**叠一层**：可叠在一个页面之上（关掉即返回该页面），
 *    但同时只允许存在一个，且不去顶掉下面的页面；
 *  - sub（分类管理等从弹窗里再开的次级弹窗）——**再叠一层**：
 *    保留下面的页面与弹窗（它们可能还带着没保存的修改），关掉即回到上一级。
 *
 * ★ 新增弹层时**必须**调用 adoptMobileLayer 登记，否则它既不会收掉下面的残留层、
 *   也不会被后续的开层动作认领 —— 用户看到的就是「这一页要连点好几次才关得掉」。
 *   插件里所有 `new Dialog` 的位置：index.ts（移动端面板）、editor.ts、settings-dialog.ts、
 *   category-manager.ts；加新的务必一并登记。
 *
 * ★ 关键：**以 DOM 为准，不靠引用记账**。
 *   1) 思源的 `Dialog.destroy()` 是异步的 —— 先摘掉 `b3-dialog--open` 让容器淡出，
 *      一个 timeout 之后才 `element.remove()` 并回调 `destroyCallback`
 *      （见移动端产物 Dialog.destroy）。所以「关了但还没消失」是常态。
 *   2) 插件覆盖安装 / 集市热更新只会换掉 JS，**页面上已有的弹层元素会留下**，
 *      它们的回调属于上一版模块实例，当前代码的任何数组都不认识它们。
 *   3) 用户遇到「要连点 5 次才关得掉」，就是这类不在账上的层 —— 每关一层，
 *      下面还压着一层（甚至压着上一版代码开出来的页面）。
 *
 * 因此每次开新层都扫一遍 DOM：凡是本插件的内容根（含旧版本没打标记的），一律认领收掉。
 */
import { isMobile } from "./device";

export type MobileLayerKind = "page" | "sheet" | "sub";

/** 只要求 Dialog 有这两样，避免把思源类型铺到各处 */
export interface MobileLayerDialog {
  element: HTMLElement;
  destroy: () => void;
}

/**
 * 本插件全屏层的内容根（跨版本兜底）。
 * 新版本会给外层打 `data-caldav-mobile-layer` 标记，但旧版本没有 —— 只能按内容认领，
 * 否则覆盖安装后残留的旧页面永远收不掉。
 * 注意用类名精确匹配：`.caldav-editor` 不会命中设置页里的 `.caldav-editor-foot`。
 */
const CONTENT_ROOTS = [".caldav-mobile-host", ".caldav-editor", ".caldav-settings"];

/** 打在弹层外层元素上的标记（`dataset.caldavMobileLayer = "page" | "sheet"`） */
const MARK = "caldavMobileLayer";

/** 走 body 的收口，撞到这些容器就停 —— 免得把整个应用当成弹层收掉 */
const APP_CONTAINERS = "#layouts, #sidebar, #sidebarRight, .layout, .layout-tab-container";

/** 当前实例开出的层：拿到实例才走 destroy()，让回调把面板与监听一起释放 */
const owned = new WeakMap<HTMLElement, MobileLayerDialog>();

/**
 * 由内容根回溯到**最外层的弹层元素**。
 * 真实结构：无类 wrapper > .b3-dialog（带 z-index 与遮罩）> … > 内容根；
 * 测试桩里 wrapper 自己就带 .b3-dialog。两种结构都收敛到 wrapper，
 * 正好与 `dialog.element` 一致，收层时 hide/remove 一次到位。
 * 不在弹层里（例如桌面端页签里的同一套面板）直接返回 null，绝不动它。
 */
function dialogBoxOf(root: Element): HTMLElement | null {
  if (!root.closest(".b3-dialog")) return null;
  let node = root as HTMLElement;
  while (
    node.parentElement &&
    node.parentElement !== document.body &&
    !node.parentElement.matches(APP_CONTAINERS)
  ) {
    node = node.parentElement;
  }
  return node;
}

/** 页面上现存的插件全屏层（去重，按文档序） */
function pluginSurfaces(): HTMLElement[] {
  const out: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(CONTENT_ROOTS.join(",")).forEach((root) => {
    const box = dialogBoxOf(root);
    if (!box || out.includes(box)) return;
    // 已经收过、正在异步销毁的层（自己打的标记 + 被我们藏起来）不再重复处理。
    // 思源的 destroy() 要等一个 timeout 才移除元素，这段时间它**仍在 DOM 里**——
    // 若下一次扫层又把它当「残留层」，就会走 box.remove() 分支绕过 dialog.destroy()，
    // 于是持有它的一方（如 mobilePanel）永远等不到回调，引用就此悬空，
    // 表现就是「点『日历 / 任务』什么也不出来」。
    if (box.dataset[MARK] && box.style.display === "none") return;
    out.push(box);
  });
  return out;
}

/** 同一种语义里最靠上的那一层（弹层按文档序 append，越靠后越在上） */
function topmostOf(boxes: HTMLElement[], kind: MobileLayerKind): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const box of boxes) if (box.dataset[MARK] === kind) found = box;
  return found;
}

/**
 * 收掉一层。思源的 destroy() 要等一个 timeout 才移除元素，不等它会和新层叠影，
 * 所以先手动藏起来（wrapper 里就是遮罩，藏它等于整屏让位）。
 */
function dismiss(box: HTMLElement): void {
  try {
    box.style.display = "none";
  } catch {
    /* 元素已不在，忽略 */
  }
  const dialog = owned.get(box);
  if (dialog) {
    owned.delete(box);
    try {
      dialog.destroy();
    } catch {
      /* 已销毁过，忽略 */
    }
    return;
  }
  // 残留层（上一版代码开出的）：没有实例可控、等不到回调，直接摘掉
  try {
    box.remove();
  } catch {
    /* 忽略 */
  }
}

/**
 * 弹层此刻是否还「活着」、可以复用或聚焦（打开入口前的必查项）。
 *
 * 只判 `destroying` 不够：
 *  - 思源 `Dialog.destroy()` 是**异步**的 —— 先摘 b3-dialog--open 淡出，一个 timeout
 *    之后才移除元素并回调；这段时间元素还在 DOM 里；
 *  - 层管理器收层时还会先 `display:none`；
 *  - 层被别处直接摘出 DOM（残留层走 remove 分支、框架重建节点）时，`destroying` 仍是 false。
 *
 * 一旦抱着「不可用的层」当成可复用，就会永远 return 而不打开任何东西 ——
 * 用户看到的就是「点了入口什么也不出来」。
 */
export function isDialogAlive(dialog: { element?: HTMLElement; destroying?: boolean }): boolean {
  const el = dialog?.element;
  if (!el || !el.isConnected) return false;
  if (el.style.display === "none") return false;
  return !dialog.destroying;
}

/**
 * 登记一层新的全屏层（非移动端不参与，桌面端仍走页签）。
 * 打开前把已有的层按语义收干净 —— 包括不属于当前代码实例的残留层。
 */
export function adoptMobileLayer(dialog: MobileLayerDialog, kind: MobileLayerKind): void {
  if (!isMobile()) return;
  const self = dialog.element;
  if (!self) return;
  owned.set(self, dialog);
  try {
    self.dataset[MARK] = kind;
  } catch {
    /* 非元素节点，忽略 */
  }
  // 下面能留几层，由这一层的语义决定：
  //   page —— 谁也不留（替换式打开，保证「连点几个入口只剩一层」）；
  //   sheet —— 留最上面那个页面（关掉正好回到它）；
  //   sub  —— 再留最上面那个弹窗（次级弹窗关掉要回到上一级弹窗）。
  // 只认打在本插件层上的标记，**旧版本遗留的无标记层一律收掉** —— 它们不在账上、
  // 也等不到回调，留着就是「关了还要再点几次」的来源。
  const others = pluginSurfaces().filter((box) => box !== self && !box.contains(self) && !self.contains(box));
  const keep: HTMLElement[] = [];
  if (kind !== "page") {
    const page = topmostOf(others, "page");
    if (page) keep.push(page);
    if (kind === "sub") {
      const sheet = topmostOf(others, "sheet");
      if (sheet) keep.push(sheet);
    }
  }
  for (const box of others) if (!keep.includes(box)) dismiss(box);
}

/**
 * 清场：把所有插件全屏层收干净（含上一版代码遗留、不在任何账上的）。
 * 插件加载时跑一次，等于开箱先把上次残留的全屏页面扫掉；
 * 卸载时跑一次，避免插件没了页面还在。
 */
export function closeAllMobileLayers(): void {
  for (const box of pluginSurfaces()) dismiss(box);
}
