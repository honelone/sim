<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue'

/* =========================================================
 * 需求映射：
 *  1. 页面正中间绘制一个圆形路径，作为运动点运行轨道
 *  2. 圆形路径最顶部放置一个固定原点
 *  3. 12 个运动点从原点出发，沿圆形路径顺时针/逆时针运行，
 *     方向由用户控制（默认逆时针）；切向时相位镜像保持位置连续
 *  4. 各点速度不同：60s 内第 1 点 1 圈、第 2 点 2 圈 … 第 12 点 12 圈
 *  5. 各点按彩虹色序着色（红→橙→黄→绿→青→蓝→紫…均匀取样）
 *  6. 顶部/底部内容展示风格与 ArcBounceSim（半圆往返页面）保持一致
 *  7. 连线：各运动点两两之间 + 每点与原点之间；连线均比圆形轨道更淡
 *  8. 点经过原点（每跑完一圈）即发声：按点序号 do re mi fa sol la si，
 *     超过 7 个则升一个八度循环（点 8~12 = do'~sol'）
 * ========================================================= */

/* ---------- 常量 ---------- */
const TOTAL_POINTS = 12        // 运动点数量（固定）
const LAP_SECONDS = 60         // 定义周期：第 n 点每 60s 运行 n 圈
const MAX_FRAME = 0.05         // 单帧最大 dt（防后台切回跳变）
const RING_ALPHA = 0.5         // 圆形轨道不透明度
const SPOKE_ALPHA = 0.16       // 点-原点连线不透明度（< RING_ALPHA）
const CHORD_ALPHA = 0.1        // 点间连线不透明度（< RING_ALPHA）
const ORIGIN_R = 7             // 原点半径
const AUDIO_DEBUG = true       // 调试开关：true 时暴露 window.__orbitAudio

// 音阶：do re mi fa sol la si（自然大调 C4~B4）
const NOTE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]
const NOTE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si']
const HUE_STEP = 360 / TOTAL_POINTS

function hsl(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)` }
function hsla(h, s, l, a) { return `hsla(${h}, ${s}%, ${l}%, ${a})` }

// 每个点预生成颜色 + 音符信息（点序号与音符/颜色一一对应）
const DOTS = Array.from({ length: TOTAL_POINTS }, (_, i) => {
  const h = Math.round(i * HUE_STEP) % 360
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

/* ---------- 交互状态（响应式） ---------- */
const direction = ref('ccw')       // ccw 逆时针 / cw 顺时针（默认逆时针）
const speedScale = ref(1)          // 演示倍速（等比压缩周期，不影响 n:1 圈速比）
const playing = ref(false)
const muted = ref(false)
const headerOpen = ref(true)
const panelOpen = ref(true)
const showChord = ref(true)        // 是否绘制点间连线
const showSpoke = ref(true)        // 是否绘制点-原点连线
const lastNote = ref(null)         // 最近一次经过原点奏响的音符

const dirSign = computed(() => (direction.value === 'ccw' ? 1 : -1))
const directionText = computed(() => (direction.value === 'ccw' ? '逆时针' : '顺时针'))

// 音频解锁状态：idle | starting | ready | blocked | unsupported
const audioState = ref('idle')
const audioNotice = ref('')
const blockedClicks = ref(0)

const canvasRef = ref(null)
const stageRef = ref(null)
const dockEl = ref(null)   // 顶部总控条（header + panel 合并后的一体容器）

/* ---------- 音频运行时（非响应式） ---------- */
let audioCtx = null            // AudioContext
let masterGain = null          // 主音量节点
let pendingNotes = []          // ctx 未就绪时排队待补发的音符
let resumePromise = null
let audioRetryTimer = 0
let noticeTimer = 0
let lastResumeProbe = 0
const audioStats = { builds: 0, unlockCalls: 0, notesScheduled: 0, notesFlushed: 0, noteAttempts: 0, passes: 0 }

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0, h: 0, dpr: 1,
  cx: 0, cy: 0, R: 0,
  pts: DOTS.map((d) => ({ i: d.i, num: d.num, f: 0 })), // f∈[0,1) 圈内相位（0=原点）
  ripples: [],                                          // 经过原点时的冲击波纹
}

/* ---------- 计时 ---------- */
let realElapsed = 0
let virtElapsed = 0
let lastLabelTick = 0
let rafId = 0                  // requestAnimationFrame id
let lastTs = 0                 // 上一帧时间戳
let resizeObserver = null      // 画布尺寸自适应
const timeReal = ref('00:00.0')
const timeVirt = ref('00:00.0')

function fmtClock(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const t = Math.floor((s * 10) % 10)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${t}`
}

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

  // header 与 panel 已合并为顶部一条总控条：直接测量它实际遮挡的顶部高度（含与顶部的间距）
  const padT = (dockEl.value ? dockEl.value.getBoundingClientRect().bottom - rect.top : 150) + 18
  const padB = 24
  const regionTop = padT
  const regionBottom = Math.max(padT + 80, h - padB)
  const regionH = regionBottom - regionTop

  sim.cx = w / 2
  sim.cy = regionTop + regionH / 2
  sim.R = Math.max(40, Math.min(w / 2 - 56, regionH / 2 - 8))
}

/* ---------- 重置 / 播放 / 方向 ---------- */
function reset() {
  playing.value = false
  unlockAudio() // 重置按钮在用户手势内，顺带解锁音频
  sim.ripples.length = 0
  for (const p of sim.pts) p.f = 0
  realElapsed = 0
  virtElapsed = 0
  lastLabelTick = 0
  timeReal.value = '00:00.0'
  timeVirt.value = '00:00.0'
  lastNote.value = null
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

// 相位镜像：切换方向时保持各点当前屏幕位置不变，仅让后续运动反向
function mirrorPhase() {
  for (const p of sim.pts) if (p.f !== 0) p.f = 1 - p.f
}

function setDirection(dir) {
  if (direction.value === dir) return
  direction.value = dir
  mirrorPhase()
}

function toggleDirection() {
  setDirection(direction.value === 'ccw' ? 'cw' : 'ccw')
}

/* =========================================================
 * 音频：Web Audio 实时合成（无外部文件）
 * ========================================================= */
function buildAudioGraph() {
  if (audioCtx && audioCtx.state !== 'closed') return true
  if (audioCtx) { audioCtx = null; masterGain = null }
  const AC = window.AudioContext || window['webkitAudioContext']
  if (!AC) { audioState.value = 'unsupported'; return false }
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
    audioState.value = 'blocked'
    return false
  }
  return true
}

function onAudioStateChange() {
  if (!audioCtx) return
  if (audioCtx.state === 'running') {
    audioState.value = 'ready'
    blockedClicks.value = 0
    flushPending()
    if (audioRetryTimer) { clearTimeout(audioRetryTimer); audioRetryTimer = 0 }
  }
}

function unlockAudio() {
  if (!buildAudioGraph()) return Promise.resolve(false)
  audioStats.unlockCalls++
  if (audioCtx.state === 'running') { audioState.value = 'ready'; return Promise.resolve(true) }
  if (audioCtx.state === 'suspended' && !resumePromise) {
    audioState.value = 'starting'
    resumePromise = audioCtx.resume().then(
      () => { resumePromise = null; return !!(audioCtx && audioCtx.state === 'running') },
      () => {
        resumePromise = null
        audioState.value = 'blocked'
        scheduleRetry()
        return false
      }
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
  audioNotice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (audioNotice.value = ''), ms)
}

function flushPending() {
  if (!pendingNotes.length || !audioCtx || audioCtx.state !== 'running') return
  const batch = pendingNotes.splice(0)
  for (const i of batch) { try { if (scheduleNoteNow(i)) audioStats.notesFlushed++ } catch (e) {} }
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

// 真正调度音符：仅在 ctx running 且未静音时执行
function scheduleNoteNow(i) {
  if (muted.value || !audioCtx || !masterGain || audioCtx.state !== 'running') return false
  const t0 = audioCtx.currentTime
  const f = DOTS[i].freq
  try {
    strike(f, t0, 'sine', 0.5, 1.0)              // 基音
    strike(f * 2.01, t0, 'sine', 0.12, 0.3)     // 八度泛音“叮”
    strike(f * 4.07, t0, 'sine', 0.05, 0.12)    // 高频亮色
    audioStats.notesScheduled++
    return true
  } catch (err) { console.warn('音符调度失败', err); return false }
}

// 第 i 个点经过原点时发声；ctx 未解锁时入队待补发
function playPassNote(i) {
  audioStats.noteAttempts++
  if (muted.value) return
  if (audioCtx && audioCtx.state === 'running') { scheduleNoteNow(i); return }
  if (buildAudioGraph()) {
    if (pendingNotes.length < 32) pendingNotes.push(i)
    unlockAudio()
  }
}

// “试听”按钮：用户手势内解锁并弹一个 do
async function testSound() {
  if (muted.value) { flashNotice('已静音：请先点击“音效开/静音”开启声音', 2400); return }
  const ok = await unlockAudio()
  if (audioState.value === 'unsupported') { flashNotice('当前浏览器不支持 Web Audio，无法发声', 3800); return }
  if (!ok || (audioCtx && audioCtx.state !== 'running')) {
    blockedClicks.value++
    if (blockedClicks.value >= 2) {
      flashNotice('浏览器一直拦截本站声音：请点地址栏左侧图标→将本站设为“允许声音”，或在新标签页打开本页后重试', 5200)
    } else {
      flashNotice('音频被浏览器拦截：本次点击即是解锁动作，请再点一次“试听”', 3600)
    }
    return
  }
  blockedClicks.value = 0
  const played = scheduleNoteNow(0)
  flashNotice(played ? '已播放 do 试听音；若仍听不到：检查系统音量/耳机、标签页是否被静音' : '试听调度失败：请检查系统音量与输出设备', 4600)
}

function audioSupervisor() {
  if (!audioCtx) return
  if (audioCtx.state === 'closed') { buildAudioGraph(); return }
  if (audioCtx.state === 'suspended') {
    const now = performance.now()
    if (now - lastResumeProbe > 1000) { lastResumeProbe = now; unlockAudio() }
  }
}

const audioChipText = computed(() => {
  if (audioNotice.value) return audioNotice.value
  switch (audioState.value) {
    case 'idle': return '音频：待启动'
    case 'starting': return '音频：解锁中…'
    case 'ready': return muted.value ? '音频：就绪 · 已静音' : '音频：就绪'
    case 'blocked': return '⚠ 音频被浏览器拦截'
    case 'unsupported': return '⚠ 不支持 Web Audio'
    default: return '音频：未知状态'
  }
})
const audioChipCls = computed(() => {
  if (audioNotice.value) return 'notice'
  return audioState.value === 'ready' ? (muted.value ? 'ok muted' : 'ok') : 'warn'
})
const audioChipTitle = computed(() => {
  if (audioState.value === 'blocked') {
    return '浏览器自动播放策略拦截了本站音频。请连续点击“试听”1~2 次（点击本身即解锁动作）；若仍失败，请点击地址栏左侧图标将本站设为“允许声音”'
  }
  if (audioState.value === 'ready') {
    return '音频已就绪：Web Audio 实时合成（无外部文件）。若听不到声音请检查系统音量/输出设备/标签页是否被静音'
  }
  return '经过音效由 Web Audio 实时合成；首次使用请点击“试听”或“播放”解锁'
})

/* ---------- 运动物理：点速 = 序号 n 圈/60s，圈相位在原点处清零检测 ---------- */
function triggerPass(i) {
  audioStats.passes++
  playPassNote(i)
  const ox = sim.cx
  const oy = sim.cy - sim.R
  sim.ripples.push({ x: ox, y: oy, age: 0, h: DOTS[i].h })
  if (sim.ripples.length > 20) sim.ripples.shift()
  lastNote.value = { num: DOTS[i].num, name: DOTS[i].name, color: DOTS[i].color, title: DOTS[i].title }
}

function updateSim(dt) {
  const scale = Number(speedScale.value) || 1
  const d = dirSign.value
  realElapsed += dt
  virtElapsed += dt * scale
  for (const p of sim.pts) {
    const step = (d * p.num * scale * dt) / LAP_SECONDS // 本帧移动量（圈）
    const raw = p.f + step
    const crossed = Math.floor(raw)                     // f∈[0,1)：floor 即跨过原点的整圈数
    if (crossed !== 0) {
      const c = Math.abs(crossed)
      for (let k = 0; k < c; k++) triggerPass(p.i)
    }
    p.f = raw - Math.floor(raw)
  }
  for (let i = sim.ripples.length - 1; i >= 0; i--) {
    sim.ripples[i].age += dt
    if (sim.ripples[i].age > 0.8) sim.ripples.splice(i, 1)
  }
}

/* ---------- 渲染 ---------- */
function posOf(f, R) {
  const rr = R === undefined ? sim.R : R
  const th = Math.PI * 2 * f
  const d = dirSign.value // CCW(d=1)：相位增大 → 顶部→左→下→右（视觉逆时针）
  return {
    x: sim.cx - d * rr * Math.sin(th),
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

// 各点与原点连线 + 各运动点两两连线（都比轨道淡）
function drawConnectors(ctx) {
  if (showSpoke.value || showChord.value) {
    ctx.save()
    ctx.lineCap = 'round'
  }
  const ox = sim.cx
  const oy = sim.cy - sim.R // 原点=轨道最顶部
  const n = sim.pts.length

  // 每个运动点 → 原点
  if (showSpoke.value) {
    ctx.lineWidth = 1
    for (const p of sim.pts) {
      const pt = posOf(p.f)
      ctx.strokeStyle = hsla(DOTS[p.i].h, 92, 66, SPOKE_ALPHA)
      ctx.beginPath()
      ctx.moveTo(ox, oy)
      ctx.lineTo(pt.x, pt.y)
      ctx.stroke()
    }
  }

  // 各运动点两两之间
  if (showChord.value) {
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
    ctx.strokeStyle = hsla(r.h ?? DOTS[0].h, 92, 68, (1 - t) * 0.7)
    ctx.lineWidth = 2
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
  for (const p of sim.pts) {
    const pt = posOf(p.f)
    const c = DOTS[p.i]
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
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = 1
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
    if (ts - lastLabelTick >= 100) {
      lastLabelTick = ts
      timeReal.value = fmtClock(realElapsed)
      timeVirt.value = fmtClock(virtElapsed)
    }
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
  } else if (e.key === 'd' || e.key === 'D') {
    toggleDirection()
  }
}

watch([headerOpen, panelOpen], async () => { await nextTick(); layout() })

onMounted(() => {
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
  clearTimeout(noticeTimer)
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
    get direction() { return direction.value },
    stats: audioStats,
    unlock: () => unlockAudio(),
  }
}
</script>

<template>
  <div class="sim-root">
    <!-- 主运行区：画布占满视口，信息条悬浮其上 -->
    <div class="stage" ref="stageRef">
      <canvas ref="canvasRef" class="sim-canvas"></canvas>
    </div>

      <!-- ================= 顶部总控条：标题/状态/操作 + 控制/图例 合并为一条悬浮卡片 ================= -->
      <div class="dock" ref="dockEl">
        <!-- 第一行：标题（左） + 状态与操作（右）；中间留白，避开顶部居中的页面切换器 -->
        <header v-if="headerOpen" class="dock-head">
        <h1 title="页面正中的圆形轨道，顶部固定原点；12 个点从原点出发按各自圈速绕行，回到原点即奏响对应音符">圆轨十二音 · 环形轨道 · 变速经过音</h1>
        <div class="header-actions">
          <span class="clock-chip" title="播放自开始/重置以来的实际流逝时间">
            <b>运行</b><em>{{ timeReal }}</em>
          </span>
          <span class="clock-chip" title="等效时间 = 实际时间 × 倍速（规则中的 60s 周期按等效时间计）">
            <b>等效</b><em>{{ timeVirt }}</em>
          </span>
          <span
            class="note-chip"
            :class="{ lit: lastNote }"
            title="最近一次运动点回到原点（经过原点）时奏响的音符"
          >
            <i class="note-dot" :style="lastNote ? { background: lastNote.color } : null"></i>
            <template v-if="lastNote">点{{ lastNote.num }} · {{ lastNote.name }}</template>
            <template v-else>—</template>
          </span>
          <span class="audio-state" :class="audioChipCls" :title="audioChipTitle">
            <i></i>{{ audioChipText }}
          </span>
          <button class="btn ghost sound" :class="{ muted }" @click="toggleMute" :title="muted ? '开启经过音效' : '关闭经过音效'">
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
          <button class="btn ghost" @click="testSound" title="立即播放一个 do，用于验证声音并解锁浏览器限制">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            试听
          </button>
          <button class="btn ghost" @click="reset" title="重置到原点 (R)">
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
          <button class="icon-btn collapse" title="收起顶部信息栏" @click="headerOpen = false">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg>
          </button>
        </div>
      </header>

      <!-- 第一行收起后的极简状态条 -->
      <div v-else class="dock-head mini-top">
        <button class="icon-btn" title="展开顶部信息栏" @click="headerOpen = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <span class="mini-state" :class="{ running: playing }"><i></i>{{ playing ? '运行中' : '已暂停' }}</span>
        <span class="mini-clock"><b>运行</b>{{ timeReal }}</span>
        <span class="mini-clock"><b>等效</b>{{ timeVirt }}</span>
        <span class="mini-clock dir" title="切换方向快捷键：D">方向 {{ directionText }}<button class="mini-dir" @click="toggleDirection">换向</button></span>
        <span class="mini-note">12 点 · 第 n 点每 60s 转 n 圈 · {{ directionText }}</span>
        <button class="btn ghost mini-reset" @click="reset" title="重置 (R)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
          重置
        </button>
        <button class="mini-play" :class="{ paused: !playing }" @click="togglePlay" title="播放/暂停 (空格)">
          <svg v-if="playing" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.9l11-6.5a1 1 0 0 0 0-1.8l-11-6.5A1 1 0 0 0 8 5.5Z" />
          </svg>
          {{ playing ? '暂停' : '播放' }}
        </button>
      </div>

      <!-- 第二行：原底部控制栏（控制项） -->
      <section v-if="panelOpen" class="dock-body">
        <div class="panel-row controls-row">
          <div class="pgroup">
            <span class="plabel">运行方向</span>
            <div class="seg">
              <button
                class="seg-btn"
                :class="{ on: direction === 'ccw' }"
                @click="setDirection('ccw')"
                title="逆时针运行（默认）；快捷键 D"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                逆时针
              </button>
              <button
                class="seg-btn"
                :class="{ on: direction === 'cw' }"
                @click="setDirection('cw')"
                title="顺时针运行；快捷键 D"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>
                顺时针
              </button>
            </div>
            <small>12 个点统一换向；默认逆时针</small>
          </div>

          <div class="pgroup grow">
            <span class="plabel">演示倍速</span>
            <div class="range-row">
              <input
                class="range"
                type="range"
                min="0.25"
                max="10"
                step="0.25"
                v-model.number="speedScale"
                title="等比缩放所有点的角速度，不改变“第 n 点 = n 圈/60s”的比例"
              />
              <output>×{{ speedScale }}</output>
            </div>
            <small>60s 内第 1 点 1 圈、第 2 点 2 圈 … 第 12 点 12 圈</small>
          </div>

          <div class="pgroup">
            <span class="plabel">连线显示</span>
            <label class="tick"><input type="checkbox" v-model="showChord" />各点之间连线</label>
            <label class="tick"><input type="checkbox" v-model="showSpoke" />各点─原点连线</label>
            <small>连线均比圆形轨道更淡</small>
          </div>
          <button class="icon-btn collapse" title="收起底部控制栏" @click="panelOpen = false">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>
      </section>

      <button v-else class="panel-fab" title="展开底部控制栏" @click="panelOpen = true">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
        控制
      </button>
    </div>
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

/* ---------- 顶部总控条：header + panel 合并成一条悬浮玻璃卡片 ---------- */
.dock {
  position: absolute;
  top: 40px;                     /* 让开顶部居中的页面切换器 */
  left: clamp(8px, 1.6vw, 20px);
  right: clamp(8px, 1.6vw, 20px);
  z-index: 6;
  display: flex;
  flex-direction: column;
  padding: 0 clamp(12px, 2vw, 24px);
  border: 1px solid var(--border);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(8, 13, 26, 0.92), rgba(15, 23, 42, 0.74));
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 40px rgba(2, 6, 23, 0.5);
}

/* 第一行：行内左右分栏 —— 标题在左，状态/操作在右，中间留白 */
.dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: nowrap;
  min-height: 44px;
  padding: 8px 0;
}
.dock-head h1 {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3px;
  white-space: nowrap;
  flex: none;
  background: linear-gradient(90deg, #e0f2fe, #7dd3fc 60%, #22d3ee);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.header-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: nowrap;
  justify-content: flex-end;
  min-width: 0;
}
.clock-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(56, 189, 248, 0.28);
  background: rgba(15, 23, 42, 0.55);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.clock-chip b {
  color: var(--text-3);
  font-weight: 500;
}
.clock-chip em {
  color: #7dd3fc;
  font-style: normal;
  font-weight: 600;
}
.note-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(15, 23, 42, 0.55);
  color: var(--text-2);
  white-space: nowrap;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.note-chip.lit {
  border-color: rgba(56, 189, 248, 0.5);
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.18);
  color: #e2e8f0;
}
.note-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  background: var(--text-3);
  box-shadow: 0 0 6px currentColor;
}
.audio-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(15, 23, 42, 0.55);
  color: var(--text-2);
  max-width: 230px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.audio-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex: none;
}
.audio-state.ok { border-color: rgba(74, 222, 128, 0.35); }
.audio-state.ok i { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.8); }
.audio-state.ok.muted i { background: #fbbf24; box-shadow: none; }
.audio-state.warn { border-color: rgba(251, 191, 36, 0.4); color: #fcd34d; }
.audio-state.warn i { background: #fbbf24; }
.audio-state.notice { border-color: rgba(56, 189, 248, 0.4); color: #7dd3fc; }
.audio-state.notice i { background: #38bdf8; }

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

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  flex: none;
  border: 1px solid var(--border);
  background: rgba(30, 41, 59, 0.6);
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.icon-btn:hover {
  color: #e2e8f0;
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
}

/* ---------- 顶部收起后的极简状态条 ---------- */
.mini-top {
  gap: 10px;
  padding: 7px 0;
  flex-wrap: wrap;
}
.mini-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
.mini-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}
.mini-state.running i {
  background: #4ade80;
  animation: pulse 1.4s infinite;
}
.mini-clock {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #7dd3fc;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  border: 1px solid rgba(56, 189, 248, 0.28);
  background: rgba(15, 23, 42, 0.55);
  padding: 4px 10px;
  border-radius: 999px;
}
.mini-clock b { color: var(--text-3); font-weight: 500; }
.mini-clock.dir { color: var(--text-2); }
.mini-dir {
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.12);
  color: #7dd3fc;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
  line-height: 1.5;
}
.mini-dir:hover { background: rgba(56, 189, 248, 0.25); }
.mini-note {
  flex: 1;
  min-width: 200px;
  text-align: right;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  background: linear-gradient(135deg, #0ea5e9, #22d3ee);
  color: #03131f;
  font-weight: 700;
  border-radius: 999px;
  padding: 6px 13px;
  font-size: 13px;
  min-width: 84px;
  cursor: pointer;
}
.mini-play:active { transform: scale(0.96); }
.mini-reset { padding: 5px 11px; border-radius: 999px; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.55); }
  70% { box-shadow: 0 0 0 7px rgba(74, 222, 128, 0); }
  100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
}

/* 第二、三行：原底部控制栏内容，与第一行上下堆叠 */
.dock-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0 10px;
  border-top: 1px dashed rgba(148, 163, 184, 0.2);
}
.panel-row {
  display: flex;
  align-items: flex-end;
  gap: clamp(16px, 3vw, 36px);
  flex-wrap: wrap;
}
.panel-row .collapse { margin-left: auto; align-self: flex-start; flex: none; }
.panel-fab {
  align-self: flex-end;
  margin: 0 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: rgba(15, 23, 42, 0.78);
  color: #7dd3fc;
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 18px rgba(2, 6, 23, 0.4);
  transition: all 0.15s;
}
.panel-fab:hover { background: rgba(56, 189, 248, 0.16); border-color: #38bdf8; }
.pgroup { min-width: 150px; display: flex; flex-direction: column; gap: 6px; }
.pgroup.grow { flex: 1; min-width: 220px; max-width: 440px; }
.plabel {
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.5px;
}
small { font-size: 11px; color: var(--text-3); line-height: 1.4; }

/* 方向切换 */
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: rgba(2, 6, 23, 0.55);
}
.seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.16s;
  white-space: nowrap;
}
.seg-btn + .seg-btn { border-left: 1px solid var(--border); }
.seg-btn:hover { color: #e2e8f0; }
.seg-btn.on {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.32), rgba(34, 211, 238, 0.18));
  color: #e0f2fe;
  font-weight: 600;
}

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

@media (max-width: 1440px) {
  .dock-head .note-chip { display: none; }
}
@media (max-width: 1280px) {
  .dock-head .audio-state { display: none; }
}
@media (max-width: 1180px) {
  .dock-head .btn.sound { display: none; }
}
@media (max-width: 1080px) {
  .dock-head .clock-chip { display: none; }
}
/* 窄屏：第一行允许换行（标题独占一行），避免与顶部切换器抢空间 */
@media (max-width: 820px) {
  .dock-head { flex-wrap: wrap; justify-content: center; }
  .dock-head h1 { width: 100%; text-align: center; }
}

</style>
