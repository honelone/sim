<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue'

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
 *  7. 连线：各点之间 + 各点─原点，均比椭圆轨道更淡
 *  8. 经过原点发声：按经过顺序 do re mi fa sol la si，超 7 个升调循环
 * ========================================================= */

/* ---------- 常量 ---------- */
const LAYER_COUNT = 10        // 层数
const CYCLE_SECONDS = 90      // 大周期：0s 出发，90s 全部回归原点
const MAX_FRAME = 0.05        // 单帧最大 dt
const RING_ALPHA = 0.5        // 外部椭圆轨道不透明度（最亮）
const LAYER_RING_ALPHA = 0.2  // 各层当前椭圆（< RING_ALPHA，> 连线）
const SPOKE_ALPHA = 0.13      // 点─原点连线（< RING_ALPHA）
const CHORD_ALPHA = 0.08      // 点间连线（< RING_ALPHA）
const ORIGIN_R = 7            // 原点半径
const MIN_NOTE_GAP = 0.11     // 相邻发声最小真实间隔（层回归约 1.6 次/秒）
const DEFAULT_SPEED = 0.5     // 默认倍速（整体放慢，便于观察一层层的发散）
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
const headerOpen = ref(true)
const panelOpen = ref(true)
const chordMode = ref('adjacent')   // off | adjacent | full
const showSpoke = ref(true)
const showRings = ref(true)         // 是否绘制圆形路径
const showEnv = ref(true)           // 是否绘制各层包络圆
const lastNote = ref(null)
const activeIdx = ref(-1)
const passed = ref(0)               // 累计经过原点次数

const audioState = ref('idle')
const audioNotice = ref('')
const blockedClicks = ref(0)

const canvasRef = ref(null)
const stageRef = ref(null)
const headerEl = ref(null)
const miniEl = ref(null)
const panelEl = ref(null)

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
let lastLabelTick = 0
const timeReal = ref('00:00.0')
const timeVirt = ref('00:00.0')

function fmtClock(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const t = Math.floor((s * 10) % 10)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${t}`
}
function fmtMMSS(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/* ---------- 布局：圆形路径居中，原点位于圆的最顶部 ---------- */
function measure(el) {
  return el && el.getBoundingClientRect ? el.getBoundingClientRect().height : 0
}

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

  const headerH = headerOpen.value ? measure(headerEl.value) || 52 : measure(miniEl.value) || 42
  const panelH = panelOpen.value ? measure(panelEl.value) || 150 : 0
  const padT = headerH + 22
  const padB = panelH + 26
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
  lastLabelTick = 0
  timeReal.value = '00:00.0'
  timeVirt.value = '00:00.0'
  lastNote.value = null
  activeIdx.value = -1
  passed.value = 0
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

const progress = computed(() => Math.min(virtElapsed / CYCLE_SECONDS, 1))
const virtLabel = computed(() => fmtMMSS(virtElapsed % CYCLE_SECONDS))
const chordModeText = computed(() => {
  return chordMode.value === 'full' ? '全部两两' : chordMode.value === 'adjacent' ? '相邻点' : '关闭'
})

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
  if (!AC) { audioState.value = 'unsupported'; return false }
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
      () => { resumePromise = null; audioState.value = 'blocked'; scheduleRetry(); return false }
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

// 某个点经过原点：按经过顺序取下一个音（节流避免 145 点同时回归时爆音）
function playPassNote() {
  audioStats.noteAttempts++
  if (muted.value) return
  const now = performance.now() / 1000
  if (lastNoteReal >= 0 && now - lastNoteReal < MIN_NOTE_GAP) return
  lastNoteReal = now
  const seq = noteSeq++ // 被节流丢弃的经过不消耗音序号，保证音阶连续
  const n = noteOf(seq)
  lastNote.value = { seq: seq + 1, name: n.name, title: n.title, h: (seq * 51) % 360 }
  if (audioCtx && audioCtx.state === 'running') {
    if (scheduleNoteNow(seq)) audioStats.notesScheduled++
    return
  }
  if (buildAudioGraph()) {
    if (pendingSeq.length < 24) pendingSeq.push(seq)
    unlockAudio()
  }
}

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
  const played = scheduleNoteNow(noteSeq)
  flashNotice(played ? '已播放试听音；若仍听不到：检查系统音量/耳机、标签页是否被静音' : '试听调度失败：请检查系统音量与输出设备', 4600)
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
    return '音频已就绪：Web Audio 实时合成（无外部文件）。经过原点的点极多，已按最小间隔节流，音高仍严格依次 do re mi fa sol la si 升调循环'
  }
  return '经过音效由 Web Audio 实时合成；首次使用请点击“试听”或“播放”解锁'
})

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
  passed.value++
  playPassNote()
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

  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    // 每走满 per 段即回到原点一次
    const a = Math.floor(segProgress(d, prev) / d.per)
    const b = Math.floor(segProgress(d, virtElapsed) / d.per)
    if (b > a) {
      const n = Math.min(b - a, 4) // 单帧最多补 4 次，避免极端倍速下爆量
      for (let m = 0; m < n; m++) triggerPass(d)
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

// 连线：各点─原点 + 各点之间（均比椭圆轨道更淡）
function drawConnectors(ctx) {
  const ox = originX()
  const oy = originY()
  const pos = sim.pos
  ctx.save()
  ctx.lineCap = 'round'

  if (showSpoke.value) {
    ctx.lineWidth = 1
    for (let i = 0; i < TOTAL_POINTS; i++) {
      ctx.strokeStyle = hsla(DOTS[i].h, 92, 68, SPOKE_ALPHA)
      ctx.beginPath()
      ctx.moveTo(ox, oy)
      ctx.lineTo(pos[i * 2], pos[i * 2 + 1])
      ctx.stroke()
    }
  }

  if (chordMode.value === 'adjacent') {
    ctx.lineWidth = 0.8
    ctx.strokeStyle = `rgba(190,214,255,${CHORD_ALPHA})`
    ctx.beginPath()
    for (let i = 0; i < TOTAL_POINTS - 1; i++) {
      ctx.moveTo(pos[i * 2], pos[i * 2 + 1])
      ctx.lineTo(pos[(i + 1) * 2], pos[(i + 1) * 2 + 1])
    }
    ctx.stroke()
  } else if (chordMode.value === 'full') {
    ctx.lineWidth = 0.6
    ctx.strokeStyle = `rgba(190,214,255,${CHORD_ALPHA * 0.7})`
    ctx.beginPath()
    for (let i = 0; i < TOTAL_POINTS; i++) {
      const ax = pos[i * 2]
      const ay = pos[i * 2 + 1]
      for (let j = i + 1; j < TOTAL_POINTS; j++) {
        ctx.moveTo(ax, ay)
        ctx.lineTo(pos[j * 2], pos[j * 2 + 1])
      }
    }
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
  }
}

watch([headerOpen, panelOpen], async () => { await nextTick(); layout() })

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

    <!-- ================= 顶部：标题 + 状态/操作条（悬浮可折叠） ================= -->
    <header v-if="headerOpen" ref="headerEl" class="sim-header">
      <h1 title="页面正中的椭圆形轨道，最顶部固定原点；145 个点分 10 层，每层是一个与轨道相似的椭圆、顶点恒相切于原点，从原点一层层发散扩大，整层同时撞上轨道后反弹收缩回原点，90s 后全部同时归零，回归时依次奏响 do re mi fa sol la si（升调循环）">层叠发散 · 145 点 10 层 · 归零音阶</h1>
      <div class="header-actions">
        <span class="clock-chip" title="播放自开始/重置以来的实际流逝时间">
          <b>运行</b><em>{{ timeReal }}</em>
        </span>
        <span class="clock-chip" title="等效时间 = 实际时间 × 倍速。每 90s（等效）所有点同时回归原点一次">
          <b>等效</b><em>{{ virtLabel }}</em><span class="clock-den">/1:30</span>
        </span>
        <span class="clock-chip pass-chip" title="累计经过原点的次数">
          <b>过原点</b><em>{{ passed }}</em>
        </span>
        <span
          class="note-chip"
          :class="{ lit: lastNote }"
          title="最近一次运动点经过原点时奏响的音符（按经过顺序 do re mi fa sol la si 升调循环）"
        >
          <i class="note-dot" :style="lastNote ? { background: `hsl(${lastNote.h}, 92%, 62%)` } : null"></i>
          <template v-if="lastNote">第{{ lastNote.seq }}音 · {{ lastNote.name }}</template>
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
        <button class="btn ghost" @click="testSound" title="立即播放下一个音，用于验证声音并解锁浏览器限制">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          试听
        </button>
        <button class="btn ghost" @click="reset" title="重置：所有点回到原点 (R)">
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

    <!-- 顶部收起后的极简状态条 -->
    <div v-else ref="miniEl" class="mini-top">
      <button class="icon-btn" title="展开顶部信息栏" @click="headerOpen = true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <span class="mini-state" :class="{ running: playing }"><i></i>{{ playing ? '运行中' : '已暂停' }}</span>
      <span class="mini-clock"><b>运行</b>{{ timeReal }}</span>
      <span class="mini-clock"><b>等效</b>{{ virtLabel }} / 1:30</span>
      <span class="mini-note">145 点 · 10 层（19 点层最快 → 10 点层最慢） · 层层发散撞轨反弹 · 90s 全部归零</span>
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

    <!-- ================= 底部：控制 + 图例（悬浮可折叠） ================= -->
    <section v-if="panelOpen" ref="panelEl" class="panel">
      <div class="panel-row controls-row">
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
              title="等比缩放所有点的运动速度，不改变各层的相对快慢"
            />
            <output>×{{ speedScale }}</output>
          </div>
          <small>0s 全部从原点发散 → 90s 全部同时回归原点（默认 ×0.5 放慢观察）</small>
        </div>

        <div class="pgroup">
          <span class="plabel">点间连线</span>
          <div class="seg">
            <button class="seg-btn" :class="{ on: chordMode === 'off' }" @click="chordMode = 'off'" title="不绘制点间连线">关闭</button>
            <button class="seg-btn" :class="{ on: chordMode === 'adjacent' }" @click="chordMode = 'adjacent'" title="按速度顺序连接相邻的两个点（144 条，性能友好）">相邻点</button>
            <button class="seg-btn" :class="{ on: chordMode === 'full' }" @click="chordMode = 'full'" title="145 个点两两相连（10440 条，可能影响帧率）">全部</button>
          </div>
          <small>连线比圆形路径更淡</small>
        </div>

        <div class="pgroup">
          <span class="plabel">显示开关</span>
          <label class="tick"><input type="checkbox" v-model="showSpoke" />各点─原点连线</label>
          <label class="tick"><input type="checkbox" v-model="showRings" />圆形路径</label>
          <label class="tick"><input type="checkbox" v-model="showEnv" />各层椭圆</label>
          <small>共 {{ TOTAL_POINTS }} 点 · 当前 {{ chordModeText }}</small>
        </div>
        <button class="icon-btn collapse" title="收起底部控制栏" @click="panelOpen = false">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>

      <div class="panel-row legend-row">
        <span class="lg-title">10 层（快→慢）· 同层同色</span>
        <span
          v-for="L in LAYERS"
          :key="L.k"
          class="lg-chip"
          :title="`第 ${L.k} 层：${L.count} 个点均匀分布 · 90s 内弹射 ${2 * L.count} 段并回到原点 · 相邻两次碰撞间隔 ${L.hit.toFixed(2)}s · 层内速率比 最快/最慢 = ${(L.rateMax / Math.max(L.rateMin, 1e-6)).toFixed(1)}∶1`"
        >
          <i class="lg-dot" :style="{ background: L.color }"></i>
          <b>{{ L.count }}</b>
          <em>{{ L.hit.toFixed(2) }}s</em>
        </span>
        <span class="rainbow" title="10 层按彩虹色序着色（红→橙→黄→绿→青→蓝→紫）"></span>
        <span class="lg-note">音效：按经过原点顺序 do re mi fa sol la si，超 7 个升调循环</span>
      </div>
    </section>

    <button v-else class="panel-fab" title="展开底部控制栏" @click="panelOpen = true">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
      控制
    </button>
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

/* ---------- header（悬浮半透明毛玻璃） ---------- */
.sim-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: nowrap;
  padding: 8px clamp(16px, 3vw, 32px);
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(8, 13, 26, 0.85), rgba(15, 23, 42, 0.5) 75%, rgba(15, 23, 42, 0));
  backdrop-filter: blur(10px);
}
.sim-header h1 {
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
.clock-chip b { color: var(--text-3); font-weight: 500; }
.clock-chip em { color: #7dd3fc; font-style: normal; font-weight: 600; }
.clock-den { color: var(--text-3); font-size: 11px; font-weight: 500; }
.pass-chip em { color: #a5b4fc; }
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
.audio-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex: none; }
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
.icon-btn:hover { color: #e2e8f0; border-color: #38bdf8; background: rgba(56, 189, 248, 0.12); }

/* ---------- 顶部收起后的极简状态条 ---------- */
.mini-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  flex-wrap: wrap;
  background: linear-gradient(180deg, rgba(8, 13, 26, 0.9), rgba(15, 23, 42, 0.6));
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(10px);
}
.mini-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); white-space: nowrap; }
.mini-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
.mini-state.running i { background: #4ade80; animation: pulse 1.4s infinite; }
.mini-clock {
  display: inline-flex;
  align-items: baseline;
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
.mini-note {
  flex: 1;
  min-width: 220px;
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

/* ---------- panel（悬浮底部，可折叠） ---------- */
.panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px clamp(14px, 2.5vw, 28px) 12px;
  background: linear-gradient(0deg, rgba(8, 13, 26, 0.9), rgba(15, 23, 42, 0.6) 85%, rgba(15, 23, 42, 0));
  border-top: 1px solid var(--border);
  backdrop-filter: blur(12px);
}
.panel-row {
  display: flex;
  align-items: flex-end;
  gap: clamp(16px, 3vw, 36px);
  flex-wrap: wrap;
  padding-right: 34px;
}
.panel-row .collapse { position: absolute; top: 10px; right: 10px; }
.legend-row {
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(148, 163, 184, 0.16);
}
.panel-fab {
  position: absolute;
  bottom: 14px;
  right: clamp(14px, 3vw, 30px);
  z-index: 7;
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
.plabel { font-size: 12px; color: var(--text-2); letter-spacing: 0.5px; }
small { font-size: 11px; color: var(--text-3); line-height: 1.4; }

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
  padding: 7px 13px;
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
.tick input { accent-color: #22d3ee; width: 14px; height: 14px; cursor: pointer; }

/* 图例 */
.lg-title { font-size: 12px; color: var(--text-3); white-space: nowrap; flex: none; }
.lg-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: rgba(15, 23, 42, 0.4);
  font-size: 11px;
  color: var(--text-2);
  cursor: default;
  white-space: nowrap;
}
.lg-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.lg-chip b { font-weight: 600; color: var(--text-1); }
.lg-chip em { font-style: normal; color: var(--text-2); }
.rainbow {
  width: 90px;
  height: 8px;
  border-radius: 999px;
  flex: none;
  background: linear-gradient(90deg, #f43f5e, #fb923c, #facc15, #4ade80, #22d3ee, #818cf8, #e879f9);
  opacity: 0.85;
}
.lg-note { font-size: 11px; color: var(--text-3); white-space: nowrap; }

@media (max-width: 1440px) { .sim-header .note-chip { display: none; } }
@media (max-width: 1320px) { .sim-header .pass-chip { display: none; } }
@media (max-width: 1280px) { .sim-header .audio-state { display: none; } }
@media (max-width: 1180px) { .sim-header .btn.sound { display: none; } }
@media (max-width: 1080px) { .sim-header .clock-chip { display: none; } }
</style>
