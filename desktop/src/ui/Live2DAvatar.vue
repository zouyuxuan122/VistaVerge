<script setup lang="ts">
// Live2D 数字人。模型是用户自备素材（授权禁分发），来源有两档：
// 1. 内置：本地构建把模型放 desktop/public/live2d/（开发/自用构建）；
// 2. 导入：安装版用户在设置里选模型文件夹，文件写入 应用数据/live2d/imported/，
//    经 Tauri asset 协议（scope 限定该目录）加载。
// 能力：状态联动、模型表情/动作、音频近似口型（非 viseme，已标注）、面向用户。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as PIXI from 'pixi.js';
import { store } from '../app/store';
import { LIVE2D_MODEL_BUNDLED } from '../app/avatarDefaults';
import { loadImportedManifest, isTauriAvailable, type ImportResult } from '../platform/live2dImport';
import { registerAvatarController } from '../app/avatarBridge';

// pixi-live2d-display/cubism4 在模块求值时要求 Live2DCubismCore 全局已存在，
// 静态导入会让整个应用白屏；必须在加载本地 core 后再动态导入。
type Live2DModelType = import('pixi-live2d-display/cubism4').Live2DModel;

(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

const BUNDLED_MODEL_URL = '/live2d/fense/fense.model3.json';
const BUNDLED_CORE_URL = '/live2d/lib/live2dcubismcore.min.js';

/** 发行版（无内置模型）的默认提示：告诉用户两条可行路径，而不是一句报错。 */
const NOT_BUNDLED_HINT =
  '本安装包不含 Live2D 模型（授权禁分发）。已默认使用视频数字人；想要 Live2D 可在 设置 → 数字人形象 里导入模型文件夹。';

interface ResolvedSources {
  modelUrl: string;
  coreUrl: string | null;
}

/** 解析模型与 Cubism Core 的加载地址（内置 → 静态路径；导入 → asset 协议）。 */
async function resolveSources(): Promise<ResolvedSources | null> {
  if (LIVE2D_MODEL_BUNDLED) {
    return { modelUrl: BUNDLED_MODEL_URL, coreUrl: BUNDLED_CORE_URL };
  }
  const manifest: ImportResult | null = loadImportedManifest();
  if (!manifest || !isTauriAvailable()) return null;
  const { appDataDir } = await import('@tauri-apps/api/path');
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const root = await appDataDir();
  const base = root.replace(/[/\\]+$/, '');
  const toUrl = (rel: string): string =>
    convertFileSrc(`${base}/live2d/imported/${rel.replace(/\\/g, '/')}`);
  return {
    modelUrl: toUrl(manifest.modelPath),
    coreUrl: manifest.corePath ? toUrl(manifest.corePath) : null,
  };
}

const hostEl = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const loadError = ref(LIVE2D_MODEL_BUNDLED ? '' : NOT_BUNDLED_HINT);

let app: PIXI.Application | null = null;
let model: Live2DModelType | null = null;
let mouthLevel = 0;
let disposed = false;

const EXPRESSION_MAP: Record<string, string | null> = {
  neutral: null,
  happy: 'lianhong',
  shy: 'lianhong',
  sad: 'kuku',
  surprised: 'heilian',
  thinking: 'heilian',
};
const ACTION_MAP: Record<string, string | null> = {
  surprised: 'jingya',
  happy: 'kaixin',
  angry: 'shengqi',
  sleepy: 'shuijiao',
  wave: 'wink',
  nod: 'kaixin',
  shake: 'yaotou',
  tilt: 'jingya',
};

let corePromise: Promise<void> | null = null;
function loadCubismCore(coreUrl: string): Promise<void> {
  corePromise ??= new Promise<void>((resolve, reject) => {
    if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) return resolve();
    const script = document.createElement('script');
    script.src = coreUrl;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Cubism Core 加载失败（模型文件夹里缺少 live2dcubismcore.min.js？）'));
    document.head.appendChild(script);
  });
  return corePromise;
}

function fitModel() {
  if (!app || !model || !hostEl.value) return;
  const w = hostEl.value.clientWidth || 1;
  const h = hostEl.value.clientHeight || 1;
  // 上半身取景：头至腰胯占据画面主体；人物贴右（左缘 mask 淡入背景，构图要点来自最初前端）
  const scale = (h * 2.15) / model.height;
  model.scale.set(scale);
  model.anchor.set(0.5, 0.08);
  model.x = w * 0.62;
  model.y = h * 0.04;
}

function playStateMotion(state: string) {
  if (!model) return;
  const target = state === 'listening' ? 'wink' : state === 'working' ? 'kaixin' : null;
  if (!target) return;
  // pixi-live2d-display 在动作组缺失时是 reject 而不是 throw：
  // fire-and-forget 会产生未处理拒绝（用户自备模型的动作组名不保证存在）。
  safeMotion(target);
}

/** 动作/表情一律走这里：缺失时静默忽略，不产生未处理拒绝。 */
function safeMotion(name: string): void {
  if (!model) return;
  void Promise.resolve(model.motion(name)).catch(() => {});
}

function safeExpression(name?: string): void {
  if (!model) return;
  void Promise.resolve(name === undefined ? model.expression() : model.expression(name)).catch(() => {});
}

function setMouth(v: number) {
  mouthLevel = Math.max(0, Math.min(1, v));
}

onMounted(async () => {
  // 解析加载来源：内置模型 → 静态路径；无内置但用户导入过 → asset 协议。
  // 两者都没有就停在诚实提示上，不发起任何请求（避免控制台 404 噪音）。
  let sources: ResolvedSources | null;
  try {
    sources = await resolveSources();
  } catch (err) {
    if (!disposed) loadError.value = `模型加载地址解析失败：${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (!sources) return; // 发行版且未导入模型：保持默认提示
  try {
    if (!sources.coreUrl) {
      loadError.value =
        '已导入 Live2D 模型，但文件夹里没有 Cubism Core（live2dcubismcore.min.js）。' +
        '请从 Live2D 官网下载 Cubism SDK for Web，把其中的 live2dcubismcore.min.js 一起放进模型文件夹后重新导入。';
      return;
    }
    await loadCubismCore(sources.coreUrl);
    if (!canvasEl.value || !hostEl.value || disposed) return;
    app = new PIXI.Application({
      view: canvasEl.value,
      backgroundAlpha: 0,
      resizeTo: hostEl.value,
      antialias: true,
    });
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    const created = await Live2DModel.from(sources.modelUrl, { autoInteract: false });
    if (disposed) {
      // 卸载早于模型加载完成：必须释放刚建出来的 model 与 app，否则两者都泄漏。
      created.destroy();
      app?.destroy(true, { children: true, texture: true });
      app = null;
      return;
    }
    model = created;
    app.stage.addChild(model as unknown as PIXI.DisplayObject);
    // pixi-live2d-display@0.4.0 内嵌 @pixi/display@6.5.10：模型原型链来自 v6，
    // v7 EventBoundary 遍历到它会调 isInteractive()（v7 mixin）而抛 TypeError。
    // 本画布无交互需求（视线只走指令协议），把模型整棵子树剪出事件系统。
    const eventInert = model as unknown as {
      eventMode: string;
      interactiveChildren: boolean;
      isInteractive?: () => boolean;
    };
    eventInert.eventMode = 'none';
    eventInert.interactiveChildren = false;
    eventInert.isInteractive ??= () => false;
    fitModel();
    playStateMotion(store.sceneState);

    app.ticker.add(() => {
      if (!model) return;
      const core = model.internalModel.coreModel as unknown as {
        setParameterValueById(id: string, value: number): void;
      };
      const speaking = store.sceneState === 'speaking';
      const target = speaking ? Math.abs(Math.sin(performance.now() / 130)) * (0.35 + mouthLevel * 0.65) : 0;
      core.setParameterValueById('ParamMouthOpenY', target);
      // 视线轻微追随用户指针（面向用户的陪伴感）
      const g = store.avatarGaze;
      core.setParameterValueById('ParamAngleX', g.x * 12);
      core.setParameterValueById('ParamAngleY', g.y * 8);
    });

    const controller = {
      setExpression(name: string) {
        safeExpression(EXPRESSION_MAP[name] ?? undefined);
        const motion = ACTION_MAP[name];
        if (motion) safeMotion(motion);
      },
      playAction(name: string) {
        const motion = ACTION_MAP[name];
        if (motion) safeMotion(motion);
      },
      setFacing() { /* Live2D 默认面向用户 */ },
      setGaze(x: number, y: number) { store.avatarGaze = { x, y }; },
      // 回放电平 → 开口度（近似口型，ticker 里按 mouthLevel 缩放振幅）
      setMouth(level: number) { setMouth(level); },
    };
    registerAvatarController(controller);
    // 开发期验证钩子：GUI/e2e 用，非产品 API（不写入文档即不承诺）
    (window as unknown as { __vvAvatar?: typeof controller }).__vvAvatar = controller;
  } catch (err) {
    // 初始化失败时不要把已建的 app 留在运行中（会持续占用 RAF 与 WebGL 上下文）
    try {
      app?.destroy(true, { children: true, texture: true });
    } catch { /* 销毁失败不覆盖原始错误 */ }
    app = null;
    model = null;
    if (!disposed) loadError.value = err instanceof Error ? err.message : String(err);
  }
});

watch(
  () => store.sceneState,
  (next, prev) => {
    if (next !== prev) playStateMotion(next);
    // 操作时视线落向膝上笔记本，其余时刻回到用户；指令协议仍可随时覆盖
    store.avatarGaze = next === 'working' ? { x: 0.06, y: -0.5 } : { x: 0, y: 0 };
  },
);

onBeforeUnmount(() => {
  disposed = true;
  registerAvatarController(null);
  try {
    model?.destroy();
  } catch { /* 已销毁 */ }
  model = null;
  // texture:true —— 之前跳过贴图释放，每次切换形象都会留下模型贴图。
  try {
    app?.destroy(true, { children: true, texture: true });
  } catch { /* 已销毁 */ }
  app = null;
});
</script>

<template>
  <section ref="hostEl" class="scene-pane avatar-pane" aria-label="数字伙伴（Live2D）">
    <canvas v-if="!loadError" ref="canvasEl" class="avatar-canvas" />
    <div v-else class="avatar-fallback">
      Live2D 模型不可用：{{ loadError }}<br />
      <small>把 fense 模型放入 desktop/public/live2d/ 后重启</small>
    </div>
    <span class="scene-tag">Live2D · 阿芙洛狄忒（用户自备）· 口型为音频近似</span>
  </section>
</template>

<style scoped>
.avatar-pane { background: transparent; }
.avatar-canvas {
  position: absolute;
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  display: block;
}
.avatar-fallback {
  height: 100%;
  display: grid;
  place-items: center;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  line-height: 2;
  padding: 20px;
}
</style>
