<script setup lang="ts">
defineProps<{ title: string; text: string }>();
</script>

<template>
  <div class="stub-panel">
    <h3>{{ title }}</h3>
    <span class="blocked-tag">集成中</span>
    <p>{{ text }}</p>
  </div>
</template>
