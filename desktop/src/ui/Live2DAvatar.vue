<script setup lang="ts">
// Live2D 数字人（用户自备模型 fense/阿芙洛狄忒，授权：灵境Sanctuary 免费使用、禁二改/售卖）。
// 能力：状态联动、模型表情/动作、音频近似口型（非 viseme，已标注）、面向用户。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as PIXI from 'pixi.js';
import { store } from '../app/store';
import { registerAvatarController } from '../app/avatarBridge';

// pixi-live2d-display/cubism4 在模块求值时要求 Live2DCubismCore 全局已存在，
// 静态导入会让整个应用白屏；必须在加载本地 core 后再动态导入。
type Live2DModelType = import('pixi-live2d-display/cubism4').Live2DModel;

(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

const MODEL_URL = '/live2d/fense/fense.model3.json';
const CORE_URL = '/live2d/lib/live2dcubismcore.min.js';

/**
 * 发行产物不含 Live2D 模型（授权禁分发，模型由用户自备）。
 * 构建期常量告诉我们这次产物里有没有模型：没有就直接走诚实回退，
 * 不去请求不存在的文件——否则控制台会留下一条 404，看起来像功能坏了。
 */
const MODEL_BUNDLED = typeof __VV_LIVE2D_BUNDLED__ === 'undefined' ? true : __VV_LIVE2D_BUNDLED__;
const NOT_BUNDLED_HINT = '本发行版不含 Live2D 模型（授权禁分发）：请自备模型放入 desktop/public/live2d/ 后重新构建';

const hostEl = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const loadError = ref(MODEL_BUNDLED ? '' : NOT_BUNDLED_HINT);

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
function loadCubismCore(): Promise<void> {
  corePromise ??= new Promise<void>((resolve, reject) => {
    if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) return resolve();
    const script = document.createElement('script');
    script.src = CORE_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Cubism Core 加载失败（本地文件缺失？）'));
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
  if (!MODEL_BUNDLED) return; // 发行版：直接展示回退文案，不发起任何请求
  try {
    await loadCubismCore();
    if (!canvasEl.value || !hostEl.value || disposed) return;
    app = new PIXI.Application({
      view: canvasEl.value,
      backgroundAlpha: 0,
      resizeTo: hostEl.value,
      antialias: true,
    });
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    const created = await Live2DModel.from(MODEL_URL, { autoInteract: false });
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
