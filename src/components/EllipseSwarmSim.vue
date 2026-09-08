<script setup>
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import SimDock from './SimDock.vue'

/* =========================================================
 * 需求映射：
 *  1. 页面正中绘制一个椭圆形路径作为运动轨道
 *  2. 椭圆最顶部放置一个固定原点
 *  3. 原点处 145 个运动点，分 10 层：
 *     最快层 19 点，逐层递减，最慢层 10 点（19+18+…+10=145）
 *  4. 运动：每层是一个与轨道相似的椭圆，顶点恒相切于原点，
 *     从原点生长发散 → 整层同时撞上轨道 → 反弹收缩回原点；
 *     层周期 = 90/点数（19 点层最快、10 点层最慢），
 *     → 0s 全部从原点出发，90s 全部同时回归原点
 *  5. 同层同色，10 层按彩虹色序着色
 *  6. 顶部/底部信息展示与既有页面同一视觉语言
 *  7. 连线：仅同一层内、按 rank 相邻的运动点相连（两端端点不连），比圆形路径更淡
 *  8. 撞轨道发声：与圆形轨道碰撞时发声，每层一种固定音（外层 do … 内层依次递增）；回归原点不发声
 * ========================================================= */

/* ---------- 常量 ---------- */
const LAYER_COUNT = 10        // 层数
const CYCLE_SECONDS = 90      // 大周期：0s 出发，90s 全部回归原点
const MAX_FRAME = 0.05        // 单帧最大 dt
const RING_ALPHA = 0.5        // 外部椭圆轨道不透明度（最亮）
const LAYER_RING_ALPHA = 0.2  // 各层当前椭圆（< RING_ALPHA，> 连线）
const LAYER_CHORD_ALPHA = 0.22   // 同层内相邻点连线（比圆形路径更淡，但清晰可见）
const ORIGIN_R = 7            // 原点半径
const MIN_NOTE_GAP = 0.11     // 相邻发声最小真实间隔（层回归约 1.6 次/秒）
const DEFAULT_SPEED = 1       // 默认倍速（下拉选项 1x/2x/5x/10x）
const AUDIO_DEBUG = true      // 调试开关：true 时暴露 window.__ellipseAudio

/* 层 k 的周期数 = 该层点数：19 点层 90s 跑 19 个来回，10 点层跑 10 个。
 * 点数越多 → 越快，与「最快层 19 点、最慢层 10 点」一致，且相邻层仅差一档 */

// 自然大调：do re mi fa sol la si（C4~B4）
const NOTE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]
const NOTE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si']

function hsl(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)` }
function hsla(h, s, l, a) { return `hsla(${h}, ${s}%, ${l}%, ${a})` }
function noteOf(seq) {
  const deg = ((seq % 7) + 7) % 7
  const oct = Math.floor(seq / 7)
  return {
    deg,
    oct,
    freq: NOTE_FREQS[deg] * Math.pow(2, oct),
    name: oct > 0 ? `${NOTE_NAMES[deg]}′` : NOTE_NAMES[deg],
    title: oct > 0 ? `${NOTE_NAMES[deg]}（升 ${oct} 个八度）` : NOTE_NAMES[deg],
  }
}

// 第 k 层点数：k=1 最外最快 → 19；k=10 最内最慢 → 10
function countOfLayer(k) { return 20 - k }
function gcd(a, b) { while (b) { const t = a % b; a = b; b = t } return a }

// 10 层按彩虹色序着色：同层同色，层间红→橙→黄→绿→青→蓝→紫循环
const LAYER_META = Array.from({ length: LAYER_COUNT }, (_, idx) => {
  const k = idx + 1
  const h = Math.round((idx * 360) / LAYER_COUNT) % 360
  return {
    k,
    h,
    color: hsl(h, 92, 62),
    light: hsl(h, 96, 82),
    dark: hsl(h, 88, 44),
  }
})

/* 145 个运动点 = 10 层，第 k 层有 (20-k) 个点。
 *
 * 运动机理（圆形台球：直线飞行 + 入射角 = 反射角）
 *
 * 1) 发散阶段：第 j 个点从原点沿「弦」直线飞出，首次落点在圆周参数角
 *      Δ = 2π·q/p   （q = 2j+1，p = 2·点数）
 *    同一时刻各点进度 u = t/t_hit 相同，故位置 = 原点 + u·(落点 − 原点)，
 *    即所有点始终均匀落在一个「以原点为中心、按 u 缩放的圆」上 —— 层层扩大。
 *    速度 = 弦长/t_hit ∝ sin(Δ/2)：Δ 越接近 π（越靠下）弦越长、越快。
 *    因为速度 ∝ 弦长，整层必定「同一时间」撞上轨道。
 *
 * 2) 碰撞反弹：圆内反射的入射角恒定 ⟹ 每次碰撞点在圆周上前进固定圆心角 Δ，
 *    第 n 个碰撞点 φ(n) = -π/2 + n·Δ，点在其间做匀速直线运动。
 *    这严格等价于入射角 = 反射角（法线即半径，等弦 ⟹ 等入射角）。
 *
 * 3) 回归原点：走满 p 段后恰好绕回原点；90s 内正好走 p 段，故全部同时归零。
 *    t_hit = 90/p = 90/(2·点数+1)，点数越多 → 碰撞越频繁 → 层越快。
 *    取 p = 2·点数+1（奇数）：q=2j+1 也为奇数，q/p 永不可能等于 1/2，
 *    故不存在「直径往返」式的原路返回，每个点都是斜向反弹。
 */
const DOTS = (() => {
  const out = []
  for (let k = 1; k <= LAYER_COUNT; k++) {
    const cnt = countOfLayer(k)
    const meta = LAYER_META[k - 1]
    const p = 2 * cnt + 1                 // 90s 内恰走 p 段（闭合）；取奇数以排除直径
    for (let j = 0; j < cnt; j++) {
      const q = 2 * j + 1                 // 绕圈数；Δ = 2π·q/p
      const g = gcd(q, p)
      const half = (Math.PI * q) / p
      out.push({
        i: out.length,
        layer: k,
        rank: j,
        q,
        p,
        per: p / g,                       // 回到原点所需段数
        delta: (360 * q) / p,             // 每次弹射跨越的圆心角（°）
        chord: 2 * Math.sin(half),        // 弦长（单位 R）
        env: Math.cos(half),              // 包络圆半径系数
        rate: Math.sin(half),             // 相对速率（∝ 弦长）
        h: meta.h,
        color: meta.color,
        light: meta.light,
        dark: meta.dark,
      })
    }
  }
  return out
})()
const TOTAL_POINTS = DOTS.length

// 每层汇总（供图例使用）
const LAYERS = LAYER_META.map((meta) => {
  const members = DOTS.filter((d) => d.layer === meta.k)
  const cnt = members.length
  return {
    k: meta.k,
    h: meta.h,
    color: meta.color,
    count: cnt,
    hit: CYCLE_SECONDS / (2 * cnt + 1),              // 相邻两次碰撞的间隔（秒）
    rateMin: Math.min(...members.map((d) => d.rate)),
    rateMax: Math.max(...members.map((d) => d.rate)),
    envMin: Math.min(...members.map((d) => d.env)),
    envMax: Math.max(...members.map((d) => d.env)),
  }
})

/* ---------- 交互状态 ---------- */
const speedScale = ref(DEFAULT_SPEED)
const playing = ref(false)
const muted = ref(false)
const showLayerChord = ref(true)   // 同层内相邻点连线（两端端点不连）
const showRings = ref(true)         // 是否绘制圆形路径
const showEnv = ref(true)           // 是否绘制各层包络圆
const lastNote = ref(null)
const activeIdx = ref(-1)

const canvasRef = ref(null)
const stageRef = ref(null)
const dockRef = ref(null)   // 顶部总控条（SimDock 组件根，供 layout 测量遮挡高度）

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0, h: 0, dpr: 1,
  cx: 0, cy: 0, R: 0,         // 圆形轨道：圆心与半径
  dotR: 4,
  ripples: [],                // 回归原点时的波纹
  pos: new Float64Array(TOTAL_POINTS * 2),
}
// 原点 = 圆形轨道最顶部
function originX() { return sim.cx }
function originY() { return sim.cy - sim.R }

let rafId = 0
let lastTs = 0
let resizeObserver = null
let realElapsed = 0
let virtElapsed = 0

/* ---------- 布局：圆形路径居中，原点位于圆的最顶部 ---------- */
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
  const padT = (dockRef.value && dockRef.value.root ? dockRef.value.root.getBoundingClientRect().bottom - rect.top : 150) + 18
  const padB = 24
  const regionTop = padT
  const regionBottom = Math.max(padT + 120, h - padB)
  const regionH = regionBottom - regionTop

  sim.cx = w / 2
  sim.cy = regionTop + regionH / 2
  sim.R = Math.max(40, Math.min(w / 2 - 46, regionH / 2 - 10))
  sim.dotR = Math.max(2.4, Math.min(5.4, sim.R * 0.017))
}

/* ---------- 控制 ---------- */
function reset() {
  playing.value = false
  unlockAudio()
  sim.ripples.length = 0
  realElapsed = 0
  virtElapsed = 0
  noteSeq = 0
  lastNote.value = null
  activeIdx.value = -1
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

// 同层连线默认开启（showLayerChord），不再区分「相邻 / 全部」三种模式

/* =========================================================
 * 音频：Web Audio 实时合成（无外部文件）
 * 经过原点的点极多（145 点 × 各自圈数），故做最小间隔节流，
 * 音高仍严格按“经过原点的先后顺序”依次 do re mi … 升调循环
 * ========================================================= */
let audioCtx = null
let masterGain = null
let resumePromise = null
let audioRetryTimer = 0
let noticeTimer = 0
let highlightTimer = 0
let lastResumeProbe = 0
let pendingSeq = []
let noteSeq = 0                 // 经过原点的累计序号 → 决定音高
let lastNoteReal = -1           // 上次发声的真实时间（节流用）
const audioStats = { builds: 0, unlockCalls: 0, noteAttempts: 0, notesScheduled: 0, passes: 0 }

function buildAudioGraph() {
  if (audioCtx && audioCtx.state !== 'closed') return true
  if (audioCtx) { audioCtx = null; masterGain = null }
  const AC = window.AudioContext || window['webkitAudioContext']
  if (!AC) { return false }
  try {
    audioCtx = new AC()
    audioCtx.addEventListener('statechange', onAudioStateChange)
    masterGain = audioCtx.createGain()
    masterGain.gain.value = 0.32
    const comp = audioCtx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 22
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

// 单个正弦音（指数衰减，钟琴质感）
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

function scheduleNoteNow(seq) {
  if (muted.value || !audioCtx || !masterGain || audioCtx.state !== 'running') return false
  const n = noteOf(seq)
  const t0 = audioCtx.currentTime
  try {
    strike(n.freq, t0, 'sine', 0.42, 0.85)
    strike(n.freq * 2.01, t0, 'sine', 0.1, 0.24)
    return true
  } catch (err) {
    console.warn('音符调度失败', err)
    return false
  }
}

// 某个点撞上圆形轨道：该层发出一种固定音（外层 do、内层依次 re mi… 升调）
function playLayerNote(layer) {
  if (muted.value) return
  audioStats.noteAttempts++
  const now = performance.now() / 1000
  if (lastNoteReal >= 0 && now - lastNoteReal < MIN_NOTE_GAP) return
  lastNoteReal = now
  const seq = layer - 1
  const n = noteOf(seq)
  lastNote.value = { seq: layer, name: n.name, title: n.title, h: LAYER_META[layer - 1].h }
  if (audioCtx && audioCtx.state === 'running') {
    if (scheduleNoteNow(seq)) audioStats.notesScheduled++
    return
  }
  if (buildAudioGraph()) {
    if (pendingSeq.length < 24) pendingSeq.push(seq)
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

/* ---------- 运动：圆形台球（直线飞行 + 入射角 = 反射角） ----------
 * 第 n 个碰撞点的圆心角：φ(n) = -π/2 + n·Δ，Δ = 2π·q/p
 * （圆的法线即半径；等弦 ⟹ 各次入射角相同 ⟹ 反射后等角前进，严格满足反射定律）
 * 点在第 n 段弦上匀速直线飞行，段间在碰撞点瞬间改变方向。
 */

// 已走过的总段数（90s 内走满 p 段）
function segProgress(d, t) {
  return (t / CYCLE_SECONDS) * d.p
}

function angleAt(d, n) {
  return -Math.PI / 2 + n * ((2 * Math.PI * d.q) / d.p)
}

function updatePositions() {
  const t = virtElapsed
  const { cx, cy, R } = sim
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const sTot = segProgress(d, t)
    const n = Math.floor(sTot)
    const u = sTot - n
    const a = angleAt(d, n)
    const b = angleAt(d, n + 1)
    const x0 = cx + R * Math.cos(a)
    const y0 = cy + R * Math.sin(a)
    const x1 = cx + R * Math.cos(b)
    const y1 = cy + R * Math.sin(b)
    sim.pos[i * 2] = x0 + (x1 - x0) * u
    sim.pos[i * 2 + 1] = y0 + (y1 - y0) * u
  }
}

// 某个点回到原点（走满 per 段）→ 奏响下一个音
function triggerPass(d) {
  audioStats.passes++
  if (sim.ripples.length < 16) {
    sim.ripples.push({ x: originX(), y: originY(), age: 0, h: d.h })
  }
  activeIdx.value = d.layer - 1
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { activeIdx.value = -1 }, 320)
}

function updateSim(dt) {
  const scale = Number(speedScale.value) || 1
  const prev = virtElapsed
  realElapsed += dt
  virtElapsed += dt * scale
  // 跨过一个完整大周期时，音阶从头开始（do re mi …）
  if (Math.floor(virtElapsed / CYCLE_SECONDS) > Math.floor(prev / CYCLE_SECONDS)) noteSeq = 0

  const hitLayers = new Set()
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const prevF = Math.floor(segProgress(d, prev))
    const nowF = Math.floor(segProgress(d, virtElapsed))
    // 每走满 per 段即回到原点一次（仅视觉波纹，不发声）
    const a = Math.floor(prevF / d.per)
    const b = Math.floor(nowF / d.per)
    if (b > a) {
      const n = Math.min(b - a, 4) // 单帧最多补 4 次，避免极端倍速下爆量
      for (let m = 0; m < n; m++) triggerPass(d)
    }
    // 与圆形轨道碰撞：跨过整数段且落点并非原点（段索引不是 p 的倍数）→ 该层发声
    if (nowF > prevF) {
      const steps = Math.min(nowF - prevF, 4)
      for (let m = 1; m <= steps; m++) {
        const seg = prevF + m         // 刚完成的这一段（1 起）
        if (seg % d.p !== 0) hitLayers.add(d.layer)   // seg%p===0 表示已回到原点
      }
    }
  }
  for (const layer of hitLayers) playLayerNote(layer)

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
  drawRings(ctx)
  drawConnectors(ctx)
  drawRipples(ctx)
  drawOrigin(ctx)
  drawDots(ctx)
}

// 圆形轨道（最亮）+ 各层的包络圆（所有弦相切的同心圆 = 视觉上的「层」）
function drawRings(ctx) {
  const { cx, cy, R } = sim
  ctx.save()
  ctx.lineCap = 'round'
  if (showRings.value) {
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(56,189,248,0.10)'
    ctx.lineWidth = 12
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(148,210,253,${RING_ALPHA})`
    ctx.lineWidth = 1.8
    ctx.stroke()
  }
  if (showEnv.value) {
    ctx.lineWidth = 1
    for (const L of LAYERS) {
      ctx.beginPath()
      ctx.arc(cx, cy, R * ((L.envMin + L.envMax) / 2), 0, Math.PI * 2)
      ctx.strokeStyle = hsla(L.h, 90, 70, LAYER_RING_ALPHA)
      ctx.stroke()
    }
  }
  ctx.restore()
}

// 连线：仅同一层内、按 rank 相邻的运动点相连；每一层左右两个端点之间不连接
function drawConnectors(ctx) {
  if (!showLayerChord.value) return
  const pos = sim.pos
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineWidth = 1
  for (let i = 1; i < TOTAL_POINTS; i++) {
    if (DOTS[i].layer !== DOTS[i - 1].layer) continue   // 仅同层相连；层间与层首尾端点不连
    const h = DOTS[i].h
    ctx.strokeStyle = hsla(h, 90, 72, LAYER_CHORD_ALPHA)
    ctx.beginPath()
    ctx.moveTo(pos[(i - 1) * 2], pos[(i - 1) * 2 + 1])
    ctx.lineTo(pos[i * 2], pos[i * 2 + 1])
    ctx.stroke()
  }
  ctx.restore()
}

function drawRipples(ctx) {
  if (!sim.ripples.length) return
  ctx.save()
  for (const r of sim.ripples) {
    const t = Math.min(r.age / 0.7, 1)
    ctx.beginPath()
    ctx.arc(r.x, r.y, 7 + t * 26, 0, Math.PI * 2)
    ctx.strokeStyle = hsla(r.h, 92, 70, (1 - t) * 0.5)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }
  ctx.restore()
}

// 固定原点（圆形路径最顶部，所有点的出发/回归处）
function drawOrigin(ctx) {
  const ox = originX()
  const oy = originY()
  ctx.save()
  const glow = ctx.createRadialGradient(ox, oy, 2, ox, oy, ORIGIN_R * 3.4)
  glow.addColorStop(0, 'rgba(253,224,71,0.42)')
  glow.addColorStop(1, 'rgba(253,224,71,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(ox, oy, ORIGIN_R * 3.4, 0, Math.PI * 2)
  ctx.fill()
  const body = ctx.createRadialGradient(ox - 2, oy - 3, 1, ox, oy, ORIGIN_R + 2)
  body.addColorStop(0, '#fff7ed')
  body.addColorStop(0.55, '#fcd34d')
  body.addColorStop(1, '#f59e0b')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(ox, oy, ORIGIN_R, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(ox, oy, 1.8, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = '11px system-ui, "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(252,211,77,0.85)'
  ctx.fillText('原点', ox, oy - ORIGIN_R - 8)
  ctx.restore()
}

// 145 个彩虹运动点
function drawDots(ctx) {
  const pos = sim.pos
  const dotR = sim.dotR
  const activeLayer = activeIdx.value + 1   // activeIdx 存的是层序号（0 起）
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const x = pos[i * 2]
    const y = pos[i * 2 + 1]
    const g = ctx.createRadialGradient(
      x - dotR * 0.35, y - dotR * 0.42, dotR * 0.12,
      x, y, dotR * 1.25
    )
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.35, d.light)
    g.addColorStop(0.75, d.color)
    g.addColorStop(1, d.dark)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    ctx.fill()
    if (d.layer === activeLayer) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
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
  window.__ellipseAudio = {
    get ctxState() { return audioCtx ? audioCtx.state : 'none' },
    get playing() { return playing.value },
    get points() { return TOTAL_POINTS },
    get virt() { return virtElapsed },
    get noteSeq() { return noteSeq },
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
.btn:hover { background: rgba(51, 65, 85, 0.85); border-color: rgba(148, 163, 184, 0.4); }
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
.plabel { font-size: 12px; color: var(--text-2); letter-spacing: 0.5px; }
small { font-size: 11px; color: var(--text-3); line-height: 1.4; }

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

@media (max-width: 1080px) { .btn.sound { display: none; } }
</style>
