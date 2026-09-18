<script setup lang="ts">
// 视频数字人层：状态联动的三段素材（原版质感），VRM 真模型接口保留待授权素材。
import { computed, ref, watch } from 'vue';
import { store } from '../app/store';
import idleUrl from '../assets/idle.mp4?url';
import listeningUrl from '../assets/listening.mp4?url';
import speakingUrl from '../assets/speaking.mp4?url';

const SOURCES: Record<string, string> = {
  idle: idleUrl,
  listening: listeningUrl,
  speaking: speakingUrl,
};

const videoEl = ref<HTMLVideoElement | null>(null);
const loadError = ref('');

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
      v-if="!loadError"
      ref="videoEl"
      class="avatar-video"
      :src="SOURCES[state]"
      autoplay
      loop
      muted
      playsinline
      @error="loadError = '视频素材加载失败'"
    />
    <div v-else class="avatar-fallback">{{ loadError }}</div>
    <span class="scene-tag">视频数字人 · VRM 真模型接口就绪，待授权素材</span>
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
