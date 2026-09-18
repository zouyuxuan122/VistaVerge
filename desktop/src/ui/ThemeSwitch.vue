<script setup lang="ts">
import type { ThemeName } from '../app/store';

defineProps<{ modelValue: ThemeName }>();
const emit = defineEmits<{ 'update:modelValue': [ThemeName] }>();
</script>

<template>
  <div class="theme-switch" role="group" aria-label="界面风格">
    <button
      type="button"
      :aria-pressed="modelValue === 'realistic'"
      @click="emit('update:modelValue', 'realistic')"
    >写实</button>
    <button
      type="button"
      :aria-pressed="modelValue === 'handdrawn'"
      @click="emit('update:modelValue', 'handdrawn')"
    >手绘</button>
  </div>
</template>
