// Disposal helpers for the scene layer (EXP-004).
//
// dispose() must be idempotent everywhere: geometries / materials / textures
// fire a 'dispose' event exactly once even if the same object is registered
// twice or the group is disposed repeatedly. This is what the "dispose
// idempotent" gate verifies.
import type * as THREE from 'three';

/** Texture slots commonly present on standard/basic materials. */
const TEXTURE_SLOTS = [
  'map',
  'alphaMap',
  'envMap',
  'emissiveMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'specularMap',
  'lightMap',
] as const;

const disposed = new WeakSet<object>();

/**
 * Dispose exactly once across all callers: scene-graph deep disposal and
 * owner-side disposal (e.g. ScreenSurface) share this guard, so a texture
 * reachable through both paths still fires its 'dispose' event once.
 */
export function disposeOnce(target: { dispose(): unknown }): void {
  if (disposed.has(target)) return;
  disposed.add(target);
  target.dispose();
}

/**
 * Deeply dispose every geometry / material / texture under `root` (each object
 * at most once, so repeated calls and shared resources are safe).
 */
export function disposeObject3DDeep(root: THREE.Object3D): void {
  root.traverse((child) => {
    const candidate = child as THREE.Mesh;
    if (candidate.geometry) disposeOnce(candidate.geometry);

    const material = (candidate as THREE.Mesh).material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const single of materials) {
      for (const slot of TEXTURE_SLOTS) {
        const texture = (single as unknown as Record<string, unknown>)[slot] as
          | { dispose(): unknown }
          | undefined;
        if (texture && typeof texture.dispose === 'function') disposeOnce(texture);
      }
      disposeOnce(single);
    }
  });
  root.parent?.remove(root);
}

/** Collects dispose callbacks; running dispose() more than once is a no-op. */
export class DisposableGroup {
  private callbacks: Array<() => void> = [];
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  add(target: { dispose(): unknown } | (() => void)): this {
    if (!this.isDisposed) {
      this.callbacks.push(typeof target === 'function' ? target : () => target.dispose());
    }
    return this;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    const callbacks = this.callbacks;
    this.callbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        // A failing disposer must not mask the others; surface it and move on.
        console.warn('[scene] dispose callback failed:', error);
      }
    }
  }
}
