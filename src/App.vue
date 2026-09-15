<script setup>
import { RouterView } from 'vue-router'
import SimNav from './components/SimNav.vue'
</script>

<template>
  <div class="app-shell">
    <SimNav />

    <!-- 每个 tab 对应一个路由页面，切换即销毁/重建（各实验自带动画循环与音频上下文） -->
    <RouterView />
  </div>
</template>

<style>
.app-shell {
  position: relative;
  height: 100dvh;
  overflow: hidden;
}
</style>
