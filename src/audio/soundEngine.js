/**
 * 可复用的音效播放引擎（Web Audio 实时合成，无外部资源）
 * -------------------------------------------------
 * 页面只需创建并持有 SoundEngine 实例，碰撞时调用 play(freq, pan) 即可发声：
 *   - 音频上下文由“用户手势”解锁（浏览器自动播放策略），会自动重试/补发
 *   - 音高（freq）由 scaleTones.js 的 assembleScale 预先算好后传入，本引擎只负责合成与播放
 *   - 每个音 = 基音(指数衰减) + 八度/高频泛音 + 一记“撞击瞬态”噪声，并支持左右声道定位
 *   - 所有发声汇总到 voiceBus：干声直连总线，同时按比例送入卷积混响支路（合成 IR），得到空间/立体感
 */
import { assembleScale } from './scaleTones.js'

export class SoundEngine {
  constructor(opts = {}) {
    this.masterVolume = opts.masterVolume ?? 0.55
    this.debug = opts.debug ?? false

    // 空间感（混响）参数：wet 比例越高越“远”，时间越长空间越大
    this.reverbEnabled = opts.reverb !== false
    this.reverbMix = opts.reverbMix ?? 0.26
    this.reverbTime = opts.reverbTime ?? 1.7

    this.audioCtx = null
    this.masterGain = null
    this.voiceBus = null      // 所有发声点汇总到总线，再分出干声与混响送出
    this.reverbSend = null
    this.reverbPreDelay = null
    this.reverbDamp = null
    this.convolver = null
    this.reverbReturn = null
    this.noiseBuffer = null
    this.resumePromise = null
    this.retryTimer = 0
    this.lastProbe = 0
    this.pending = [] // 解锁前发生的碰撞音先入队，解锁成功后补发
    this.muted = false
    this.stats = {
      builds: 0,
      unlockCalls: 0,
      collisions: 0,
      noteAttempts: 0,
      notesScheduled: 0,
      notesFlushed: 0,
    }

    this._stereoPanSupport = undefined
    this._onStateChange = this._onStateChange.bind(this)
  }

  /* ---------- 音频图构建 ---------- */
  build() {
    // closed（浏览器已关闭/异常结束的旧上下文）必须丢弃重建
    if (this.audioCtx && this.audioCtx.state !== 'closed') return true
    if (this.audioCtx) {
      this.audioCtx = null
      this.masterGain = null
      this.voiceBus = null
      this.reverbSend = null
      this.reverbPreDelay = null
      this.reverbDamp = null
      this.convolver = null
      this.reverbReturn = null
      this.noiseBuffer = null
    }
    const AC = window.AudioContext || window['webkitAudioContext']
    if (!AC) return false
    try {
      this.audioCtx = new AC()
      this.audioCtx.addEventListener('statechange', this._onStateChange)

      // 总线：音量 + 软限幅，防止多个音同时碰撞时削波
      this.masterGain = this.audioCtx.createGain()
      this.masterGain.gain.value = this.masterVolume
      const comp = this.audioCtx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.knee.value = 18
      comp.ratio.value = 8
      comp.attack.value = 0.003
      comp.release.value = 0.25
      this.masterGain.connect(comp)
      comp.connect(this.audioCtx.destination)

      // 发声总线：干声直连 masterGain，同时按比例送入混响支路
      this.voiceBus = this.audioCtx.createGain()
      this.voiceBus.gain.value = 1
      this.voiceBus.connect(this.masterGain)
      this._buildReverb()

      // 预生成 60ms 白噪声缓冲，供“撞击瞬态”复用
      const len = Math.floor(this.audioCtx.sampleRate * 0.06)
      this.noiseBuffer = this.audioCtx.createBuffer(1, len, this.audioCtx.sampleRate)
      const data = this.noiseBuffer.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

      this.stats.builds++
      return true
    } catch (err) {
      console.warn('WebAudio 初始化失败', err)
      try { this.audioCtx && this.audioCtx.close() } catch (e) {}
      this.audioCtx = null
      this.masterGain = null
      this.voiceBus = null
      this.reverbSend = null
      this.reverbPreDelay = null
      this.reverbDamp = null
      this.convolver = null
      this.reverbReturn = null
      this.noiseBuffer = null
      return false
    }
  }

  /* ---------- 混响支路 ---------- */
  // 合成一段立体声脉冲响应（IR）：指数衰减噪声 + 高频阻尼，听起来像中小房间的自然回声
  _buildImpulseResponse(seconds, decay = 2.6) {
    const rate = this.audioCtx.sampleRate
    const len = Math.max(1, Math.floor(rate * seconds))
    const buf = this.audioCtx.createBuffer(2, len, rate)
    const fadeIn = Math.max(1, rate * 0.004) // 头部淡入，避免“咔哒”爆音
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch)
      let lp = 0
      for (let i = 0; i < len; i++) {
        const t = i / len
        const env = Math.pow(1 - t, decay)
        const n = Math.random() * 2 - 1
        lp += (n - lp) * 0.32 // 一阶低通：模拟空气对高频的吸收
        data[i] = lp * env * Math.min(1, i / fadeIn)
      }
    }
    return buf
  }

  _buildReverb() {
    if (!this.reverbEnabled || !this.audioCtx.createConvolver) return false
    try {
      this.convolver = this.audioCtx.createConvolver()
      this.convolver.normalize = true // 由浏览器按能量归一，湿声音量不随混响时长漂移
      this.convolver.buffer = this._buildImpulseResponse(this.reverbTime)

      this.reverbSend = this.audioCtx.createGain()
      this.reverbSend.gain.value = 1

      // 预延迟：直达声与回声拉开一点距离，空间定位更清晰
      this.reverbPreDelay = this.audioCtx.createDelay(0.2)
      this.reverbPreDelay.delayTime.value = 0.018

      // 阻尼低通：只让中低频进入混响，避免高频糊成一片
      this.reverbDamp = this.audioCtx.createBiquadFilter()
      this.reverbDamp.type = 'lowpass'
      this.reverbDamp.frequency.value = 4200
      this.reverbDamp.Q.value = 0.7071

      this.reverbReturn = this.audioCtx.createGain()
      this.reverbReturn.gain.value = this.reverbMix

      this.voiceBus.connect(this.reverbSend)
      this.reverbSend.connect(this.reverbPreDelay)
      this.reverbPreDelay.connect(this.reverbDamp)
      this.reverbDamp.connect(this.convolver)
      this.convolver.connect(this.reverbReturn)
      this.reverbReturn.connect(this.masterGain)
      return true
    } catch (err) {
      console.warn('混响初始化失败，退回干声', err)
      this.convolver = null
      this.reverbSend = null
      this.reverbReturn = null
      return false
    }
  }

  // 运行时调节湿声比例（0 = 全干声）
  setReverbMix(v) {
    this.reverbMix = Math.max(0, Math.min(1, Number(v) || 0))
    if (this.reverbReturn && this.audioCtx) {
      this.reverbReturn.gain.setTargetAtTime(this.reverbMix, this.audioCtx.currentTime, 0.05)
    }
  }

  _onStateChange() {
    if (!this.audioCtx) return
    if (this.audioCtx.state === 'running') {
      this.flushPending()
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = 0
      }
    }
  }

  /* ---------- 解锁（必须在用户手势内调用） ---------- */
  unlock() {
    if (!this.build()) return Promise.resolve(false)
    this.stats.unlockCalls++
    if (this.audioCtx.state === 'running') return Promise.resolve(true)
    if (this.audioCtx.state === 'suspended' && !this.resumePromise) {
      this.resumePromise = this.audioCtx.resume().then(
        () => {
          this.resumePromise = null
          return !!(this.audioCtx && this.audioCtx.state === 'running')
        },
        () => {
          this.resumePromise = null
          this.scheduleRetry()
          return false
        }
      )
    }
    return this.resumePromise || Promise.resolve(false)
  }

  scheduleRetry() {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.unlock()
    }, 900)
  }

  // 解锁成功后补发之前被拦截的碰撞音
  flushPending() {
    if (!this.pending.length || !this.audioCtx || this.audioCtx.state !== 'running') return
    const batch = this.pending.splice(0)
    for (const item of batch) {
      try { if (this._scheduleFreq(item.freq, item.pan, item.opts)) this.stats.notesFlushed++ } catch (e) {}
    }
  }

  /* ---------- 左右声道定位 ---------- */
  _panSupported() {
    if (this._stereoPanSupport === undefined) {
      const AC = window.AudioContext || window['webkitAudioContext']
      this._stereoPanSupport = !!(AC && AC.prototype && typeof AC.prototype.createStereoPanner === 'function')
    }
    return this._stereoPanSupport
  }
  // wet=true 时走“干声 + 混响送出”的总线；wet=false 只出干声
  _pannedOut(pan, wet = true) {
    const dest = (wet && this.voiceBus) || this.masterGain
    const pv = Math.max(-1, Math.min(1, Number(pan) || 0))
    if (pv !== 0 && this._panSupported()) {
      const node = this.audioCtx.createStereoPanner()
      node.pan.value = pv
      node.connect(dest)
      return node
    }
    return dest
  }

  /* ---------- 合成单音 ---------- */
  _strike(freq, t0, type, peak, decay, pan, wet = true) {
    const osc = this.audioCtx.createOscillator()
    const g = this.audioCtx.createGain()
    const out = this._pannedOut(pan, wet)
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
      if (out !== this.masterGain && out !== this.voiceBus) out.disconnect()
    }
  }

  // 撞击瞬态（短促带通噪声，模拟“触碰直线”的物理感）
  _noiseHit(t0, dur, pan, wet = true) {
    if (!this.noiseBuffer || !this.masterGain) return
    const src = this.audioCtx.createBufferSource()
    src.buffer = this.noiseBuffer
    const filter = this.audioCtx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 2600
    filter.Q.value = 0.8
    const g = this.audioCtx.createGain()
    const out = this._pannedOut(pan, wet)
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
      if (out !== this.masterGain && out !== this.voiceBus) out.disconnect()
    }
  }

  // 真正调度一个频率（含泛音与可选撞击瞬态）；仅在 running 且未静音时执行
  // opts.soft  : true 时整体更轻更短（用于重叠和声音程等）
  // opts.impact: false 时不加物理撞击瞬态噪声（用于纯钟琴音色页面）
  // opts.reverb: false 时该音只出干声，不进混响
  _scheduleFreq(freq, pan = 0, opts = {}) {
    if (this.muted || !this.audioCtx || !this.masterGain || this.audioCtx.state !== 'running') return false
    const soft = !!opts.soft
    const withImpact = opts.impact !== false
    const wet = opts.reverb !== false // 单音级开关：可指定某个音不进混响
    const t0 = this.audioCtx.currentTime
    try {
      if (withImpact) this._noiseHit(t0, 0.035, pan, wet)              // 物理撞击瞬态（可关闭）
      this._strike(freq, t0, 'sine', soft ? 0.2 : 0.5, soft ? 0.5 : 0.9, pan, wet)       // 基音
      this._strike(freq * 2.01, t0, 'sine', soft ? 0.05 : 0.12, soft ? 0.18 : 0.28, pan, wet) // 八度泛音“叮”
      this._strike(freq * 4.07, t0, 'sine', soft ? 0.02 : 0.06, 0.1, pan, wet) // 高频亮色
      this.stats.notesScheduled++
      return true
    } catch (err) {
      console.warn('音符调度失败', err)
      return false
    }
  }

  /**
   * 第 index 个点（0 起）触线时发声。
   * @param {number} freq 由 assembleScale 预先算好的频率
   * @param {number} pan  −1 左声道 / 0 居中 / +1 右声道
   * ctx 尚未 running（首次交互未解锁/被策略拦截）时不丢弃：入队等解锁补发。
   */
  play(freq, pan = 0, opts = {}) {
    this.stats.noteAttempts++
    this.stats.collisions++
    if (this.muted) return
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this._scheduleFreq(freq, pan, opts)
      return
    }
    if (this.build()) {
      if (this.pending.length < 32) this.pending.push({ freq, pan, opts })
      this.unlock()
    }
  }

  setMuted(b) { this.muted = !!b }

  // 周期监督：ctx 被策略拦截(suspended)时重试；异常关闭(closed)时重建
  supervisor() {
    if (!this.audioCtx) return
    if (this.audioCtx.state === 'closed') {
      this.build()
      return
    }
    if (this.audioCtx.state === 'suspended') {
      const now = performance.now()
      if (now - this.lastProbe > 1000) {
        this.lastProbe = now
        this.unlock()
      }
    }
  }

  // 调试快照（URL 加 ?debug 后注入 window.__*Audio）
  snapshot() {
    return {
      ctxState: this.audioCtx ? this.audioCtx.state : 'none',
      muted: this.muted,
      reverb: { enabled: !!this.convolver, mix: this.reverbMix, time: this.reverbTime },
      stats: this.stats,
      unlock: () => this.unlock(),
      setReverbMix: (v) => this.setReverbMix(v),
    }
  }

  dispose() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {})
    }
    this.audioCtx = null
    this.masterGain = null
    this.voiceBus = null
    this.reverbSend = null
    this.reverbPreDelay = null
    this.reverbDamp = null
    this.convolver = null
    this.reverbReturn = null
    this.noiseBuffer = null
    this.pending = []
  }
}

// 供页面直接组装音效表的便捷再导出
export { assembleScale }
