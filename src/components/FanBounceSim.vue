<script setup>
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import SimDock from './SimDock.vue'
// 音效定义与播放逻辑已抽离为可复用模块：
//  - scaleTones.js：基础/降调/升调音阶与 assembleScale 装配
//  - soundEngine.js：SoundEngine 播放引擎（碰撞时调用 engine.play）
import { SoundEngine, assembleScale } from '../audio/soundEngine.js'
import { rainbowColors, hsla, nearestRainbowName } from '../visual/rainbow.js'

/* =========================================================
 * 需求映射：
 *  1. 页面中部绘制固定原点，自原点向左上/右上各引一条对称线段，
 *     两线段夹角可调（默认 135°；单侧相对竖直倾斜 = 夹角/2）
 *  2. 左侧线段上按“距原点由近及远”放若干运动点
 *  3. 运动点以原点为圆心、各自到原点的距离为半径，
 *     沿圆弧路径（夹在两线段之间，翻越顶部）从左线段摆到右线段，撞线即折返
 *  4. 变速：60s 内第 1 个点(最内)往返 30 次、第 2 个 29 次 … 最外 1 次
 *     （一个往返 = 左线→右线→左线，周期 = 60/n 秒）
 *  5. 各点按彩虹色序着色：两端点取彩虹两端色，中间按渐变顺序依次标注
 *  6. 顶部/底部信息展示与既有实验页保持同一视觉语言
 *  7. 连线：任意两个运动点之间连线（可选）＋ 每点与原点之间连线，均比线段路径更淡
 *  8. 运动点撞到任一线段时发声：音高由音效模块 assembleScale 给出
 *     （基础 do..si，超过 7 个按“降调→升调组”依次扩展）
 *  9. 点的数量最低 7 个，确保 7 个基础音效（do..si）完整播放
 * ========================================================= */

/* ---------- 常量 ---------- */
const DEFAULT_COUNT = 30        // 默认运动点数量（需求为 30）
const MIN_COUNT = 7             // UI 下限：确保 7 个基础音效完整播放
const MAX_COUNT = 40            // UI 上限
const CYCLE_SECONDS = 60        // 周期基准：60s 内完成“按层分配的往返次数”
const WEDGE_MIN = 80            // 两线夹角下限（°）
const WEDGE_MAX = 170           // 两线夹角上限（°）
const ORIGIN_R = 7              // 原点半径
const MAX_FRAME = 0.05          // 单帧最大 dt（防后台切回跳变）
const SEG_ALPHA = 0.92          // 线段路径不透明度（最亮）
const ARC_ALPHA = 0.16          // 各层圆弧引导线不透明度（< 线段）
const CHORD_ALPHA = 0.09        // 点间连线不透明度（< 线段）
const SPOKE_ALPHA = 0.13        // 点-原点连线不透明度（< 线段）
const AUDIO_DEBUG = true        // 调试开关

// 第 n 点（n=1 起）在 60s 内完成的往返次数：最内层=总点数，最外层=1，逐层递减
function cyclesOf(i, n) { return n - i }

/* ---------- 交互状态 ---------- */
const count = ref(DEFAULT_COUNT)
const effCount = computed(() => Math.min(Math.max(Math.round(Number(count.value) || MIN_COUNT), MIN_COUNT), MAX_COUNT))
const wedgeDeg = ref(135)          // 两条线段的夹角（默认 135°）
const halfRad = computed(() => ((wedgeDeg.value / 2) * Math.PI) / 180)
const speedScale = ref(1)
const playing = ref(false)
const muted = ref(false)
const showChord = ref(true)        // 点两两连线
const showSpoke = ref(true)        // 点-原点连线
const lastNote = ref(null)
const activeIdx = ref(-1)

const canvasRef = ref(null)
const stageRef = ref(null)
const dockRef = ref(null)   // 顶部总控条（SimDock 组件根，供 layout 测量遮挡高度）

// 每个运动点的元信息（颜色 = 彩虹两端点 + 中间渐变；音符 = 音效表 assembleScale）
const scale = computed(() => assembleScale(effCount.value))
const meta = computed(() =>
  Array.from({ length: effCount.value }, (_, i) => {
    const c = rainbowColors(i, effCount.value)
    const note = scale.value[i]
    const cyc = cyclesOf(i, effCount.value)
    return {
      i, num: i + 1, h: c.hue, cyc,
      color: c.color,
      light: c.light,
      dark: c.dark,
      freq: note.freq,
      deg: note.deg,
      oct: note.oct,
      name: note.name,
      disp: note.disp,
      title: note.title,
      period: CYCLE_SECONDS / cyc,
      half: (CYCLE_SECONDS / cyc) / 2,
      colorName: nearestRainbowName(c.hue),
      titleFull: `第 ${i + 1} 点（第 ${i + 1} 层）：60s 往返 ${cyc} 次 · 音高 ${note.title} · 颜色 ${nearestRainbowName(c.hue)}`,
    }
  })
)

/* ---------- 音频引擎（可复用模块，见 src/audio/soundEngine.js） ---------- */
const engine = new SoundEngine({ masterVolume: 0.5, debug: AUDIO_DEBUG })
let noticeTimer = 0
let highlightTimer = 0

/* ---------- 运行时几何/状态 ---------- */
const sim = {
  w: 0, h: 0, dpr: 1,
  cx: 0, cy: 0, R: 0, dotR: 5,
  segLen: 0,             // 线段可视长度
  pts: [],               // { s ∈[-1,1]，相对两线夹角的归一化位置：-1 左线 / +1 右线; dir; bounce }
  ripples: [],
}

let rafId = 0
let lastTs = 0
let resizeObserver = null
let realElapsed = 0
let virtElapsed = 0

/* ---------- 布局：原点下移、V 形与圆弧整体偏低且略放大 ---------- */
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

  // 顶部总控条已合并为一条：直接测量它实际遮挡的顶部高度（含与顶部的间距）
  const padT = (dockRef.value && dockRef.value.root ? dockRef.value.root.getBoundingClientRect().bottom - rect.top : 150) + 16
  const padB = 24
  const regionTop = padT
  const regionBottom = Math.max(padT + 120, h - padB)

  sim.cx = w / 2
  // 整体向下移动：原点锚点从区域垂直中心(0.5)下移到 3/4 处（即向下移动“到区域底部距离的一半”）
  const regionH = regionBottom - regionTop
  sim.cy = regionTop + regionH * 0.75

  const sinH = Math.sin(halfRad.value)
  // 以“移动前”的可用半径为基准适量放大（×1.2），确保图形确实整体下移、而非仅因放大又顶回顶部
  const rVert = Math.max(40, (regionH * 0.5 - 26) * 1.2)
  const rHoriz = sinH > 0.001 ? (w / 2 - 46) / sinH : w / 2
  sim.R = Math.max(40, Math.min(rVert, rHoriz))
  sim.segLen = sim.R + Math.min(34, sim.R * 0.1)
  sim.dotR = Math.max(3.2, Math.min(7, sim.R * 0.016))
}

/* ---------- 运动点数组同步（数量变化时重建，尽量保持相位） ---------- */
function syncDots() {
  const n = effCount.value
  const old = sim.pts
  sim.pts = []
  for (let i = 0; i < n; i++) {
    if (old[i]) sim.pts.push(old[i])   // 复用旧对象：改数量不丢当前相位
    else sim.pts.push({ s: -1, dir: 1, bounce: -1 })
  }
}

function setCount(v) {
  count.value = Math.min(Math.max(Math.round(Number(v) || MIN_COUNT), MIN_COUNT), MAX_COUNT)
}
function stepCount(delta) {
  setCount((Number(count.value) || MIN_COUNT) + delta)
}

function reset() {
  playing.value = false
  engine.unlock()
  sim.ripples.length = 0
  for (const p of sim.pts) { p.s = -1; p.dir = 1; p.bounce = -1 }
  realElapsed = 0
  virtElapsed = 0
  lastNote.value = null
  activeIdx.value = -1
}

function togglePlay() {
  playing.value = !playing.value
  engine.unlock()
}
function toggleMute() {
  muted.value = !muted.value
  engine.setMuted(muted.value)
  engine.unlock()
  flashNotice(muted.value ? '声音已关闭（静音）' : '声音已开启', 1400)
}

// 轻量临时提示（用于静音切换等）
function flashNotice(text, ms = 2600) {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { noticeTimer = 0 }, ms)
  void text
}

/* ---------- 运动物理：归一化角位置 s∈[-1,1]，±1 对应左右线段 ---------- */
// 一个往返周期走满 4（-1→+1→-1）；第 i 点在 60s 内往返 cyclesOf(i) 次，
// 所以归一化角速度 = 4 · cycles / 60
function impactAt(i) {
  const p = sim.pts[i]
  p.bounce = 0
  const d = meta.value[i]
  const r = ((i + 1) / effCount.value) * sim.R
  const th = p.s * halfRad.value // p.s 此时必为 ±1
  const x = sim.cx + r * Math.sin(th)
  const y = sim.cy - r * Math.cos(th)
  sim.ripples.push({ x, y, age: 0, h: d.h })
  if (sim.ripples.length > 26) sim.ripples.shift()
  const pan = p.s > 0 ? 1 : -1 // 右线→右声道，左线→左声道
  // 对应音符：由音效表按点序给出（基础 do..si → 降调 → 升调组）
  engine.play(d.freq, pan)
  lastNote.value = { num: d.num, name: d.disp, color: d.color, title: d.title }
  activeIdx.value = i
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { activeIdx.value = -1 }, 420)
}

function updateSim(dt) {
  const scale = Number(speedScale.value) || 1
  realElapsed += dt
  virtElapsed += dt * scale
  const n = sim.pts.length
  for (let i = 0; i < n; i++) {
    const p = sim.pts[i]
    const cyc = cyclesOf(i, n)
    const v = ((4 * cyc) / CYCLE_SECONDS) * scale // 归一化角速度
    let remain = v * dt
    let guard = 0
    // 事件式精确反弹：把越过端点的剩余位移反向带走，保证周期精确无漂移
    while (remain > 1e-9 && guard < 16) {
      const toEnd = p.dir > 0 ? 1 - p.s : p.s + 1
      if (remain <= toEnd) {
        p.s += p.dir * remain
        remain = 0
      } else {
        p.s = p.dir > 0 ? 1 : -1
        remain -= toEnd
        p.dir *= -1
        impactAt(i)
      }
      guard++
    }
    if (p.bounce >= 0) {
      p.bounce += dt
      if (p.bounce > 2) p.bounce = -1
    }
  }
  for (let i = sim.ripples.length - 1; i >= 0; i--) {
    sim.ripples[i].age += dt
    if (sim.ripples[i].age > 0.7) sim.ripples.splice(i, 1)
  }
}

/* ---------- 渲染 ---------- */
function posOf(i, s) {
  const r = ((i + 1) / effCount.value) * sim.R
  const th = s * halfRad.value
  return { x: sim.cx + r * Math.sin(th), y: sim.cy - r * Math.cos(th), r, th }
}
// 两边界光线在 canvas 角度体系下对应的圆弧起止角（经过顶部 -90°）
function arcAngles() {
  const hr = halfRad.value
  return { a0: -hr - Math.PI / 2, a1: hr - Math.PI / 2 }
}

function render() {
  const canvas = canvasRef.value
  if (!canvas || !sim.w) return
  const ctx = canvas.getContext('2d')
  ctx.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0)
  ctx.clearRect(0, 0, sim.w, sim.h)
  drawGuides(ctx)
  drawSegments(ctx)
  drawConnectors(ctx)
  drawRipples(ctx)
  drawDots(ctx)
  drawOrigin(ctx)
}

// 各层圆弧引导线（运动路径：以原点为圆心、介于两线段之间的圆弧）
function drawGuides(ctx) {
  const { cx, cy } = sim
  const { a0, a1 } = arcAngles()
  const n = meta.value.length
  ctx.save()
  ctx.lineCap = 'round'
  // 中轴虚线（竖直向上，示意 0° 顶点方向）
  ctx.strokeStyle = 'rgba(226,232,240,0.08)'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 9])
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx, cy - sim.R - 8)
  ctx.stroke()
  ctx.setLineDash([])

  // 每一层一条圆弧引导线（用该点自身颜色极淡绘制）
  for (let i = 0; i < n; i++) {
    const r = ((i + 1) / n) * sim.R
    const d = meta.value[i]
    ctx.strokeStyle = hsla(d.h, 90, 72, ARC_ALPHA)
    ctx.lineWidth = i === n - 1 ? 1.4 : 1
    ctx.beginPath()
    ctx.arc(cx, cy, r, a0, a1, false)
    ctx.stroke()
  }

  // 原点附近的夹角示意弧（虚线）
  const markR = Math.max(18, sim.R * 0.1)
  ctx.strokeStyle = 'rgba(190,214,255,0.18)'
  ctx.lineWidth = 1
  ctx.setLineDash([2, 5])
  ctx.beginPath()
  ctx.arc(cx, cy, markR, a0, a1, false)
  ctx.stroke()
  ctx.setLineDash([])

  // 夹角数值标注（置于外圆弧上方的空白区）
  ctx.font = '11px system-ui, "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = 'rgba(148,210,250,0.55)'
  ctx.fillText(`两线夹角 ${wedgeDeg.value}° · 相对竖直各 ${(wedgeDeg.value / 2).toFixed(1)}°`, cx, cy - sim.R - 12)
  ctx.restore()
}

// 左右两条线段路径（最亮，即“线段路径”本体）
function drawSegments(ctx) {
  const { cx, cy } = sim
  const hr = halfRad.value
  const L = sim.segLen
  const dx = L * Math.sin(hr)
  const dy = L * Math.cos(hr)
  ctx.save()
  ctx.lineCap = 'round'
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy - dy)
  grad.addColorStop(0, 'rgba(125,211,252,0.55)')
  grad.addColorStop(0.5, 'rgba(224,242,254,0.95)')
  grad.addColorStop(1, 'rgba(125,211,252,0.55)')
  // 柔光
  ctx.strokeStyle = 'rgba(56,189,248,0.14)'
  ctx.lineWidth = 9
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - dx, cy - dy); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy - dy); ctx.stroke()
  // 主线段
  ctx.strokeStyle = grad
  ctx.lineWidth = 2.6
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - dx, cy - dy); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy - dy); ctx.stroke()
  // 端点亮帽
  for (const ex of [-dx, dx]) {
    ctx.beginPath()
    ctx.arc(cx + ex, cy - dy, 3.4, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(224,242,254,0.9)'
    ctx.fill()
  }
  ctx.restore()
}

// 连线：每点─原点 与 各运动点两两之间（均显著淡于线段路径）
function drawConnectors(ctx) {
  const n = sim.pts.length
  if (!n) return
  const pts = []
  for (let i = 0; i < n; i++) pts.push(posOf(i, sim.pts[i].s))
  ctx.save()
  ctx.lineCap = 'round'

  if (showSpoke.value) {
    ctx.lineWidth = 1
    for (let i = 0; i < n; i++) {
      const d = meta.value[i]
      ctx.strokeStyle = hsla(d.h, 92, 70, SPOKE_ALPHA)
      ctx.beginPath()
      ctx.moveTo(sim.cx, sim.cy)
      ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
  }

  if (showChord.value) {
    ctx.lineWidth = 0.8
    ctx.strokeStyle = `rgba(190,214,255,${CHORD_ALPHA})`
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        ctx.beginPath()
        ctx.moveTo(pts[i].x, pts[i].y)
        ctx.lineTo(pts[j].x, pts[j].y)
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

function drawRipples(ctx) {
  ctx.save()
  for (const r of sim.ripples) {
    const t = Math.min(r.age / 0.7, 1)
    ctx.beginPath()
    ctx.arc(r.x, r.y, 6 + t * 24, 0, Math.PI * 2)
    ctx.strokeStyle = hsla(r.h ?? 0, 92, 70, (1 - t) * 0.6)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }
  ctx.restore()
}

function drawDots(ctx) {
  const n = sim.pts.length
  const dotR = sim.dotR
  for (let i = 0; i < n; i++) {
    const p = sim.pts[i]
    const c = meta.value[i]
    const pt = posOf(i, p.s)
    // 色晕
    const glow = ctx.createRadialGradient(pt.x, pt.y, 1, pt.x, pt.y, dotR * 2.7)
    glow.addColorStop(0, hsla(c.h, 92, 66, 0.5))
    glow.addColorStop(1, hsla(c.h, 92, 66, 0))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, dotR * 2.7, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.translate(pt.x, pt.y)
    // 撞线瞬间沿“切向(摆动方向)/径向”的压扁回弹形变
    let sx = 1
    let sy = 1
    if (p.bounce >= 0) {
      const k = Math.exp(-3.4 * p.bounce) * Math.cos(10 * p.bounce)
      sy = 1 - 0.5 * k
      sx = 1 + 0.55 * k
    }
    ctx.rotate(pt.th)
    ctx.scale(sx, sy)

    const g = ctx.createRadialGradient(-dotR * 0.35, -dotR * 0.42, dotR * 0.12, 0, 0, dotR * 1.25)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.35, c.light)
    g.addColorStop(0.75, c.color)
    g.addColorStop(1, c.dark)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()

    // 高亮点（图例 hover / 撞线瞬间）显示点序号
    if (activeIdx.value === i) {
      ctx.save()
      ctx.font = '600 11px system-ui, "Microsoft YaHei", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillStyle = c.light
      ctx.shadowColor = c.color
      ctx.shadowBlur = 6
      ctx.fillText(String(c.num), pt.x, pt.y - dotR - 8)
      ctx.restore()
    }
  }
}

function drawOrigin(ctx) {
  const { cx, cy } = sim
  ctx.save()
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, ORIGIN_R * 3.2)
  glow.addColorStop(0, 'rgba(253,224,71,0.4)')
  glow.addColorStop(1, 'rgba(253,224,71,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(cx, cy, ORIGIN_R * 3.2, 0, Math.PI * 2)
  ctx.fill()
  const body = ctx.createRadialGradient(cx - 2, cy - 3, 1, cx, cy, ORIGIN_R + 2)
  body.addColorStop(0, '#fff7ed')
  body.addColorStop(0.55, '#fcd34d')
  body.addColorStop(1, '#f59e0b')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(cx, cy, ORIGIN_R, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(cx, cy, 1.8, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = '11px system-ui, "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(252,211,77,0.85)'
  ctx.fillText('原点', cx, cy + ORIGIN_R + 15)
  ctx.restore()
}

/* ---------- 主循环 ---------- */
function tick(ts) {
  rafId = requestAnimationFrame(tick)
  const dt = lastTs ? Math.min(Math.max((ts - lastTs) / 1000, 0), MAX_FRAME) : 0
  lastTs = ts
  if (playing.value) {
    updateSim(dt)
  }
  engine.supervisor()
  render()
}

function onUserGesture() { engine.unlock() }
function onKeydown(e) {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'r' || e.key === 'R') {
    reset()
  }
}

watch(effCount, () => { syncDots() })

onMounted(() => {
  syncDots()
  layout()
  rafId = requestAnimationFrame(tick)
  resizeObserver = new ResizeObserver(() => layout())
  resizeObserver.observe(stageRef.value)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointerdown', onUserGesture, { passive: true })
  window.addEventListener('keydown', onUserGesture)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObserver && resizeObserver.disconnect()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onUserGesture)
  window.removeEventListener('keydown', onUserGesture)
  clearTimeout(noticeTimer)
  clearTimeout(highlightTimer)
  engine.dispose()
})

if (AUDIO_DEBUG) {
  window.__fanAudio = {
    ...engine.snapshot(),
    get playing() { return playing.value },
    get count() { return effCount.value },
    get wedge() { return wedgeDeg.value },
  }
}
</script>

<template>
  <div class="sim-root">
    <div class="stage" ref="stageRef">
      <canvas ref="canvasRef" class="sim-canvas"></canvas>
    </div>

    <SimDock
      ref="dockRef"
      :playing="playing"
      :muted="muted"
      :show-count="true"
      :count="count"
      :count-min="MIN_COUNT"
      :count-max="MAX_COUNT"
      :speed="speedScale"
      @toggle-play="togglePlay"
      @toggle-mute="toggleMute"
      @reset="reset"
      @update:count="setCount"
      @step-count="stepCount"
      @update:speed="(v) => (speedScale = v)"
    />
  </div>
</template>

<style scoped>
.sim-root {
  position: relative;
  height: 100dvh;
  overflow: hidden;
}

/* ---------- 主运行区 ---------- */
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.sim-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

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

/* 合并后的整体控制条：操作按钮 + 参数控件 一行流式排列 */
.dock-inner {
  display: flex;
  flex-wrap: wrap;
  flex-direction: row-reverse;
  align-items: center;
  gap: clamp(10px, 2vw, 22px);
  padding: 10px clamp(12px, 2vw, 20px);
}
.actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(14px, 2.4vw, 36px);
  flex: 1 1 auto;
  min-width: 0;
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
.btn:active { transform: scale(0.96); }
.btn.sound.muted { opacity: 0.75; border-color: rgba(248, 113, 113, 0.45); }
.btn.sound.muted svg { color: #f87171; }
.btn.play {
  border: none;
  background: linear-gradient(135deg, #0ea5e9, #22d3ee);
  color: #03131f;
  font-weight: 700;
  min-width: 104px;
  justify-content: center;
  box-shadow: 0 6px 24px rgba(34, 211, 238, 0.35);
}
.btn.play:hover { filter: brightness(1.08); }

.pgroup { min-width: 150px; display: flex; flex-direction: column; gap: 6px; }
.pgroup.grow { flex: 1; min-width: 200px; max-width: 440px; }
.plabel {
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.5px;
}
small { font-size: 11px; color: var(--text-3); line-height: 1.4; }

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
.num:focus { border-color: var(--accent); }

.range-row { display: flex; align-items: center; gap: 12px; }
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
  min-width: 74px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.tick {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.tick input {
  accent-color: #22d3ee;
  width: 14px;
  height: 14px;
  cursor: pointer;
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
.pgroup.inline {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pgroup.inline .plabel {
  white-space: nowrap;
}
.pgroup.inline small {
  display: none;
}

@media (max-width: 1080px) { .btn.sound { display: none; } }
</style>
