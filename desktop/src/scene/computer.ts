// Refined computer set: 16:9 monitor with emissive status screen, keycap
// InstancedMesh, mouse, CatmullRom cables, rounded wood desk and contact
// shadows (EXP-004 step 2, UI_UX_AVATAR §1.1 right pane scene).
//
// Units are meters. Layout (top view, +Z toward the viewer/camera):
//
//            z=-0.28  ┌─ monitor (screen faces +Z)
//   desk top y=0.72   │
//            z=+0.10  ├─ keyboard + mouse
//            z=+0.46  └─ avatar seat position (avatar.ts places the root here)
//
// Fully constructible without a GPU: the screen canvas is injectable and the
// contact shadows are baked into DataTextures instead of DOM canvases.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { disposeObject3DDeep } from './dispose';
import { ScreenSurface, type ScreenCanvasLike, type ScreenStatus } from './screen';

export interface ComputerSceneOptions {
  /** Backing canvas for the emissive screen; defaults to DOM canvas or a headless no-op. */
  screenCanvas?: ScreenCanvasLike;
}

export interface ComputerDimensions {
  screen: { width: number; height: number };
  desk: { width: number; depth: number; height: number };
  keycaps: number;
}

export interface ComputerScene {
  readonly group: THREE.Group;
  readonly screen: ScreenSurface;
  readonly keycapCount: number;
  readonly cableCurves: THREE.CatmullRomCurve3[];
  readonly contactShadows: THREE.Mesh[];
  readonly dimensions: ComputerDimensions;
  writeScreenStatus(status: ScreenStatus): void;
  dispose(): void;
}

// ── Tuned layout constants (meters) ──────────────────────────────────────────

export const DESK = { width: 1.6, depth: 0.8, top: 0.72, thickness: 0.05 } as const;
export const MONITOR = { z: -0.28, standHeight: 0.16 } as const;
// 27" class 16:9 panel: 0.608 / 0.342 ≈ 1.7778.
export const SCREEN = { width: 0.608, height: 0.342 } as const;
export const KEYBOARD = { x: -0.14, z: 0.1, width: 0.46, depth: 0.16, rows: 5, cols: 14 } as const;
export const MOUSE = { x: 0.32, z: 0.1 } as const;

const WOOD_COLOR = 0x8a6142;
const DARK_PLASTIC = 0x22262c;
const BEZEL_COLOR = 0x16181c;

// ── Helpers ──────────────────────────────────────────────────────────────────

function applyShadows(root: THREE.Object3D, cast: boolean, receive: boolean): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
    }
  });
}

/**
 * Baked radial contact shadow (UI_UX_AVATAR grounding without DOM canvas): a
 * small RGBA DataTexture with an alpha falloff, rendered as a flat decal just
 * above the desk. Survives quality=low (where light shadows are disabled).
 */
function makeContactShadow(sizeX: number, sizeZ: number, opacity: number): THREE.Mesh {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const half = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const alpha = Math.round(230 * Math.pow(1 - d, 1.7));
      const i = (y * size + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = alpha;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sizeX, sizeZ),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.name = 'contact-shadow';
  return mesh;
}

function addContactShadow(
  parent: THREE.Object3D,
  shadows: THREE.Mesh[],
  x: number,
  z: number,
  sizeX: number,
  sizeZ: number,
  opacity = 0.55,
): void {
  const shadow = makeContactShadow(sizeX, sizeZ, opacity);
  shadow.position.set(x, DESK.top + 0.002, z);
  parent.add(shadow);
  shadows.push(shadow);
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function buildComputerScene(options: ComputerSceneOptions = {}): ComputerScene {
  const group = new THREE.Group();
  group.name = 'computer';
  const cableCurves: THREE.CatmullRomCurve3[] = [];
  const contactShadows: THREE.Mesh[] = [];

  // Desk: rounded wood slab on two simple legs (legs mostly hidden by framing).
  const desk = new THREE.Mesh(
    new RoundedBoxGeometry(DESK.width, DESK.thickness, DESK.depth, 4, 0.02),
    new THREE.MeshStandardMaterial({ color: WOOD_COLOR, roughness: 0.55, metalness: 0.05 }),
  );
  desk.name = 'desk';
  desk.position.y = DESK.top - DESK.thickness / 2;
  group.add(desk);

  const legMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.4 });
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, DESK.top, 0.5), legMaterial);
    leg.name = `desk-leg-${side < 0 ? 'left' : 'right'}`;
    leg.position.set((side * DESK.width) / 2 - side * 0.09, DESK.top / 2, 0);
    group.add(leg);
  }

  // ── Monitor: bezel + emissive 16:9 screen + stand ─────────────────────────
  // 侧向构图：显示器在她左手侧并朝她与镜头微转，人物面向用户时屏幕仍入镜
  const monitor = new THREE.Group();
  monitor.name = 'monitor';
  monitor.position.set(-0.3, DESK.top, MONITOR.z);
  monitor.rotation.y = 0.5;

  const bezel = new THREE.Mesh(
    new RoundedBoxGeometry(
      SCREEN.width + 0.05,
      SCREEN.height + 0.05,
      0.028,
      3,
      0.008,
    ),
    new THREE.MeshStandardMaterial({ color: BEZEL_COLOR, roughness: 0.35, metalness: 0.25 }),
  );
  bezel.name = 'bezel';
  bezel.position.y = MONITOR.standHeight + SCREEN.height / 2;
  monitor.add(bezel);

  const screen = new ScreenSurface(options.screenCanvas, 1024, 576);
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN.width, SCREEN.height),
    // toneMapped=false keeps the panel reading as a self-lit display under ACES.
    new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false }),
  );
  screenMesh.name = 'screen';
  screenMesh.position.set(0, bezel.position.y, 0.016);
  monitor.add(screenMesh);

  const monitorStand = new THREE.Group();
  monitorStand.name = 'monitor-stand';

  const standBase = new THREE.Mesh(
    new RoundedBoxGeometry(0.26, 0.02, 0.2, 3, 0.008),
    new THREE.MeshStandardMaterial({ color: DARK_PLASTIC, roughness: 0.4, metalness: 0.2 }),
  );
  standBase.name = 'stand-base';
  standBase.position.set(0, 0.012, 0.02);
  monitorStand.add(standBase);

  const standColumn = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, MONITOR.standHeight, 0.045),
    new THREE.MeshStandardMaterial({ color: DARK_PLASTIC, roughness: 0.4, metalness: 0.2 }),
  );
  standColumn.name = 'stand-column';
  standColumn.position.set(0, MONITOR.standHeight / 2 + 0.02, 0.02);
  monitorStand.add(standColumn);

  monitor.add(monitorStand);

  group.add(monitor);

  // ── Keyboard: base slab + independent keycap InstancedMesh (5×14 = 70) ────
  const keyboardBase = new THREE.Mesh(
    new RoundedBoxGeometry(KEYBOARD.width, 0.018, KEYBOARD.depth, 3, 0.006),
    new THREE.MeshStandardMaterial({ color: DARK_PLASTIC, roughness: 0.5 }),
  );
  keyboardBase.name = 'keyboard-base';
  keyboardBase.position.set(KEYBOARD.x, DESK.top + 0.011, KEYBOARD.z);
  group.add(keyboardBase);

  const keycapCount = KEYBOARD.rows * KEYBOARD.cols; // 70 >= 60
  const keycapMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.026, 0.012, 0.026),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.6 }),
    keycapCount,
  );
  keycapMesh.name = 'keycaps';
  {
    const dummy = new THREE.Object3D();
    const gapX = 0.031;
    const gapZ = 0.029;
    const startX = KEYBOARD.x - ((KEYBOARD.cols - 1) * gapX) / 2;
    const startZ = KEYBOARD.z - ((KEYBOARD.rows - 1) * gapZ) / 2;
    let index = 0;
    for (let row = 0; row < KEYBOARD.rows; row += 1) {
      for (let col = 0; col < KEYBOARD.cols; col += 1) {
        dummy.position.set(startX + col * gapX, DESK.top + 0.02, startZ + row * gapZ);
        dummy.updateMatrix();
        keycapMesh.setMatrixAt(index, dummy.matrix);
        index += 1;
      }
    }
    keycapMesh.instanceMatrix.needsUpdate = true;
  }
  group.add(keycapMesh);

  // ── Mouse ──────────────────────────────────────────────────────────────────
  const mouse = new THREE.Mesh(
    new RoundedBoxGeometry(0.072, 0.032, 0.115, 4, 0.014),
    new THREE.MeshStandardMaterial({ color: DARK_PLASTIC, roughness: 0.45 }),
  );
  mouse.name = 'mouse';
  mouse.position.set(MOUSE.x, DESK.top + 0.018, MOUSE.z);
  group.add(mouse);

  // ── Cables: monitor power drop + keyboard & mouse leads (CatmullRom) ──────
  const cableMaterial = new THREE.LineBasicMaterial({ color: 0x101215 });
  const cableSpecs: THREE.Vector3[][] = [
    // Monitor power cable down behind the desk.
    [
      new THREE.Vector3(-0.05, DESK.top + 0.18, MONITOR.z - 0.03),
      new THREE.Vector3(-0.32, DESK.top + 0.05, MONITOR.z - 0.12),
      new THREE.Vector3(-0.48, 0.45, -0.42),
      new THREE.Vector3(-0.5, 0.05, -0.48),
    ],
    // Keyboard lead to the monitor trunk.
    [
      new THREE.Vector3(KEYBOARD.x - 0.2, DESK.top + 0.012, KEYBOARD.z + 0.04),
      new THREE.Vector3(-0.3, DESK.top + 0.005, -0.05),
      new THREE.Vector3(-0.18, DESK.top + 0.01, MONITOR.z + 0.08),
      new THREE.Vector3(-0.05, DESK.top + 0.18, MONITOR.z - 0.03),
    ],
    // Mouse lead to the monitor trunk.
    [
      new THREE.Vector3(MOUSE.x + 0.03, DESK.top + 0.016, MOUSE.z + 0.05),
      new THREE.Vector3(0.42, DESK.top + 0.008, -0.04),
      new THREE.Vector3(0.22, DESK.top + 0.01, MONITOR.z + 0.1),
      new THREE.Vector3(-0.05, DESK.top + 0.18, MONITOR.z - 0.03),
    ],
  ];
  cableSpecs.forEach((points, i) => {
    const curve = new THREE.CatmullRomCurve3(points);
    cableCurves.push(curve);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
      cableMaterial,
    );
    line.name = `cable-${i}`;
    group.add(line);
  });

  // ── Contact shadows (baked decals, quality-independent) ───────────────────
  addContactShadow(group, contactShadows, 0, MONITOR.z + 0.02, 1.15, 0.5, 0.6);
  addContactShadow(group, contactShadows, KEYBOARD.x, KEYBOARD.z, 0.62, 0.3, 0.5);
  addContactShadow(group, contactShadows, MOUSE.x, MOUSE.z, 0.26, 0.32, 0.5);

  applyShadows(bezel, true, true);
  applyShadows(standBase, true, true);
  applyShadows(standColumn, true, true);
  applyShadows(keyboardBase, true, true);
  keycapMesh.castShadow = true;
  mouse.castShadow = true;
  desk.receiveShadow = true;

  const dimensions: ComputerDimensions = {
    screen: { width: SCREEN.width, height: SCREEN.height },
    desk: { width: DESK.width, depth: DESK.depth, height: DESK.top },
    keycaps: keycapCount,
  };

  return {
    group,
    screen,
    keycapCount,
    cableCurves,
    contactShadows,
    dimensions,
    writeScreenStatus(status: ScreenStatus) {
      screen.writeStatus(status);
    },
    dispose() {
      disposeObject3DDeep(group);
      screen.dispose();
    },
  };
}
