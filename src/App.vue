<script setup>
import { ref } from 'vue'
import ArcBounceSim from './components/ArcBounceSim.vue'
import OrbitHarmonySim from './components/OrbitHarmonySim.vue'

// 页面切换（两个实验页面互斥渲染）
const page = ref('orbit')
</script>

<template>
  <div class="app-shell">
    <nav class="page-switch">
      <button
        class="ps-btn"
        :class="{ on: page === 'orbit' }"
        @click="page = 'orbit'"
        title="圆形轨道 · 12 个变速点 · 经过原点奏响音阶（新增页）"
      >
        <i class="orb"></i>圆轨音阶
      </button>
      <button
        class="ps-btn"
        :class="{ on: page === 'arc' }"
        @click="page = 'arc'"
        title="半圆往返 · 弹性反弹 · 音阶碰撞"
      >
        <i class="arc"></i>半圆弹跳
      </button>
    </nav>
    <OrbitHarmonySim v-if="page === 'orbit'" />
    <ArcBounceSim v-else />
  </div>
</template>

<style>
.app-shell {
  position: relative;
  height: 100dvh;
  overflow: hidden;
}

/* 顶部居中的页面切换器（悬浮于各页信息条之上） */
.page-switch {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.16));
  background: rgba(8, 13, 26, 0.72);
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 18px rgba(2, 6, 23, 0.45);
  max-width: calc(100vw - 20px);
}
.ps-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-2, #94a3b8);
  font-size: 12px;
  line-height: 1;
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.16s ease;
}
.ps-btn:hover {
  color: #e2e8f0;
}
.ps-btn.on {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.35), rgba(34, 211, 238, 0.2));
  color: #e0f2fe;
  font-weight: 600;
}
.ps-btn i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.ps-btn .orb {
  background: conic-gradient(#f43f5e, #fb923c, #facc15, #4ade80, #22d3ee, #818cf8, #e879f9, #f43f5e);
  border-radius: 50%;
}
.ps-btn .arc {
  background: linear-gradient(90deg, #38bdf8, #22d3ee);
  border-radius: 50%;
}

@media (max-width: 760px) {
  .page-switch {
    top: 6px;
    left: auto;
    right: 8px;
    transform: none;
  }
}
</style>
