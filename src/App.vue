<script setup>
import { ref } from 'vue'
import SimNav from './components/SimNav.vue'
import ArcBounceSim from './components/ArcBounceSim.vue'
import OrbitHarmonySim from './components/OrbitHarmonySim.vue'
import FanBounceSim from './components/FanBounceSim.vue'
import EllipseSwarmSim from './components/EllipseSwarmSim.vue'

// 页面切换（四个实验页面互斥渲染）
const page = ref('fan')   // 默认进入「V形扇摆」
</script>

<template>
  <div class="app-shell">
    <SimNav :active="page" @select="page = $event" />

    <EllipseSwarmSim v-if="page === 'ellipse'" />
    <FanBounceSim v-else-if="page === 'fan'" />
    <OrbitHarmonySim v-else-if="page === 'orbit'" />
    <ArcBounceSim v-else />
  </div>
</template>

<style>
.app-shell {
  position: relative;
  height: 100dvh;
  overflow: hidden;
}
</style>
