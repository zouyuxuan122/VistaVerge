<script setup lang="ts">
// EXP-006 记忆面板（查看/搜索/改/删/导出）。
// 可挂载实现位于 src/plugins/views/memoryView.ts；本 SFC 为薄包装。
import { MemoryView } from '../plugins/views/memoryView';
</script>

<template>
  <MemoryView />
</template>
