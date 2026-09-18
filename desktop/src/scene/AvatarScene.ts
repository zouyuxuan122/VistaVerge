// AvatarScene: the right-pane 3D stage — renderer, lighting, computer set and
// the layered avatar adapter slot (EXP-004, UI_UX_AVATAR §1.1/§1.3).
//
// Rendering setup: ACES filmic tone mapping, sRGB output, PCFSoft shadow maps,
// key/fill/rim lighting plus RoomEnvironment IBL (PMREM, real renderer only).
//
// Logic-mode construction: pass `createRenderer` to inject a fake renderer so
// the whole stage (state machine, mouth clamp, audio-clock envelope, quality
// tiers, resize, idempotent dispose, VRM license gate) is testable without a
// GPU. Rendering correctness itself is accepted by EXP-007 GUI screenshots.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { buildComputerScene, type ComputerScene } from './computer';
import { DisposableGroup, disposeObject3DDeep } from './dispose';
import { createLightingRig, type LightingRig } from './lights';
import { PlaceholderAvatar } from './avatar';
import { loadVrm, type LoadVrmOptions } from './vrmAvatar';
import {
  clamp01,
  isAvatarState,
  type AvatarRenderer,
  type AvatarSceneOptions,
  type AvatarState,
  type SceneQuality,
  type SceneRendererLike,
} from './types';

export type { SceneQuality } from './types';

/**
 * RMS → mouth gain for the audio-clock envelope. This is an APPROXIMATION
 * (loudness envelope), explicitly NOT viseme lip-sync — when phoneme timings
 * become available the viseme layer replaces it (UI_UX_AVATAR §2 degradation
 * row requires the approximation to be labeled).
 */
export const RMS_MOUTH_GAIN = 4;
export const AUDIO_MOUTH_IS_NOT_VISEME = true as const;

const MAX_PIXEL_RATIO = 2;

function maxPixelRatio(): number {
  return typeof devicePixelRatio !== 'undefined'
    ? Math.min(devicePixelRatio, MAX_PIXEL_RATIO)
    : 1;
}

function createDefaultRenderer(canvas: HTMLCanvasElement): SceneRendererLike {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(maxPixelRatio());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

export class AvatarScene extends EventTarget {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: SceneRendererLike;
  readonly computer: ComputerScene;
  readonly lighting: LightingRig;

  private readonly canvas: HTMLCanvasElement;
  private readonly clock: () => number;
  private readonly disposables = new DisposableGroup();
  private readonly onWindowResize = () => this.resize();

  /** The live avatar slot; replaced only through loadVrmAvatar's license gate. */
  avatar: AvatarRenderer;
  private currentState: AvatarState = 'idle';
  private currentQuality: SceneQuality = 'high';
  private audioClock: (() => number) | null = null;
  private manualMouth = 0;
  private lastTime: number;
  private rafId: number | null = null;
  private disposedFlag = false;

  constructor(canvas: HTMLCanvasElement, options: AvatarSceneOptions = {}) {
    super();
    this.canvas = canvas;
    this.clock = options.clock ?? (() => performance.now());
    this.renderer = options.createRenderer?.(canvas) ?? createDefaultRenderer(canvas);
    // The stage owns the rendering contract regardless of who created the
    // renderer (injected fakes included): ACES tone mapping, sRGB output,
    // PCFSoft shadow maps.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(maxPixelRatio());
    this.lastTime = this.clock();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141a);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
    // 正面偏侧取景：人物默认面向用户，电脑在她左侧入镜
    this.camera.position.set(0.5, 1.22, 1.62);
    this.camera.lookAt(0.05, 0.96, 0.18);

    this.disposables.add({ dispose: () => this.renderer.dispose() });

    this.lighting = createLightingRig();
    this.scene.add(this.lighting.group);
    this.disposables.add({ dispose: () => this.lighting.dispose() });

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.9 }),
    );
    floor.name = 'floor';
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.disposables.add({ dispose: () => disposeObject3DDeep(floor) });

    this.computer = buildComputerScene();
    this.scene.add(this.computer.group);
    this.disposables.add({ dispose: () => this.computer.dispose() });

    this.avatar = new PlaceholderAvatar({ clock: this.clock, random: options.random });
    this.scene.add(this.avatar.getRoot());
    this.disposables.add({ dispose: () => this.avatar.dispose() });

    this.setupEnvironment();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
      this.disposables.add(() => window.removeEventListener('resize', this.onWindowResize));
    }
  }

  /** True while the live character is the procedural placeholder. */
  get avatarIsPlaceholder(): boolean {
    return this.avatar.isPlaceholder;
  }

  get quality(): SceneQuality {
    return this.currentQuality;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  // ── Driving API ────────────────────────────────────────────────────────────

  setState(state: AvatarState): void {
    if (!isAvatarState(state)) {
      console.warn(`[AvatarScene] ignored unknown avatar state: ${String(state)}`);
      return;
    }
    this.currentState = state;
    this.avatar.setState(state);
    // §3(4): leaving the speaking layer closes the mouth immediately.
    if (state !== 'speaking') this.avatar.setMouthOpen(0);
  }

  /** Manual mouth target; clamped here so adapters never see out-of-range values. */
  setMouthOpen(value: number): void {
    this.manualMouth = clamp01(value);
    if (this.currentState === 'speaking' && !this.audioClock) {
      this.avatar.setMouthOpen(this.manualMouth);
    }
  }

  setGaze(x: number, y: number): void {
    this.avatar.setGaze(x, y);
  }

  /** 模型可控表情：仅当前渲染器实现该能力时生效（VRM 适配器同接口）。 */
  applyExpression(name: string): void {
    const capable = this.avatar as unknown as { setExpression?: (n: string) => void };
    capable.setExpression?.(name);
  }

  /** 模型可控一次性动作（nod/shake/tilt/wave）。 */
  playAction(name: string): void {
    const capable = this.avatar as unknown as { playAction?: (n: string) => void };
    capable.playAction?.(name);
  }

  /** 朝向覆盖：'user' 面向用户 / 'screen' 面向屏幕 / null 状态机默认。 */
  setFacing(mode: 'user' | 'screen' | null): void {
    const capable = this.avatar as unknown as { setFacing?: (m: 'user' | 'screen' | null) => void };
    capable.setFacing?.(mode);
  }

  /**
   * Attach/detach an audio clock. `source` returns the current input RMS in
   * [0, 1] (e.g. from an AnalyserNode over the TTS playback). While speaking,
   * RMS drives the mouth as an approximate loudness envelope — labeled
   * approximation, NOT viseme (AUDIO_MOUTH_IS_NOT_VISEME). Detaching closes
   * the mouth immediately (§3(4)).
   */
  setAudioClock(source: (() => number) | null): void {
    this.audioClock = source;
    if (!source && this.currentState === 'speaking') {
      this.avatar.setMouthOpen(0);
    }
  }

  setQuality(quality: SceneQuality): void {
    this.currentQuality = quality;
    const shadowsOn = quality === 'high';
    this.renderer.shadowMap.enabled = shadowsOn;
    this.renderer.setPixelRatio(shadowsOn ? maxPixelRatio() : 1);
    this.lighting.applyQuality(quality);
  }

  /**
   * Try to replace the placeholder with a real VRM. On any rejection
   * (undeclared license, missing asset) the placeholder stays live and a
   * `vrm-rejected` event carries the reason. Returns whether the swap happened.
   */
  async loadVrmAvatar(
    url: string,
    licenseMeta: unknown,
    options: LoadVrmOptions = {},
  ): Promise<boolean> {
    const outcome = await loadVrm(url, licenseMeta, options);
    if (!outcome.ok) {
      this.dispatchEvent(
        new CustomEvent('vrm-rejected', { detail: { reason: outcome.reason, url } }),
      );
      return false;
    }
    // 加载期间可能已卸载：此时不能往已清空的场景里 add，也不能派发事件。
    if (this.disposedFlag) {
      outcome.avatar.dispose();
      return false;
    }
    const previous = this.avatar;
    this.scene.remove(previous.getRoot());
    // 被替换掉的 avatar 必须释放（旧的非占位 VRM 之前只 remove 不 dispose，
    // 几何/材质/贴图全部泄漏）；占位实现同样走这条路径。
    previous.dispose();
    this.avatar = outcome.avatar;
    this.scene.add(this.avatar.getRoot());
    this.dispatchEvent(
      new CustomEvent('avatar-replaced', {
        detail: { isPlaceholder: false, source: outcome.avatar.source },
      }),
    );
    return true;
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────

  /** Advance the stage by dt seconds (audio-clock mouth injection happens here). */
  update(dtSeconds: number): void {
    if (this.disposedFlag) return;
    if (this.audioClock && this.currentState === 'speaking') {
      this.avatar.setMouthOpen(clamp01(this.audioClock() * RMS_MOUTH_GAIN));
    }
    this.avatar.update(dtSeconds);
  }

  /** Render exactly one frame from the current clock (used by logic tests too). */
  renderFrame(): void {
    if (this.disposedFlag) return;
    const now = this.clock();
    const dt = THREE.MathUtils.clamp((now - this.lastTime) / 1000, 0, 0.1);
    this.lastTime = now;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Start the requestAnimationFrame loop (no-op without a RAF implementation). */
  start(): void {
    if (this.disposedFlag || this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      console.warn('[AvatarScene] requestAnimationFrame unavailable; loop not started');
      return;
    }
    this.lastTime = this.clock();
    const tick = () => {
      if (this.disposedFlag) return;
      const now = this.clock();
      const dt = THREE.MathUtils.clamp((now - this.lastTime) / 1000, 0, 0.1);
      this.lastTime = now;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  /** Resize the drawing buffer; degenerate heights leave the camera aspect untouched. */
  resize(width?: number, height?: number): void {
    if (this.disposedFlag) return;
    const fallbackWidth = this.canvas?.clientWidth || this.canvas?.width || 1;
    const fallbackHeight = this.canvas?.clientHeight || this.canvas?.height || 1;
    const w = width ?? fallbackWidth;
    const h = height ?? fallbackHeight;
    this.renderer.setSize(w, h);
    if (h > 0) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Idempotent: second call is a no-op; frame loop and renderer stop first. */
  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    this.stop();
    this.disposables.dispose();
    this.scene.clear();
  }

  // ── Environment IBL ────────────────────────────────────────────────────────

  private setupEnvironment(): void {
    const maybeWebGL = this.renderer as { isWebGLRenderer?: boolean };
    if (!maybeWebGL.isWebGLRenderer) return; // injected logic-mode renderer: skip PMREM
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer as unknown as THREE.WebGLRenderer);
      const target = pmrem.fromScene(new RoomEnvironment(), 0.04);
      this.scene.environment = target.texture;
      this.disposables.add(() => {
        target.texture.dispose();
        target.dispose();
        pmrem.dispose();
      });
    } catch (error) {
      // IBL is an enhancement; losing it must not break the stage (§2).
      console.warn('[AvatarScene] RoomEnvironment unavailable, continuing without IBL:', error);
    }
  }
}
