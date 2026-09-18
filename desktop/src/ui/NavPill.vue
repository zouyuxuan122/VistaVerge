<script setup lang="ts">
import type { NavTarget } from '../app/store';

const props = defineProps<{ current: NavTarget }>();
const emit = defineEmits<{ select: [NavTarget] }>();

const items: { id: NavTarget; label: string; glyph: string }[] = [
  { id: 'chat', label: '对话', glyph: '💬' },
  { id: 'study', label: '学习', glyph: '📖' },
  { id: 'tasks', label: '任务', glyph: '🛠' },
  { id: 'plugins', label: '插件', glyph: '🧩' },
  { id: 'settings', label: '设置', glyph: '⚙' },
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
      <span class="glyph" aria-hidden="true">{{ item.glyph }}</span>{{ item.label }}
    </button>
  </nav>
</template>
