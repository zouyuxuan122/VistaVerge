// avatarBridge — 应用层到角色渲染器的控制桥。
// 三维场景与 Live2D 挂载时注册；视频形象不注册（表情控制在视频模式不可用，UI 已诚实标注）。
export interface AvatarController {
  setExpression(name: string): void;
  playAction(name: string): void;
  setFacing(mode: 'user' | 'screen' | null): void;
  setGaze(x: number, y: number): void;
  /**
   * 回放电平（0..1）→ 口型包络。这是**近似口型**（按音量驱动开口度），
   * 不是 viseme 音素对齐；实现方必须保持这个语义，不得对外宣称音素同步。
   */
  setMouth?(level: number): void;
}

let controller: AvatarController | null = null;

export function registerAvatarController(next: AvatarController | null): void {
  controller = next;
}

export function avatarExpression(name: string): void {
  controller?.setExpression(name);
}

export function avatarAction(name: string): void {
  controller?.playAction(name);
}

export function avatarFacing(mode: 'user' | 'screen' | null): void {
  controller?.setFacing(mode);
}

export function avatarGaze(x: number, y: number): void {
  controller?.setGaze(x, y);
}

/** 音量 → 开口度；未注册控制器（视频形象）时静默忽略。 */
export function avatarMouth(level: number): void {
  controller?.setMouth?.(level);
}

export function hasAvatarController(): boolean {
  return controller !== null;
}
