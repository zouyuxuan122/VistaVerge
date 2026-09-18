// EXP-004 logic-layer tests for the placeholder avatar (desktop/src/scene/avatar.ts).
//
// No GPU, no renderer: PlaceholderAvatar is a procedural scene graph plus a
// driver whose behavior (blink scheduling, gaze lerp, mouth clamp, typing
// oscillation) is fully testable in Node with a fake clock and a seeded RNG.
// The placeholder is explicitly NOT the final character; the real VRM pipeline
// is gated in scene/vrmAvatar.ts and tested in scene-vrm.test.ts.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { BLINK_DURATION_MS, BLINK_INTERVAL_MS, PlaceholderAvatar } from '../../src/scene/avatar';

// Deterministic RNG (mulberry32) so blink intervals are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeAvatar(options: { clock: () => number; random?: () => number }) {
  return new PlaceholderAvatar({
    clock: options.clock,
    random: options.random ?? mulberry32(20260918),
  });
}

function node(avatar: PlaceholderAvatar, name: string): THREE.Object3D {
  const found = avatar.getRoot().getObjectByName(name);
  expect(found, `expected joint group "${name}" on the placeholder rig`).toBeTruthy();
  return found as THREE.Object3D;
}

const lidsOf = (avatar: PlaceholderAvatar) => ({
  left: node(avatar, 'lid-left'),
  right: node(avatar, 'lid-right'),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PlaceholderAvatar (logic layer, no GPU)', () => {
  it('declares itself as a placeholder and builds the full joint rig', () => {
    const avatar = makeAvatar({ clock: () => 0 });

    expect(avatar.isPlaceholder).toBe(true);
    for (const name of [
      'head',
      'eye-left',
      'eye-right',
      'lid-left',
      'lid-right',
      'jaw',
      'torso',
      'arm-left',
      'arm-right',
      'forearm-left',
      'forearm-right',
      'hand-left',
      'hand-right',
      'hips',
    ]) {
      expect(avatar.getRoot().getObjectByName(name), name).toBeTruthy();
    }
    expect(avatar.getRoot().children.length).toBeGreaterThan(0);
  });

  it('默认面向用户，working 时转向屏幕（EXP-007 面向用户策略）', () => {
    const avatar = makeAvatar({ clock: () => 0 });
    // 构造即面向用户（FACE_USER_YAW = π）
    expect(Math.abs(avatar.getRoot().rotation.y - Math.PI)).toBeLessThan(0.01);
    avatar.setState('working');
    for (let i = 0; i < 40; i += 1) avatar.update(0.1);
    expect(Math.abs(avatar.getRoot().rotation.y)).toBeLessThan(0.05);
    avatar.setState('listening');
    for (let i = 0; i < 40; i += 1) avatar.update(0.1);
    expect(Math.abs(avatar.getRoot().rotation.y - Math.PI)).toBeLessThan(0.05);
  });

  it('is seated facing the desk with hands at keyboard height', () => {
    const avatar = makeAvatar({ clock: () => 0 });
    // 几何断言在“面向屏幕”姿态下进行（与桌面布局合同一致）
    avatar.setFacing('screen');
    for (let i = 0; i < 40; i += 1) avatar.update(0.1);
    const scene = new THREE.Scene();
    scene.add(avatar.getRoot());
    scene.updateMatrixWorld(true);

    const head = node(avatar, 'head');
    const torso = node(avatar, 'torso');
    const hand = node(avatar, 'hand-right');

    // Head sits above the torso and forward of it (the rig faces -Z, the
    // monitor side; the stage places the root between desk and camera).
    const headWorld = head.getWorldPosition(new THREE.Vector3());
    const torsoWorld = torso.getWorldPosition(new THREE.Vector3());
    expect(headWorld.y).toBeGreaterThan(torsoWorld.y);
    expect(headWorld.z).toBeLessThan(torsoWorld.z);

    // Hands rest on the keyboard: just above the 0.72 m desk top, in front of
    // the torso. UI_UX_AVATAR §1.3(3) makes exact contact an art acceptance
    // item (EXP-007), the logic layer only pins the plausible band.
    const handWorld = hand.getWorldPosition(new THREE.Vector3());
    expect(handWorld.y).toBeGreaterThan(0.7);
    expect(handWorld.y).toBeLessThan(0.8);
    expect(handWorld.z).toBeGreaterThan(0.0);
    expect(handWorld.z).toBeLessThan(0.3);
    expect(avatar.getRoot().position.z).toBeGreaterThan(0.3);
  });

  it('blinks after a random interval inside the configured window (fake clock)', () => {
    let now = 0;
    const avatar = makeAvatar({ clock: () => now });
    const lids = lidsOf(avatar);

    avatar.update(0.016);
    expect(lids.left.scale.y).toBeLessThan(0.3); // open: thin sliver

    let firstClosedAt = -1;
    for (let i = 0; i < 400; i += 1) {
      now += 50;
      avatar.update(0.05);
      if (lids.left.scale.y > 0.9) {
        firstClosedAt = now;
        break;
      }
    }

    expect(firstClosedAt).toBeGreaterThan(0);
    expect(firstClosedAt).toBeGreaterThanOrEqual(BLINK_INTERVAL_MS[0]);
    expect(firstClosedAt).toBeLessThanOrEqual(BLINK_INTERVAL_MS[1] + BLINK_DURATION_MS);

    // The blink completes and the lids reopen.
    for (let i = 0; i < 20 && lids.left.scale.y > 0.3; i += 1) {
      now += 30;
      avatar.update(0.03);
    }
    expect(lids.left.scale.y).toBeLessThan(0.3);
    expect(lids.right.scale.y).toBeLessThan(0.3);
  });

  it('does not blink while the fake clock is frozen', () => {
    const avatar = makeAvatar({ clock: () => 0 });
    const lids = lidsOf(avatar);

    for (let i = 0; i < 240; i += 1) avatar.update(0.016);

    expect(lids.left.scale.y).toBeLessThan(0.3);
    expect(lids.right.scale.y).toBeLessThan(0.3);
  });

  it('lerps gaze toward the target instead of snapping', () => {
    let now = 0;
    const avatar = makeAvatar({ clock: () => now });
    const head = node(avatar, 'head');

    avatar.setGaze(1, 0);
    avatar.update(0.016);
    const yawAfterFirst = head.rotation.y;
    expect(yawAfterFirst).toBeGreaterThan(0);
    expect(yawAfterFirst).toBeLessThan(0.3); // did not snap to the 0.45 rad target

    for (let i = 0; i < 60; i += 1) {
      now += 16;
      avatar.update(0.016);
    }
    expect(head.rotation.y).toBeGreaterThan(yawAfterFirst);
    expect(Math.abs(head.rotation.y - 0.45)).toBeLessThan(0.05);
  });

  it('clamps mouthOpen to [0, 1] before driving the jaw', () => {
    let now = 0;
    const avatar = makeAvatar({ clock: () => now });
    const jaw = node(avatar, 'jaw');
    avatar.setState('speaking');
    avatar.update(0.016);
    const closedRotation = jaw.rotation.x;

    avatar.setMouthOpen(1.7);
    expect(avatar.mouthOpen).toBe(1);
    now += 16;
    avatar.update(0.016);
    const openRotation = jaw.rotation.x;
    expect(openRotation).toBeGreaterThan(closedRotation + 0.2);

    avatar.setMouthOpen(-0.5);
    expect(avatar.mouthOpen).toBe(0);
    now += 16;
    avatar.update(0.016);
    expect(jaw.rotation.x).toBeCloseTo(closedRotation, 5);
  });

  it('oscillates both forearms while working and keeps them still when idle', () => {
    let now = 0;
    const avatar = makeAvatar({ clock: () => now });
    const left = node(avatar, 'forearm-left');
    const right = node(avatar, 'forearm-right');

    // Idle: repeated updates leave the rest pose untouched.
    avatar.setState('idle');
    avatar.update(0.05);
    const idleLeft = left.rotation.x;
    const idleRight = right.rotation.x;
    now += 100;
    avatar.update(0.1);
    expect(left.rotation.x).toBeCloseTo(idleLeft, 6);
    expect(right.rotation.x).toBeCloseTo(idleRight, 6);

    // Working: both forearms move, in alternating phase.
    avatar.setState('working');
    now += 16;
    avatar.update(0.016);
    const l1 = left.rotation.x;
    const r1 = right.rotation.x;
    now += 40;
    avatar.update(0.04);
    const l2 = left.rotation.x;
    const r2 = right.rotation.x;
    expect(Math.abs(l2 - l1)).toBeGreaterThan(0.002);
    expect(Math.abs(r2 - r1)).toBeGreaterThan(0.002);
    // Alternating keystrokes: one forearm moves up while the other moves down.
    expect((l2 - l1) * (r2 - r1)).toBeLessThan(0);
  });

  it('follows setMouthOpen only while speaking', () => {
    let now = 0;
    const avatar = makeAvatar({ clock: () => now });
    const jaw = node(avatar, 'jaw');

    avatar.setMouthOpen(0.6);
    avatar.update(0.016);
    const idleJaw = jaw.rotation.x;

    avatar.setState('speaking');
    now += 16;
    avatar.update(0.016);
    expect(jaw.rotation.x).toBeGreaterThan(idleJaw + 0.1);
  });

  it('dispose() disposes rig geometries/materials once and is idempotent', () => {
    const avatar = makeAvatar({ clock: () => 0 });
    const chest = node(avatar, 'chest') as THREE.Mesh;
    const skull = node(avatar, 'skull') as THREE.Mesh;

    let geometryDisposes = 0;
    chest.geometry.addEventListener('dispose', () => {
      geometryDisposes += 1;
    });
    let materialDisposes = 0;
    const material = skull.material as THREE.Material;
    material.addEventListener('dispose', () => {
      materialDisposes += 1;
    });

    avatar.dispose();
    avatar.dispose();

    expect(geometryDisposes).toBe(1);
    expect(materialDisposes).toBe(1);
  });
});
