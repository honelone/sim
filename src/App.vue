<script setup>
import { ref } from 'vue'
import ArcBounceSim from './components/ArcBounceSim.vue'
import OrbitHarmonySim from './components/OrbitHarmonySim.vue'
import FanBounceSim from './components/FanBounceSim.vue'
import EllipseSwarmSim from './components/EllipseSwarmSim.vue'

// 页面切换（四个实验页面互斥渲染）
const page = ref('ellipse')
</script>

<template>
  <div class="app-shell">
    <nav class="page-switch">
      <button
        class="ps-btn"
        :class="{ on: page === 'fan' }"
        @click="page = 'fan'"
        title="V 形夹角 135° · 30 层彩虹弧摆 · 撞线奏音阶（新增页）"
      >
        <i class="fan"></i>V形扇摆
      </button>
      <button
        class="ps-btn"
        :class="{ on: page === 'ellipse' }"
        @click="page = 'ellipse'"
        title="椭圆轨道 · 145 个点分 10 层 · 层层发散撞轨反弹 · 90s 全部回归原点并奏响音阶（新增页）"
      >
        <i class="ell"></i>层叠发散
      </button>
      <button
        class="ps-btn"
        :class="{ on: page === 'orbit' }"
        @click="page = 'orbit'"
        title="圆形轨道 · 12 个变速点 · 经过原点奏响音阶"
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

/* 顶部居中的页面切换器（悬浮于各页总控条之上，始终顶部水平居中） */
.page-switch {
  position: fixed;
  top: 6px;
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
.ps-btn .fan {
  background:
    linear-gradient(135deg, transparent 48%, #e0f2fe 49% 51%, transparent 52%),
    conic-gradient(from 202.5deg at 50% 78%, #f43f5e 0 28%, #fb923c 28% 44%, #facc15 44% 60%, #4ade80 60% 76%, #22d3ee 76% 92%, #818cf8 92% 100%);
  border-radius: 2px 2px 50% 50%;
  transform: rotate(45deg) scaleY(0.9);
}
.ps-btn .ell {
  background: conic-gradient(#f43f5e, #fb923c, #facc15, #4ade80, #22d3ee, #818cf8, #e879f9, #f43f5e);
  border-radius: 50%;
  transform: scaleY(0.62);
}

/* 窄屏同样保持顶部水平居中，只压缩内边距与字号 */
@media (max-width: 760px) {
  .page-switch {
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    gap: 0;
  }
  .ps-btn { padding: 6px 9px; font-size: 11px; }
}
</style>
