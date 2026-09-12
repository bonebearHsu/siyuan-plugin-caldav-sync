/**
 * 模拟思源 loader：加载 dist/index.js 并实例化插件，验证可正常初始化与渲染
 * 结构：无顶栏按钮；Dock = 标题 + 一行 5 按钮（新增/排序/日历视图/任务视图/刷新）；
 *       主日历页签 = 顶部 年/月/周/日 分段切换 + 视图容器。
 */
import assert from "node:assert";
import { setupBrowserDom, loadBuiltPlugin, seedStore } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
assert.ok(PluginClass, "应导出默认插件类");

const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();

const reg = globalThis.__syRegistrations;
assert.strictEqual(reg.topbar.length, 0, "不应注册顶栏按钮");
assert.strictEqual(reg.dock.length, 1, "应注册 Dock");
assert.strictEqual(reg.tab.length, 1, "应注册页签类型");
assert.ok(reg.icons[0].includes("iconCalDavSync"), "应注册图标");
assert.strictEqual(reg.commands.length, 4, "应注册 4 个命令");

const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

// ---- Dock：标题 + 一行 5 按钮 ----
seedStore(plugin);
const dockEl = document.createElement("div");
document.body.appendChild(dockEl);
const dockCustom = { element: dockEl, data: { key: "dock" } };
reg.dock[0].init.call(dockCustom, dockCustom);

assert.ok(dockEl.classList.contains("caldav-dock"), "Dock 应渲染精简面板");
assert.match(dockEl.querySelector(".caldav-brand-title")?.textContent || "", /日历任务管理/, "Dock 标题应为「日历任务管理」");
assert.strictEqual(dockEl.querySelectorAll(".caldav-dock-act").length, 5, "应有 5 个按钮");
assert.ok(
  Array.from(dockEl.querySelectorAll(".caldav-dock-act")).every((b) => !b.querySelector("span") && !(b.textContent || "").trim()),
  "Dock 按钮应为纯图标（不含文字标签）"
);
assert.strictEqual(dockEl.querySelectorAll(".caldav-dock-menu[data-menu]").length, 2, "新增/排序 应为带下拉的菜单");
assert.strictEqual(dockEl.querySelectorAll(".caldav-dock-popitem").length, 9, "新增 2 个 + 排序 7 个共 9 个选项");
assert.ok(!dockEl.querySelector(".caldav-dock-btn"), "不应再使用旧 nav 按钮");
assert.ok(!dockEl.querySelector(".caldav-app"), "Dock 不应渲染完整日历面板");
assert.ok(!dockEl.querySelector(".cal-month-grid"), "Dock 不应渲染月视图网格");
assert.ok(!dockEl.querySelector(".caldav-cal-item"), "Dock 不应包含日历列表");

// 回归保护：Dock 初始化后应延迟打开默认「日历」页签（编辑前因 init 阶段布局未就绪导致 openTab 被忽略）
await new Promise((r) => setTimeout(r, 450));
assert.ok(reg.lastOpenTab, "Dock 初始化后应默认在主窗口打开日历页签");
assert.strictEqual(reg.lastOpenTab.custom.title, "日历", "默认打开的页签标题应为「日历」");
assert.strictEqual(reg.lastOpenTab.custom.id, "siyuan-plugin-caldav-synccaldav-sync-tab", "默认页签 id 应为插件页签类型");

// Dock 下方最近任务/事件列表区
assert.ok(dockEl.querySelector(".caldav-dock-list"), "Dock 应显示最近任务/事件列表区");
assert.ok(dockEl.querySelector("[data-dock='filter']"), "Dock 应有筛选下拉");
assert.ok(dockEl.querySelector("[data-dock='search']"), "Dock 应有搜索框");
assert.ok(dockEl.querySelector(".caldav-dock-items"), "Dock 应有任务列表容器");
assert.ok(dockEl.querySelectorAll(".caldav-dock-item").length >= 1, "默认「未来七天」筛选下 Dock 应渲染任务卡片");
assert.ok(dockEl.querySelector(".caldav-dock-tag"), "任务卡片应包含标签");

// Dock 分类筛选弹窗
const catBtn = dockEl.querySelector("[data-dock='category']");
assert.ok(catBtn, "Dock 应有分类筛选按钮");
click(catBtn);
const catPop = dockEl.querySelector("[data-pop='category']");
assert.ok(catPop && !catPop.hidden, "点击分类筛选应展开分类弹窗");
assert.ok(catPop.querySelector("[data-cat-key='__all__']"), "分类弹窗应含「所有分类」");
assert.ok(catPop.querySelector("[data-cat-key='__none__']"), "分类弹窗应含「无分类」");
assert.ok(catPop.querySelector("[data-cat-key='工作']"), "分类弹窗应含「工作」分类");
// 选择「工作」并确定
click(catPop.querySelector("[data-cat-key='工作'] input"));
click(catPop.querySelector("[data-cat-action='ok']"));
assert.ok(catPop.hidden, "确定后分类弹窗应收起");

// ---- Dock「日历视图」按钮 → 在主窗口打开页签 ----
click(dockEl.querySelector('[data-action="cal-view"]'));
assert.ok(reg.lastOpenTab, "点击「日历视图」应调用 openTab 打开主窗口页签");
assert.ok(String(reg.lastOpenTab.custom.id).includes("caldav-sync-tab"), "页签 id 应为插件页签类型");
// 回归保护：openTab 的 custom.data 必须可序列化且不得放入插件实例
// （否则思源在构建/保存布局时 JSON.stringify 抛循环引用错误，导致页签打不开）
assert.doesNotThrow(() => JSON.stringify(reg.lastOpenTab.custom.data), "custom.data 必须可 JSON 序列化");
assert.strictEqual(reg.lastOpenTab.custom.data?.plugin, undefined, "custom.data 不得包含插件实例（plugin），须改用闭包访问");

// 模拟主窗口页签初始化
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: reg.lastOpenTab.custom.data };
reg.tab[0].init.call(tabCustom, tabCustom);

assert.ok(tabEl.querySelector(".caldav-app"), "页签应渲染完整日历面板");
assert.ok(tabEl.querySelector(".cal-month-grid"), "默认月视图应渲染");
assert.strictEqual(tabEl.querySelectorAll(".caldav-seg-btn").length, 4, "应有 年/月/周/日 四个分段按钮");
assert.strictEqual(tabEl.querySelectorAll(".caldav-cal-item").length, 2, "页签日历筛选应包含 2 个日历");
// 今日单元格应唯一标记（样式靠 .is-today 加深底色与描边）
assert.strictEqual(tabEl.querySelectorAll(".cal-month-cell.is-today").length, 1, "月视图应恰好一个今日单元格");
assert.ok(tabEl.querySelector(".cal-month-cell.is-today .cal-today-badge"), "今日单元格应有日期徽标");

// ---- 年视图 ----
click(tabEl.querySelector('[data-view="year"]'));
assert.ok(tabEl.querySelector(".cal-year"), "年视图应渲染");
assert.strictEqual(tabEl.querySelectorAll(".cal-year-month").length, 12, "年视图应有 12 个月");
// 点击某月标题 → 跳转到月视图
click(tabEl.querySelector(".cal-year-month-head"));
assert.ok(tabEl.querySelector(".cal-month-grid"), "点击月份标题应跳转到月视图");

// ---- 任务视图（通过 Dock「任务视图」按钮进入）+ 下拉筛选 ----
click(dockEl.querySelector('[data-action="task-view"]'));
assert.ok(tabEl.querySelector(".cal-task-view"), "任务视图应渲染");
assert.ok(tabEl.querySelector(".cal-task"), "应有任务条目");
assert.ok(tabEl.querySelector(".caldav-app").classList.contains("is-task"), "任务视图应隐藏分段控件");

const filterSel = tabEl.querySelector(".cal-task-filter");
assert.ok(filterSel, "任务视图应有筛选下拉框");
assert.strictEqual(filterSel.value, "allincomplete", "任务视图默认应为「所有未完成」筛选");
const nodateOpt = Array.from(filterSel.options).find((o) => o.value === "nodate");
assert.ok(nodateOpt, "筛选下拉框应含「无日期」选项");
filterSel.value = "nodate";
filterSel.dispatchEvent(new Event("change", { bubbles: true }));
const nodateTasks = tabEl.querySelectorAll(".cal-task");
assert.ok(nodateTasks.length >= 1, "「无日期」筛选应有任务");
assert.ok([...nodateTasks].some((t) => t.textContent.includes("无截止任务")), "应含无截止任务");
assert.ok(![...nodateTasks].some((t) => t.textContent.includes("测试条目 2")), "不应含带日期的任务");
filterSel.value = "today";
filterSel.dispatchEvent(new Event("change", { bubbles: true }));
assert.ok(tabEl.querySelectorAll(".cal-task").length >= 1, "「今日」筛选应有任务");

// ---- 周/日视图 ----
click(tabEl.querySelector('[data-action="today"]'));
click(tabEl.querySelector('[data-view="week"]'));
assert.ok(tabEl.querySelector(".cal-wk"), "周视图应渲染");
assert.strictEqual(tabEl.querySelectorAll(".cal-wk-col").length, 7, "周视图应 7 列");
assert.ok(tabEl.querySelector(".cal-wk-nowline"), "应有当前时间线");

click(tabEl.querySelector('[data-view="day"]'));
assert.strictEqual(tabEl.querySelectorAll(".cal-wk-col").length, 1, "日视图应 1 列");
const dayWk = tabEl.querySelector(".cal-wk");
assert.ok(/--cols:\s*1\b/.test(dayWk?.getAttribute("style") || ""), "日视图应把网格列数 --cols 设为 1（避免单列被压成 1/7 宽）");

// ---- 月视图，点击条目 chip 打开编辑弹窗 ----
click(tabEl.querySelector('[data-view="month"]'));
const chip = tabEl.querySelector("[data-open]");
assert.ok(chip, "月视图应有条目 chip");
click(chip);
assert.ok(document.querySelector(".caldav-editor"), "编辑弹窗应打开");
assert.ok(document.querySelector('[data-f="summary"]').value.includes("测试条目"), "弹窗应载入标题");
assert.ok(document.querySelector(".caldav-section--card"), "编辑弹窗应使用卡片分组");
assert.ok(document.querySelector('[data-f="startDate"]'), "应拆分为开始日期输入");
assert.ok(document.querySelector('[data-f="startTime"]'), "应拆分为开始时间输入");
const calInput = document.querySelector('input[data-f="calendar"]');
assert.ok(calInput && calInput.type === "hidden", "编辑弹窗应用隐藏 input 保存日历值（自定义下拉）");
const calTrigger = document.querySelector(".caldav-cal-trigger");
assert.ok(calTrigger, "编辑弹窗应有日历自定义下拉触发按钮");
assert.ok(calTrigger.closest(".caldav-input-wrap").querySelector(".caldav-cal-icon"), "日历下拉左侧图标应为日历颜色图标");
const calPop = document.querySelector(".caldav-cal-pop");
assert.ok(calPop && calPop.hidden, "日历下拉弹层应存在且默认收起");
assert.ok(calPop.querySelectorAll(".caldav-cal-option").length >= 1, "日历下拉弹层应渲染日历选项");
// 点击触发按钮展开弹层，点选另一项后隐藏 input 值应更新
calTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.ok(!calPop.hidden, "点击触发按钮应展开日历弹层");
const opt2 = calPop.querySelectorAll(".caldav-cal-option")[1];
if (opt2) {
  const prev = calInput.value;
  opt2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.notStrictEqual(calInput.value, prev, "点选选项应更新日历值");
  assert.ok(calPop.hidden, "点选后弹层应收起");
}
// 任务分类药丸：默认分类渲染、点选写入隐藏 input、无分类清空
const catHidden = document.querySelector('input[data-f="categories"]');
assert.ok(catHidden && catHidden.type === "hidden", "分类值应存于隐藏 input");
const pills = Array.from(document.querySelectorAll(".caldav-cat-pill"));
assert.ok(pills.length >= 4, "分类药丸应含 无分类 + 默认分类");
assert.ok(pills[0].classList.contains("caldav-cat-pill--none"), "第一个药丸应为 无分类");
assert.ok(pills[0].classList.contains("is-active"), "默认应选中 无分类");
const workPill = pills.find((p) => p.dataset.cat === "工作");
assert.ok(workPill, "默认分类应包含 工作");
workPill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.strictEqual(catHidden.value, "工作", "点选分类药丸应写入分类名");
assert.ok(workPill.classList.contains("is-active"), "点选后药丸应高亮");
assert.ok(!pills[0].classList.contains("is-active"), "选择分类后 无分类 应取消高亮");
pills[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.strictEqual(catHidden.value, "", "点 无分类 应清空分类");
// 管理分类按钮应打开分类管理弹窗
document.querySelector('[data-action="cat-manage"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
const mgr = document.querySelector(".caldav-catmgr");
assert.ok(mgr, "点 管理分类 应打开分类管理弹窗");
assert.ok(mgr.querySelector('[data-mgr="add"]'), "分类管理应有 添加新分类 按钮");
assert.ok(mgr.querySelector('[data-mgr="reset"]'), "分类管理应有 重置为默认 按钮");
assert.ok(mgr.querySelectorAll(".caldav-catmgr-row").length >= 3, "分类管理应列出默认分类");
// 添加新分类 → 出现编辑行；保存写回 store
mgr.querySelector('[data-mgr="add"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
const nameInput = mgr.querySelector('[data-edit="name"]');
assert.ok(nameInput, "添加新分类后应出现名称编辑框");
nameInput.value = "测试分类";
mgr.querySelector('.caldav-catmgr-row.is-editing [data-mgr="edit"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
mgr.querySelector('[data-action="save"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.ok(!document.querySelector(".caldav-catmgr"), "保存后分类管理弹窗应关闭");
assert.ok(document.querySelector(".caldav-editor"), "编辑弹窗应仍在");
assert.ok(document.querySelector(".caldav-foot-btn--primary"), "保存按钮应使用新样式");
assert.ok(document.querySelector(".caldav-foot-btn--ghost"), "取消按钮应使用新样式");
click(document.querySelector('[data-action="cancel"]'));
assert.ok(!document.querySelector(".caldav-editor"), "弹窗应关闭");

// ---- Dock 排序下拉：7 种排序选项 + active 标记 ----
// 先重置分类筛选为「所有分类」，避免此前步骤留下的筛选导致列表为空、断言失真
click(dockEl.querySelector("[data-dock='category']"));
click(dockEl.querySelector("[data-cat-key='__all__'] input"));
click(dockEl.querySelector("[data-cat-action='ok']"));
for (const m of ["priority", "start", "end", "completed", "created", "category", "title"]) {
  assert.ok(dockEl.querySelector(`[data-action="sort-${m}"]`), `排序下拉应含 sort-${m} 选项`);
}
click(dockEl.querySelector('[data-action="sort-end"]'));
assert.ok(dockEl.querySelector('[data-action="sort-end"]').classList.contains("is-active"), "结束时间排序应高亮");
click(dockEl.querySelector('[data-action="sort-start"]'));
assert.ok(dockEl.querySelector('[data-action="sort-start"]').classList.contains("is-active"), "开始时间排序应高亮");

// 按标题排序：列表条目应按 summary 升序排列
click(dockEl.querySelector('[data-action="sort-title"]'));
assert.ok(dockEl.querySelector('[data-action="sort-title"]').classList.contains("is-active"), "标题排序应高亮");
{
  const titles = Array.from(dockEl.querySelectorAll(".caldav-dock-item-title")).map((e) => e.textContent);
  // 与实现一致：小写后按码元比较
  const sorted = [...titles].sort((a, b) => {
    const la = a.toLowerCase(), lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  assert.deepStrictEqual(titles, sorted, "按标题排序后条目应按标题升序排列");
}

// 按优先级排序：Dock 列表应正常渲染（无优先级条目视为最低，并列回退开始时间）
click(dockEl.querySelector('[data-action="sort-priority"]'));
assert.ok(dockEl.querySelector('[data-action="sort-priority"]').classList.contains("is-active"), "优先级排序应高亮");
assert.ok(dockEl.querySelectorAll(".caldav-dock-item").length >= 1, "优先级排序下列表应正常渲染");
click(dockEl.querySelector('[data-action="sort-start"]'));

// ---- Dock 新增下拉：新增事件弹出编辑框 ----
click(dockEl.querySelector('[data-toggle="add"]'));
assert.ok(!dockEl.querySelector('[data-pop="add"]').hidden, "点击「新增」应展开下拉");
click(dockEl.querySelector('[data-action="add-event"]'));
assert.ok(document.querySelector(".caldav-editor"), "新增事件应打开编辑弹窗");
click(document.querySelector('[data-action="cancel"]'));
assert.ok(!document.querySelector(".caldav-editor"), "弹窗应关闭");

// ---- 页签已打开时，Dock「日历视图」应直接切回日历（不重复渲染） ----
click(dockEl.querySelector('[data-action="cal-view"]'));
assert.ok(tabEl.querySelector(".cal-month-grid"), "Dock 点击「日历视图」应切回月视图");

// ---- 页签内设置：日历筛选浮层 → 设置弹窗 ----
click(tabEl.querySelector('[data-action="calfilter"]'));
assert.ok(!tabEl.querySelector('[data-pop="calfilter"]').hidden, "日历筛选浮层应展开");
click(tabEl.querySelector('[data-action="settings"]'));
const settingsEl = document.querySelector(".caldav-settings");
assert.ok(settingsEl, "设置弹窗应打开");
assert.ok(settingsEl.querySelector(".caldav-section--card"), "设置弹窗应使用卡片分组");
assert.ok(settingsEl.querySelector('[data-action="save"].caldav-foot-btn--primary'), "设置弹窗保存按钮应为新主按钮风格");
assert.ok(settingsEl.querySelector('[data-action="cancel"].caldav-foot-btn--ghost'), "设置弹窗取消按钮应为新幽灵按钮风格");
// 空 URL 时测试连接应直接提示错误，不应显示成功
const serverInput = settingsEl.querySelector("input[data-s='server']");
if (serverInput) serverInput.value = "";
click(settingsEl.querySelector("[data-action='test']"));
const testMsg = settingsEl.querySelector("[data-msg]");
assert.ok(testMsg && testMsg.textContent.includes("服务器地址不能为空"), "空 URL 测试连接应提示服务器地址不能为空");
document.querySelector(".b3-dialog .b3-dialog--close")?.remove();
settingsEl?.closest(".b3-dialog")?.remove();

// ---- 卸载 ----
plugin.onunload();

console.log("[loader] 模拟思源加载链路全部通过（Dock 一行5按钮/下拉 + 年视图 + 分段切换 + 排序 + 编辑弹窗）");
