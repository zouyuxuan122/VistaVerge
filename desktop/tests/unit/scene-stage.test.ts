// EXP-004 logic-layer tests for the AvatarScene stage (desktop/src/scene/AvatarScene.ts).
//
// No GPU: the renderer is injected as a recording fake via the createRenderer
// option, so AvatarScene is fully constructed (scene graph, lighting rig,
// computer, placeholder avatar, state machine) without instantiating
// THREE.WebGLRenderer and without a WebGL context. Rendering correctness is
// accepted by EXP-007 GUI screenshots.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { AvatarScene } from '../../src/scene/AvatarScene';
import { PlaceholderAvatar } from '../../src/scene/avatar';
import type { SceneRendererLike } from '../../src/scene/types';

// ── Fake renderer / canvas ───────────────────────────────────────────────────

function makeFakeRenderer() {
  const calls = {
    setSize: [] as [number, number][],
    pixelRatios: [] as number[],
    renders: 0,
    disposes: 0,
  };
  const renderer: SceneRendererLike = {
    setSize: (width, height) => {
      calls.setSize.push([width, height]);
    },
    setPixelRatio: (value) => {
      calls.pixelRatios.push(value);
    },
    render: () => {
      calls.renders += 1;
    },
    dispose: () => {
      calls.disposes += 1;
    },
    shadowMap: { enabled: false, type: -1 },
    toneMapping: -1,
    outputColorSpace: '',
  };
  return { renderer, calls };
}

function makeCanvas(): HTMLCanvasElement {
  return {
    width: 320,
    height: 240,
    clientWidth: 320,
    clientHeight: 240,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;
}

function makeStage(clock: () => number = () => 0) {
  const { renderer, calls } = makeFakeRenderer();
  const stage = new AvatarScene(makeCanvas(), { createRenderer: () => renderer, clock });
  return { stage, renderer, calls };
}

const VALID_META = {
  license: 'CC-BY-4.0',
  source: 'https://example.test/models/unit.vrm',
  declaredAt: '2026-09-18T00:00:00.000Z',
};

/**
 * Typed test accessor: the mouth target is on PlaceholderAvatar, not on the
 * AvatarRenderer contract. Guard the downcast with an instanceof check rather
 * than an unsafe blind cast or @ts-ignore.
 */
function placeholderMouthOf(stage: AvatarScene): number {
  const { avatar } = stage;
  expect(avatar).toBeInstanceOf(PlaceholderAvatar);
  return (avatar as PlaceholderAvatar).mouthOpen;
}

/**
 * Runtime boundary helper: the UI / wire layer may pass any string; the stage
 * must validate and ignore invalid values. The signature cast is the point
 * where the test deliberately crosses the compile-time boundary.
 */
function setStateUnvalidated(stage: AvatarScene, state: string): void {
  (stage.setState as (value: string) => void)(state);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AvatarScene (logic layer, injected renderer)', () => {
  it('constructs with placeholder avatar, computer, lights, ACES tone mapping and PCFSoft shadows', () => {
    const { stage, renderer } = makeStage();

    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);

    expect(stage.avatar.isPlaceholder).toBe(true);
    expect(stage.avatar.state).toBe('idle');
    expect(stage.scene.getObjectByName('computer')).toBeTruthy();
    for (const name of ['light-key', 'light-fill', 'light-rim']) {
      expect(stage.scene.getObjectByName(name), name).toBeTruthy();
    }

    // Injected fake renderer is not a WebGL renderer: the PMREM
    // RoomEnvironment must be skipped gracefully (no environment map).
    expect(stage.scene.environment).toBeNull();
  });

  it('forwards valid states and ignores unknown ones (state machine)', () => {
    const { stage } = makeStage();

    stage.setState('working');
    expect(stage.avatar.state).toBe('working');

    setStateUnvalidated(stage, 'nope');
    expect(stage.avatar.state).toBe('working'); // unchanged, no throw
  });

  it('clamps setMouthOpen before it reaches the avatar', () => {
    const { stage } = makeStage();

    stage.setState('speaking');
    stage.setMouthOpen(2.5);
    expect(placeholderMouthOf(stage)).toBe(1);
  });

  it('drives mouth from the audio clock RMS envelope and closes instantly on detach', () => {
    const { stage, calls } = makeStage();

    stage.setState('speaking');
    stage.setAudioClock(() => 0.2);
    stage.renderFrame();
    // Approximate RMS envelope (gain 4, clamped), explicitly NOT a viseme.
    expect(placeholderMouthOf(stage)).toBeCloseTo(0.8, 5);
    expect(calls.renders).toBe(1);

    // §3(4): on pause/cancel the mouth closes immediately, no residual opening.
    stage.setAudioClock(null);
    expect(placeholderMouthOf(stage)).toBe(0);

    // Leaving speaking also closes the mouth.
    stage.setAudioClock(() => 0.5);
    stage.setState('listening');
    expect(placeholderMouthOf(stage)).toBe(0);
  });

  it('quality low disables shadows and drops pixel ratio; high restores', () => {
    const { stage, renderer, calls } = makeStage();
    const keyLight = stage.scene.getObjectByName('light-key') as THREE.DirectionalLight;

    stage.setQuality('low');
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(keyLight.castShadow).toBe(false);
    expect(calls.pixelRatios[calls.pixelRatios.length - 1]).toBe(1);

    stage.setQuality('high');
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(keyLight.castShadow).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
  });

  it('resize updates renderer size and camera aspect and guards degenerate heights', () => {
    const { stage, calls } = makeStage();

    stage.resize(1280, 720);
    expect(calls.setSize[calls.setSize.length - 1]).toEqual([1280, 720]);
    expect(Math.abs(stage.camera.aspect - 1280 / 720)).toBeLessThan(1e-9);

    const aspectBefore = stage.camera.aspect;
    expect(() => stage.resize(640, 0)).not.toThrow();
    expect(stage.camera.aspect).toBe(aspectBefore);
  });

  it('renderFrame drives the avatar update and the renderer once per call', () => {
    let now = 0;
    const { stage, calls } = makeStage(() => now);

    stage.renderFrame();
    expect(calls.renders).toBe(1);
    now += 33;
    stage.renderFrame();
    expect(calls.renders).toBe(2);
  });

  it('dispose is idempotent and stops rendering afterwards', () => {
    const { stage, calls } = makeStage();

    stage.dispose();
    expect(calls.disposes).toBe(1);
    expect(stage.disposed).toBe(true);

    stage.dispose();
    expect(calls.disposes).toBe(1); // still exactly once

    stage.renderFrame();
    expect(calls.renders).toBe(0); // never rendered on this fresh stage
  });

  it('VRM license gate: rejections keep the placeholder, success swaps it in', async () => {
    const { stage } = makeStage();
    const rejections: string[] = [];
    stage.addEventListener('vrm-rejected', (event) => {
      rejections.push((event as CustomEvent<{ reason: string }>).detail.reason);
    });

    // No license declaration: rejected before any loader/network access.
    const missing = await stage.loadVrmAvatar('unit.vrm', {});
    expect(missing).toBe(false);
    expect(stage.avatar.isPlaceholder).toBe(true);
    expect(rejections).toHaveLength(1);

    // Declared license but the asset is missing: rejected, placeholder kept.
    const failed = await stage.loadVrmAvatar('unit.vrm', VALID_META, {
      createLoader: () => ({ loadAsync: () => Promise.reject(new Error('404 not found')) }),
    });
    expect(failed).toBe(false);
    expect(stage.avatar.isPlaceholder).toBe(true);
    expect(rejections).toHaveLength(2);
    expect(rejections[1]).toContain('load-failed');

    // Declared license and loadable asset: placeholder replaced.
    const ok = await stage.loadVrmAvatar('unit.vrm', VALID_META, {
      createLoader: () => ({
        loadAsync: async () => ({ scene: new THREE.Group(), userData: {} }),
      }),
    });
    expect(ok).toBe(true);
    expect(stage.avatar.isPlaceholder).toBe(false);
  });
});
