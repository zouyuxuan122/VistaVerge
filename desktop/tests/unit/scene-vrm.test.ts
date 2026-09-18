// EXP-004 logic-layer tests for the VRM adapter and the license gate
// (desktop/src/scene/vrmAvatar.ts).
//
// No GPU and no network: the GLTF loader is injected, so loadVrm's gate order
// (license declaration BEFORE any fetch) and the failure path (asset missing)
// are testable in Node. Real VRM assets remain BLOCKED (no licensed material);
// these tests only cover the adapter contract.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { VrmAvatar, createDefaultVrmLoader, gateLicense, loadVrm } from '../../src/scene/vrmAvatar';

const VALID_META = {
  license: 'CC-BY-4.0',
  source: 'https://example.test/models/unit.vrm',
  declaredAt: '2026-09-18T00:00:00.000Z',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('VRM license gate (UI_UX_AVATAR §2/§3.5)', () => {
  it('accepts a complete license declaration', () => {
    const gate = gateLicense(VALID_META);
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.meta.license).toBe('CC-BY-4.0');
      expect(gate.meta.source).toContain('unit.vrm');
      expect(gate.meta.declaredAt).toBe(VALID_META.declaredAt);
    }
  });

  it('rejects missing license, missing source or missing declaration time with distinct reasons', () => {
    expect(gateLicense({}).ok).toBe(false);
    const reasons = [
      gateLicense({ source: 's', declaredAt: '2026-09-18T00:00:00Z' }),
      gateLicense({ license: 'CC0', declaredAt: '2026-09-18T00:00:00Z' }),
      gateLicense({ license: 'CC0', source: 's' }),
    ].map((gate) => (gate.ok ? '' : gate.reason));
    expect(new Set(reasons).size).toBe(3);

    const notAnObject = gateLicense('CC-BY-4.0');
    expect(notAnObject.ok).toBe(false);
  });

  it('rejects an unparseable declaredAt timestamp', () => {
    const gate = gateLicense({ ...VALID_META, declaredAt: 'not-a-date' });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain('declaredAt');
  });

  it('loadVrm refuses before any loader/network access when the license is undeclared', async () => {
    let loaderCalled = false;
    const outcome = await loadVrm('unit.vrm', {}, {
      createLoader: () => {
        loaderCalled = true;
        return { loadAsync: async () => ({ scene: new THREE.Group() }) };
      },
    });

    expect(outcome.ok).toBe(false);
    expect(loaderCalled).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('license');
  });

  it('loadVrm reports asset failure as a rejected outcome without throwing', async () => {
    const outcome = await loadVrm('missing.vrm', VALID_META, {
      createLoader: () => ({ loadAsync: () => Promise.reject(new Error('404')) }),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.startsWith('load-failed')).toBe(true);
  });

  it('loadVrm wraps a loaded glTF into a non-placeholder VrmAvatar', async () => {
    const gltfScene = new THREE.Group();
    gltfScene.name = 'vrm-scene';
    const outcome = await loadVrm('unit.vrm', VALID_META, {
      createLoader: () => ({ loadAsync: async () => ({ scene: gltfScene, userData: {} }) }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.avatar.isPlaceholder).toBe(false);
      expect(outcome.avatar.getRoot()).toBe(gltfScene);
    }
  });

  it('VrmAvatar drives the aa expression, updates and disposes idempotently', () => {
    const setValues: Array<[string, number]> = [];
    const gltfScene = new THREE.Group();
    const avatar = new VrmAvatar(
      {
        scene: gltfScene,
        userData: {
          vrm: {
            expressionManager: {
              setValue: (name: string, value: number) => {
                setValues.push([name, value]);
              },
            },
          },
        },
      },
      'unit.vrm',
    );

    avatar.setMouthOpen(0.7);
    expect(setValues.at(-1)).toEqual(['aa', 0.7]);

    expect(() => {
      avatar.setState('speaking');
      avatar.setGaze(0.3, 0.1);
      avatar.update(0.016);
    }).not.toThrow();

    avatar.dispose();
    avatar.dispose();
    expect(setValues.at(-1)).toEqual(['aa', 0]); // closed after dispose, not stuck open
  });

  it('createDefaultVrmLoader registers a three-vrm plugin on a real GLTFLoader', () => {
    const loader = createDefaultVrmLoader();
    expect(typeof loader.loadAsync).toBe('function');
  });
});
