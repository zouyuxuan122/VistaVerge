<script setup lang="ts">
// 视频数字人层：状态联动的三段素材（原版质感），VRM 真模型接口保留待授权素材。
//
// 素材在 src/assets/*.mp4，属用户自备、不入库（.gitignore）。因此不能用静态 import
// ——新 clone 的仓库里没有这些文件，构建会直接失败。用 import.meta.glob 惰性解析：
// 素材在 → 正常渲染；素材缺 → 诚实显示「缺素材」，构建仍可通过。
import { computed, ref, watch } from 'vue';
import { store } from '../app/store';

const videoModules = import.meta.glob('../assets/*.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const pickVideo = (name: string): string | null => {
  const hit = Object.entries(videoModules).find(([path]) => path.endsWith(`/${name}.mp4`));
  return hit ? hit[1] : null;
};

const SOURCES: Record<string, string | null> = {
  idle: pickVideo('idle'),
  listening: pickVideo('listening'),
  speaking: pickVideo('speaking'),
};

/** 三个素材齐全才可用；缺任何一个都按缺素材处理（不播一半）。 */
const available = Object.values(SOURCES).every((url) => typeof url === 'string');

const videoEl = ref<HTMLVideoElement | null>(null);
const loadError = ref(available ? '' : '视频素材缺失：把 idle/listening/speaking.mp4 放入 desktop/src/assets/ 后重新构建');

const state = computed(() => {
  switch (store.sceneState) {
    case 'listening':
      return 'listening';
    case 'speaking':
    case 'working':
      return 'speaking';
    default:
      return 'idle';
  }
});

watch(
  state,
  (next) => {
    const el = videoEl.value;
    if (!el) return;
    const url = SOURCES[next];
    if (typeof url !== 'string') return;
    if (el.dataset.state !== next) {
      el.dataset.state = next;
      el.src = url;
      el.play().catch(() => {});
    }
  },
  { immediate: true },
);
</script>

<template>
  <section class="scene-pane avatar-pane" aria-label="数字伙伴">
    <video
      v-if="available && !loadError"
      ref="videoEl"
      class="avatar-video"
      :src="SOURCES[state] ?? undefined"
      autoplay
      loop
      muted
      playsinline
      @error="loadError = '视频素材加载失败'"
    />
    <div v-else class="avatar-fallback">{{ loadError }}</div>
    <span class="scene-tag">视频数字人 · 素材用户自备 · 不可表情控制</span>
  </section>
</template>

<style scoped>
.avatar-pane {
  background: transparent;
}
.avatar-video {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: auto;
  max-width: none;
  object-fit: cover;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 26%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 26%);
  filter: saturate(1.04);
}
.avatar-fallback {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 13px;
}
</style>
