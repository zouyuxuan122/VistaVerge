<script setup lang="ts">
// ui/teacher/SlideSurface.vue — 单页幻灯片 DOM 渲染（文本框绝对定位 + 图片）。
// 纯展示组件：不做缩放，尺寸即幻灯片原始 px；外层负责 transform 缩放。
import type { Slide } from '../../teacher/pptx';

defineProps<{
  slide: Slide | null;
  widthPx: number;
  heightPx: number;
}>();
</script>

<template>
  <div class="slide-surface" :style="{ width: `${widthPx}px`, height: `${heightPx}px` }">
    <template v-if="slide">
      <img
        v-for="image in slide.images"
        :key="image.id"
        v-show="image.url"
        class="slide-image"
        :src="image.url ?? undefined"
        :alt="image.name || '幻灯片图片'"
        :style="{ left: `${image.x}px`, top: `${image.y}px`, width: `${image.width}px`, height: `${image.height}px` }"
      />
      <div
        v-for="box in slide.texts"
        :key="box.id"
        class="slide-text-box"
        :style="{
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: `${box.width}px`,
          minHeight: `${box.height}px`,
        }"
      >
        <p
          v-for="(paragraph, index) in box.paragraphs"
          :key="index"
          class="slide-paragraph"
          :class="`lvl-${Math.min(paragraph.level, 3)}`"
        >{{ paragraph.text }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.slide-surface {
  position: relative;
  background: var(--panel-solid);
  color: var(--text);
  overflow: hidden;
}
.slide-image {
  position: absolute;
  object-fit: contain;
}
.slide-text-box {
  position: absolute;
  padding: 2px 4px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.slide-paragraph {
  margin: 0 0 4px;
  font-size: 18px;
}
.slide-paragraph.lvl-1 { font-size: 15px; padding-left: 14px; color: var(--muted); }
.slide-paragraph.lvl-2 { font-size: 13px; padding-left: 28px; color: var(--muted); }
.slide-paragraph.lvl-3 { font-size: 12px; padding-left: 42px; color: var(--faint); }
</style>
