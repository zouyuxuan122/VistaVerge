<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';

const stream = ref<MediaStream | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
const status = ref<'idle' | 'active' | 'denied' | 'unsupported'>('idle');
const message = ref('');

async function start() {
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c?: object) => Promise<MediaStream> };
  if (!md?.getDisplayMedia) {
    status.value = 'unsupported';
    message.value = '当前环境不支持屏幕采集（Tauri WebView2 需系统授权，浏览器需 HTTPS/localhost）';
    return;
  }
  try {
    const next = await md.getDisplayMedia({ video: true, audio: false });
    stream.value = next;
    status.value = 'active';
    // v-if 翻转后 <video> 要到下一次 DOM 刷新才存在；
    // 不 await nextTick 的话 videoEl 仍是 null，画面永远不显示（功能等于不可用）。
    await nextTick();
    if (videoEl.value) {
      videoEl.value.srcObject = next;
      await videoEl.value.play().catch(() => {
        /* 自动播放被拒：muted+autoplay 一般可播，失败时画面仍会在用户交互后出现 */
      });
    }
    next.getVideoTracks()[0]?.addEventListener('ended', stop);
  } catch {
    status.value = 'denied';
    message.value = '已取消或被系统拒绝授权';
  }
}

function stop() {
  for (const track of stream.value?.getTracks() ?? []) track.stop();
  stream.value = null;
  status.value = 'idle';
}

onBeforeUnmount(stop);
</script>

<template>
  <div class="pane-scroll">
    <span class="readonly-tag">
      <svg class="ro-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
      只读镜像 · 画面不可操作，不作为 AI 执行平面
    </span>
    <div class="mirror-stage" :class="{ 'is-live': !!stream }">
      <!-- 只读语义视觉化：扫描线 + 水印（图标 + 文案，不依赖颜色） -->
      <span class="mirror-scanlines" aria-hidden="true" />
      <span class="mirror-watermark" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
        只读镜像 · 不可操作
      </span>
      <video v-if="stream" ref="videoEl" autoplay muted playsinline />
      <div v-else class="placeholder">
        {{ message || '这里显示你授权共享的屏幕/窗口画面。' }}<br />
        <button class="btn" style="margin-top:14px" @click="start">选择要共享的画面</button>
      </div>
    </div>
    <div style="margin-top:10px" v-if="stream">
      <button class="btn danger" @click="stop">停止共享</button>
    </div>
  </div>
</template>
