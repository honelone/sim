<script setup>
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import SimDock from './SimDock.vue'

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

const canvasRef = ref(null)
const stageRef = ref(null)
const dockRef = ref(null)   // 顶部总控条（SimDock 组件根，供 layout 测量遮挡高度）

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

// 真实时间 realElapsed 按帧累计；等效周期时间 virtElapsed 再乘演示倍速，
// 即 ×N 下 900s/N 的真实时长就对应规则里的 900s
let realElapsed = 0
let virtElapsed = 0

/* ---------- 数量约束与画布几何（间距固定、数量不受窗口影响） ---------- */
const effCount = computed(() =>
  Math.min(Math.max(Math.round(Number(countInput.value) || 1), 1), MAX_DOTS)
)

// 最外层半径：逻辑值（effCount × FIXED_SPACING）经视图缩放后的实际显示像素
const radiusOuter = computed(() =>
  Math.round(effCount.value * FIXED_SPACING * (sim.scale || 1))
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

  // 顶部总控条已合并为一条：直接测量它实际遮挡的顶部高度（含与顶部的间距）
  const topPad = dockRef.value && dockRef.value.root ? dockRef.value.root.getBoundingClientRect().bottom - rect.top : 96
  sim.availR = Math.max(40, Math.min(w / 2 - 48, sim.cy - topPad - 16))

  // 注意：不再按窗口回落/压缩点数——数量与间距都保持用户设定
  syncDots()
  applyViewScale()
}

// 若构图总宽（点数 × 固定间距）超出当前可视半径，整体等比缩小；否则保持 1:1
function applyViewScale() {
  const n = sim.dots.length
  const logical = n * FIXED_SPACING
  sim.scale = logical > 0 ? Math.min(1, sim.availR / logical) : 1
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
    return false
  }
  return true
}

function onAudioStateChange() {
  if (!audioCtx) return
  if (audioCtx.state === 'running') {
    flushPending()
    if (audioRetryTimer) {
      clearTimeout(audioRetryTimer)
      audioRetryTimer = 0
    }
  }
}

// 必须在“用户手势”（点击/按键）内调用才能绕过自动播放策略。
// 被拦截时 ctx 保持 suspended，resume() 被拒 → 定时重试，
// 用户一旦获得 sticky activation，后续 resume 即可成功。
function unlockAudio() {
  if (!buildAudioGraph()) return Promise.resolve(false)
  audioStats.unlockCalls++
  if (audioCtx.state === 'running') {
    return Promise.resolve(true)
  }
  if (audioCtx.state === 'suspended' && !resumePromise) {
    resumePromise = audioCtx.resume().then(
      () => {
        resumePromise = null
        return !!(audioCtx && audioCtx.state === 'running')
      },
      () => {
        resumePromise = null
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
  // 复用临时提示（此处用于静音切换等），不影响其它逻辑
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { noticeTimer = 0 }, ms)
  // 仅触发计时避免未使用告警；实际展示交由调用方的轻量提示
  void text
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
// pan：−1 = 左端点碰撞（左声道） / 0 = 居中 / +1 = 右端点碰撞（右声道）
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
    get muted() { return muted.value },
    get playing() { return playing.value },
    stats: audioStats,
    unlock: () => unlockAudio(),
  }
}
</script>

<template>
  <div class="sim-root">
    <!-- 主运行区：占满整个视口（画布全屏最大化，控制条仅悬浮其上） -->
    <div class="stage" ref="stageRef">
      <canvas ref="canvasRef" class="sim-canvas"></canvas>
    </div>

    <SimDock
      ref="dockRef"
      :playing="playing"
      :muted="muted"
      :show-count="true"
      :count="countInput"
      :count-min="1"
      :count-max="MAX_DOTS"
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
  align-items: flex-end;
  gap: clamp(14px, 2.4vw, 30px);
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

.pgroup {
  min-width: 150px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pgroup.grow {
  flex: 1;
  min-width: 200px;
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

/* 窄屏逐步隐藏次要控件 */
@media (max-width: 1080px) {
  .btn.sound { display: none; }
}
</style>
