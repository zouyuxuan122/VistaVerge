// Public surface of the scene layer (EXP-004). EXP-005's main UI imports the
// stage from here; the module graph stays acyclic (AvatarScene.ts imports the
// concrete modules directly, this barrel is export-only).
export { AvatarScene, RMS_MOUTH_GAIN, AUDIO_MOUTH_IS_NOT_VISEME } from './AvatarScene';
export type { SceneQuality } from './types';
export { buildComputerScene, DESK, MONITOR, SCREEN, KEYBOARD, MOUSE } from './computer';
export type { ComputerScene, ComputerDimensions, ComputerSceneOptions } from './computer';
export {
  PlaceholderAvatar,
  SEATED_POSE,
  BLINK_INTERVAL_MS,
  BLINK_DURATION_MS,
} from './avatar';
export {
  VrmAvatar,
  gateLicense,
  loadVrm,
  createDefaultVrmLoader,
} from './vrmAvatar';
export type {
  VrmLicenseMeta,
  LicenseGate,
  LoadVrmOptions,
  LoadVrmOutcome,
  VrmGltfLike,
  VrmLoaderLike,
} from './vrmAvatar';
export { ScreenSurface, createScreenCanvas } from './screen';
export type { ScreenCanvasLike, ScreenContext2DLike, ScreenStatus } from './screen';
export { createLightingRig } from './lights';
export type { LightingRig } from './lights';
export { DisposableGroup, disposeObject3DDeep } from './dispose';
export {
  AVATAR_STATES,
  clamp01,
  isAvatarState,
} from './types';
export type {
  AvatarRenderer,
  AvatarSceneOptions,
  AvatarState,
  PlaceholderAvatarOptions,
  SceneRendererLike,
} from './types';
