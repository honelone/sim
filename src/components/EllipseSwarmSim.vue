<script setup>
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import SimDock from './SimDock.vue'
// 音效播放逻辑与音阶常量已抽离为可复用模块（见 src/audio）
import { SoundEngine } from '../audio/soundEngine.js'
import { BASE_FREQS as NOTE_FREQS, NOTE_NAMES } from '../audio/scaleTones.js'

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
const MAX_FRAME = 0.05        // 单帧最大 dt
const ELLIPSE_V = 1.03         // 椭圆纵向半径相对横向的放大系数（纵向稍大）
const RING_ALPHA = 0.5        // 外部椭圆轨道不透明度（最亮）
const LAYER_CHORD_ALPHA = 0.4   // 同层内相邻点连线（比轨道更淡，但清晰可见）
const ORIGIN_R = 7            // 原点半径
const MIN_NOTE_GAP = 0.08     // 相邻发声最小真实间隔（节流）
const DEFAULT_SPEED = 1       // 默认倍速（下拉选项 1x/2x/5x/10x）
const AUDIO_DEBUG = true      // 调试开关：true 时暴露 window.__ellipseAudio
const SPREAD_MAX = 78 * Math.PI / 180   // 初始发散方向与竖直轴的参考夹角
const ENDPOINT_PINCH = 0.5              // 最外两点张角压缩系数（<1）：越小，左右端点越靠拢成双
const PINCH_POW = 1.7                   // 压缩曲率：越大，压缩越集中在最外两点
const T_FIRST_BASE = 2.0       // 最快层首次撞轨时间（秒）；层数越多→ratio 越大→首次碰撞越早

/* 椭圆台球：145 个点 = 10 层，第 k 层 (20-k) 个点。
 * 所有点从原点（椭圆顶点）出发，沿「过原点的纵向轴」左右对称地发散；
 * 在椭圆内壁做匀速直线运动，撞到边界时按「入射角 = 反射角」相对椭圆法线反弹；
 * 点数越多 → 初速越大（最快层 19 点、最慢层 10 点）。 */

// 音阶常量（NOTE_FREQS / NOTE_NAMES）已改由 src/audio/scaleTones.js 统一导出

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

const MAX_CNT = countOfLayer(1)   // 19，点数最多（最快层）

/* 145 个运动点 = 10 层，第 k 层有 (20-k) 个点。
 * 椭圆台球：每个点从原点出发，初速方向绕「过原点的纵向轴」左右对称分布；
 * 运行时在椭圆内做匀速直线运动，撞壁时按椭圆法线反弹（见 stepDot）。 */
const DOTS = (() => {
  const out = []
  for (let k = 1; k <= LAYER_COUNT; k++) {
    const cnt = countOfLayer(k)
    const meta = LAYER_META[k - 1]
    const ratio = cnt / MAX_CNT                 // 点数越多 → 初速越大
    const half = (cnt - 1) / 2                 // 使角度索引关于 0 对称
    const spread = half > 0 ? SPREAD_MAX / half : 0
    for (let j = 0; j < cnt; j++) {
      const m = j - half                       // 居中索引：…+m … −m，左右对称
      const ang = m * spread                   // 与竖直轴的夹角（弧度，右正左负）
      out.push({
        i: out.length,
        layer: k,
        rank: j,
        dir: ang,                              // 初始发散方向（绕竖直轴）
        speedRatio: ratio,
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
  return {
    k: meta.k,
    h: meta.h,
    color: meta.color,
    count: members.length,
  }
})

/* ---------- 交互状态 ---------- */
const speedScale = ref(DEFAULT_SPEED)
const playing = ref(false)
const muted = ref(false)
const showLayerChord = ref(true)   // 同层内相邻点连线（两端端点不连）
const showRings = ref(true)         // 是否绘制圆形路径
const lastNote = ref(null)
const activeIdx = ref(-1)

const canvasRef = ref(null)
const stageRef = ref(null)
const dockRef = ref(null)   // 顶部总控条（SimDock 组件根，供 layout 测量遮挡高度）

/* ---------- 运行时非响应式数据 ---------- */
const sim = {
  w: 0, h: 0, dpr: 1,
  cx: 0, cy: 0, Rx: 0, Ry: 0,     // 椭圆轨道：圆心与横/纵半径
  dotR: 4,
  ripples: [],                    // 近原点碰撞时的波纹
  pos: new Float64Array(TOTAL_POINTS * 2),   // 各点位置 x,y
  vel: new Float64Array(TOTAL_POINTS * 2),   // 各点速度 vx,vy（像素/秒）
}
// 原点 = 椭圆轨道最顶部（所有点的出发/回归处）
function originX() { return sim.cx }
function originY() { return sim.cy - sim.Ry }

let rafId = 0
let lastTs = 0
let resizeObserver = null

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
  // 椭圆轨道：纵向半径比横向大一点（保证在区域内不溢出）
  const maxRx = w / 2 - 46
  const maxRy = regionH / 2 - 10
  const base = Math.min(maxRx, maxRy / ELLIPSE_V)
  sim.Rx = Math.max(40, base)
  sim.Ry = sim.Rx * ELLIPSE_V
  sim.dotR = Math.max(2.4, Math.min(5.4, sim.Rx * 0.017))
  initDots()   // 轨道尺寸变化后，重新把所有点放回原点并赋予对称初速
}

/* ---------- 控制 ---------- */
function reset() {
  playing.value = false
  engine.unlock()
  sim.ripples.length = 0
  lastNote.value = null
  activeIdx.value = -1
  initDots()
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

// 同层连线默认开启（showLayerChord），不再区分「相邻 / 全部」三种模式

/* ---------- 音频：由可复用 SoundEngine 负责（见 src/audio/soundEngine.js） ----------
 * 本页仅负责“何时发声 / 发什么音”，调用 engine.play(freq, pan, opts) 即可。 */

const engine = new SoundEngine({ masterVolume: 0.32, debug: AUDIO_DEBUG })
let noticeTimer = 0
let highlightTimer = 0
let lastNoteReal = -1           // 上次发声的真实时间（节流用）
const stats = { passes: 0 }     // 页面统计；音频链路指标由 engine.snapshot() 暴露

// 轻量临时提示（用于静音切换等）
function flashNotice(text, ms = 2600) {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { noticeTimer = 0 }, ms)
  void text
}

/* ---------- 运动：椭圆台球（直线飞行 + 椭圆法线反弹） ----------
 * 每个点从原点出发，在椭圆内做匀速直线运动；
 * 撞到椭圆边界时，按「入射角 = 反射角」相对椭圆在该点的法线反弹。
 * 椭圆方程 ((x-cx)/Rx)² + ((y-cy)/Ry)² = 1，外法线方向正比于梯度
 *   n ∝ ( (x-cx)/Rx² , (y-cy)/Ry² )；反射：v' = v − 2(v·n)n。
 * 由于法线并非半径方向（仅四个顶点处重合），反弹严格遵循椭圆局部弧角，
 * 因此轨迹会随椭圆形状自然改变，不再是圆台球的仿射拉伸。 */

// 把所有点放回原点，并赋予「绕纵向轴对称」的初速
function initDots() {
  const { cx, cy, Rx, Ry } = sim
  if (!Rx) return
  const ox = cx
  const oy = cy - Ry + 0.5          // 原点（椭圆顶点），略向内避免恰好落在边界
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const a = d.dir
    const sa = Math.sin(a), ca = Math.cos(a)
    // 从原点沿 (sin a, cos a) 发出射线，求与椭圆边界的距离 L：
    // 将直线参数式代入椭圆方程，得到 L = (2·cos a / Ry) / (sin²a/Rx² + cos²a/Ry²)
    const L = (2 * ca / Ry) / (sa * sa / (Rx * Rx) + ca * ca / (Ry * Ry))
    // 同层共用首次碰撞时间 T（点数越多 → ratio 越大 → T 越小 → 越早撞轨）；
    // speed = L / T ⇒ 同层所有点同时到达边界，且对称点点距相同 → 速度一致。
    const T = T_FIRST_BASE / d.speedRatio
    const speed = Math.max(0.01, L / T)
    sim.pos[i * 2] = ox
    sim.pos[i * 2 + 1] = oy
    sim.vel[i * 2] = sa * speed
    sim.vel[i * 2 + 1] = ca * speed
  }
}

// 椭圆在 (px,py) 处的单位外法线，写入 out=[nx,ny]
function ellipseNormal(px, py, out) {
  const gx = 2 * (px - sim.cx) / (sim.Rx * sim.Rx)
  const gy = 2 * (py - sim.cy) / (sim.Ry * sim.Ry)
  const len = Math.hypot(gx, gy) || 1
  out[0] = gx / len
  out[1] = gy / len
}

const _n = [0, 0]
// 单个点在 dt 秒内的推进（含至多一次边界反弹）
function stepDot(i, dt) {
  const x = sim.pos[i * 2]
  const y = sim.pos[i * 2 + 1]
  const vx = sim.vel[i * 2]
  const vy = sim.vel[i * 2 + 1]

  // 沿速度方向求解何时触及椭圆边界（ellipseVal = 1 的正根）
  const ax = vx / sim.Rx, ay = vy / sim.Ry
  const a = ax * ax + ay * ay
  const bx = (x - sim.cx) / sim.Rx, by = (y - sim.cy) / sim.Ry
  const b = 2 * (bx * ax + by * ay)
  const c = bx * bx + by * by - 1     // 起点在内部 → c < 0

  const nx = x + vx * dt, ny = y + vy * dt
  if (c < 0 && a > 0) {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const tHit = (-b + Math.sqrt(disc)) / (2 * a)   // 取向外方向的根
      if (tHit > 1e-6 && tHit <= dt) {
        const hx = x + vx * tHit
        const hy = y + vy * tHit
        ellipseNormal(hx, hy, _n)
        const dot = vx * _n[0] + vy * _n[1]
        // 反射：v' = v − 2(v·n)n
        sim.vel[i * 2] = vx - 2 * dot * _n[0]
        sim.vel[i * 2 + 1] = vy - 2 * dot * _n[1]
        // 略微内移，避免下一帧仍被判定为穿出
        sim.pos[i * 2] = hx - _n[0] * 0.01
        sim.pos[i * 2 + 1] = hy - _n[1] * 0.01
        onBoundary(i, hx, hy)
        return
      }
    }
  }
  sim.pos[i * 2] = nx
  sim.pos[i * 2 + 1] = ny
}

// 撞击边界：该层奏固定音（外层 do … 内层升调）；接近原点时激起波纹
function onBoundary(i, hx, hy) {
  if (muted.value) return
  const now = performance.now() / 1000
  if (lastNoteReal >= 0 && now - lastNoteReal < MIN_NOTE_GAP) return
  lastNoteReal = now
  const d = DOTS[i]
  const n = noteOf(d.layer - 1)
  lastNote.value = { seq: d.layer, name: n.name, title: n.title, h: d.h }
  engine.play(n.freq, 0, { impact: false })

  const dx = hx - originX(), dy = hy - originY()
  const r = sim.Rx * 0.18
  if (dx * dx + dy * dy < r * r) {
    if (sim.ripples.length < 16) {
      sim.ripples.push({ x: originX(), y: originY(), age: 0, h: d.h })
    }
    activeIdx.value = d.layer - 1
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { activeIdx.value = -1 }, 320)
  }
}

function updateSim(dt) {
  const scale = Number(speedScale.value) || 1
  let remaining = dt * scale
  // 子步进：把一帧拆小，避免高速穿模、保证每步至多一次反弹
  const maxStep = Math.min(sim.Rx, sim.Ry) * 0.12
  let guard = 0
  while (remaining > 1e-9 && guard++ < 64) {
    const h = Math.min(remaining, maxStep)
    for (let i = 0; i < TOTAL_POINTS; i++) stepDot(i, h)
    remaining -= h
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
  drawRings(ctx)
  drawConnectors(ctx)
  drawRipples(ctx)
  drawOrigin(ctx)
  drawDots(ctx)
}

// 椭圆轨道（最亮）
function drawRings(ctx) {
  const { cx, cy, Rx, Ry } = sim
  ctx.save()
  ctx.lineCap = 'round'
  if (showRings.value) {
    ctx.beginPath()
    ctx.ellipse(cx, cy, Rx, Ry, 0, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(56,189,248,0.10)'
    ctx.lineWidth = 12
    ctx.stroke()

    ctx.beginPath()
    ctx.ellipse(cx, cy, Rx, Ry, 0, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(148,210,253,${RING_ALPHA})`
    ctx.lineWidth = 1.8
    ctx.stroke()
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
    ctx.strokeStyle = hsla(h, 92, 56, LAYER_CHORD_ALPHA)
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
  clearTimeout(noticeTimer)
  clearTimeout(highlightTimer)
  engine.dispose()
})

if (AUDIO_DEBUG) {
  window.__ellipseAudio = {
    ...engine.snapshot(),
    get playing() { return playing.value },
    get points() { return TOTAL_POINTS },
    stats,
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
