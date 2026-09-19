/**
 * 运行环境判定 —— 供 UI 层决定用桌面形态还是触摸形态渲染。
 *
 * 为什么单独抽一个模块：思源移动端的 DOM 结构与桌面端差异很大
 * （没有页签栏、Dialog 全屏、触摸取代鼠标），插件需要按前端类型分支。
 * `getFrontend()` 返回 "desktop" | "desktop-window" | "mobile" |
 * "browser-desktop" | "browser-mobile"，用 endsWith("mobile") 可同时命中
 * 手机 App（mobile）与手机浏览器伺服（browser-mobile）。
 *
 * 非思源环境（单元测试的 jsdom）下 getFrontend 不可用，兜底按桌面处理，
 * 保证测试仍走桌面路径。
 */
import { getFrontend } from "siyuan";

/** 是否运行在移动端前端（手机 App 或手机浏览器） */
export function isMobile(): boolean {
  try {
    return getFrontend().endsWith("mobile");
  } catch {
    return false;
  }
}
