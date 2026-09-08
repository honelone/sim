<script setup>
import { ref } from 'vue'

const props = defineProps({
  playing: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  showCount: { type: Boolean, default: false },
  count: { type: Number, default: 0 },
  countMin: { type: Number, default: 1 },
  countMax: { type: Number, default: 999 },
  speed: { type: Number, default: 1 },
})
const emit = defineEmits([
  'toggle-play',
  'toggle-mute',
  'reset',
  'update:count',
  'step-count',
  'update:speed',
])

// 暴露根元素，供页面 layout 测量其遮挡高度
const root = ref(null)
defineExpose({ root })

function onCountInput(e) {
  emit('update:count', Number(e.target.value))
}
function onSpeedChange(e) {
  emit('update:speed', Number(e.target.value))
}
</script>

<template>
  <div class="dock" ref="root">
    <div class="dock-inner">
      <!-- 左侧：点的数量 + 演示倍速（各页面统一结构） -->
      <div class="dock-left">
        <div class="pgroup inline" v-if="showCount">
          <span class="plabel">点的数量</span>
          <div class="stepper">
            <button class="step" type="button" :disabled="count <= countMin" @click="emit('step-count', -1)">−</button>
            <input
              class="num"
              type="number"
              :min="countMin"
              :max="countMax"
              :value="count"
              @change="onCountInput"
            />
            <button class="step" type="button" :disabled="count >= countMax" @click="emit('step-count', 1)">+</button>
          </div>
        </div>

        <div class="pgroup inline">
          <span class="plabel">演示倍速</span>
          <select class="speed-select" :value="speed" @change="onSpeedChange" title="整体缩放运动节奏">
            <option :value="1">1x</option>
            <option :value="2">2x</option>
            <option :value="5">5x</option>
            <option :value="10">10x</option>
          </select>
        </div>
      </div>

      <!-- 右侧：音效开关 + 动画播放（各页面统一结构） -->
      <div class="dock-right">
        <button class="btn ghost" type="button" @click="emit('reset')" title="重置 (R)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
          重置
        </button>
        <button
          class="btn ghost sound"
          type="button"
          :class="{ muted }"
          @click="emit('toggle-mute')"
          :title="muted ? '开启和弦音效' : '关闭和弦音效'"
        >
          <svg v-if="muted" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
          {{ muted ? '已静音' : '音效开' }}
        </button>
        <button class="btn play" type="button" :class="{ paused: !playing }" @click="emit('toggle-play')" title="播放/暂停 (空格)">
          <svg v-if="playing" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.9l11-6.5a1 1 0 0 0 0-1.8l-11-6.5A1 1 0 0 0 8 5.5Z" />
          </svg>
          {{ playing ? '暂停' : '播放' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 顶部总控条：合并后的整体悬浮玻璃卡片 ---------- */
.dock {
  position: absolute;
  top: 40px;                     /* 让开顶部居中的页面切换器 */
  left: clamp(8px, 1.6vw, 20px);
  right: clamp(8px, 1.6vw, 20px);
  z-index: 6;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(8, 13, 26, 0.92), rgba(15, 23, 42, 0.74));
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 40px rgba(2, 6, 23, 0.5);
}

/* 控制条：操作按钮 + 参数控件 一行流式排列 */
.dock-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(10px, 2vw, 22px);
  padding: 10px clamp(12px, 2vw, 20px);
}
.dock-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(14px, 2.4vw, 36px);
  flex: 1 1 auto;
  min-width: 0;
}
.dock-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  background: rgba(30, 41, 59, 0.55);
  color: var(--text-1);
  border-radius: 10px;
  padding: 8px 15px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.18s ease;
  user-select: none;
  white-space: nowrap;
}
.btn:hover {
  background: rgba(51, 65, 85, 0.85);
  border-color: rgba(148, 163, 184, 0.4);
}
.btn:active {
  transform: scale(0.96);
}
.btn.ghost svg {
  color: var(--text-2);
}
.btn.sound.muted {
  opacity: 0.75;
  border-color: rgba(248, 113, 113, 0.45);
}
.btn.sound.muted svg {
  color: #f87171;
}
.btn.play {
  border: none;
  background: linear-gradient(135deg, #0ea5e9, #22d3ee);
  color: #03131f;
  font-weight: 700;
  min-width: 104px;
  justify-content: center;
  box-shadow: 0 6px 24px rgba(34, 211, 238, 0.35);
}
.btn.play:hover {
  filter: brightness(1.08);
}

.pgroup {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pgroup.inline {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.plabel {
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 6px;
}
.step {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(30, 41, 59, 0.6);
  color: var(--text-1);
  font-size: 16px;
  cursor: pointer;
  transition: all 0.15s;
}
.step:hover:not(:disabled) {
  background: rgba(51, 65, 85, 0.9);
}
.step:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.num {
  width: 68px;
  height: 30px;
  text-align: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(2, 6, 23, 0.7);
  color: var(--text-1);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border 0.15s;
}
.num:focus {
  border-color: var(--accent);
}

/* 倍速下拉 */
.speed-select {
  appearance: none;
  -webkit-appearance: none;
  height: 34px;
  width: 76px;
  padding: 0 26px 0 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background-color: rgba(2, 6, 23, 0.7);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
  color: var(--text-1);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  outline: none;
  transition: border 0.15s, box-shadow 0.15s;
}
.speed-select:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.18);
}

/* 窄屏隐藏音效按钮，避免拥挤 */
@media (max-width: 1080px) {
  .btn.sound { display: none; }
}
</style>
