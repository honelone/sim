<script setup>
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'

/* =========================================================
 * 需求映射（各条目见代码注释）：
 *  1. 水平直线贯穿整个画布
 *  2. 中心原点，半径略大于直线宽度
 *  3. 原点向左每隔一段距离等距排列“点”
 *  4. 点的数量由用户输入控制
 *  5. 相邻点间距存在 [SPACING_MIN, SPACING_MAX] 约束
 *  6. 以“点到原点的距离”为半径，画上方半圆弧路径（颜色比直线淡）
 *  7. 播放按钮：点击后点开始运动
 *  8. 所有点沿线做匀速运动（角速度不同但线速度相同）
 *  9. 从直线一端绕半圆到另一端后原路返回，无限循环
 * 10. 到达端点触线时做弹性压缩/回弹的物理反弹动画
 * ========================================================= */

/* ---------- 常量 ---------- */
const SPACING_MIN = 28            // 相邻点间距下限 px
const SPACING_MAX = 140           // 相邻点间距上限 px
const LINE_WIDTH = 3              // 主直线宽度 px
const ORIGIN_R = 7                // 原点半径（> 直线宽度）
const DOT_R = 6                   // 运动点半径
const LINE_Y_RATIO = 0.58         // 直线在画布高度上的比例位置
const ARC_ALPHA = 0.3             // 半圆路径不透明度
const MAX_FRAME = 0.05            // 单帧最大 dt 秒（防止后台切回跳变）

/* ---------- 交互状态（响应式） ---------- */
const countInput = ref(5)         // 用户输入的点数量
const spacingVal = ref(64)        // 用户期望的间距
const speedVal = ref(260)         // 匀速运动的线速度 px/s
const playing = ref(false)        // 是否播放
const availR = ref(0)             // 当前画布可用半径（自动适配窗口）

const canvasRef = ref(null)
const stageRef = ref(null)

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0,
  h: 0,
  dpr: 1,
  cx: 0,
  cy: 0,
  dots: [],        // 每个运动点: { d, L, pos, dir, bounce }
  ripples: [],     // 触线反弹时的冲击波纹
}

let rafId = 0
let lastTs = 0
let resizeObserver = null

/* ---------- 约束推导（供 UI 展示） ---------- */
const maxCount = computed(() => {
  if (availR.value <= 0) return 20
  return Math.max(1, Math.floor(availR.value / SPACING_MIN))
})

const effCount = computed(() => {
  const n = Math.round(Number(countInput.value) || 1)
  return Math.min(Math.max(n, 1), maxCount.value)
})

const effSpacing = computed(() => {
  const n = effCount.value
  const cap = availR.value > 0 ? availR.value / n : SPACING_MAX
  return Math.min(Math.max(spacingVal.value, SPACING_MIN), Math.min(SPACING_MAX, cap))
})

const spacingLabel = computed(() => Math.round(effSpacing.value))
const outerLabel = computed(() => Math.round(effSpacing.value * effCount.value))

const spacingHint = computed(() => {
  const allow = Math.round(Math.min(SPACING_MAX, availR.value > 0 ? availR.value / effCount.value : SPACING_MAX))
  return `允许范围 ${SPACING_MIN} ~ ${allow}px（超出时自动收缩，保证弧线不越界）`
})

/* ---------- 画布几何与点列重建 ---------- */
function layout() {
  const canvas = canvasRef.value
  const stage = stageRef.value
  if (!canvas || !stage) return
  const rect = stage.getBoundingClientRect()
  const w = rect.width
  const h = rect.height
  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  sim.w = w
  sim.h = h
  sim.dpr = dpr
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  sim.cx = w / 2
  sim.cy = h * LINE_Y_RATIO

  // 可用半径 = 水平可用一半 与 竖直可用高度 的较小值，并留边
  availR.value = Math.max(42, Math.min(w / 2 - 110, sim.cy - 120))

  // 数量自动回落到当前画布可容纳范围
  const c = Math.min(Math.max(1, Math.round(Number(countInput.value) || 1)), maxCount.value)
  if (c !== countInput.value) countInput.value = c
  syncDots()
}

function syncDots() {
  const dists = Array.from({ length: effCount.value }, (_, i) => (i + 1) * effSpacing.value)
  const old = sim.dots
  sim.dots = dists.map((d, i) => {
    const L = Math.PI * d // 半圆弧长
    const prev = old[i]
    if (prev && prev.L > 0) {
      // 尽量保持原来在弧上的相对进度（改变数量/间距时不突兀）
      const frac = Math.min(Math.max(prev.pos / prev.L, 0), 1)
      return { d, L, pos: frac * L, dir: prev.dir, bounce: -1 }
    }
    // 初始静止位置：直线左端 = 弧长尽头（距原点 d）
    return { d, L, pos: L, dir: -1, bounce: -1 }
  })
}

function setCount(value) {
  const n = Math.round(Number(value) || 1)
  countInput.value = Math.min(Math.max(n, 1), maxCount.value)
}
function stepCount(delta) {
  setCount((Number(countInput.value) || 1) + delta)
}

function reset() {
  playing.value = false
  sim.ripples.length = 0
  sim.dots.forEach((p) => {
    p.pos = p.L
    p.dir = -1
    p.bounce = -1
  })
}

function togglePlay() {
  playing.value = !playing.value
}

/* ---------- 运动物理 ---------- */
function impactAtEnd(p) {
  // 触线反弹：标记冲击时刻（用于绘制弹性压缩/回弹）
  p.bounce = 0
  const sideX = p.pos <= 0 ? sim.cx + p.d : sim.cx - p.d // 触地点（直线另一端）
  sim.ripples.push({ x: sideX, y: sim.cy, age: 0 })
  if (sim.ripples.length > 24) sim.ripples.shift()
}

function update(dt) {
  const v = Number(speedVal.value) || 260
  for (const p of sim.dots) {
    let pos = p.pos + p.dir * v * dt
    if (p.dir < 0 && pos <= 0) {
      // 到达右端点（另一端触线）
      p.pos = 0
      p.dir = 1
      impactAtEnd(p)
    } else if (p.dir > 0 && pos >= p.L) {
      // 到达左端点（原路另一侧触线）
      p.pos = p.L
      p.dir = -1
      impactAtEnd(p)
    } else {
      p.pos = pos
    }
    if (p.bounce >= 0) {
      p.bounce += dt
      if (p.bounce > 2) p.bounce = -1 // 弹跳动画结束
    }
  }
  for (let i = sim.ripples.length - 1; i >= 0; i--) {
    sim.ripples[i].age += dt
    if (sim.ripples[i].age > 0.7) sim.ripples.splice(i, 1)
  }
}

/* ---------- 渲染 ---------- */
function render() {
  const canvas = canvasRef.value
  if (!canvas || !sim.w) return
  const ctx = canvas.getContext('2d')
  ctx.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0)
  ctx.clearRect(0, 0, sim.w, sim.h)

  drawCenterGuide(ctx)
  drawMainLine(ctx)
  drawArcPaths(ctx)
  drawRipples(ctx)
  drawDots(ctx)
  drawOrigin(ctx)
}

function drawMainLine(ctx) {
  const { w, cy } = sim
  ctx.save()
  ctx.lineCap = 'round'
  // 光晕层
  ctx.strokeStyle = 'rgba(56,189,248,0.16)'
  ctx.lineWidth = LINE_WIDTH + 9
  ctx.beginPath()
  ctx.moveTo(0, cy)
  ctx.lineTo(w, cy)
  ctx.stroke()
  // 主直线（贯穿整个页面宽度）
  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, 'rgba(125,211,252,0.45)')
  grad.addColorStop(0.5, '#7dd3fc')
  grad.addColorStop(1, 'rgba(125,211,252,0.45)')
  ctx.strokeStyle = grad
  ctx.lineWidth = LINE_WIDTH
  ctx.beginPath()
  ctx.moveTo(0, cy)
  ctx.lineTo(w, cy)
  ctx.stroke()
  ctx.restore()
}

function drawCenterGuide(ctx) {
  ctx.save()
  ctx.strokeStyle = 'rgba(226,232,240,0.09)'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 8])
  ctx.beginPath()
  ctx.moveTo(sim.cx, 0)
  ctx.lineTo(sim.cx, sim.h)
  ctx.stroke()
  ctx.restore()
}

// 每个“点”以其到原点的距离为半径，画上方半圆弧作为运动路径
function drawArcPaths(ctx) {
  ctx.save()
  ctx.lineCap = 'round'
  for (const p of sim.dots) {
    ctx.beginPath()
    // canvas 角度 π→2π 即为直线以上的半圆（左端→顶点→右端）
    ctx.arc(sim.cx, sim.cy, p.d, Math.PI, Math.PI * 2, false)
    ctx.strokeStyle = `rgba(103,232,249,${ARC_ALPHA})` // 颜色显著淡于主直线
    ctx.lineWidth = 2
    ctx.stroke()
  }
  ctx.restore()
}

function drawRipples(ctx) {
  ctx.save()
  for (const r of sim.ripples) {
    const t = Math.min(r.age / 0.7, 1)
    ctx.beginPath()
    ctx.arc(r.x, r.y, 7 + t * 26, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.55})`
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
}

function drawDots(ctx) {
  for (const p of sim.dots) {
    const a = p.pos / p.d
    const x = sim.cx + p.d * Math.cos(a)
    const y = sim.cy - p.d * Math.sin(a)

    // 弹性反弹形变：触线瞬间横向压扁(挤压)，随后竖直过冲(回弹)并衰减
    let rx = DOT_R
    let ry = DOT_R
    if (p.bounce >= 0) {
      const k = Math.exp(-3.4 * p.bounce) * Math.cos(10 * p.bounce)
      ry = DOT_R * (1 - 0.52 * k)
      rx = DOT_R * (1 + 0.62 * k)
    }

    ctx.save()
    ctx.translate(x, y)
    ctx.scale(rx / DOT_R, ry / DOT_R)

    // 边缘环
    ctx.beginPath()
    ctx.arc(0, 0, DOT_R, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(165,243,252,0.85)'
    ctx.lineWidth = 1.4
    ctx.stroke()

    // 球体渐变
    const g = ctx.createRadialGradient(-DOT_R * 0.35, -DOT_R * 0.4, DOT_R * 0.15, 0, 0, DOT_R * 1.2)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.5, '#a5f3fc')
    g.addColorStop(1, '#0ea5e9')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, DOT_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

function drawOrigin(ctx) {
  const { cx, cy } = sim
  ctx.save()
  // 外发光
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, ORIGIN_R * 3)
  glow.addColorStop(0, 'rgba(253,224,71,0.35)')
  glow.addColorStop(1, 'rgba(253,224,71,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(cx, cy, ORIGIN_R * 3, 0, Math.PI * 2)
  ctx.fill()

  // 主体（原点尺寸略大于直线宽度）
  const body = ctx.createRadialGradient(cx - 2, cy - 3, 1, cx, cy, ORIGIN_R + 2)
  body.addColorStop(0, '#fff7ed')
  body.addColorStop(0.55, '#fcd34d')
  body.addColorStop(1, '#f59e0b')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(cx, cy, ORIGIN_R, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 1.4
  ctx.stroke()

  // 中心小核
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(cx, cy, 1.8, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/* ---------- 主循环 ---------- */
function tick(ts) {
  rafId = requestAnimationFrame(tick)
  const dt = lastTs ? Math.min(Math.max((ts - lastTs) / 1000, 0), MAX_FRAME) : 0
  lastTs = ts
  if (playing.value) update(dt)
  render()
}

function onKeydown(e) {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'r' || e.key === 'R') {
    reset()
  }
}

watch([countInput, spacingVal], () => {
  syncDots()
})

onMounted(() => {
  layout()
  rafId = requestAnimationFrame(tick)
  resizeObserver = new ResizeObserver(() => layout())
  resizeObserver.observe(stageRef.value)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObserver && resizeObserver.disconnect()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="sim-root">
    <header class="sim-header">
      <div>
        <h1>半圆往返 · 弹性反弹演示</h1>
        <p class="sub">多个点沿各自上方半圆路径匀速往返，触线时产生物理反弹效果</p>
      </div>
      <div class="header-actions">
        <button class="btn ghost" @click="reset" title="重置 (R)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
          重置
        </button>
        <button class="btn play" :class="{ paused: !playing }" @click="togglePlay" title="播放/暂停 (空格)">
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
    </header>

    <div class="stage" ref="stageRef">
      <canvas ref="canvasRef" class="sim-canvas"></canvas>

      <div class="stage-badges">
        <span class="badge" :class="{ running: playing }">
          <i></i>{{ playing ? '运动进行中' : '已暂停' }}
        </span>
        <span class="badge">点数 n = {{ effCount }}</span>
        <span class="badge">实际间距 {{ spacingLabel }}px</span>
        <span class="badge">最远半径 {{ outerLabel }}px</span>
      </div>

      <div class="legend">
        <span class="lg"><i class="sw line"></i>基准直线</span>
        <span class="lg"><i class="sw arc"></i>半圆路径</span>
        <span class="lg"><i class="sw origin"></i>原点</span>
        <span class="lg"><i class="sw dot"></i>运动点</span>
      </div>
    </div>

    <section class="panel">
      <div class="pgroup">
        <span class="plabel">点的数量</span>
        <div class="stepper">
          <button class="step" :disabled="effCount <= 1" @click="stepCount(-1)">−</button>
          <input
            class="num"
            type="number"
            min="1"
            :max="maxCount"
            v-model.number="countInput"
            @change="setCount(countInput)"
          />
          <button class="step" :disabled="effCount >= maxCount" @click="stepCount(1)">+</button>
        </div>
        <small>1 ~ {{ maxCount }}</small>
      </div>

      <div class="pgroup grow">
        <span class="plabel">点间距</span>
        <div class="range-row">
          <input
            class="range"
            type="range"
            :min="SPACING_MIN"
            :max="SPACING_MAX"
            step="1"
            v-model.number="spacingVal"
          />
          <output>{{ spacingLabel }}px</output>
        </div>
        <small>{{ spacingHint }}</small>
      </div>

      <div class="pgroup grow">
        <span class="plabel">运动速度</span>
        <div class="range-row">
          <input
            class="range"
            type="range"
            min="40"
            max="600"
            step="10"
            v-model.number="speedVal"
          />
          <output>{{ speedVal }} px/s</output>
        </div>
        <small>所有点保持同一线速度（各点弧长不同，角速度相应不同）</small>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sim-root {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---------- header ---------- */
.sim-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px clamp(16px, 4vw, 40px);
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.65), rgba(15, 23, 42, 0.1));
}
.sim-header h1 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.3px;
  background: linear-gradient(90deg, #e0f2fe, #7dd3fc 60%, #22d3ee);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.sim-header .sub {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-3);
}
.header-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  background: rgba(30, 41, 59, 0.55);
  color: var(--text-1);
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.18s ease;
  user-select: none;
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
.btn.play {
  border: none;
  background: linear-gradient(135deg, #0ea5e9, #22d3ee);
  color: #03131f;
  font-weight: 700;
  min-width: 108px;
  justify-content: center;
  box-shadow: 0 6px 24px rgba(34, 211, 238, 0.35);
}
.btn.play.paused {
  background: linear-gradient(135deg, #0ea5e9, #22d3ee);
}
.btn.play:hover {
  filter: brightness(1.08);
}

/* ---------- stage ---------- */
.stage {
  position: relative;
  flex: 1;
  min-height: 260px;
  overflow: hidden;
}
.sim-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.stage-badges {
  position: absolute;
  top: 14px;
  left: clamp(14px, 3vw, 28px);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  pointer-events: none;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid var(--border);
  backdrop-filter: blur(6px);
  padding: 5px 10px;
  border-radius: 999px;
}
.badge i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}
.badge.running i {
  background: #4ade80;
  box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6);
  animation: pulse 1.4s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.55); }
  70% { box-shadow: 0 0 0 7px rgba(74, 222, 128, 0); }
  100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
}

.legend {
  position: absolute;
  right: clamp(14px, 3vw, 28px);
  bottom: 12px;
  display: flex;
  gap: 14px;
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.5);
  border: 1px solid var(--border);
  backdrop-filter: blur(6px);
  font-size: 12px;
  color: var(--text-2);
  flex-wrap: wrap;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.sw {
  display: inline-block;
  width: 22px;
  height: 4px;
  border-radius: 2px;
}
.sw.line { background: linear-gradient(90deg, rgba(125, 211, 252, 0.4), #7dd3fc); }
.sw.arc { background: #67e8f9; opacity: 0.4; border-radius: 4px 4px 0 0; height: 10px; clip-path: none; }
.sw.origin { background: radial-gradient(circle at 30% 30%, #fff7ed, #f59e0b); height: 10px; width: 10px; border-radius: 50%; }
.sw.dot { background: radial-gradient(circle at 30% 30%, #fff, #0ea5e9); height: 10px; width: 10px; border-radius: 50%; }

/* ---------- panel ---------- */
.panel {
  display: flex;
  align-items: flex-end;
  gap: clamp(16px, 3vw, 34px);
  flex-wrap: wrap;
  padding: 12px clamp(16px, 4vw, 40px) 14px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  backdrop-filter: blur(14px);
}
.pgroup {
  min-width: 150px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pgroup.grow {
  flex: 1;
  min-width: 220px;
  max-width: 460px;
}
.plabel {
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.5px;
}
small {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
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
.range-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.range {
  flex: 1;
  appearance: none;
  -webkit-appearance: none;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, #0ea5e9, #22d3ee);
  outline: none;
  cursor: pointer;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--accent-2);
  box-shadow: 0 2px 8px rgba(34, 211, 238, 0.5);
  cursor: pointer;
}
.range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--accent-2);
  cursor: pointer;
}
output {
  min-width: 84px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
</style>
