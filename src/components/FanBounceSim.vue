<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue'

/* =========================================================
 * 需求映射：
 *  1. 页面中部绘制固定原点，自原点向左上/右上各引一条对称线段，
 *     两线段夹角可调（默认 135°；单侧相对竖直倾斜 = 夹角/2）
 *  2. 左侧线段上按“距原点由近及远”放 30 个运动点
 *  3. 运动点以原点为圆心、各自到原点的距离为半径，
 *     沿圆弧路径（夹在两线段之间，翻越顶部）从左线段摆到右线段，撞线即折返
 *  4. 变速：60s 内第 1 个点(最内)往返 30 次、第 2 个 29 次 … 第 30 个(最外)1 次
 *     （一个往返 = 左线→右线→左线，周期 = 60/n 秒）
 *  5. 各点按彩虹色序（红橙黄绿蓝靛紫）循环着色
 *  6. 顶部/底部信息展示与既有实验页保持同一视觉语言
 *  7. 连线：任意两个运动点之间连线（可选）＋ 每点与原点之间连线，
 *     均比线段路径更淡
 *  8. 运动点撞到任一线段时发声：按点序 do re mi fa sol la si，
 *     每满 7 个点升一个八度循环（点 8 起 do'、点 15 起 do'' …）
 * ========================================================= */

/* ---------- 常量 ---------- */
const DEFAULT_COUNT = 30        // 默认运动点数量（需求为 30）
const MIN_COUNT = 2             // UI 下限
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

// 自然大调：do re mi fa sol la si（C4~B4）
const NOTE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]
const NOTE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si']
const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷']
// 彩虹七色（红橙黄绿蓝靛紫）按点序循环
const RAINBOW_HUES = [0, 30, 55, 130, 205, 240, 285]

function hsl(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)` }
function hsla(h, s, l, a) { return `hsla(${h}, ${s}%, ${l}%, ${a})` }

// 第 n 点（n=1 起）在 60s 内完成的往返次数：最内层=总点数，最外层=1，逐层递减
function cyclesOf(i, n) { return n - i }

function noteOf(i) {
  const deg = i % 7
  const oct = Math.floor(i / 7)
  return {
    deg,
    oct,
    freq: NOTE_FREQS[deg] * Math.pow(2, oct),
    base: NOTE_NAMES[deg],
    disp: oct > 0 ? `${NOTE_NAMES[deg]}${SUP[Math.min(oct, SUP.length - 1)]}` : NOTE_NAMES[deg],
    title: oct > 0 ? `${NOTE_NAMES[deg]}（升 ${oct} 个八度）` : NOTE_NAMES[deg],
  }
}

/* ---------- 交互状态 ---------- */
const count = ref(DEFAULT_COUNT)
const effCount = computed(() => Math.min(Math.max(Math.round(Number(count.value) || 1), MIN_COUNT), MAX_COUNT))
const wedgeDeg = ref(135)          // 两条线段的夹角（默认 135°）
const halfRad = computed(() => ((wedgeDeg.value / 2) * Math.PI) / 180)
const speedScale = ref(1)
const playing = ref(false)
const muted = ref(false)
const headerOpen = ref(true)
const panelOpen = ref(true)
const showChord = ref(true)        // 点两两连线
const showSpoke = ref(true)        // 点-原点连线
const lastNote = ref(null)
const activeIdx = ref(-1)

const audioState = ref('idle')
const audioNotice = ref('')
const blockedClicks = ref(0)

const canvasRef = ref(null)
const stageRef = ref(null)
const headerEl = ref(null)
const miniEl = ref(null)
const panelEl = ref(null)

// 每个运动点的元信息（颜色 = 彩虹七色按点序循环；音符 = 七音阶按点序循环升调）
const meta = computed(() =>
  Array.from({ length: effCount.value }, (_, i) => {
    const h = RAINBOW_HUES[i % 7]
    const cyc = cyclesOf(i, effCount.value)
    const note = noteOf(i)
    return {
      i, num: i + 1, h, cyc,
      color: hsl(h, 92, 62),
      light: hsl(h, 96, 82),
      dark: hsl(h, 88, 44),
      ...note,
      period: CYCLE_SECONDS / cyc,
      half: (CYCLE_SECONDS / cyc) / 2,
      title: `第 ${i + 1} 点（第 ${i + 1} 层）：60s 往返 ${cyc} 次 · 音高 ${note.title} · 颜色 ${['红','橙','黄','绿','蓝','靛','紫'][i % 7]}`,
    }
  })
)

/* ---------- 音频运行时 ---------- */
let audioCtx = null
let masterGain = null
let noiseBuffer = null
let resumePromise = null
let audioRetryTimer = 0
let noticeTimer = 0
let highlightTimer = 0
let lastResumeProbe = 0
let pendingNotes = []
const audioStats = { builds: 0, unlockCalls: 0, collisions: 0, noteAttempts: 0, notesScheduled: 0, notesFlushed: 0 }

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
let lastLabelTick = 0
const timeReal = ref('00:00.0')
const timeVirt = ref('00:00.0')
const seekText = ref('00:00')

/* ---------- 布局：原点居中，V 形与圆弧整体位于上半区 ---------- */
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

  // 顶部/底部悬浮信息条的高度（用真实 DOM 高度）
  const headerH = headerOpen.value ? measure(headerEl.value) || 52 : measure(miniEl.value) || 42
  const panelH = panelOpen.value ? measure(panelEl.value) || 150 : 0
  const padT = headerH + 20
  const padB = panelH + 24
  const regionTop = padT
  const regionBottom = Math.max(padT + 120, h - padB)

  sim.cx = w / 2
  sim.cy = regionTop + (regionBottom - regionTop) / 2

  const sinH = Math.sin(halfRad.value)
  const rVert = sim.cy - padT - 26
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
  count.value = Math.min(Math.max(Math.round(Number(v) || 1), MIN_COUNT), MAX_COUNT)
}
function stepCount(delta) {
  setCount((Number(count.value) || 1) + delta)
}

/* ---------- 时间显示 ---------- */
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
function parseSeekSeconds(text) {
  const txt = String(text || '').trim()
  if (!txt) return null
  if (/^\d{1,3}(\.\d+)?$/.test(txt)) return parseFloat(txt)
  const m = /^(\d{1,2}):([0-5]?\d)(\.\d+)?$/.exec(txt)
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2] + (m[3] || ''))
  return null
}

// 已知等效时间 t，求第 i 个点的归一化位置与方向（供 seek 快照）
function sampleAt(t, i) {
  const n = effCount.value
  const d = meta.value[i]
  const P = d.period
  let u = t % P
  if (u < 0) u += P
  if (u <= d.half) return { s: -1 + 2 * (u / d.half), dir: 1 }
  return { s: 1 - 2 * ((u - d.half) / d.half), dir: -1 }
}

function seekEq(secsRaw, quiet = false) {
  const secs = Number(secsRaw)
  if (!Number.isFinite(secs)) {
    if (!quiet) flashNotice('请输入有效时间，如 00:30 或 30（秒）', 2600)
    return
  }
  const clamped = Math.min(Math.max(secs, 0), CYCLE_SECONDS)
  if (!quiet && clamped !== secs) {
    flashNotice(`定位时间需在 0:00 ~ 1:00 之间，已调整为 ${fmtMMSS(clamped)}`, 3000)
  }
  const n = effCount.value
  for (let i = 0; i < n; i++) {
    const s = sampleAt(clamped, i)
    const p = sim.pts[i]
    p.s = s.s
    p.dir = s.dir
    p.bounce = -1
  }
  sim.ripples.length = 0
  const scale = Number(speedScale.value) || 1
  virtElapsed = clamped
  realElapsed = clamped / scale
  lastLabelTick = 0
  timeVirt.value = fmtClock(clamped)
  timeReal.value = fmtClock(clamped / scale)
  seekText.value = fmtMMSS(clamped)
  render()
}
function applySeekInput() {
  const secs = parseSeekSeconds(seekText.value)
  if (secs === null) {
    seekText.value = fmtMMSS(Math.round(virtElapsed))
    flashNotice('格式示例：00:20、1:00 或 30（秒）', 2800)
    return
  }
  seekEq(secs)
  flashNotice(`已定位到 ${fmtMMSS(Math.min(Math.max(secs, 0), CYCLE_SECONDS))} 的瞬时位置`, 1600)
}
function seekLive() {
  const secs = parseSeekSeconds(seekText.value)
  if (secs !== null && secs >= 0 && secs <= CYCLE_SECONDS) seekEq(secs, true)
}
function nudgeSeek(delta) {
  seekEq(virtElapsed + delta, true)
}

function reset() {
  playing.value = false
  unlockAudio()
  sim.ripples.length = 0
  for (const p of sim.pts) { p.s = -1; p.dir = 1; p.bounce = -1 }
  realElapsed = 0
  virtElapsed = 0
  lastLabelTick = 0
  timeReal.value = '00:00.0'
  timeVirt.value = '00:00.0'
  seekText.value = '00:00'
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

/* =========================================================
 * 音频：Web Audio 实时合成（无外部文件）
 * ========================================================= */
function buildAudioGraph() {
  if (audioCtx && audioCtx.state !== 'closed') return true
  if (audioCtx) { audioCtx = null; masterGain = null; noiseBuffer = null }
  const AC = window.AudioContext || window['webkitAudioContext']
  if (!AC) { audioState.value = 'unsupported'; return false }
  try {
    audioCtx = new AC()
    audioCtx.addEventListener('statechange', onAudioStateChange)
    masterGain = audioCtx.createGain()
    masterGain.gain.value = 0.5
    const comp = audioCtx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 18
    comp.ratio.value = 8
    comp.attack.value = 0.003
    comp.release.value = 0.25
    masterGain.connect(comp)
    comp.connect(audioCtx.destination)

    const len = Math.floor(audioCtx.sampleRate * 0.06)
    noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    audioStats.builds++
  } catch (err) {
    console.warn('WebAudio 初始化失败', err)
    try { audioCtx && audioCtx.close() } catch (e) {}
    audioCtx = null
    masterGain = null
    noiseBuffer = null
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
  for (const item of batch) {
    try { if (scheduleNoteNow(item.index, item.pan ?? 0)) audioStats.notesFlushed++ } catch (e) {}
  }
}

let stereoPanSupport = null
function panSupported() {
  if (stereoPanSupport === null) {
    const AC = window.AudioContext || window['webkitAudioContext']
    stereoPanSupport = !!(AC && AC.prototype && typeof AC.prototype.createStereoPanner === 'function')
  }
  return stereoPanSupport
}
function pannedOut(pan) {
  const pv = Math.max(-1, Math.min(1, Number(pan) || 0))
  if (pv !== 0 && panSupported()) {
    const node = audioCtx.createStereoPanner()
    node.pan.value = pv
    node.connect(masterGain)
    return node
  }
  return masterGain
}
function strike(freq, t0, type, peak, decay, pan) {
  if (!audioCtx || !masterGain) return
  const osc = audioCtx.createOscillator()
  const g = audioCtx.createGain()
  const out = pannedOut(pan)
  osc.type = type
  osc.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay)
  osc.connect(g)
  g.connect(out)
  osc.start(t0)
  osc.stop(t0 + decay + 0.05)
  osc.onended = () => {
    osc.disconnect()
    g.disconnect()
    if (out !== masterGain) out.disconnect()
  }
}
function noiseHit(t0, dur, pan) {
  if (!noiseBuffer || !masterGain) return
  const src = audioCtx.createBufferSource()
  src.buffer = noiseBuffer
  const filter = audioCtx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 2600
  filter.Q.value = 0.8
  const g = audioCtx.createGain()
  const out = pannedOut(pan)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(filter)
  filter.connect(g)
  g.connect(out)
  src.start(t0)
  src.stop(t0 + dur + 0.02)
  src.onended = () => {
    src.disconnect()
    filter.disconnect()
    g.disconnect()
    if (out !== masterGain) out.disconnect()
  }
}
// index 0 起；pan：-1 左线碰撞(左声道) / 0 居中(试听) / +1 右线碰撞(右声道)
function scheduleNoteNow(index, pan = 0) {
  if (muted.value || !audioCtx || !masterGain || audioCtx.state !== 'running') return false
  const t0 = audioCtx.currentTime
  const f = meta.value[index].freq
  try {
    noiseHit(t0, 0.035, pan)
    strike(f, t0, 'sine', 0.5, 0.9, pan)
    strike(f * 2.01, t0, 'sine', 0.12, 0.28, pan)
    strike(f * 4.07, t0, 'sine', 0.06, 0.1, pan)
    audioStats.notesScheduled++
    return true
  } catch (err) {
    console.warn('音符调度失败', err)
    return false
  }
}
function playCollisionNote(index, pan = 0) {
  audioStats.noteAttempts++
  if (muted.value) return
  if (audioCtx && audioCtx.state === 'running') {
    scheduleNoteNow(index, pan)
    return
  }
  if (buildAudioGraph()) {
    if (pendingNotes.length < 32) pendingNotes.push({ index, pan })
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
  return '撞线音效由 Web Audio 实时合成；首次使用请点击“试听”或“播放”解锁'
})

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
  audioStats.collisions++
  const pan = p.s > 0 ? 1 : -1 // 右线→右声道，左线→左声道
  playCollisionNote(i, pan)
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

watch(effCount, () => { syncDots() })
watch([headerOpen, panelOpen], async () => { await nextTick(); layout() })

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
  clearTimeout(audioRetryTimer)
  clearTimeout(noticeTimer)
  clearTimeout(highlightTimer)
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {})
    audioCtx = null
    masterGain = null
    noiseBuffer = null
  }
})

if (AUDIO_DEBUG) {
  window.__fanAudio = {
    get ctxState() { return audioCtx ? audioCtx.state : 'none' },
    get playing() { return playing.value },
    get count() { return effCount.value },
    get wedge() { return wedgeDeg.value },
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
      <h1 title="正中原点向左右上各引一条线段（默认夹角 135°，单侧相对竖直 67.5°）；多个点沿各自半径的圆弧在两条线段间摆荡，撞线即反弹并奏响音阶">V 形扇摆 · 彩虹弧摆 · 撞线音阶</h1>
      <div class="header-actions">
        <span class="clock-chip" title="播放自开始/重置以来的实际流逝时间（暂停期间不计）">
          <b>运行</b><em>{{ timeReal }}</em>
        </span>
        <span class="clock-chip" title="等效时间 = 实际时间 × 倍速。每 60s（等效）所有点同步回到左侧线段一次">
          <b>等效</b><em>{{ timeVirt }}</em><span class="clock-den">/1:00</span>
        </span>
        <span
          class="note-chip"
          :class="{ lit: lastNote }"
          title="最近一次运动点撞线时奏响的音符"
        >
          <i class="note-dot" :style="lastNote ? { background: lastNote.color } : null"></i>
          <template v-if="lastNote">点{{ lastNote.num }} · {{ lastNote.name }}</template>
          <template v-else>—</template>
        </span>
        <span class="seek-chip">
          <b class="seek-label">定位</b>
          <input
            class="seek-input"
            v-model="seekText"
            inputmode="decimal"
            spellcheck="false"
            placeholder="mm:ss"
            title="输入 mm:ss（如 00:30）或纯秒数（如 30），回车跳转；范围 0:00 ~ 1:00"
            @input="seekLive"
            @keydown.enter.prevent="applySeekInput"
            @keydown.esc="seekText = fmtMMSS(Math.round(virtElapsed))"
          />
          <button class="seek-btn" title="后退 10 秒" @click="nudgeSeek(-10)">−10s</button>
          <button class="seek-btn" title="前进 10 秒" @click="nudgeSeek(10)">+10s</button>
          <button class="seek-btn go" title="跳转到输入的时间点" @click="applySeekInput">跳转</button>
        </span>
        <span class="audio-state" :class="audioChipCls" :title="audioChipTitle">
          <i></i>{{ audioChipText }}
        </span>
        <button class="btn ghost sound" :class="{ muted }" @click="toggleMute" :title="muted ? '开启撞线音效' : '关闭撞线音效'">
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
        <button class="btn ghost" @click="reset" title="重置到左侧线段 (R)">
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
      <span class="mini-clock"><b>等效</b>{{ timeVirt }} / 1:00</span>
      <span class="mini-clock" title="第 n 点（内→外）：60s 内往返 {{ effCount - 1 }}~1 次不等">V 夹角 {{ wedgeDeg }}° · {{ effCount }} 点</span>
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
        <div class="pgroup">
          <span class="plabel">点的数量</span>
          <div class="stepper">
            <button class="step" :disabled="effCount <= MIN_COUNT" @click="stepCount(-1)">−</button>
            <input
              class="num"
              type="number"
              :min="MIN_COUNT"
              :max="MAX_COUNT"
              v-model.number="count"
              @change="setCount(count)"
            />
            <button class="step" :disabled="effCount >= MAX_COUNT" @click="stepCount(1)">+</button>
          </div>
          <small>默认 30：第 n 点 60s 内往返 {{ effCount }} 递减至 1 次（内快外慢）</small>
        </div>

        <div class="pgroup">
          <span class="plabel">两线夹角</span>
          <div class="range-row">
            <input
              class="range"
              type="range"
              :min="WEDGE_MIN"
              :max="WEDGE_MAX"
              step="1"
              v-model.number="wedgeDeg"
              title="两条线段在原点处形成的夹角；默认 135°（单侧相对竖直倾斜 67.5°）。注：需求中“倾斜 62.5°×2=125°”与“夹角 135°”不一致，故默认以 135° 夹角为准，可在此调节"
            />
            <output>{{ wedgeDeg }}°</output>
          </div>
          <small>单侧相对竖直 {{ (wedgeDeg / 2).toFixed(1) }}°</small>
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
              title="等比缩放所有点的摆动速度，不改变“内快外慢”的比例"
            />
            <output>×{{ speedScale }}</output>
          </div>
          <small>60s 内最内层往返 30 次 → 最外层 1 次（按层递减）</small>
        </div>

        <div class="pgroup">
          <span class="plabel">连线显示</span>
          <label class="tick"><input type="checkbox" v-model="showChord" />各点之间连线</label>
          <label class="tick"><input type="checkbox" v-model="showSpoke" />各点─原点连线</label>
          <small>连线均比线段路径更淡</small>
        </div>
        <button class="icon-btn collapse" title="收起底部控制栏" @click="panelOpen = false">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>

      <div class="panel-row legend-row">
        <span class="lg-title">点序 → 颜色（彩虹循环）与撞线音高（每 7 点升一调）</span>
        <span
          v-for="d in meta"
          :key="d.num"
          class="lg-chip"
          :class="{ on: activeIdx === d.i }"
          :title="d.title"
          @mouseenter="activeIdx = d.i"
          @mouseleave="activeIdx = -1"
        >
          <i class="lg-dot" :style="{ background: d.color }"></i>
          <b>{{ d.num }}</b>
          <em>{{ d.disp }}</em>
        </span>
      </div>
    </section>

    <button v-else class="panel-fab" title="展开底部控制栏" @click="panelOpen = true">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
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

/* ---------- header（悬浮半透明毛玻璃，不占布局） ---------- */
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
.clock-chip b {
  color: var(--text-3);
  font-weight: 500;
}
.clock-chip em {
  color: #7dd3fc;
  font-style: normal;
  font-weight: 600;
}
.clock-den {
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
  margin-left: 1px;
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
.seek-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid rgba(56, 189, 248, 0.28);
  background: rgba(15, 23, 42, 0.55);
  color: var(--text-2);
  white-space: nowrap;
}
.seek-label {
  color: var(--text-3);
  font-weight: 500;
  margin-right: 2px;
}
.seek-input {
  width: 56px;
  padding: 3px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(2, 6, 23, 0.72);
  color: var(--text-1);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  outline: none;
}
.seek-input:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.18);
}
.seek-input::placeholder {
  color: var(--text-3);
  opacity: 0.6;
}
.seek-btn {
  padding: 3px 7px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(30, 41, 59, 0.6);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  line-height: 1.4;
}
.seek-btn:hover {
  border-color: #38bdf8;
  color: var(--text-1);
  background: rgba(56, 189, 248, 0.12);
}
.seek-btn.go {
  border-color: rgba(56, 189, 248, 0.45);
  color: #7dd3fc;
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
.btn.ghost svg { color: var(--text-2); }
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
.panel-row .collapse {
  position: absolute;
  top: 10px;
  right: 10px;
}
.legend-row {
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(148, 163, 184, 0.16);
  max-height: 104px;
  overflow-y: auto;
  scrollbar-width: none;
}
.legend-row::-webkit-scrollbar { display: none; }
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

/* 图例 */
.lg-title {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  flex: none;
}
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
  transition: all 0.18s;
}
.lg-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}
.lg-chip b { font-weight: 600; color: var(--text-1); }
.lg-chip em { font-style: normal; color: var(--text-2); }
.lg-chip.on {
  transform: scale(1.1);
  border-color: rgba(255, 255, 255, 0.55);
  box-shadow: 0 0 10px rgba(125, 211, 252, 0.35);
  background: rgba(56, 189, 248, 0.16);
}
.lg-chip.on em { color: #fff; }

@media (max-width: 1520px) {
  .sim-header .seek-btn { display: none; }
}
@media (max-width: 1380px) {
  .sim-header .seek-chip { display: none; }
}
@media (max-width: 1440px) {
  .sim-header .note-chip { display: none; }
}
@media (max-width: 1280px) {
  .sim-header .audio-state { display: none; }
}
@media (max-width: 1180px) {
  .sim-header .btn.sound { display: none; }
}
@media (max-width: 1080px) {
  .sim-header .clock-chip { display: none; }
}
</style>
