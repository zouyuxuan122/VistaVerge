<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store } from '../app/store';
import { registerAvatarController } from '../app/avatarBridge';
import { AvatarScene } from '../scene/AvatarScene';

const canvasEl = ref<HTMLCanvasElement | null>(null);
const sceneError = ref('');
let scene: AvatarScene | null = null;
// 最近一次回放电平：控制器注册时可能还没收到过事件，先留住。
let mouthLevel = 0;

onMounted(() => {
  if (!canvasEl.value) return;
  try {
    scene = new AvatarScene(canvasEl.value);
    scene.resize();
    scene.start();
    scene.setState(store.sceneState);
    registerAvatarController({
      setExpression: (n) => scene?.applyExpression(n),
      playAction: (n) => scene?.playAction(n),
      setFacing: (m) => scene?.setFacing(m),
      setGaze: (x, y) => scene?.setGaze(x, y),
      // 音频近似口型：把回放电平接到场景的音频时钟（RMS → 开口度，非 viseme）
      setMouth: (level) => {
        mouthLevel = level;
        scene?.setAudioClock(() => mouthLevel);
      },
    });
    if (mouthLevel > 0) scene.setAudioClock(() => mouthLevel);
  } catch (err) {
    sceneError.value = err instanceof Error ? err.message : String(err);
  }
});

watch(
  () => store.sceneState,
  (next) => scene?.setState(next),
);

onBeforeUnmount(() => {
  registerAvatarController(null);
  scene?.dispose();
  scene = null;
});
</script>

<template>
  <section class="scene-pane" aria-label="角色与桌面场景">
    <canvas v-if="!sceneError" ref="canvasEl" data-testid="scene-canvas" />
    <div v-else class="boot-screen" style="background:transparent">
      <div class="err" style="padding:24px">三维场景不可用：{{ sceneError }}</div>
    </div>
    <span class="scene-tag">程序化占位形象 · 导入授权 VRM 后可替换</span>
  </section>
</template>
