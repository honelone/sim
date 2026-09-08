<script setup>
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'

/* =========================================================
 * 需求映射（各条目见代码注释）：
 *  1. 水平直线贯穿整个画布
 *  2. 中心原点，半径略大于直线宽度
 *  3. 原点向左每隔一段距离等距排列“点”
 *  4. 点的数量由用户输入控制：窗口尺寸变化时数量保持不变，仅手动修改才更新
 *  5. 相邻点间距为固定值 FIXED_SPACING，不可由用户调整；构图随窗口整体等比缩放适配
 *  5b.顶部信息/控制条与底部参数条悬浮于画布之上且可折叠/隐藏，不占用主运行区域
 *  6. 以“点到原点的距离”为半径，画上方半圆弧路径（颜色比直线淡）
 *  7. 播放按钮：点击后点开始运动
 *  8. 各层按“周期”定速：最内层点每 900s 往返 127 次，最外层往返 100 次，
 *     中间各层按序号线性过渡（内快外慢）
 *  9. 从直线一端绕半圆到另一端后原路返回，无限循环
 * 10. 到达端点触线时做弹性压缩/回弹的物理反弹动画
 * 11. 绘制“点与原点”之间的连线，颜色比半圆路径更淡
 * 12. 点触线时发声：按“距原点由近及远”固定分配音高，
 *     do re mi fa sol la si → 超过 7 个则升一个八度继续重复
 * ========================================================= */

/* ---------- 常量 ---------- */
const FIXED_SPACING = 64          // 点间距固定值 px：不可由用户调整；构图随窗口整体等比缩放适配
const MAX_DOTS = 40               // 数量的 UI 硬上限（仅约束手动输入，不随窗口尺寸自动回落）
const LINE_WIDTH = 3              // 主直线宽度 px
const ORIGIN_R = 7                // 原点半径（> 直线宽度）
const DOT_R = 6                   // 运动点半径
const LINE_Y_RATIO = 0.58         // 直线在画布高度上的比例位置
const ARC_ALPHA = 0.3             // 半圆路径不透明度
const CONNECT_ALPHA = 0.13        // “点-原点”连线不透明度（须小于 ARC_ALPHA）

// 周期运动规则：最内层点每 CYCLE_PERIOD 秒往返 CYCLE_INNER 次，最外层往返 CYCLE_OUTER 次，
// 中间各层按序号线性过渡（往返 1 次 = 沿上方半圆从左到右再回到左）
const CYCLE_PERIOD = 900          // 统计周期秒数
const CYCLE_INNER = 127           // 最内层（距原点最近）每 900s 的往返次数
const CYCLE_OUTER = 100           // 最外层（距原点最远）每 900s 的往返次数
const MAX_FRAME = 0.05            // 单帧最大 dt 秒（防止后台切回跳变）

// 音阶（自然大调 do re mi fa sol la si = C4 D4 E4 F4 G4 A4 B4）
const NOTE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]

/* ---------- 交互状态（响应式） ---------- */
const countInput = ref(28)         // 用户输入的点数量（默认 28；仅手动修改时变化，不随窗口尺寸变化）
const speedScale = ref(1)          // 演示倍速：整体缩放周期节奏，不影响内外层比例
const playing = ref(false)         // 是否播放
const muted = ref(false)           // 是否静音（默认有声）
const viewScale = ref(1)           // 整体视图缩放（0~1）：把“固定间距×数量”的构图等比适配进可视区
const headerOpen = ref(true)       // 顶部信息/控制条是否展开
const panelOpen = ref(true)        // 底部参数条是否展开

// 音频解锁状态：idle | starting | ready | blocked | unsupported
const audioState = ref('idle')
const audioNotice = ref('')
const blockedClicks = ref(0)   // 连续几次在“用户手势”内解锁失败（用于给出逐步指引）

const canvasRef = ref(null)
const stageRef = ref(null)

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0,
  h: 0,
  dpr: 1,
  cx: 0,
  cy: 0,
  availR: 0,       // 当前可视区能容纳的最大半径（随窗口 / 悬浮条状态变化）
  scale: 1,        // 整体视图缩放：构图不超界时为 1，超出则等比缩小以完整容纳
  dots: [],        // 每个运动点: { d, L, pos, dir, bounce }，数组序=距原点由近及远
  ripples: [],     // 触线反弹时的冲击波纹
}

// Web Audio：音频上下文必须由“用户手势”启动（浏览器自动播放策略）。
// 创建成功 ≠ 能出声：被策略拦截时 state 停留在 suspended，需反复在用户手势中重试解锁。
const AUDIO_DEBUG = typeof location !== 'undefined' && /[?&]debug(?:=|&|$)/.test(location.search)
let audioCtx = null
let masterGain = null
let noiseBuffer = null
let resumePromise = null
let audioRetryTimer = 0
let lastResumeProbe = 0
let pendingNotes = []    // 解锁前发生的碰撞音先入队，解锁成功后补发
let noticeTimer = 0
// 调试计数器（URL 加 ?debug 后注入 window.__simAudio，便于定位问题）
const audioStats = { builds: 0, unlockCalls: 0, collisions: 0, noteAttempts: 0, notesScheduled: 0, notesFlushed: 0 }

let rafId = 0
let lastTs = 0
let resizeObserver = null

/* ---------- 数量约束与画布几何（间距固定、数量不受窗口影响） ---------- */
// 点数仅受 UI 硬上限约束：只有用户手动修改数量时 sim.dots 才会重建；
// 窗口尺寸变化不回落数量、不压缩间距。若“数量×固定间距”超出可视区，
// 则整幅构图等比缩小（viewScale）以完整容纳，实际外缘 = radiusOuter。
const effCount = computed(() =>
  Math.min(Math.max(Math.round(Number(countInput.value) || 1), 1), MAX_DOTS)
)

// 最外层半径：逻辑值（effCount × FIXED_SPACING）经视图缩放后的实际显示像素
const radiusOuter = computed(() =>
  Math.round(effCount.value * FIXED_SPACING * viewScale.value)
)

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

  // 顶部悬浮条展开时预留其遮挡高度（仅单行标题+状态栏）；收起后运行区更大 → 可用半径随之增大
  const topPad = headerOpen.value ? 96 : 52
  sim.availR = Math.max(40, Math.min(w / 2 - 48, sim.cy - topPad))

  // 注意：不再按窗口回落/压缩点数——数量与间距都保持用户设定
  syncDots()
  applyViewScale()
}

// 若构图总宽（点数 × 固定间距）超出当前可视半径，整体等比缩小；否则保持 1:1
function applyViewScale() {
  const n = sim.dots.length
  const logical = n * FIXED_SPACING
  sim.scale = logical > 0 ? Math.min(1, sim.availR / logical) : 1
  viewScale.value = sim.scale
}

function syncDots() {
  const n = effCount.value
  const dists = Array.from({ length: n }, (_, i) => (i + 1) * FIXED_SPACING)
  const old = sim.dots
  sim.dots = dists.map((d, i) => {
    const L = Math.PI * d // 半圆弧长（逻辑值，绘制时乘视图缩放系数）
    const prev = old[i]
    if (prev && prev.L > 0) {
      // 尽量保持原来在弧上的相对进度（手动改数量时位置不突兀）
      const frac = Math.min(Math.max(prev.pos / prev.L, 0), 1)
      return { d, L, pos: frac * L, dir: prev.dir, bounce: -1 }
    }
    // 初始静止位置：直线左端 = 弧长尽头（距原点 d）
    return { d, L, pos: L, dir: -1, bounce: -1 }
  })
}

function setCount(value) {
  countInput.value = Math.min(Math.max(Math.round(Number(value) || 1), 1), MAX_DOTS)
}
function stepCount(delta) {
  setCount((Number(countInput.value) || 1) + delta)
}

/* ---------- 计时显示 ---------- */
// 真实时间 realElapsed 按帧累计；等效周期时间 virtElapsed 再乘演示倍速，
// 即 ×N 下 900s/N 的真实时长就对应规则里的 900s
let realElapsed = 0
let virtElapsed = 0
let lastLabelTick = 0
const timeReal = ref('00:00.0')
const timeVirt = ref('00:00.0')

// —— 时间定位（seek）状态 ——
const seekText = ref('00:00') // 输入框文本，格式 mm:ss 或纯秒数

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
// 解析手动输入：支持 mm:ss（1~2 位分 + 0~59 秒）或纯秒数（如 90 / 12.5）
function parseSeekSeconds(text) {
  const txt = String(text || '').trim()
  if (!txt) return null
  if (/^\d{1,3}(\.\d+)?$/.test(txt)) return parseFloat(txt)
  const m = /^(\d{1,2}):([0-5]?\d)(\.\d+)?$/.exec(txt)
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2] + (m[3] || ''))
  return null
}

// 与 update() 完全一致的“按层周期数”插值：i=0 最内层 127 … 最外层 100
function cyclesFor(i, n) {
  return n > 1 ? CYCLE_INNER - ((CYCLE_INNER - CYCLE_OUTER) / (n - 1)) * i : CYCLE_INNER
}

// 解析定位：点在弧参数 pos∈[0,L] 上做匀速三角波往返。
// 半程时长 half = 900/(2·cycles)，t 落在半程内即 pos 递减(从左端→右端)，否则递增(右→左)
function sampleAt(t, i, n) {
  const p = sim.dots[i]
  const half = CYCLE_PERIOD / (2 * cyclesFor(i, n))
  const full = half * 2
  let u = t % full
  if (u < 0) u += full
  if (u <= half) return { pos: p.L * (1 - u / half), dir: -1 }
  return { pos: p.L * ((u - half) / half), dir: 1 }
}

// 跳到任意等效时间秒数（0~900）。立即重算各点位置并刷新画面；
// 之后点“播放”即从该位置沿时间轴继续推进。
function seekEq(secsRaw, quiet = false) {
  const secs = Number(secsRaw)
  if (!Number.isFinite(secs)) {
    if (!quiet) flashNotice('请输入有效时间，如 05:30 或 330（秒）', 2600)
    return
  }
  const clamped = Math.min(Math.max(secs, 0), CYCLE_PERIOD)
  if (!quiet && clamped !== secs) {
    flashNotice(`定位时间需在 0:00 ~ 15:00 之间，已调整为 ${fmtMMSS(clamped)}`, 3000)
  }
  const n = sim.dots.length
  for (let i = 0; i < n; i++) {
    const s = sampleAt(clamped, i, n)
    const p = sim.dots[i]
    p.pos = s.pos
    p.dir = s.dir
    p.bounce = -1 // 一次性跳转不触发弹跳波纹/碰撞音
  }
  sim.ripples.length = 0
  const scale = Number(speedScale.value) || 1
  virtElapsed = clamped
  realElapsed = clamped / scale // 保持“等效 = 实际 × 倍速”的口径
  lastLabelTick = 0
  timeVirt.value = fmtClock(clamped)
  timeReal.value = fmtClock(clamped / scale)
  seekText.value = fmtMMSS(clamped)
  render()
}

function applySeekInput() {
  const secs = parseSeekSeconds(seekText.value)
  if (secs === null) {
    seekText.value = fmtMMSS(Math.round(virtElapsed)) // 非法则回显当前
    flashNotice('格式示例：03:20、15:00 或 200（秒）', 2800)
    return
  }
  seekEq(secs)
  flashNotice(`已定位到 ${fmtMMSS(Math.min(Math.max(secs, 0), CYCLE_PERIOD))} 的瞬时位置`, 1600)
}

// 输入过程中即时定位（合法即生效），便于“输入/选择任意时间立即显示”
function seekLive() {
  const secs = parseSeekSeconds(seekText.value)
  if (secs !== null && secs >= 0 && secs <= CYCLE_PERIOD) seekEq(secs, true)
}

function nudgeSeek(delta) {
  seekEq(virtElapsed + delta, true)
}

function reset() {
  playing.value = false
  unlockAudio() // 空格 R 等用户手势内解锁音频
  sim.ripples.length = 0
  sim.dots.forEach((p) => {
    p.pos = p.L
    p.dir = -1
    p.bounce = -1
  })
  realElapsed = 0
  virtElapsed = 0
  lastLabelTick = 0
  timeReal.value = '00:00.0'
  timeVirt.value = '00:00.0'
  seekText.value = '00:00'
}

function togglePlay() {
  playing.value = !playing.value
  unlockAudio() // 播放按钮是用户手势，借此创建并恢复 AudioContext
}

function toggleMute() {
  muted.value = !muted.value
  unlockAudio()
  flashNotice(muted.value ? '声音已关闭（静音）' : '声音已开启', 1400)
}

/* ---------- 音频（碰撞音效，Web Audio 实时合成，无外部资源） ---------- */
function buildAudioGraph() {
  // closed（浏览器已关闭/异常结束的旧上下文）必须丢弃重建，否则永久无法出声
  if (audioCtx && audioCtx.state !== 'closed') return true
  if (audioCtx) {
    audioCtx = null
    masterGain = null
    noiseBuffer = null
  }
  const AC = window.AudioContext || window['webkitAudioContext']
  if (!AC) {
    audioState.value = 'unsupported'
    return false
  }
  try {
    audioCtx = new AC()
    audioCtx.addEventListener('statechange', onAudioStateChange)

    // 总线：音量 + 软限幅，防止多个音同时碰撞时削波
    masterGain = audioCtx.createGain()
    masterGain.gain.value = 0.6
    const comp = audioCtx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 18
    comp.ratio.value = 8
    comp.attack.value = 0.003
    comp.release.value = 0.25
    masterGain.connect(comp)
    comp.connect(audioCtx.destination)

    // 预生成 60ms 白噪声缓冲，供“撞击瞬态”复用
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
    if (audioRetryTimer) {
      clearTimeout(audioRetryTimer)
      audioRetryTimer = 0
    }
  }
}

// 必须在“用户手势”（点击/按键）内调用才能绕过自动播放策略。
// 被拦截时 ctx 保持 suspended，resume() 被拒 → 置为 blocked 并定时重试，
// 用户一旦获得 sticky activation，后续 resume 即可成功。
function unlockAudio() {
  if (!buildAudioGraph()) return Promise.resolve(false)
  audioStats.unlockCalls++
  if (audioCtx.state === 'running') {
    audioState.value = 'ready'
    return Promise.resolve(true)
  }
  if (audioCtx.state === 'suspended' && !resumePromise) {
    audioState.value = 'starting'
    resumePromise = audioCtx.resume().then(
      () => {
        resumePromise = null
        return !!(audioCtx && audioCtx.state === 'running')
      },
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

// 解锁成功后补发之前被拦截的碰撞音
function flushPending() {
  if (!pendingNotes.length || !audioCtx || audioCtx.state !== 'running') return
  const batch = pendingNotes.splice(0)
  for (const item of batch) {
    try { if (scheduleNoteNow(item.index, item.pan ?? 0)) audioStats.notesFlushed++ } catch (e) {}
  }
}

// —— 左右声道定位 ——
// 用 StereoPannerNode 把每个碰撞音定位到 −1(全左) ~ +1(全右)；
// 不支持（旧浏览器）时退化为单声道居中播放，不影响发声。
let stereoPanSupport = null
function panSupported() {
  if (stereoPanSupport === null) {
    const AC = window.AudioContext || window['webkitAudioContext']
    stereoPanSupport = !!(AC && AC.prototype && typeof AC.prototype.createStereoPanner === 'function')
  }
  return stereoPanSupport
}
// 返回本音符的目标输出节点：pan≈0 直接用主总线；否则创建挂到主总线上的 panner
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

// 弹奏单个音调（指数衰减，类似木琴/钟琴）；pan：−1 左 / 0 中 / +1 右
function strike(freq, t0, type, peak, decay, pan) {
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

// 撞击瞬态（短促带通噪声，模拟“触碰直线”的物理感）；pan：−1 左 / 0 中 / +1 右
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

// 真正调度音符：仅在 ctx 处于 running 且未静音时执行
// pan：−1 = 左端点碰撞（左声道） / 0 = 居中（如试听） / +1 = 右端点碰撞（右声道）
function scheduleNoteNow(index, pan = 0) {
  if (muted.value || !audioCtx || !masterGain || audioCtx.state !== 'running') return false
  const t0 = audioCtx.currentTime
  const semi = index % 7
  const oct = Math.floor(index / 7)
  const f = NOTE_FREQS[semi] * Math.pow(2, oct)
  try {
    noiseHit(t0, 0.035, pan)              // 物理撞击瞬态
    strike(f, t0, 'sine', 0.5, 0.9, pan)  // 基音（较长、更易被听到）
    strike(f * 2.01, t0, 'sine', 0.12, 0.28, pan) // 八度泛音“叮”
    strike(f * 4.07, t0, 'sine', 0.06, 0.1, pan)  // 高频亮色
    audioStats.notesScheduled++
    return true
  } catch (err) {
    console.warn('音符调度失败', err)
    return false
  }
}

// 第 index 个点（距原点由近及远，0 起）触线时发声：
// 音高 = do re mi fa sol la si 循环，每超过 7 个升一个八度；
// 声像 = 左端点碰撞→左声道(−1)，右端点碰撞→右声道(+1)。
// ctx 尚未 running（首次交互未解锁/被策略拦截）时不丢弃：入队等解锁补发。
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

// “试听”按钮：用户手势内解锁并立即弹一个 Do，用于验证声音链路
async function testSound() {
  if (muted.value) {
    flashNotice('已静音：请先点击“音效开/静音”开启声音', 2400)
    return
  }
  const ok = await unlockAudio()
  if (audioState.value === 'unsupported') {
    flashNotice('当前浏览器不支持 Web Audio，无法发声', 3800)
    return
  }
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
  flashNotice(
    played
      ? '已播放 Do 试听音；若仍听不到：①检查系统音量/耳机 ②看标签页是否有“喇叭×”静音 ③确认非静音状态'
      : '试听调度失败：请检查系统音量与输出设备',
    4600
  )
}

function audioSupervisor() {
  // ctx 被策略拦截(suspended)时周期重试；异常关闭(closed)时重建
  if (!audioCtx) return
  if (audioCtx.state === 'closed') {
    buildAudioGraph()
    return
  }
  if (audioCtx.state === 'suspended') {
    const now = performance.now()
    if (now - lastResumeProbe > 1000) {
      lastResumeProbe = now
      unlockAudio()
    }
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
  return audioState.value === 'ready'
    ? muted.value ? 'ok muted' : 'ok'
    : 'warn'
})
const audioChipTitle = computed(() => {
  if (audioState.value === 'blocked') {
    return '浏览器自动播放策略拦截了本站音频。请连续点击“试听”按钮 1~2 次（点击本身即解锁动作）；若仍失败，请点击地址栏左侧图标，将本站设为“允许声音”，或在新标签页打开本页后重试'
  }
  if (audioState.value === 'ready') {
    return '音频已就绪：Web Audio 实时合成（无外部文件），主音量 0.6 非零；若点击试听后仍听不到，请检查系统音量/输出设备/浏览器标签页是否被静音'
  }
  return '碰撞音效由 Web Audio 实时合成，无需外部音频文件；首次使用请点击“试听”或“播放”解锁'
})

/* ---------- 运动物理 ---------- */
function impactAtEnd(p, index) {
  // 触线反弹：标记冲击时刻（用于绘制弹性压缩/回弹）
  p.bounce = 0
  const sideX = p.pos <= 0 ? sim.cx + p.d * sim.scale : sim.cx - p.d * sim.scale // 触地点（直线另一端）
  sim.ripples.push({ x: sideX, y: sim.cy, age: 0 })
  if (sim.ripples.length > 24) sim.ripples.shift()
  audioStats.collisions++
  const pan = p.pos <= 0 ? 1 : -1 // 右端点触线 → 右声道(+1)；左端点触线 → 左声道(−1)
  playCollisionNote(index, pan)   // 对应音符：距原点最近的=Do，向外依次升调
}

function update(dt) {
  const scale = Number(speedScale.value) || 1
  // 累计计时：真实流逝 + 按倍速折算的等效周期时间
  realElapsed += dt
  virtElapsed += dt * scale
  // 往返次数按层线性过渡：i=0(最内层)=CYCLE_INNER … 最外层=CYCLE_OUTER
  const n = sim.dots.length
  const step = n > 1 ? (CYCLE_INNER - CYCLE_OUTER) / (n - 1) : 0
  for (let i = 0; i < n; i++) {
    const p = sim.dots[i]
    // 往返一次路程 = 2·L(半圆弧长)；周期时间 = CYCLE_PERIOD / 往返次数
    // 线速度 v = 路程 / 周期 = 2L·cycles / CYCLE_PERIOD，再乘演示倍速
    const cycles = CYCLE_INNER - step * i
    const v = ((2 * p.L * cycles) / CYCLE_PERIOD) * scale
    // 事件式精确积分：本帧位移在端点处精确反弹，并把“越过端点的剩余位移”
    // 反向继续带走（而不是截断丢弃）。否则每撞击一次平均丢失半帧行程，
    // 会使各层实际频率略高于标称、内外层漂移量不同，第 900s 无法同步回位成一条直线。
    let remain = v * dt
    let guard = 0
    while (remain > 1e-9 && guard < 16) {
      const toEnd = p.dir < 0 ? p.pos : p.L - p.pos
      if (remain <= toEnd) {
        p.pos += p.dir * remain
        remain = 0
      } else {
        p.pos = p.dir < 0 ? 0 : p.L // 触线端点（右/左）
        remain -= toEnd
        p.dir *= -1
        impactAtEnd(p, i)
      }
      guard++
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
  drawConnectors(ctx)
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
    // canvas 角度 π→2π 即为直线以上的半圆（左端→顶点→右端）；半径按视图缩放
    ctx.arc(sim.cx, sim.cy, p.d * sim.scale, Math.PI, Math.PI * 2, false)
    ctx.strokeStyle = `rgba(103,232,249,${ARC_ALPHA})` // 颜色显著淡于主直线
    ctx.lineWidth = 2
    ctx.stroke()
  }
  ctx.restore()
}

// 点与原点之间的连线：不透明度低于半圆路径（CONNECT_ALPHA < ARC_ALPHA）
function drawConnectors(ctx) {
  ctx.save()
  ctx.lineWidth = 1
  ctx.lineCap = 'round'
  ctx.strokeStyle = `rgba(148,210,250,${CONNECT_ALPHA})`
  for (const p of sim.dots) {
    const a = p.pos / p.d
    const r = p.d * sim.scale
    const x = sim.cx + r * Math.cos(a)
    const y = sim.cy - r * Math.sin(a)
    ctx.beginPath()
    ctx.moveTo(sim.cx, sim.cy)
    ctx.lineTo(x, y)
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
    const r = p.d * sim.scale
    const x = sim.cx + r * Math.cos(a)
    const y = sim.cy - r * Math.sin(a)

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
  if (playing.value) {
    update(dt)
    // 计时标签每 ~100ms 刷新一次（避免每帧触发 Vue 重渲染）
    if (ts - lastLabelTick >= 100) {
      lastLabelTick = ts
      timeReal.value = fmtClock(realElapsed)
      timeVirt.value = fmtClock(virtElapsed)
    }
  }
  audioSupervisor()
  render()
}

// 任意用户手势（点击/按键）都可能携带可解锁音频的“激活”，捕获它们尽早解锁
function onUserGesture() {
  unlockAudio()
}

function onKeydown(e) {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'r' || e.key === 'R') {
    reset()
  }
}

watch(countInput, () => {
  syncDots()
  applyViewScale()
})
// 顶部/底部悬浮条收起或展开后，可视半径变化 → 重新做等比适配
watch([headerOpen, panelOpen], () => {
  layout()
})

onMounted(() => {
  layout()
  rafId = requestAnimationFrame(tick)
  resizeObserver = new ResizeObserver(() => layout())
  resizeObserver.observe(stageRef.value)
  window.addEventListener('keydown', onKeydown)
  // 捕获任意首次用户手势（点击画布/控件/空白处），尽早创建并解锁音频
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
    noiseBuffer = null
  }
})

// URL 携带 ?debug 时暴露内部状态，便于排查碰撞触发与音频链路
if (AUDIO_DEBUG) {
  window.__simAudio = {
    get ctxState() { return audioCtx ? audioCtx.state : 'none' },
    get audioState() { return audioState.value },
    get muted() { return muted.value },
    get pending() { return pendingNotes.length },
    get playing() { return playing.value },
    stats: audioStats,
    unlock: () => unlockAudio(),
  }
}
</script>

<template>
  <div class="sim-root">
    <!-- 主运行区：占满整个视口（画布全屏最大化，信息条仅悬浮其上） -->
    <div class="stage" ref="stageRef">
      <canvas ref="canvasRef" class="sim-canvas"></canvas>
    </div>

    <!-- ================= 顶部标题 + 操作/状态栏（悬浮 + 可折叠，单行布局） ================= -->
    <header v-if="headerOpen" class="sim-header">
      <h1>半圆往返 · 弹性反弹 · 音阶碰撞</h1>
      <div class="header-actions">
        <span class="clock-chip" title="播放自开始/重置以来的实际流逝时间（暂停期间不计）">
          <b>运行</b><em>{{ timeReal }}</em>
        </span>
        <span class="clock-chip" title="等效周期时间 = 实际时间 × 倍速。×1 时到 15:00 即对应规则中的 900s：最内层往返 127 次、最外层 100 次；倍速越高到点越快">
          <b>等效</b><em>{{ timeVirt }}</em><span class="clock-den">/15:00</span>
        </span>
        <span class="seek-chip">
          <b class="seek-label">定位</b>
          <input
            class="seek-input"
            v-model="seekText"
            inputmode="decimal"
            spellcheck="false"
            placeholder="mm:ss"
            title="输入 mm:ss（如 07:30）或纯秒数（如 450），回车跳转；范围 0:00 ~ 15:00"
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
        <button class="btn ghost" @click="reset" title="重置 (R)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
          重置
        </button>
        <button
          class="btn ghost sound"
          :class="{ muted }"
          @click="toggleMute"
          :title="muted ? '开启碰撞音效' : '关闭碰撞音效'"
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
        <button class="btn ghost" @click="testSound" title="立即播放一个 Do 音，用于验证声音并解锁浏览器限制">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          试听
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

    <div v-else class="mini-top">
      <button class="icon-btn" title="展开顶部信息栏" @click="headerOpen = true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <span class="mini-state" :class="{ running: playing }"><i></i>{{ playing ? '运行中' : '已暂停' }}</span>
      <span class="mini-clock"><b>运行</b>{{ timeReal }}</span>
      <span class="mini-clock"><b>等效</b>{{ timeVirt }} / 15:00</span>
      <span class="mini-note">点数 {{ effCount }} · 最远半径 {{ radiusOuter }}px</span>
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

    <!-- ================= 底部参数条：悬浮 + 可折叠 ================= -->
    <section v-if="panelOpen" class="panel">
      <div class="panel-row">
        <div class="pgroup">
          <span class="plabel">点的数量</span>
          <div class="stepper">
            <button class="step" :disabled="effCount <= 1" @click="stepCount(-1)">−</button>
            <input
              class="num"
              type="number"
              min="1"
              :max="MAX_DOTS"
              v-model.number="countInput"
              @change="setCount(countInput)"
            />
            <button class="step" :disabled="effCount >= MAX_DOTS" @click="stepCount(1)">+</button>
          </div>
          <small>1 ~ {{ MAX_DOTS }}：仅手动修改才变化，窗口尺寸改变不影响数量</small>
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
              title="整体缩放运动节奏，不改变内外层的 127:100 周期比例；最高 ×10"
            />
            <output>×{{ speedScale }}</output>
          </div>
          <small>最内层每 900s 往返 127 次 → 最外层 100 次（按层线性过渡，内快外慢）</small>
        </div>
        <button class="icon-btn collapse" title="收起底部参数栏" @click="panelOpen = false">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>
    </section>

    <button v-else class="panel-fab" title="展开底部参数栏" @click="panelOpen = true">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
      参数
    </button>
  </div>
</template>

<style scoped>
.sim-root {
  position: relative;
  height: 100dvh;
  overflow: hidden;
}

/* ---------- 主运行区：占满整个视口（悬浮条不参与布局，画布始终全屏） ---------- */
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

/* ---------- header（悬浮 + 半透明毛玻璃，不占用布局空间） ---------- */
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
  font-size: 17px;
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
  width: 62px;
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
  max-width: 260px;
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
.audio-state.ok {
  border-color: rgba(74, 222, 128, 0.35);
}
.audio-state.ok i {
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.8);
}
.audio-state.ok.muted i {
  background: #fbbf24;
  box-shadow: none;
}
.audio-state.warn {
  border-color: rgba(251, 191, 36, 0.4);
  color: #fcd34d;
}
.audio-state.warn i {
  background: #fbbf24;
}
.audio-state.notice {
  border-color: rgba(56, 189, 248, 0.4);
  color: #7dd3fc;
}
.audio-state.notice i {
  background: #38bdf8;
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

/* ---------- 通用图标按钮 ---------- */
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

/* ---------- 顶部信息栏收起后的极简状态条 ---------- */
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
.mini-clock b {
  color: var(--text-3);
  font-weight: 500;
}
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
  padding: 7px 14px;
  font-size: 13px;
  min-width: 86px;
  cursor: pointer;
}
.mini-play:active {
  transform: scale(0.96);
}
.mini-reset {
  padding: 6px 12px;
  border-radius: 999px;
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.55); }
  70% { box-shadow: 0 0 0 7px rgba(74, 222, 128, 0); }
  100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
}

/* ---------- panel（悬浮于底部，不占布局空间；可折叠） ---------- */
.panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px clamp(14px, 2.5vw, 28px) 10px;
  background: linear-gradient(0deg, rgba(8, 13, 26, 0.88), rgba(15, 23, 42, 0.55) 85%, rgba(15, 23, 42, 0));
  border-top: 1px solid var(--border);
  backdrop-filter: blur(12px);
}
.panel-row {
  display: flex;
  align-items: flex-end;
  gap: clamp(16px, 3vw, 34px);
  flex-wrap: wrap;
  padding-right: 34px; /* 给右上角“收起”按钮留位 */
}
.panel-row .collapse {
  position: absolute;
  top: 10px;
  right: 10px;
  margin-left: 0;
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
.panel-fab:hover {
  background: rgba(56, 189, 248, 0.16);
  border-color: #38bdf8;
}
.panel-fab svg {
  flex: none;
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

/* —— 顶部状态栏与标题保持同一行：窄屏时逐步隐藏次要控件 —— */
@media (max-width: 1480px) {
  .sim-header .seek-btn {
    display: none; /* 隐藏 ±10s，保留 mm:ss 输入 + 跳转 */
  }
}
@media (max-width: 1320px) {
  .sim-header .audio-state {
    display: none;
  }
}
@media (max-width: 1240px) {
  .sim-header .btn.sound {
    display: none; /* 隐藏静音开关，仍可用“试听”体验声音 */
  }
}
@media (max-width: 1080px) {
  .sim-header .seek-label,
  .sim-header .clock-chip {
    display: none;
  }
}
</style>
