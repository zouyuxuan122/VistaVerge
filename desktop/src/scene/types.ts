// Shared contracts for the VistaVerge 3D scene layer (EXP-004).
//
// Design basis: docs/product/UI_UX_AVATAR.md §1.3 (layered avatar rendering),
// §2 (failure/degradation) and §3 (data & interface contract). This layer must
// stay constructible without a GPU: all logic-level behavior is testable in
// Node by injecting a fake renderer / fake clock / fake loader.
import type * as THREE from 'three';

/** Runtime avatar states driven by the conversation / task engine. */
export type AvatarState = 'idle' | 'listening' | 'speaking' | 'working';

export const AVATAR_STATES: readonly AvatarState[] = ['idle', 'listening', 'speaking', 'working'];

export function isAvatarState(value: unknown): value is AvatarState {
  return typeof value === 'string' && (AVATAR_STATES as readonly string[]).includes(value);
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Visual quality tier (UI_UX_AVATAR §6: reversible defaults). */
export type SceneQuality = 'high' | 'low';

/**
 * Minimal renderer surface the stage needs. The real implementation is
 * THREE.WebGLRenderer; tests inject a recording fake so the stage logic can be
 * exercised without instantiating a GPU context.
 */
export interface SceneRendererLike {
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio(value: number): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
  shadowMap: { enabled: boolean; type: number };
  toneMapping: number;
  outputColorSpace: string;
}

/**
 * Layered avatar adapter (blink / gaze / mouth / typing / pose).
 * Placeholders and the future VRM adapter both implement this, so the stage
 * can swap them without knowing which one is live.
 */
export interface AvatarRenderer {
  /**
   * True while the rendered character is the procedural placeholder and NOT a
   * licensed VRM asset. The UI must surface this (UI_UX_AVATAR §2: no video or
   * placeholder may masquerade as a ready model).
   */
  readonly isPlaceholder: boolean;
  readonly state: AvatarState;
  getRoot(): THREE.Object3D;
  setState(state: AvatarState): void;
  /** Normalized mouth opening target; adapters clamp to [0, 1]. */
  setMouthOpen(value: number): void;
  /** Gaze target in normalized screen-ish coordinates, each axis in [-1, 1]. */
  setGaze(x: number, y: number): void;
  /** Advance the driver by dt seconds (absolute blink timing comes from the injected clock). */
  update(dtSeconds: number): void;
  dispose(): void;
}

export interface PlaceholderAvatarOptions {
  /** Millisecond clock used for absolute blink scheduling (fake clocks in tests). */
  clock?: () => number;
  /** RNG for blink intervals (seeded RNG in tests). Defaults to Math.random. */
  random?: () => number;
}

export interface AvatarSceneOptions {
  /**
   * Renderer factory. Defaults to creating a real THREE.WebGLRenderer on the
   * canvas; tests inject a fake to avoid instantiating a GPU context.
   */
  createRenderer?: (canvas: HTMLCanvasElement) => SceneRendererLike;
  /** Millisecond clock (defaults to performance.now) used for frame deltas and blink timing. */
  clock?: () => number;
  /** RNG forwarded to the default placeholder avatar. */
  random?: () => number;
}
