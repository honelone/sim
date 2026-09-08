<script setup>
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import SimDock from './SimDock.vue'

/* =========================================================
 * 圆轨十二音：页面正中绘制圆形轨道，最顶部为固定原点；
 * 各运动点从原点出发沿圆轨运行，每跑完一圈（回到原点）即奏响对应音。
 * 速度：第 n 点每 60s 运行 n 圈（点序即“第几圈/60s”）。
 * 点数可由顶部总控条调整（与其它实验页一致的步进器）。
 * 额外：任意两个运动点在圆周上相遇（重叠）时，奏响二者对应的和声音程。
 * 头部与半圆弹跳页一致（SimDock）；方向/连线显示控制已取消
 * （连线常显、方向固定逆时针，无切换 UI）。
 * ========================================================= */

/* ---------- 常量 ---------- */
const LAP_SECONDS = 60         // 定义周期：第 n 点每 60s 运行 n 圈
const MAX_FRAME = 0.05         // 单帧最大 dt（防后台切回跳变）
const RING_ALPHA = 0.5         // 圆形轨道不透明度
const SPOKE_ALPHA = 0.16       // 点-原点连线不透明度（< RING_ALPHA）
const CHORD_ALPHA = 0.1        // 点间连线不透明度（< RING_ALPHA）
const ORIGIN_R = 7             // 原点半径
const DIR = 1                  // 方向：1=逆时针（默认，固定，无切换 UI）
const MIN_POINTS = 1           // 点数下限
const MAX_POINTS = 24          // 点数上限（足够展示十二音、不至于过密）
const AUDIO_DEBUG = true

// 音阶：do re mi fa sol la si（自然大调 C4~B4）
const NOTE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]
const NOTE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si']

function hsl(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)` }
function hsla(h, s, l, a) { return `hsla(${h}, ${s}%, ${l}%, ${a})` }

// 每个点预生成颜色 + 音符信息（点序号与音符/颜色一一对应）
// 颜色按数量在色环上均分；音高按 do re mi… 循环、超 7 个升八度
function makeDots(n) {
  return Array.from({ length: n }, (_, i) => {
    const h = Math.round(i * (360 / n)) % 360
    const semi = i % 7
    const oct = Math.floor(i / 7)
    return {
      i, num: i + 1, h,
      color: hsl(h, 92, 62),
      light: hsl(h, 96, 82),
      dark: hsl(h, 88, 44),
      freq: NOTE_FREQS[semi] * Math.pow(2, oct),
      name: oct > 0 ? `${NOTE_NAMES[semi]}′` : NOTE_NAMES[semi],
      title: oct > 0 ? `${NOTE_NAMES[semi]}（升八度）` : NOTE_NAMES[semi],
    }
  })
}
const DOTS = computed(() => makeDots(countInput.value))

/* ---------- 交互状态（响应式） ---------- */
const countInput = ref(12)         // 运动点数量（默认 12，可手动调整）
const speedScale = ref(1)          // 演示倍速（等比压缩周期，不影响 n:1 圈速比）
const playing = ref(false)
const muted = ref(false)
const activeIdx = ref(-1)          // 当前高亮（刚经过原点）的点索引

const canvasRef = ref(null)
const stageRef = ref(null)
const dockRef = ref(null)           // 顶部总控条（SimDock 组件根，供 layout 测量遮挡高度）

/* ---------- 点的数量控制（与其它页面一致） ---------- */
function setCount(value) {
  countInput.value = Math.min(Math.max(Math.round(Number(value) || 1), MIN_POINTS), MAX_POINTS)
}
function stepCount(delta) {
  setCount((Number(countInput.value) || 1) + delta)
}

/* ---------- 音频运行时（非响应式） ---------- */
let audioCtx = null            // AudioContext
let masterGain = null          // 主音量节点
let resumePromise = null
let audioRetryTimer = 0
let highlightTimer = 0
let lastResumeProbe = 0
let pendingNotes = []          // ctx 未就绪时排队待补发的音符
const audioStats = { builds: 0, unlockCalls: 0, noteAttempts: 0, notesScheduled: 0, notesFlushed: 0, passes: 0, overlaps: 0 }

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0, h: 0, dpr: 1,
  cx: 0, cy: 0, R: 0,
  pts: [],          // 运动点：{ i, num, f }，f∈[0,1) 圈内相位（0=原点）；数量随 countInput 变化
  ripples: [],      // 经过原点 / 两点相遇时的冲击波纹
  pairDelta: {},    // 各点对上一帧的“最短角差”，用于检测圆周相遇（重叠）
}

// 数量变化时同步运动点数组：尽量保留已有相位，新增点从原点出发
function syncPoints() {
  const n = countInput.value
  const old = sim.pts
  sim.pts = Array.from({ length: n }, (_, i) => {
    const prev = old[i]
    return { i, num: i + 1, f: prev ? prev.f : 0 }
  })
  sim.pairDelta = {} // 数量变化后重新记录角差，避免误触发重叠
}

let rafId = 0                  // requestAnimationFrame id
let lastTs = 0                 // 上一帧时间戳
let resizeObserver = null      // 画布尺寸自适应

/* ---------- 几何布局：圆居中，原点位于轨道最顶部 ---------- */
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

  // 顶部总控条：直接测量 SimDock 实际遮挡的顶部高度（含与顶部的间距）
  const simRoot = stageRef.value.closest('.sim-root') || stageRef.value.parentElement
  const dockEl = simRoot && simRoot.querySelector('.dock')
  const padT = (dockEl ? dockEl.getBoundingClientRect().bottom - rect.top : 96) + 16
  const padB = 22
  const regionTop = padT
  const regionBottom = Math.max(padT + 80, h - padB)
  const regionH = regionBottom - regionTop

  // 圆居中于可用区域；半径取可用宽高的最小值
  sim.cx = w / 2
  sim.cy = regionTop + regionH / 2
  sim.R = Math.max(40, Math.min(w / 2 - 56, regionH / 2 - 8))
}

/* ---------- 重置 / 播放 / 静音 ---------- */
function reset() {
  playing.value = false
  unlockAudio() // 重置按钮在用户手势内，顺带解锁音频
  sim.ripples.length = 0
  sim.pairDelta = {} // 重置后所有点回到原点（重合），清空缓存以免开局爆发重叠音
  for (const p of sim.pts) p.f = 0
  activeIdx.value = -1
}

function togglePlay() {
  playing.value = !playing.value
  unlockAudio()
}

function toggleMute() {
  muted.value = !muted.value
  unlockAudio()
}

/* =========================================================
 * 音频：Web Audio 实时合成（无外部文件）
 * ========================================================= */
function buildAudioGraph() {
  if (audioCtx && audioCtx.state !== 'closed') return true
  if (audioCtx) { audioCtx = null; masterGain = null }
  const AC = window.AudioContext || window['webkitAudioContext']
  if (!AC) { return false }
  try {
    audioCtx = new AC()
    audioCtx.addEventListener('statechange', onAudioStateChange)
    masterGain = audioCtx.createGain()
    masterGain.gain.value = 0.5
    const comp = audioCtx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 20
    comp.ratio.value = 6
    comp.attack.value = 0.003
    comp.release.value = 0.25
    masterGain.connect(comp)
    comp.connect(audioCtx.destination)
    audioStats.builds++
  } catch (err) {
    console.warn('WebAudio 初始化失败', err)
    try { audioCtx && audioCtx.close() } catch (e) {}
    audioCtx = null
    masterGain = null
    return false
  }
  return true
}

function onAudioStateChange() {
  if (!audioCtx) return
  if (audioCtx.state === 'running') {
    flushPending()
    if (audioRetryTimer) { clearTimeout(audioRetryTimer); audioRetryTimer = 0 }
  }
}

function unlockAudio() {
  if (!buildAudioGraph()) return Promise.resolve(false)
  audioStats.unlockCalls++
  if (audioCtx.state === 'running') { return Promise.resolve(true) }
  if (audioCtx.state === 'suspended' && !resumePromise) {
    resumePromise = audioCtx.resume().then(
      () => { resumePromise = null; return !!(audioCtx && audioCtx.state === 'running') },
      () => { resumePromise = null; scheduleRetry(); return false }
    )
  }
  return resumePromise || Promise.resolve(false)
}

function scheduleRetry() {
  if (audioRetryTimer) return
  audioRetryTimer = setTimeout(() => {
    audioRetryTimer = 0
    if (audioCtx && audioCtx.state === 'suspended') unlockAudio()
  }, 900)
}

function flushPending() {
  if (!pendingNotes.length || !audioCtx || audioCtx.state !== 'running') return
  const batch = pendingNotes.splice(0)
  for (const note of batch) { try { if (scheduleNoteNow(note.freq, note.soft)) audioStats.notesFlushed++ } catch (e) {} }
}

// 弹奏单个正弦音（指数衰减，钟琴质感）
function strike(freq, t0, type, peak, decay) {
  if (!audioCtx || !masterGain) return
  const osc = audioCtx.createOscillator()
  const g = audioCtx.createGain()
  osc.type = type
  osc.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay)
  osc.connect(g)
  g.connect(masterGain)
  osc.start(t0)
  osc.stop(t0 + decay + 0.06)
  osc.onended = () => { osc.disconnect(); g.disconnect() }
}

// 真正调度音符：仅在 ctx running 且未静音时执行；soft=true 用于两点重叠（更轻更短）
function scheduleNoteNow(freq, soft) {
  if (muted.value || !audioCtx || !masterGain || audioCtx.state !== 'running') return false
  const t0 = audioCtx.currentTime
  try {
    if (soft) {
      strike(freq, t0, 'sine', 0.22, 0.5)         // 重叠：轻
      strike(freq * 2.01, t0, 'sine', 0.05, 0.18) // 重叠：泛音更弱
    } else {
      strike(freq, t0, 'sine', 0.5, 1.0)          // 基音
      strike(freq * 2.01, t0, 'sine', 0.12, 0.3)  // 八度泛音“叮”
      strike(freq * 4.07, t0, 'sine', 0.05, 0.12) // 高频亮色
    }
    audioStats.notesScheduled++
    return true
  } catch (err) { console.warn('音符调度失败', err); return false }
}

// 通用发声：ctx 未解锁时按 {freq, soft} 入队待补发
function playNote(freq, soft) {
  audioStats.noteAttempts++
  if (muted.value) return
  if (audioCtx && audioCtx.state === 'running') { scheduleNoteNow(freq, !!soft); return }
  if (buildAudioGraph()) {
    if (pendingNotes.length < 64) pendingNotes.push({ freq, soft: !!soft })
    unlockAudio()
  }
}

// 第 i 个点经过原点时发声
function playPassNote(i) {
  playNote(DOTS.value[i].freq)
}

// 任意两点在圆周上相遇（重叠）时：两音同时发声（和声音程）
function playOverlap(i, j) {
  playNote(DOTS.value[i].freq, true)
  playNote(DOTS.value[j].freq, true)
}

function audioSupervisor() {
  if (!audioCtx) return
  if (audioCtx.state === 'closed') { buildAudioGraph(); return }
  if (audioCtx.state === 'suspended') {
    const now = performance.now()
    if (now - lastResumeProbe > 1000) { lastResumeProbe = now; unlockAudio() }
  }
}

/* ---------- 运动物理：点速 = 序号 n 圈/60s，圈相位在原点处清零检测 ---------- */
function triggerPass(i) {
  audioStats.passes++
  playPassNote(i)
  const ox = sim.cx
  const oy = sim.cy - sim.R
  sim.ripples.push({ x: ox, y: oy, age: 0, h: DOTS.value[i].h })
  if (sim.ripples.length > 20) sim.ripples.shift()
  activeIdx.value = DOTS.value[i].i
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { activeIdx.value = -1 }, 420)
}

// 两点在圆周上相遇（角位置重合）：标注涟漪 + 奏响对应和声音程
function triggerOverlap(i, j) {
  audioStats.overlaps++
  playOverlap(i, j)
  const pt = posOf(sim.pts[i].f) // 此刻 i、j 位置重合
  const hue = (DOTS.value[i].h + DOTS.value[j].h) / 2
  sim.ripples.push({ x: pt.x, y: pt.y, age: 0, h: hue, kind: 'overlap' })
  if (sim.ripples.length > 40) sim.ripples.shift()
}

// 取两相位在圆上“最短有向差” ∈ (-0.5, 0.5]，过零点即两点的圆周相遇
function shortestDelta(a, b) {
  let d = ((a - b) % 1 + 1) % 1
  if (d > 0.5) d -= 1
  return d
}

// 检测任意两点是否在圆周上相遇（位置重合），触发重叠音与视觉涟漪
function detectOverlaps() {
  const n = sim.pts.length
  if (n < 2) return
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = shortestDelta(sim.pts[i].f, sim.pts[j].f)
      const key = i * n + j
      const prev = sim.pairDelta[key]
      if (prev === undefined) { sim.pairDelta[key] = d; continue }
      const crossed = (prev < 0) !== (d < 0) && Math.abs(d - prev) < 0.5
      sim.pairDelta[key] = d
      if (crossed) triggerOverlap(i, j)
    }
  }
}

function updateSim(dt) {
  const scale = Number(speedScale.value) || 1
  for (const p of sim.pts) {
    const step = (DIR * p.num * scale * dt) / LAP_SECONDS // 本帧移动量（圈）
    const raw = p.f + step
    const crossed = Math.floor(raw)                     // f∈[0,1)：floor 即跨过原点的整圈数
    if (crossed !== 0) {
      const c = Math.abs(crossed)
      for (let k = 0; k < c; k++) triggerPass(p.i)
    }
    p.f = raw - Math.floor(raw)
  }
  detectOverlaps()
  for (let i = sim.ripples.length - 1; i >= 0; i--) {
    sim.ripples[i].age += dt
    if (sim.ripples[i].age > 0.8) sim.ripples.splice(i, 1)
  }
}

/* ---------- 渲染 ---------- */
function posOf(f, R) {
  const rr = R === undefined ? sim.R : R
  const th = Math.PI * 2 * f
  // DIR=1：相位增大 → 顶部→左→下→右（视觉逆时针），f=0 即原点（轨道最顶端）
  return {
    x: sim.cx - DIR * rr * Math.sin(th),
    y: sim.cy - rr * Math.cos(th),
  }
}

function render() {
  const canvas = canvasRef.value
  if (!canvas || !sim.w) return
  const ctx = canvas.getContext('2d')
  ctx.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0)
  ctx.clearRect(0, 0, sim.w, sim.h)
  drawRing(ctx)
  drawConnectors(ctx)
  drawRipples(ctx)
  drawOrigin(ctx)
  drawDots(ctx)
}

// 圆形轨道（页面正中）
function drawRing(ctx) {
  const { cx, cy, R } = sim
  ctx.save()
  ctx.lineCap = 'round'
  // 外层柔光
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(56,189,248,0.10)'
  ctx.lineWidth = 12
  ctx.stroke()
  // 主轨道
  const grad = ctx.createRadialGradient(cx, cy, R - 8, cx, cy, R + 8)
  grad.addColorStop(0, 'rgba(125,211,252,0.1)')
  grad.addColorStop(0.5, `rgba(148,210,253,${RING_ALPHA})`)
  grad.addColorStop(1, 'rgba(125,211,252,0.1)')
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = grad
  ctx.lineWidth = 1.6
  ctx.stroke()
  ctx.restore()
}

// 各点与原点连线 + 各运动点两两连线（都比轨道淡，常显）
function drawConnectors(ctx) {
  ctx.save()
  ctx.lineCap = 'round'
  const ox = sim.cx
  const oy = sim.cy - sim.R // 原点=轨道最顶部
  const n = sim.pts.length

  // 每个运动点 → 原点
  ctx.lineWidth = 1
  for (const p of sim.pts) {
    const pt = posOf(p.f)
    ctx.strokeStyle = hsla(DOTS.value[p.i].h, 92, 66, SPOKE_ALPHA)
    ctx.beginPath()
    ctx.moveTo(ox, oy)
    ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
  }

  // 各运动点两两之间
  ctx.lineWidth = 0.8
  ctx.strokeStyle = `rgba(190,214,255,${CHORD_ALPHA})`
  for (let i = 0; i < n; i++) {
    const a = posOf(sim.pts[i].f)
    for (let j = i + 1; j < n; j++) {
      const b = posOf(sim.pts[j].f)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
  ctx.restore()
}

function drawRipples(ctx) {
  ctx.save()
  for (const r of sim.ripples) {
    const t = Math.min(r.age / 0.8, 1)
    const rad = 8 + t * (sim.R * 0.16)
    ctx.beginPath()
    ctx.arc(r.x, r.y, rad, 0, Math.PI * 2)
    if (r.kind === 'overlap') {
      // 两点相遇：白色亮环，区别于原点处的彩色涟漪
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.85})`
      ctx.lineWidth = 2.4
    } else {
      ctx.strokeStyle = hsla(r.h ?? DOTS.value[0].h, 92, 68, (1 - t) * 0.7)
      ctx.lineWidth = 2
    }
    ctx.stroke()
  }
  ctx.restore()
}

// 固定原点（轨道最顶部）
function drawOrigin(ctx) {
  const { cx } = sim
  const oy = sim.cy - sim.R
  ctx.save()
  // 外发光
  const glow = ctx.createRadialGradient(cx, oy, 2, cx, oy, ORIGIN_R * 3.4)
  glow.addColorStop(0, 'rgba(253,224,71,0.4)')
  glow.addColorStop(1, 'rgba(253,224,71,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(cx, oy, ORIGIN_R * 3.4, 0, Math.PI * 2)
  ctx.fill()
  // 主体
  const body = ctx.createRadialGradient(cx - 2, oy - 3, 1, cx, oy, ORIGIN_R + 2)
  body.addColorStop(0, '#fff7ed')
  body.addColorStop(0.55, '#fcd34d')
  body.addColorStop(1, '#f59e0b')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(cx, oy, ORIGIN_R, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(cx, oy, 1.8, 0, Math.PI * 2)
  ctx.fill()
  // 文字标签
  ctx.font = '11px system-ui, "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(252,211,77,0.85)'
  ctx.fillText('原点', cx, oy - ORIGIN_R - 8)
  ctx.restore()
}

// 运动点（彩虹着色球体）
function drawDots(ctx) {
  const dotR = Math.max(4, Math.min(7.5, sim.R * 0.024))
  const active = activeIdx.value
  for (const p of sim.pts) {
    const pt = posOf(p.f)
    const c = DOTS.value[p.i]
    ctx.save()
    // 色晕
    ctx.shadowColor = c.color
    ctx.shadowBlur = 12
    const g = ctx.createRadialGradient(
      pt.x - dotR * 0.35, pt.y - dotR * 0.42, dotR * 0.12,
      pt.x, pt.y, dotR * 1.25
    )
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.35, c.light)
    g.addColorStop(0.75, c.color)
    g.addColorStop(1, c.dark)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = p.i === active ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.75)'
    ctx.lineWidth = p.i === active ? 2 : 1
    ctx.stroke()
    ctx.restore()
  }
}

/* ---------- 主循环 ---------- */
function tick(ts) {
  rafId = requestAnimationFrame(tick)
  const dt = lastTs ? Math.min(Math.max((ts - lastTs) / 1000, 0), MAX_FRAME) : 0
  lastTs = ts
  if (playing.value) {
    updateSim(dt)
  }
  audioSupervisor()
  render()
}

function onUserGesture() { unlockAudio() }

function onKeydown(e) {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'r' || e.key === 'R') {
    reset()
  }
}

watch(countInput, () => { syncPoints(); layout() })

onMounted(() => {
  syncPoints()
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
  clearTimeout(audioRetryTimer)
  clearTimeout(highlightTimer)
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {})
    audioCtx = null
    masterGain = null
  }
})

if (AUDIO_DEBUG) {
  window.__orbitAudio = {
    get ctxState() { return audioCtx ? audioCtx.state : 'none' },
    get playing() { return playing.value },
    get speed() { return speedScale.value },
    get count() { return countInput.value },
    stats: audioStats,
    unlock: () => unlockAudio(),
  }
}
</script>

<template>
  <div class="sim-root">
    <!-- 主运行区：画布占满视口，控制条悬浮其上 -->
    <div class="stage" ref="stageRef">
      <canvas ref="canvasRef" class="sim-canvas"></canvas>
    </div>

    <!-- 顶部总控条：与其它实验页一致（点的数量 / 倍速 / 重置 / 音效 / 播放） -->
    <SimDock
      ref="dockRef"
      :playing="playing"
      :muted="muted"
      :show-count="true"
      :count="countInput"
      :count-min="MIN_POINTS"
      :count-max="MAX_POINTS"
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
</style>
