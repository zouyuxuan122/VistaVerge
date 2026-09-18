// Three-point studio lighting rig for the desk scene (EXP-004 step 1).
//
// key / fill / rim directional lights + PCFSoft-capable shadow configuration.
// RoomEnvironment IBL is wired by AvatarScene (it needs the real renderer for
// PMREMGenerator and is skipped on injected fake renderers).
import * as THREE from 'three';

import type { SceneQuality } from './types';
import { DisposableGroup } from './dispose';

export interface LightingRig {
  readonly group: THREE.Group;
  readonly keyLight: THREE.DirectionalLight;
  readonly fillLight: THREE.DirectionalLight;
  readonly rimLight: THREE.DirectionalLight;
  /** low quality turns shadow casting off (renderer shadowMap is handled by the stage). */
  applyQuality(quality: SceneQuality): void;
  dispose(): void;
}

export function createLightingRig(): LightingRig {
  const group = new THREE.Group();
  group.name = 'lighting';

  // Warm key light from the upper right; the only shadow caster.
  const keyLight = new THREE.DirectionalLight(0xfff1de, 2.6);
  keyLight.name = 'light-key';
  keyLight.position.set(1.7, 2.6, 1.9);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 8;
  keyLight.shadow.camera.left = -2.2;
  keyLight.shadow.camera.right = 2.2;
  keyLight.shadow.camera.top = 2.2;
  keyLight.shadow.camera.bottom = -2.2;
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.radius = 4;
  group.add(keyLight);

  // Cool fill from the left softens the key.
  const fillLight = new THREE.DirectionalLight(0x9db8e8, 0.75);
  fillLight.name = 'light-fill';
  fillLight.position.set(-2.1, 1.3, 1.4);
  group.add(fillLight);

  // Rim from behind separates avatar and monitor from the background.
  const rimLight = new THREE.DirectionalLight(0xbfd4ff, 1.1);
  rimLight.name = 'light-rim';
  rimLight.position.set(-0.4, 2.0, -2.3);
  group.add(rimLight);

  const disposables = new DisposableGroup();

  return {
    group,
    keyLight,
    fillLight,
    rimLight,
    applyQuality(quality: SceneQuality) {
      const shadowsOn = quality === 'high';
      keyLight.castShadow = shadowsOn;
      const size = shadowsOn ? 2048 : 512;
      if (keyLight.shadow.mapSize.x !== size) {
        // three 只在 shadow.map === null 时按 mapSize 分配贴图；
        // 首帧后改 mapSize 是空操作，必须先释放旧 map，否则质量切换不生效。
        keyLight.shadow.map?.dispose();
        keyLight.shadow.map = null;
        keyLight.shadow.mapSize.set(size, size);
      }
    },
    dispose() {
      disposables.dispose();
      group.parent?.remove(group);
    },
  };
}
