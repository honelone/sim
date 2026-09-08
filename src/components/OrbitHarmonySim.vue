<script setup>
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import SimDock from './SimDock.vue'

/* =========================================================
 * 需求映射：
 *  1. 全部运动点沿同一椭圆轨道运动（点尺寸略大，居中）
 *  2. 自然大调 7 个音高（do re mi fa sol la si）各分配一个运动点 → 共 7 个
 *  3. 每个点的运动周期 = 该音音符时值 × 整体缩放；相邻音依次放慢，
 *     形成“由快到慢”的优美视觉节奏；整体缩放可调（倍速）
 *  4. 和弦连线：7 个点的实时位置两两连线，构成随时间呼吸的星形多边形
 *  5. 连线状态可切换：显示 / 隐藏（默认显示）
 *  6. 每个运动点用音高对应颜色（彩虹七色），轨道用较淡同色
 *  7. 顶部/底部信息展示与既有实验页保持同一视觉语言
 * ========================================================= */

/* ---------- 常量 ---------- */
const NOTE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si']
const NOTE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]
const BEAT = 0.6                  // 基础音符时值（秒），整体缩放基准
const MIN_FRAME = 0.05            // 单帧最大 dt
const DEFAULT_SPEED = 1           // 默认倍速（下拉选项 1x/2x/5x/10x）
const RING_BASE_ALPHA = 0.75      // 轨道基础不透明度（最亮）
const CHORD_ALPHA = 0.32          // 连线不透明度
const ORBIT_CX_RATIO = 0.5
const ORBIT_CY_RATIO = 0.56
const AUDIO_DEBUG = true

// 彩虹七色（红橙黄绿蓝靛紫），与音阶一一对应
const RAINBOW_HUES = [0, 30, 55, 130, 205, 240, 285]
function hsl(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)` }
function hsla(h, s, l, a) { return `hsla(${h}, ${s}%, ${l}%, ${a})` }

// 7 个音的运动周期：do 最快，依次放慢（倍数随音序号递增）
const POINTS = NOTE_NAMES.map((name, i) => {
  const h = RAINBOW_HUES[i]
  return {
    i,
    name,
    freq: NOTE_FREQS[i],
    h,
    color: hsl(h, 92, 62),
    light: hsl(h, 96, 82),
    dark: hsl(h, 88, 44),
    period: BEAT * (1 + i * 0.55),  // 相邻音依次放慢，形成由快到慢的节奏
  }
})
const N = POINTS.length

/* ---------- 交互状态 ---------- */
const speedScale = ref(DEFAULT_SPEED)
const playing = ref(false)
const muted = ref(false)
const showChord = ref(true)
const direction = ref(1)           // 1 顺时针 / -1 逆时针
const lastNote = ref(null)         // 最近一次发声的音符（名称+颜色）
const activeIdx = ref(-1)         // 当前高亮发声的点（图例联动）

const canvasRef = ref(null)
const stageRef = ref(null)
const dockRef = ref(null)   // 顶部总控条（SimDock 组件根，供 layout 测量遮挡高度）

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0, h: 0, dpr: 1,
  cx: 0, cy: 0, R: 0,           // 椭圆基准：以圆近似，再按宽高比例拉伸
  rx: 0, ry: 0, dotR: 7,
  ripples: [],
  pos: new Float64Array(N * 2),  // 每个点的实时坐标
}
const orbit = Array.from({ length: N }, () => ({ phase: 0, angle: 0 }))

let rafId = 0
let lastTs = 0
let resizeObserver = null
let realElapsed = 0
let virtElapsed = 0

/* ---------- 音频 runtime ---------- */
let audioCtx = null
let masterGain = null
let resumePromise = null
let audioRetryTimer = 0
let noticeTimer = 0
let highlightTimer = 0
let lastResumeProbe = 0
let pendingSeq = []
const audioStats = { builds: 0, unlockCalls: 0, noteAttempts: 0, notesScheduled: 0, passes: 0 }

/* ---------- 布局 ---------- */
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
  const padT = (dockRef.value && dockRef.value.root ? dockRef.value.root.getBoundingClientRect().bottom - rect.top : 200) + 30
  const padB = 26
  const regionTop = padT
  const regionBottom = Math.max(padT + 120, h - padB)
  const regionH = regionBottom - regionTop

  sim.cx = w * ORBIT_CX_RATIO
  sim.cy = regionTop + regionH / 2
  const availH = regionH
  const availW = w * 0.84
  sim.rx = Math.max(60, Math.min(availW / 2 - 24, availH * 1.35))
  sim.ry = Math.max(48, Math.min(availH / 2 - 14, sim.rx * 0.66))
  sim.dotR = Math.max(5, Math.min(9, sim.rx * 0.02))
}

/* ---------- 控制 ---------- */
function reset() {
  playing.value = false
  unlockAudio()
  sim.ripples.length = 0
  realElapsed = 0
  virtElapsed = 0
  lastNote.value = null
  activeIdx.value = -1
  for (const o of orbit) { o.phase = 0; o.angle = 0 }
}

function togglePlay() {
  playing.value = !playing.value
  unlockAudio()
}

function toggleMute() {
  muted.value = !muted.value
  unlockAudio()
  flashNotice(muted.value ? '声音已关闭（静音）' : '声音已开启', 1400)
}

function setDirection(dir) {
  direction.value = dir
  flashNotice(dir > 0 ? '顺时针' : '逆时针', 1200)
}

/* =========================================================
 * 音频：Web Audio 实时合成（无外部文件）
 * 每个运动点经过椭圆最右侧（即“12 点钟”最高点）时奏响其对应音，
 * 音高 = do re mi fa sol la si（按点序），并做最小间隔节流。
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
    masterGain.gain.value = 0.34
    const comp = audioCtx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 20
    comp.ratio.value = 8
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

function flashNotice(text, ms = 2600) {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { noticeTimer = 0 }, ms)
  void text
}

function flushPending() {
  if (!pendingSeq.length || !audioCtx || audioCtx.state !== 'running') return
  const batch = pendingSeq.splice(0)
  for (const seq of batch) {
    try { if (scheduleNoteNow(seq)) audioStats.notesScheduled++ } catch (e) {}
  }
}

// 单音：指数衰减（钟琴质感），附带一个高八度泛音“叮”
function strike(freq, t0, type, peak, decay) {
  if (!audioCtx || !masterGain) return
  const osc = audioCtx.createOscillator()
  const g = audioCtx.createGain()
  osc.type = type
  osc.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay)
  osc.connect(g)
  g.connect(masterGain)
  osc.start(t0)
  osc.stop(t0 + decay + 0.05)
  osc.onended = () => { osc.disconnect(); g.disconnect() }
}

// 顶点（12 点钟）发声：只有当 ctx 处于 running 且未静音时“真正”发出
function scheduleNoteNow(seq) {
  if (muted.value || !audioCtx || !masterGain || audioCtx.state !== 'running') return false
  const f = POINTS[seq].freq
  const t0 = audioCtx.currentTime
  try {
    strike(f, t0, 'sine', 0.5, 0.85)
    strike(f * 2.01, t0, 'sine', 0.12, 0.26)
    return true
  } catch (err) {
    console.warn('音符调度失败', err)
    return false
  }
}

// 点经过椭圆最右端（角度约 -90°，即 12 点钟顶点）时触发
function onVertex(i) {
  audioStats.passes++
  const p = POINTS[i]
  if (sim.ripples.length < 16) sim.ripples.push({ x: sim.pos[i * 2], y: sim.pos[i * 2 + 1], age: 0, h: p.h })
  lastNote.value = { name: p.name, color: p.color, title: `${p.name}（${p.freq.toFixed(0)}Hz）` }
  activeIdx.value = i
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { activeIdx.value = -1 }, 320)
}

function playNote(seq) {
  if (muted.value) return
  audioStats.noteAttempts++
  if (audioCtx && audioCtx.state === 'running') {
    if (scheduleNoteNow(seq)) audioStats.notesScheduled++
    return
  }
  if (buildAudioGraph()) {
    if (pendingSeq.length < 16) pendingSeq.push(seq)
    unlockAudio()
  }
}

function audioSupervisor() {
  if (!audioCtx) return
  if (audioCtx.state === 'closed') { buildAudioGraph(); return }
  if (audioCtx.state === 'suspended') {
    const now = performance.now()
    if (now - lastResumeProbe > 1000) { lastResumeProbe = now; unlockAudio() }
  }
}

/* ---------- 运动 ---------- */
function updateSim(dt) {
  const scale = Number(speedScale.value) || 1
  realElapsed += dt
  virtElapsed += dt * scale
  for (let i = 0; i < N; i++) {
    const o = orbit[i]
    // 角速度 = 2π / 周期
    const w = (2 * Math.PI) / POINTS[i].period
    const prevAngle = o.angle
    o.angle += direction.value * w * dt * scale
    o.phase += direction.value * w * dt * scale
    // 经过椭圆最右端（角度约 -90°，即 12 点钟顶点）时触发发声与波纹
    let a = o.angle - prevAngle
    // 归一化到 [-π, π]，判断是否跨过 -π/2（顶部）
    let crossed = false
    let t = Math.atan2(Math.sin(prevAngle + Math.PI / 2), Math.cos(prevAngle + Math.PI / 2))
    let t2 = Math.atan2(Math.sin(o.angle + Math.PI / 2), Math.cos(o.angle + Math.PI / 2))
    // 跨过 π→-π 边界处理
    if (t2 - t > Math.PI) t2 -= 2 * Math.PI
    if (t - t2 > Math.PI) t2 += 2 * Math.PI
    crossed = (t <= 0 && t2 >= 0) || (t >= 0 && t2 <= 0)
    void a
    if (crossed) onVertex(i), playNote(i)
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
  updatePositions()
  const ctx = canvas.getContext('2d')
  ctx.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0)
  ctx.clearRect(0, 0, sim.w, sim.h)
  drawRing(ctx)
  drawChords(ctx)
  drawRipples(ctx)
  drawOrigin(ctx)
  drawDots(ctx)
}

function updatePositions() {
  for (let i = 0; i < N; i++) {
    const o = orbit[i]
    // 椭圆参数：以最右端为起点（角度 -90° 即 12 点钟），顺时针运动
    const ang = o.angle
    sim.pos[i * 2] = sim.cx + sim.rx * Math.cos(ang)
    sim.pos[i * 2 + 1] = sim.cy + sim.ry * Math.sin(ang)
  }
}

// 轨道（较淡的彩虹七色描边）
function drawRing(ctx) {
  ctx.save()
  ctx.lineWidth = 1.6
  for (let i = 0; i < N; i++) {
    const p = POINTS[i]
    ctx.strokeStyle = hsla(p.h, 90, 65, RING_BASE_ALPHA * 0.6)
    ctx.beginPath()
    ctx.ellipse(sim.cx, sim.cy, sim.rx, sim.ry, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

// 和弦连线：7 个点两两相连，构成随时间呼吸的星形多边形
function drawChords(ctx) {
  if (!showChord.value) return
  const pos = sim.pos
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 1.4
  ctx.strokeStyle = `rgba(186,230,253,${CHORD_ALPHA})`
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      ctx.moveTo(pos[i * 2], pos[i * 2 + 1])
      ctx.lineTo(pos[j * 2], pos[j * 2 + 1])
    }
  }
  ctx.stroke()
  ctx.restore()
}

function drawRipples(ctx) {
  if (!sim.ripples.length) return
  ctx.save()
  for (const r of sim.ripples) {
    const t = Math.min(r.age / 0.7, 1)
    ctx.beginPath()
    ctx.arc(r.x, r.y, 8 + t * 30, 0, Math.PI * 2)
    ctx.strokeStyle = hsla(r.h ?? 0, 92, 70, (1 - t) * 0.6)
    ctx.lineWidth = 1.8
    ctx.stroke()
  }
  ctx.restore()
}

// 中心原点（七色光晕，寓意和弦中心）
function drawOrigin(ctx) {
  const { cx, cy } = sim
  ctx.save()
  let glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, 30)
  const stops = POINTS.map((p, k) => [k / (N - 1), p.color])
  glow.addColorStop(0, 'rgba(255,255,255,0.9)')
  for (const [pos, color] of stops) glow.addColorStop(pos, hsla(POINTS[Math.round(pos * (N - 1))].h, 92, 65, 0.25))
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(cx, cy, 30, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(226,232,240,0.9)'
  ctx.beginPath()
  ctx.arc(cx, cy, 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawDots(ctx) {
  const pos = sim.pos
  const dotR = sim.dotR
  const active = activeIdx.value
  for (let i = 0; i < N; i++) {
    const p = POINTS[i]
    const x = pos[i * 2]
    const y = pos[i * 2 + 1]
    const glow = ctx.createRadialGradient(x, y, 1, x, y, dotR * 3)
    glow.addColorStop(0, hsla(p.h, 92, 66, 0.45))
    glow.addColorStop(1, hsla(p.h, 92, 66, 0))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, y, dotR * 3, 0, Math.PI * 2)
    ctx.fill()

    const g = ctx.createRadialGradient(x - dotR * 0.35, y - dotR * 0.42, dotR * 0.15, x, y, dotR * 1.3)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.4, p.light)
    g.addColorStop(0.8, p.color)
    g.addColorStop(1, p.dark)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    ctx.fill()
    if (i === active) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
}

/* ---------- 主循环 ---------- */
function tick(ts) {
  rafId = requestAnimationFrame(tick)
  const dt = lastTs ? Math.min(Math.max((ts - lastTs) / 1000, 0), MIN_FRAME) : 0
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

onMounted(() => {
  layout()
  render()
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
  clearTimeout(noticeTimer)
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
    get chord() { return showChord.value },
    get dir() { return direction.value },
    stats: audioStats,
    unlock: () => unlockAudio(),
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
      :show-count="false"
      :speed="speedScale"
      @toggle-play="togglePlay"
      @toggle-mute="toggleMute"
      @reset="reset"
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

.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.seg button {
  border: none;
  background: rgba(15, 23, 42, 0.55);
  color: var(--text-2);
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button.on { background: linear-gradient(135deg, rgba(14,165,233,0.25), rgba(34,211,238,0.25)); color: #e2e8f0; }

.tick {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.tick input { accent-color: #22d3ee; width: 14px; height: 14px; cursor: pointer; }

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
