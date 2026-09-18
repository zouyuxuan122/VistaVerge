<script setup lang="ts">
// EXP-006 插件市场面板。
// 可挂载实现位于 src/plugins/views/marketView.ts（本仓库 vitest 配置未含 Vue SFC
// 插件，组件逻辑在 .ts 中以 @vue/test-utils 测试）；本 SFC 为应用内薄包装，
// 依赖经 props 注入，不假定 App 结构。
import { MarketView } from '../plugins/views/marketView';
</script>

<template>
  <MarketView />
</template>
