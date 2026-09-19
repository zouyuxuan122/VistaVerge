/**
 * app/avatarDefaults.ts — 数字人默认形象的裁决规则。
 *
 * 裁决（用户 2026-09-19 指定）：**没有内置 Live2D 模型时默认用视频数字人**，
 * 用户导入模型后再用 Live2D。理由：发行产物不含模型（授权禁分发），
 * 默认 live2d 只会让新用户第一眼看到「模型不可用」的报错。
 *
 * 两条优先级（谁都不能覆盖谁）：
 * 1. 用户在设置里**显式选过**形象 → 永远尊重，不再自动切换；
 * 2. 没选过 → 按构建产物里有没有模型决定默认值。
 */

export type AvatarMode = 'live2d' | 'video' | 'scene3d';

export const AVATAR_MODES: readonly AvatarMode[] = ['live2d', 'video', 'scene3d'];

/** 构建期常量：本次产物是否内嵌 Live2D 模型与 Cubism Core（vite/vitest 配置 define）。 */
export const LIVE2D_MODEL_BUNDLED: boolean = __VV_LIVE2D_BUNDLED__ !== false;

/**
 * 裁决默认形象。纯函数，可单测。
 * @param bundled 构建产物是否内置模型
 * @param saved   用户此前显式保存的选择（localStorage），null = 没选过
 */
export function resolveDefaultAvatarMode(bundled: boolean, saved: string | null): AvatarMode {
  if (saved !== null && (AVATAR_MODES as readonly string[]).includes(saved)) {
    return saved as AvatarMode;
  }
  return bundled ? 'live2d' : 'video';
}

/** 设置面板里给用户看的选项文案：没内置模型时必须说清「需导入模型」。 */
export function avatarOptionLabel(mode: AvatarMode): string {
  switch (mode) {
    case 'live2d':
      return LIVE2D_MODEL_BUNDLED
        ? 'Live2D · 阿芙洛狄忒（可表情/动作控制）'
        : 'Live2D（本安装包未内置模型，需先导入）';
    case 'video':
      return '视频数字人（默认 · 不可表情控制）';
    case 'scene3d':
      return '三维占位形象（实验，VRM 接入路径）';
  }
}
