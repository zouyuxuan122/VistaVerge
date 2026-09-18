// VRM avatar adapter + license gate (EXP-004, UI_UX_AVATAR §1.3(1), §2, §3(5)).
//
// Contract:
//  - The default character must be a legally sourced real VRM; a placeholder
//    may never masquerade as a loaded model.
//  - `loadVrm(url, licenseMeta)` validates the license declaration BEFORE any
//    network access; an undeclared license or a missing/corrupt asset is
//    rejected and the caller keeps the placeholder (isPlaceholder unchanged).
//  - License fields are mandatory: license name, source, declaration time.
//
// Real VRM assets are BLOCKED (no licensed material in the workspace); this
// module only implements and tests the adapter + gate contract.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as THREE from 'three';

import { disposeObject3DDeep } from './dispose';
import type { AvatarRenderer, AvatarState } from './types';
import { clamp01 } from './types';

// ── License gate ─────────────────────────────────────────────────────────────

/** Mandatory import declaration (UI_UX_AVATAR §3(5): 来源、许可名、用户声明时间). */
export interface VrmLicenseMeta {
  license: string;
  source: string;
  declaredAt: string;
  author?: string;
  notes?: string;
}

export type LicenseGate =
  | { ok: true; meta: VrmLicenseMeta }
  | { ok: false; reason: string };

function requiredString(meta: Record<string, unknown>, field: keyof VrmLicenseMeta): string | null {
  const value = meta[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function gateLicense(meta: unknown): LicenseGate {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { ok: false, reason: 'license-not-an-object' };
  }
  const record = meta as Record<string, unknown>;

  const license = requiredString(record, 'license');
  if (!license) return { ok: false, reason: 'missing-license' };
  const source = requiredString(record, 'source');
  if (!source) return { ok: false, reason: 'missing-source' };
  const declaredAt = requiredString(record, 'declaredAt');
  if (!declaredAt) return { ok: false, reason: 'missing-declaredAt' };
  if (Number.isNaN(Date.parse(declaredAt))) {
    return { ok: false, reason: 'invalid-declaredAt' };
  }

  return {
    ok: true,
    meta: {
      license,
      source,
      declaredAt,
      author: typeof record.author === 'string' ? record.author : undefined,
      notes: typeof record.notes === 'string' ? record.notes : undefined,
    },
  };
}

// ── Loader abstraction ───────────────────────────────────────────────────────

/** Loose structural view of a glTF result with a registered VRM plugin. */
export interface VrmGltfLike {
  scene: THREE.Group;
  animations?: unknown[];
  userData?: Record<string, unknown>;
}

/** Loose structural view of the parts of VRM the placeholder stage needs. */
interface VrmRuntime {
  scene?: THREE.Object3D;
  update?(dtSeconds: number): void;
  expressionManager?: {
    setValue?(name: string, value: number): unknown;
  };
}

export interface VrmLoaderLike {
  loadAsync(url: string): Promise<VrmGltfLike>;
}

export function createDefaultVrmLoader(): VrmLoaderLike {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return {
    loadAsync: (url: string) => loader.loadAsync(url) as Promise<VrmGltfLike>,
  };
}

export interface LoadVrmOptions {
  /** Loader factory; injected in tests so no network access happens. */
  createLoader?: () => VrmLoaderLike;
}

export type LoadVrmOutcome =
  | { ok: true; avatar: VrmAvatar; meta: VrmLicenseMeta }
  | { ok: false; reason: string };

/**
 * Load a VRM behind the license gate. Order is load-bearing: the gate runs
 * before any loader is created, so an undeclared import never touches the
 * network or the filesystem.
 */
export async function loadVrm(
  url: string,
  licenseMeta: unknown,
  options: LoadVrmOptions = {},
): Promise<LoadVrmOutcome> {
  const gate = gateLicense(licenseMeta);
  if (!gate.ok) {
    return { ok: false, reason: `license-rejected: ${gate.reason}` };
  }
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { ok: false, reason: 'missing-url' };
  }

  const loader = options.createLoader?.() ?? createDefaultVrmLoader();
  try {
    const gltf = await loader.loadAsync(url);
    return { ok: true, avatar: new VrmAvatar(gltf, url), meta: gate.meta };
  } catch (error) {
    return { ok: false, reason: `load-failed: ${String(error)}` };
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * AvatarRenderer over a loaded VRM. Layer binding is intentionally minimal:
 * mouth drives the `aa` expression when an expression manager exists, update
 * ticks the VRM springbones/expressions. Skeletal layer tuning (viseme map,
 * IK, expression presets) is an art acceptance item once a licensed asset
 * exists (BLOCKED).
 */
export class VrmAvatar implements AvatarRenderer {
  readonly isPlaceholder = false;

  private readonly gltfScene: THREE.Group;
  private readonly sourceUrl: string;
  private readonly vrm: VrmRuntime | undefined;
  private currentState: AvatarState = 'idle';
  private mouthTarget = 0;
  private disposed = false;

  constructor(gltf: VrmGltfLike, sourceUrl: string) {
    this.gltfScene = gltf.scene;
    this.sourceUrl = sourceUrl;
    this.vrm = gltf.userData?.['vrm'] as VrmRuntime | undefined;
  }

  getRoot(): THREE.Object3D {
    return this.gltfScene;
  }

  get state(): AvatarState {
    return this.currentState;
  }

  /** URL the model was loaded from (provenance debugging). */
  get source(): string {
    return this.sourceUrl;
  }

  setState(state: AvatarState): void {
    this.currentState = state;
  }

  setMouthOpen(value: number): void {
    this.mouthTarget = clamp01(value);
    const manager = this.vrm?.expressionManager;
    manager?.setValue?.('aa', this.mouthTarget);
  }

  setGaze(_x: number, _y: number): void {
    // Bone-level gaze binding requires a licensed asset to tune (BLOCKED).
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;
    this.vrm?.update?.(dtSeconds);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Close the mouth so a disposed avatar never stays frozen open.
    this.vrm?.expressionManager?.setValue?.('aa', 0);
    disposeObject3DDeep(this.gltfScene);
  }
}
