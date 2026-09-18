// Procedural placeholder avatar (EXP-004 step 3).
//
// This character is explicitly a PLACEHOLDER (isPlaceholder = true): a
// stylized blocky figure with head / eyes / lids / jaw / torso / arm joints,
// seated facing the monitor (the rig faces -Z; the stage places the root
// between desk and camera). It implements the same AvatarRenderer layers as
// the future VRM adapter: blink, gaze, mouth, typing arms. It is NOT the
// final character — licensed VRM assets are BLOCKED (see EXP-004 report).
//
// All units meters. Layout contract with computer.ts:
//   desk top y = 0.72, keyboard around z = +0.10, avatar root at (0, 0, 0.46).
import * as THREE from 'three';

import { disposeObject3DDeep } from './dispose';
import {
  clamp01,
  type AvatarRenderer,
  type AvatarState,
  type PlaceholderAvatarOptions,
} from './types';

// ── Tuned pose / animation constants ─────────────────────────────────────────

/** Layout contract shared with computer.ts / AvatarScene camera framing. */
export const SEATED_POSE = {
  rootZ: 0.46,
  headY: 1.1,
  seatY: 0.52,
  deskTopY: 0.72,
} as const;

/** Blink window (ms) — first blink lands inside [min, max]. */
export const BLINK_INTERVAL_MS: readonly [number, number] = [2200, 6000];
export const BLINK_DURATION_MS = 300;
const LID_THIN = 0.15; // lid scale.y when fully open (thin sliver above the eye)
const GAZE_LERP_RATE = 9; // 1/s exponential approach
const GAZE_MAX_YAW = 0.45;
const GAZE_MAX_PITCH = 0.25;
const HEAD_BASE_PITCH = -0.08; // slight downward look toward the screen
const JAW_REST = 0.02;
const JAW_OPEN = 0.42;
const TYPING_STROKE_HZ = 4.2;
const TYPING_AMPLITUDE = 0.14;
const BREATH_AMPLITUDE = 0.004;
const NOD_AMPLITUDE = 0.04;

const ARM_REST = 1.45; // shoulder rotation.x (world ≈ 1.40 after torso lean)
const FOREARM_REST = -0.9; // elbow rotation.x so hands rest on the keyboard
const FACE_SCREEN_YAW = 0; // rig faces -Z toward the monitor
const FACE_USER_YAW = Math.PI; // turned around: face points +Z toward the user
const FACING_LERP = 5; // 1/s
const BLUSH = 0xe8909a;

const SKIN = 0xd8a47f;
const SKIN_DARK = 0xc08b63;
const SHIRT = 0x3a4a5f;
const PANTS = 0x2a2d33;
const HAIR = 0x2a2320;
const EYE_WHITE = 0xf4f4f4;
const IRIS = 0x27343f;

export type AvatarExpression = 'neutral' | 'happy' | 'sad' | 'thinking' | 'surprised' | 'shy';
export type AvatarAction = 'nod' | 'shake' | 'tilt' | 'wave';
export type AvatarFacing = 'user' | 'screen';

// ── Rig ──────────────────────────────────────────────────────────────────────

export class PlaceholderAvatar implements AvatarRenderer {
  readonly isPlaceholder = true;

  private readonly root: THREE.Group;
  private readonly head: THREE.Group;
  private readonly eyes: THREE.Group;
  private readonly lids: THREE.Mesh[];
  private readonly brows: THREE.Mesh[];
  private readonly blushMeshes: THREE.Mesh[];
  private readonly mouthMesh: THREE.Mesh;
  private readonly jaw: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly arms: [THREE.Group, THREE.Group];
  private readonly forearms: [THREE.Group, THREE.Group];

  private currentState: AvatarState = 'idle';
  private mouthTarget = 0;
  private readonly gazeTarget = new THREE.Vector2(0, 0);
  private readonly gazeCurrent = new THREE.Vector2(0, 0);
  private typingPhase = 0;

  // 面向：默认面向用户（FACE_USER_YAW），working 状态转向屏幕
  private facingTarget = FACE_USER_YAW;
  private facingCurrent = FACE_USER_YAW;
  private facingOverride: AvatarFacing | null = null;

  // 表情与动作（模型可控层）
  private expression: AvatarExpression = 'neutral';
  private expressionStartedAt = 0;
  private action: { name: AvatarAction; startedAt: number } | null = null;
  /** 表情层的睁眼基线（开心眯眼/悲伤低垂）；眨眼层在此基线上闭合。 */
  private lidBaseline = 1;

  private nextBlinkAt: number;
  private blinkStart: number | null = null;
  private disposed = false;

  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(options: PlaceholderAvatarOptions = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.nextBlinkAt = this.clock() + this.nextBlinkInterval();

    const build = buildRig();
    this.root = build.root;
    this.head = build.head;
    this.eyes = build.eyes;
    this.lids = build.lids;
    this.brows = build.brows;
    this.blushMeshes = build.blushMeshes;
    this.mouthMesh = build.mouthMesh;
    this.jaw = build.jaw;
    this.torso = build.torso;
    this.arms = build.arms;
    this.forearms = build.forearms;
    this.root.position.set(0, 0, SEATED_POSE.rootZ);
    this.root.rotation.y = FACE_USER_YAW;
  }

  getRoot(): THREE.Object3D {
    return this.root;
  }

  get state(): AvatarState {
    return this.currentState;
  }

  /** Clamped mouth target last set via setMouthOpen (0 when closed). */
  get mouthOpen(): number {
    return this.mouthTarget;
  }

  setState(state: AvatarState): void {
    this.currentState = state;
  }

  setMouthOpen(value: number): void {
    this.mouthTarget = clamp01(value);
  }

  setGaze(x: number, y: number): void {
    this.gazeTarget.set(THREE.MathUtils.clamp(x, -1, 1), THREE.MathUtils.clamp(y, -1, 1));
  }

  /** 模型可控表情（UI_UX_AVATAR §1.3 表情层）。 */
  setExpression(name: AvatarExpression): void {
    this.expression = name;
    this.expressionStartedAt = this.clock();
  }

  get currentExpression(): AvatarExpression {
    return this.expression;
  }

  /** 模型可控动作（一次性手势，播完自动回位）。 */
  playAction(name: AvatarAction): void {
    this.action = { name, startedAt: this.clock() };
  }

  get currentAction(): AvatarAction | null {
    return this.action?.name ?? null;
  }

  /** 显式覆盖朝向；null 恢复状态机默认（working→屏幕，其余→用户）。 */
  setFacing(mode: AvatarFacing | null): void {
    this.facingOverride = mode;
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;
    const dt = THREE.MathUtils.clamp(dtSeconds, 0, 0.1);
    const t = this.clock();

    this.applyFacing(dt);
    this.applyBlink(t);
    this.applyGaze(dt, t);
    this.applyExpression(t);
    this.applyAction(dt, t);
    this.applyMouth();
    this.applyPosture(dt, t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeObject3DDeep(this.root);
  }

  // ── Layers ─────────────────────────────────────────────────────────────────

  private nextBlinkInterval(): number {
    const [min, max] = BLINK_INTERVAL_MS;
    return min + this.random() * (max - min);
  }

  /** Random-interval blink loop driven by the absolute injected clock. */
  private applyBlink(t: number): void {
    if (this.blinkStart === null) {
      if (t < this.nextBlinkAt) {
        this.setLids(1);
        return;
      }
      this.blinkStart = t;
    }
    const phase = (t - this.blinkStart) / BLINK_DURATION_MS;
    if (phase >= 1) {
      this.blinkStart = null;
      this.nextBlinkAt = t + this.nextBlinkInterval();
      this.setLids(1);
      return;
    }
    // Triangular openness: close on the way up, reopen on the way down.
    const openness = phase <= 0.5 ? 1 - phase * 2 : (phase - 0.5) * 2;
    this.setLids(openness);
  }

  private setLids(openness: number): void {
    // 睁眼基线由表情层给出（如开心眯眼），眨眼在基线与全闭之间插值
    const openScale = LID_THIN + (1 - this.lidBaseline) * (1 - LID_THIN);
    const scale = openScale + (1 - clamp01(openness)) * (1 - openScale);
    for (const lid of this.lids) lid.scale.y = scale;
  }

  /** Exponential gaze lerp; the head leads, the eyes follow a fraction. */
  private applyGaze(dt: number, t: number): void {
    const k = 1 - Math.exp(-dt * GAZE_LERP_RATE);
    this.gazeCurrent.x += (this.gazeTarget.x - this.gazeCurrent.x) * k;
    this.gazeCurrent.y += (this.gazeTarget.y - this.gazeCurrent.y) * k;

    this.head.rotation.y = this.gazeCurrent.x * GAZE_MAX_YAW;
    const nod =
      this.currentState === 'listening' ? Math.sin(t * 0.004) * NOD_AMPLITUDE : 0;
    this.head.rotation.x =
      HEAD_BASE_PITCH - this.gazeCurrent.y * GAZE_MAX_PITCH + nod;
    this.eyes.rotation.y = this.gazeCurrent.x * 0.15;
    this.eyes.rotation.x = -this.gazeCurrent.y * 0.08;
  }

  /** 朝向插值：状态机默认（working 看屏幕，其余面向用户），setFacing 可覆盖。 */
  private applyFacing(dt: number): void {
    const policy: AvatarFacing = this.facingOverride ?? (this.currentState === 'working' ? 'screen' : 'user');
    this.facingTarget = policy === 'user' ? FACE_USER_YAW : FACE_SCREEN_YAW;
    const k = 1 - Math.exp(-dt * FACING_LERP);
    let delta = this.facingTarget - this.facingCurrent;
    // 取最短弧，避免大角度回转绕远路
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.facingCurrent += delta * k;
    this.root.rotation.y = this.facingCurrent;
  }

  /** 表情层：眉形、腮红、嘴形、头部倾斜（与口型/视线层叠加，不互斥）。 */
  private applyExpression(t: number): void {
    const since = t - this.expressionStartedAt;
    const ease = Math.min(1, since / 350);
    const e = this.expression;
    const set = (target: { lidY: number; browY: number; browTilt: number; blush: number; mouthCurve: number; mouthWide: number; headTilt: number; gazeLift: number }) => {
      // 眼睑只调基线，眨眼层保有最终控制权（避免表情层吞掉眨眼）
      this.lidBaseline = THREE.MathUtils.lerp(this.lidBaseline, target.lidY, ease);
      for (const [i, brow] of this.brows.entries()) {
        brow.position.y = THREE.MathUtils.lerp(brow.position.y, target.browY, ease);
        brow.rotation.z = THREE.MathUtils.lerp(
          brow.rotation.z,
          (i === 0 ? 1 : -1) * target.browTilt,
          ease,
        );
      }
      for (const blush of this.blushMeshes) {
        (blush.material as THREE.MeshStandardMaterial).opacity = THREE.MathUtils.lerp(
          (blush.material as THREE.MeshStandardMaterial).opacity,
          target.blush,
          ease,
        );
      }
      this.mouthMesh.rotation.x = THREE.MathUtils.lerp(this.mouthMesh.rotation.x, target.mouthCurve, ease);
      this.mouthMesh.scale.x = THREE.MathUtils.lerp(this.mouthMesh.scale.x, target.mouthWide, ease);
      this.head.rotation.z = THREE.MathUtils.lerp(this.head.rotation.z, target.headTilt, ease);
      if (target.gazeLift !== 0) this.gazeTarget.set(this.gazeTarget.x, target.gazeLift);
    };
    switch (e) {
      case 'happy':
        set({ lidY: 0.55, browY: 0.03, browTilt: -0.1, blush: 0.5, mouthCurve: -0.5, mouthWide: 1.25, headTilt: 0.06, gazeLift: 0 });
        break;
      case 'sad':
        set({ lidY: 0.6, browY: 0.02, browTilt: 0.35, blush: 0, mouthCurve: 0.35, mouthWide: 0.8, headTilt: -0.04, gazeLift: -0.3 });
        break;
      case 'thinking':
        set({ lidY: 0.75, browY: 0.035, browTilt: 0.15, blush: 0, mouthCurve: 0.05, mouthWide: 0.9, headTilt: 0.16, gazeLift: 0.5 });
        break;
      case 'surprised':
        set({ lidY: 1, browY: 0.045, browTilt: -0.25, blush: 0.2, mouthCurve: 0, mouthWide: 0.7, headTilt: 0, gazeLift: 0 });
        break;
      case 'shy':
        set({ lidY: 0.7, browY: 0.02, browTilt: 0.1, blush: 0.85, mouthCurve: -0.2, mouthWide: 0.85, headTilt: 0.1, gazeLift: -0.2 });
        break;
      default:
        set({ lidY: 1, browY: 0.028, browTilt: 0, blush: 0, mouthCurve: 0, mouthWide: 1, headTilt: 0, gazeLift: 0 });
    }
  }

  /** 动作层：一次性手势（点头/摇头/歪头/挥手），播完自动回位。 */
  private applyAction(dt: number, t: number): void {
    if (!this.action) return;
    const DUR: Partial<Record<AvatarAction, number>> = { nod: 700, shake: 900, tilt: 1200, wave: 1400 };
    const { name, startedAt } = this.action;
    const duration = DUR[name];
    // [act:x] 协议允许的表情词（happy/angry/surprised/sleepy）不是手势。
    // 之前这里没校验：DUR[name] 为 undefined → phase=NaN → 手臂 rotation 变 NaN
    // 且 action 永远清不掉，模型矩阵被永久污染。未知动作直接丢弃。
    if (duration === undefined) {
      this.action = null;
      return;
    }
    const phase = (t - startedAt) / duration;
    if (phase >= 1) {
      // 收势：必须把手臂还原到静止姿态，否则挥手一次后手臂永久抬起。
      if (name === 'wave') this.restRightArm();
      this.action = null;
      return;
    }
    const wave = Math.sin(phase * Math.PI * 2);
    if (name === 'nod') {
      this.head.rotation.x += wave * 0.18;
    } else if (name === 'shake') {
      this.head.rotation.y += Math.sin(phase * Math.PI * 4) * 0.22;
    } else if (name === 'tilt') {
      this.head.rotation.z += Math.sin(phase * Math.PI) * 0.2;
    } else {
      // wave：右臂抬起左右摆（右臂在面向用户时位于画面左侧）
      const right = this.arms[1];
      const lift = Math.sin(Math.min(1, phase * 3) * Math.PI * 0.5);
      right.rotation.z = -lift * 1.6;
      right.rotation.x = ARM_REST - lift * 1.1;
      const [ , rightForearm ] = this.forearms;
      rightForearm.rotation.z = Math.sin(t * 0.02) * 0.5 * lift;
    }
  }

  /** 右臂回静止位（挥手结束后调用）。 */
  private restRightArm(): void {
    const right = this.arms[1];
    right.rotation.z = 0;
    right.rotation.x = ARM_REST;
    const [ , rightForearm ] = this.forearms;
    rightForearm.rotation.z = 0;
  }

  /** Mouth opens only in the speaking layer (UI_UX_AVATAR §1.3 layering). */
  private applyMouth(): void {
    const open = this.currentState === 'speaking' ? this.mouthTarget : 0;
    this.jaw.rotation.x = JAW_REST + open * JAW_OPEN;
  }

  /** Typing arms while working; subtle breathing always; still otherwise. */
  private applyPosture(dt: number, t: number): void {
    this.torso.position.y = 0.8 + Math.sin(t * 0.0016) * BREATH_AMPLITUDE;

    if (this.currentState !== 'working') return;
    this.typingPhase += dt * TYPING_STROKE_HZ * Math.PI * 2;
    const [left, right] = this.forearms;
    left.rotation.x = FOREARM_REST + Math.sin(this.typingPhase) * TYPING_AMPLITUDE;
    right.rotation.x = FOREARM_REST + Math.sin(this.typingPhase + Math.PI) * TYPING_AMPLITUDE;
  }
}

// ── Geometry builder ─────────────────────────────────────────────────────────

function buildRig(): {
  root: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Group;
  lids: THREE.Mesh[];
  brows: THREE.Mesh[];
  blushMeshes: THREE.Mesh[];
  mouthMesh: THREE.Mesh;
  jaw: THREE.Group;
  torso: THREE.Group;
  arms: [THREE.Group, THREE.Group];
  forearms: [THREE.Group, THREE.Group];
} {
  const skinMaterial = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.65 });
  const skinDarkMaterial = new THREE.MeshStandardMaterial({ color: SKIN_DARK, roughness: 0.65 });
  const shirtMaterial = new THREE.MeshStandardMaterial({ color: SHIRT, roughness: 0.7 });
  const pantsMaterial = new THREE.MeshStandardMaterial({ color: PANTS, roughness: 0.7 });
  const hairMaterial = new THREE.MeshStandardMaterial({ color: HAIR, roughness: 0.55 });
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: EYE_WHITE, roughness: 0.25 });
  const irisMaterial = new THREE.MeshStandardMaterial({ color: IRIS, roughness: 0.3 });

  const root = new THREE.Group();
  root.name = 'placeholder-avatar';

  // ── Hips + seated legs ────────────────────────────────────────────────────
  const hips = new THREE.Group();
  hips.name = 'hips';
  hips.position.set(0, SEATED_POSE.seatY, 0);
  root.add(hips);

  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.18), pantsMaterial);
  pelvis.name = 'pelvis';
  pelvis.position.y = 0.02;
  hips.add(pelvis);

  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? -1 : 1;
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.09, 0.34), pantsMaterial);
    thigh.name = `thigh-${side}`;
    thigh.position.set(sign * 0.075, -0.05, -0.15);
    hips.add(thigh);

    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.36, 0.085), pantsMaterial);
    shin.name = `shin-${side}`;
    shin.position.set(sign * 0.075, -0.23, -0.29);
    hips.add(shin);

    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.05, 0.17), pantsMaterial);
    foot.name = `foot-${side}`;
    foot.position.set(sign * 0.075, -0.445, -0.32);
    hips.add(foot);
  }

  // ── Torso (slight forward lean toward the desk) ───────────────────────────
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.set(0, 0.8, 0);
  torso.rotation.x = -0.05;
  root.add(torso);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.44, 0.18), shirtMaterial);
  chest.name = 'chest';
  torso.add(chest);

  // ── Arms: shoulder → elbow → wrist joint groups ───────────────────────────
  const arms: THREE.Group[] = [];
  const forearms: THREE.Group[] = [];
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? -1 : 1;
    const arm = new THREE.Group();
    arm.name = `arm-${side}`;
    arm.position.set(sign * 0.185, 0.17, 0.01);
    arm.rotation.x = ARM_REST;
    torso.add(arm);
    arms.push(arm);

    const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.26, 0.055), shirtMaterial);
    upperArm.name = `upper-arm-${side}`;
    upperArm.position.y = -0.13;
    arm.add(upperArm);

    const forearm = new THREE.Group();
    forearm.name = `forearm-${side}`;
    forearm.position.y = -0.26;
    forearm.rotation.x = FOREARM_REST;
    arm.add(forearm);
    forearms.push(forearm);

    const forearmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.24, 0.05), skinMaterial);
    forearmMesh.name = `forearm-mesh-${side}`;
    forearmMesh.position.y = -0.12;
    forearm.add(forearmMesh);

    const hand = new THREE.Group();
    hand.name = `hand-${side}`;
    hand.position.y = -0.24;
    forearm.add(hand);

    const handMesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.07), skinMaterial);
    handMesh.name = `hand-mesh-${side}`;
    handMesh.position.y = -0.045;
    hand.add(handMesh);
  }

  // ── Head: skull, hair, eyes, lids, jaw ────────────────────────────────────
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 0.3, -0.02);
  torso.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.095, 24, 18), skinMaterial);
  skull.name = 'skull';
  head.add(skull);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 18), hairMaterial);
  hair.name = 'hair';
  hair.position.set(0, 0.014, 0.014);
  hair.scale.set(1, 0.82, 0.95);
  head.add(hair);

  const eyes = new THREE.Group();
  eyes.name = 'eyes';
  eyes.position.set(0, 0.005, -0.075);
  head.add(eyes);

  const lids: THREE.Mesh[] = [];
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? -1 : 1;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), eyeMaterial);
    eye.name = `eye-${side}`;
    eye.position.x = sign * 0.033;
    eyes.add(eye);

    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.007, 12, 10), irisMaterial);
    iris.name = `iris-${side}`;
    iris.position.set(0, 0, -0.012);
    eye.add(iris);

    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.02, 0.014), skinDarkMaterial);
    lid.name = `lid-${side}`;
    lid.position.set(sign * 0.033, 0.004, -0.014);
    lid.scale.y = LID_THIN;
    eyes.add(lid);
    lids.push(lid);
  }

  // 眉形（表情层：倾斜/升降表达情绪）
  const browMaterial = new THREE.MeshStandardMaterial({ color: HAIR, roughness: 0.6 });
  const brows: THREE.Mesh[] = [];
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? -1 : 1;
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, 0.008), browMaterial);
    brow.name = `brow-${side}`;
    brow.position.set(sign * 0.033, 0.028, -0.08);
    eyes.add(brow);
    brows.push(brow);
  }

  // 腮红（害羞/开心时淡入）
  const blushMeshes: THREE.Mesh[] = [];
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? -1 : 1;
    const blushMat = new THREE.MeshStandardMaterial({
      color: BLUSH,
      roughness: 0.9,
      transparent: true,
      opacity: 0,
    });
    const blush = new THREE.Mesh(new THREE.CircleGeometry(0.016, 16), blushMat);
    blush.name = `blush-${side}`;
    blush.position.set(sign * 0.052, -0.018, -0.082);
    blush.rotation.y = Math.PI; // 面向 -Z（脸所在的一侧）
    head.add(blush);
    blushMeshes.push(blush);
  }

  // 嘴（表情层的曲线基础；说话由 jaw 层驱动）
  const mouthMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.034, 0.005, 0.006),
    new THREE.MeshStandardMaterial({ color: 0x7a4a3a, roughness: 0.6 }),
  );
  mouthMesh.name = 'mouth';
  mouthMesh.position.set(0, -0.032, -0.086);
  head.add(mouthMesh);

  const jaw = new THREE.Group();
  jaw.name = 'jaw';
  jaw.position.set(0, -0.045, -0.01);
  jaw.rotation.x = JAW_REST;
  head.add(jaw);

  const jawMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.06), skinMaterial);
  jawMesh.name = 'jaw-mesh';
  jawMesh.position.set(0, -0.02, -0.012);
  jaw.add(jawMesh);

  return {
    root,
    head,
    eyes,
    lids,
    brows,
    blushMeshes,
    mouthMesh,
    jaw,
    torso,
    arms: [arms[0], arms[1]],
    forearms: [forearms[0], forearms[1]],
  };
}
