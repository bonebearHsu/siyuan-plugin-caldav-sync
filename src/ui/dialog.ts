/**
 * 全插件唯一的弹窗（Dialog）创建入口。
 *
 * 存在的唯一理由：**类型包落后于运行时**。
 * 思源的 Dialog 自 **v3.2.0** 起支持 `containerClassName`（把类名拼进
 * `.b3-dialog__container` 的 class），但 npm 上的 `siyuan` 类型包（1.2.7 / 1.2.8）至今
 * 没同步这个字段 —— 直接传会报 TS2353。而 `vite build` 走 esbuild 只做转译、不做类型
 * 检查，所以这个错误不会在构建里暴露，只会被 `npx tsc --noEmit` 照出来。
 *
 * 这里只做一层类型收口：参数**原样交给思源**，挂类由思源自己完成，插件不额外动手
 * （plugin.json 的 minAppVersion 已提到 3.2.0，该参数必定会被识别）。
 * 等类型包补上这个字段，本文件即可删除，各处直接用 `new Dialog`。
 */
import { Dialog } from "siyuan";

/** 思源 Dialog 的官方构造选项（从类型签名派生，日后升级类型包会自动跟随） */
export type SiyuanDialogOptions = ConstructorParameters<typeof Dialog>[0];

export type CalDialogOptions = SiyuanDialogOptions & {
  /** 追加到 `.b3-dialog__container` 上的类名（思源 v3.2.0+ 原生支持，见文件头注释） */
  containerClassName?: string;
};

/** 创建弹窗；`containerClassName` 由思源自己挂到 `.b3-dialog__container` 上 */
export function newDialog(options: CalDialogOptions): Dialog {
  return new Dialog(options as SiyuanDialogOptions);
}
