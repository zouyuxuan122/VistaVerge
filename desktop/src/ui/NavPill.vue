<script setup lang="ts">
import type { NavTarget } from '../app/store';

const props = defineProps<{ current: NavTarget }>();
const emit = defineEmits<{ select: [NavTarget] }>();

// 内联 SVG 油墨图标（G-UI-10）：替代 emoji，线条随 currentColor，双主题都能上色。
const items: { id: NavTarget; label: string; icon: string }[] = [
  { id: 'chat', label: '对话', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  { id: 'study', label: '学习', icon: '<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>' },
  { id: 'tasks', label: '任务', icon: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>' },
  { id: 'plugins', label: '插件', icon: '<path d="M10 3a2 2 0 0 1 4 0v1h3a2 2 0 0 1 2 2v3h1a2 2 0 0 1 0 4h-1v3a2 2 0 0 1-2 2h-3v1a2 2 0 0 1-4 0v-1H7a2 2 0 0 1-2-2v-3H4a2 2 0 0 1 0-4h1V6a2 2 0 0 1 2-2h3z"/>' },
  { id: 'settings', label: '设置', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>' },
];

function onKeydown(e: KeyboardEvent) {
  const i = items.findIndex((it) => it.id === props.current);
  if (e.key === 'ArrowRight') emit('select', items[(i + 1) % items.length].id);
  if (e.key === 'ArrowLeft') emit('select', items[(i - 1 + items.length) % items.length].id);
}
</script>

<template>
  <nav class="nav-pill" aria-label="主导航" @keydown="onKeydown">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      :aria-current="current === item.id ? 'page' : undefined"
      @click="emit('select', item.id)"
    >
      <svg
        class="glyph"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        v-html="item.icon"
      />{{ item.label }}
    </button>
  </nav>
</template>
