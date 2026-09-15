<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import SimDock from './SimDock.vue'
// 音效播放逻辑与音阶常量已抽离为可复用模块（见 src/audio）
import { SoundEngine } from '../audio/soundEngine.js'
import { BASE_FREQS as NOTE_FREQS, NOTE_NAMES } from '../audio/scaleTones.js'

/* =========================================================
 * 需求映射（新增“自然回归原点”的周期规律）
 *  1. 页面正中绘制一个椭圆形路径作为运动轨道，椭圆最顶部为固定原点。
 *  2. 原点处 145 个运动点分 10 层：最快层 19 点 → 最慢层 10 点（19+18+…+10=145）。
 *  3. 周期 = CYCLE_S = 90 秒。第 k 层（cnt = 20−k 个点）把椭圆内环均分成
 *     N=cnt+1 个轨位（轨位 0 即原点），层内每个点一个周期恰好碰撞 cnt+1 次：
 *       19 点层 → 20 次 · 18 点层 → 19 次 · … · 10 点层 → 11 次
 *     每个点先飞向其“发散轨位”f（= 序号+1，逐点不同 → 发散角度各不相同），
 *     再按与该层点数互素的步长 s 遍历其余全部非原点轨位，最后一条弦落回原点轨；
 *     因此每个点“最后一次碰撞即回归原点的碰撞”，且此前绝不会经过原点。
 *  4. 回归从不“强制”：没有“到 90 秒把点瞬间拉回原点”的逻辑。点始终匀速直线
 *     飞行、撞轨即转向；速率 = 自身闭合折线长度 / 90s（逐点不同），因此每个点
 *     的第 cnt+1 条弦终点被几何天然算准在原点，点沿该弦自然飞抵原点完成回归，
 *     随后无缝进入下一周期。
 *  5. 同层同色，10 层按彩虹色序着色；撞轨发声（每层一种固定音，外层 do … 内层递增）；
 *     撞到原点轨（回归）时在原点激起波纹并点亮该层。
 * ========================================================= */

/* ---------- 常量 ---------- */
const LAYER_COUNT = 10        // 层数
const CYCLE_S = 90            // 周期秒数：每个点完成 cnt+1 次碰撞并回归原点
const MAX_FRAME = 0.05        // 单帧最大 dt
const ELLIPSE_V = 1.00        // 椭圆纵向半径相对横向的放大系数（纵向稍大）
const RING_ALPHA = 0.5        // 外部椭圆轨道不透明度（最亮）
const LAYER_CHORD_ALPHA = 0.4 // 同层内相邻点连线（比轨道更淡，但清晰可见）
const ORIGIN_R = 7            // 原点半径
const MIN_NOTE_GAP = 0.08     // 相邻发声最小真实间隔（节流）
const DEFAULT_SPEED = 1       // 默认倍速（下拉选项 1x/2x/5x/10x）
const AUDIO_DEBUG = true      // 调试开关：true 时暴露 window.__ellipseAudio

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

// 最大公约数（用于挑选与层点数互素的穿行步长）
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
 * 运动规律：本层把椭圆内环均分成 N=cnt+1 个轨位（轨位 0 = 原点），其余 1..cnt
 * 为非原点轨位。点 j 的发散轨位 f=j+1（首弦目标逐点不同 → 发散角度各不相同），
 * 之后以互素步长 s 遍历其余全部非原点轨位（gcd(s,cnt)=1 → 一个周期内轨位不重
 * 不漏、中途绝不经过原点轨 0），最后一条弦才落回原点 → 恰好在 90s 周期终点回归。 */
const DOTS = (() => {
  const out = []
  for (let k = 1; k <= LAYER_COUNT; k++) {
    const cnt = countOfLayer(k)
    const meta = LAYER_META[k - 1]
    // 互素步长池：与 cnt 互素的 s（1..cnt-1），作为该层各点“穿行步长”的来源
    const steps = []
    for (let s = 1; s < cnt; s++) if (gcd(s, cnt) === 1) steps.push(s)
    for (let j = 0; j < cnt; j++) {
      out.push({
        i: out.length,
        layer: k,
        rank: j,
        N: cnt + 1,          // 该层每点一个周期的碰撞次数（= 点数 + 1）
        f: j + 1,            // 发散轨位：首弦目标逐点不同（1..cnt）→ 发散角度各不相同
        s: steps[j % steps.length], // 穿行步长：与 cnt 互素 → 走遍非原点轨位且不重复
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

// 各层当前轨道几何：轨位 n 的像素坐标（n=0 即原点）
const LAYER_GEOM = LAYERS.map((m) => ({
  k: m.k,
  N: m.count + 1,
  PX: new Float64Array(m.count + 1),
  PY: new Float64Array(m.count + 1),
}))

/* ---------- 交互状态 ---------- */
const speedScale = ref(DEFAULT_SPEED)
const playing = ref(false)
const muted = ref(false)
const showLayerChord = ref(true)   // 同层内相邻点连线（两端端点不连）
const showRings = ref(true)        // 是否绘制椭圆轨道
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
  ripples: [],                    // 回归原点时的波纹
  elapsed: 0,                     // 累计仿真时间（秒，受倍速影响；周期由 CYCLE_S 决定）
  pos: new Float64Array(TOTAL_POINTS * 2),   // 各点位置 x,y（每帧由周期相位求出）
}
// 原点 = 椭圆轨道最顶部（所有点的出发/回归处）
function originX() { return sim.cx }
function originY() { return sim.cy - sim.Ry }

let rafId = 0
let lastTs = 0
let resizeObserver = null

/* ---------- 布局：椭圆路径居中，原点位于椭圆的最顶部 ---------- */
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

  sim.elapsed = 0
  buildPaths()   // 轨道尺寸变化后重建全部点路径（轨位均匀分布于椭圆）
}

/* ---------- 控制 ---------- */
function reset() {
  playing.value = false
  engine.unlock()
  sim.ripples.length = 0
  lastNote.value = null
  activeIdx.value = -1
  sim.elapsed = 0
  initCycle()
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

/* ---------- 音频：由可复用 SoundEngine 负责（见 src/audio/soundEngine.js） ----------
 * 本页仅负责“何时发声 / 发什么音”，调用 engine.play(freq, pan, opts) 即可。 */

const engine = new SoundEngine({ masterVolume: 0.32, reverbMix: 0.22, reverbTime: 1.4 , debug: AUDIO_DEBUG })
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

/* ---------- 运动：90s 周期 · 闭合折线 · 自然回归 ----------
 * 每层把椭圆内环均分为 N=cnt+1 个轨位（轨位 0 = 原点，位于椭圆最顶部）。
 * 每个点的轨位序列：0 → 发散轨位 f → 以互素步长 s 依次遍历该层其余全部
 * 非原点轨位（gcd(s,cnt)=1 ⇒ 走遍 1..cnt 不重不漏、中途绝不碰原点）→ 0。
 * 点始终在相邻轨位间走直线弦、速率恒定 → 每撞一次内壁即“转向”进入下一条弦。
 * 因为只有最后一条弦以轨位 0 为终点，“最后一次碰撞即回归原点”由几何天然决定：
 * 点按自身速率自然飞抵原点完成回归，全程无任何强制归位。
 * 速率 = 自身闭合折线长度 / CYCLE_S，使每个点恰在 90s 内走完一个周期并回归。 */

// 按当前椭圆尺寸重建每个点的闭合折线路径、速率与碰撞时刻表
function buildPaths() {
  if (!sim.Rx) return
  const { cx, cy, Rx, Ry } = sim

  // 各层轨位：n=0 为原点，其余 N-1 个轨位在椭圆上按 2π/N 均匀分布
  for (const lg of LAYER_GEOM) {
    for (let n = 0; n < lg.N; n++) {
      const u = -Math.PI / 2 + (Math.PI * 2 * n) / lg.N
      lg.PX[n] = cx + Rx * Math.cos(u)
      lg.PY[n] = cy + Ry * Math.sin(u)
    }
  }

  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const lg = LAYER_GEOM[d.layer - 1]
    const N = d.N
    const cnt = N - 1
    const PX = lg.PX
    const PY = lg.PY

    // 弦端点轨位序列 seq[0..N]：seq[0]=0(原点) → 发散轨位 f → 按互素步长 s
    // 依次走遍 1..cnt 全部非原点轨位（中途绝不经过原点轨）→ seq[N]=0(原点)。
    // 点恰好有 N 条弦、恰好碰撞 N=cnt+1 次，末条弦终点 = 原点 → 周期终点自然回归。
    if (!d.seq || d.seq.length !== N + 1) d.seq = new Uint8Array(N + 1)
    const seq = d.seq
    seq[0] = 0
    for (let j = 1; j < N; j++) {
      seq[j] = ((d.f - 1 + (j - 1) * d.s) % cnt) + 1
    }
    seq[N] = 0

    // 前缀累计路程 pref[j] = 走完第 1~j 条弦后的路程
    if (!d.pref) d.pref = new Float64Array(N + 1)
    const pref = d.pref
    pref[0] = 0
    for (let j = 0; j < N; j++) {
      const dx = PX[seq[j + 1]] - PX[seq[j]]
      const dy = PY[seq[j + 1]] - PY[seq[j]]
      pref[j + 1] = pref[j] + Math.hypot(dx, dy)
    }

    // 恒定速率 = 闭合折线总长 / 周期 → 第 N 次（最后）碰撞恰在第 90 秒回归原点
    const total = pref[N]
    d.speed = Math.max(0.001, total / CYCLE_S)

    // 各次碰撞的周期内时刻 T[j]（j=1..N；T[N]=90）
    if (!d.T) d.T = new Float64Array(N + 1)
    const T = d.T
    T[0] = 0
    for (let j = 1; j <= N; j++) T[j] = pref[j] / d.speed
  }
  initCycle()
}

// 周期起始：所有点回到原点，从各自的第 1 次碰撞开始计时
function initCycle() {
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    d.gidx = 1          // 下一个待触发事件的下标（1..N）
    d.nextAt = d.T[1]   // 首次碰撞的绝对时间
  }
}

// 由周期相位把 145 个点摆到各自弦上（相位 0 = 原点）
function placeDots() {
  if (!sim.Rx) return
  const ph = sim.elapsed % CYCLE_S
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const lg = LAYER_GEOM[d.layer - 1]
    const N = d.N
    const seq = d.seq
    const pref = d.pref
    const PX = lg.PX
    const PY = lg.PY

    const dist = ph * d.speed
    // 定位当前在第几条弦上（弦 k：pref[k] → pref[k+1]）
    let k = 0
    while (k < N - 1 && pref[k + 1] <= dist) k++
    const span = pref[k + 1] - pref[k]
    let u = span > 1e-12 ? (dist - pref[k]) / span : 0
    if (u < 0) u = 0
    else if (u > 1) u = 1

    const a = seq[k]
    const b = seq[k + 1]
    sim.pos[i * 2] = PX[a] + (PX[b] - PX[a]) * u
    sim.pos[i * 2 + 1] = PY[a] + (PY[b] - PY[a]) * u
  }
}

// 某次撞轨事件：轨位 rail（0 = 原点，即“回归原点”的碰撞）
function fireEvent(d, lg, rail) {
  const now = performance.now() / 1000

  // 撞轨发声：每层固定一种音（外层 do … 内层升调）
  if (!muted.value && (lastNoteReal < 0 || now - lastNoteReal >= MIN_NOTE_GAP)) {
    lastNoteReal = now
    const n = noteOf(d.layer - 1)
    lastNote.value = { seq: d.layer, name: n.name, title: n.title, h: d.h }
    engine.play(n.freq, 0, { impact: false })
  }

  // 撞到原点轨（0）→ 这次碰撞就是“回归原点的碰撞”：原点激起波纹、点亮该层
  if (rail === 0) {
    stats.passes++
    if (!muted.value && sim.ripples.length < 16) {
      sim.ripples.push({ x: originX(), y: originY(), age: 0, h: d.h })
    }
    activeIdx.value = d.layer - 1
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { activeIdx.value = -1 }, 320)
  }
}

function updateSim(dt) {
  sim.elapsed += dt * (Number(speedScale.value) || 1)
  const now = sim.elapsed

  // 逐点推进“撞轨事件”：谁的时刻到了就触发（含 90s 时刻的回归原点）
  for (let i = 0; i < TOTAL_POINTS; i++) {
    const d = DOTS[i]
    const lg = LAYER_GEOM[d.layer - 1]
    while (d.nextAt <= now) {
      const g = d.gidx
      fireEvent(d, lg, d.seq[g])
      // 计算与下一次事件的时间间隔（周期 90s，事件可越过周期边界）
      const curT = d.T[g]
      d.gidx = g < d.N ? g + 1 : 1
      const dT = d.gidx === 1 ? d.T[1] : d.T[d.gidx] - curT
      d.nextAt += dT
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

// 固定原点（椭圆轨道最顶部，所有点的出发/回归处）
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
  placeDots()
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
