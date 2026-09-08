/**
 * 音效定义模块（与播放逻辑解耦，可独立复用）
 * -------------------------------------------------
 * 音阶按“do re mi fa sol la si”定义：
 *  - 基础音效组（BASE）：do..si（参考八度，C4~B4）
 *  - 降调音效组（FLAT）：在基础音效上整体降一个八度
 *  - 升调音效组（SHARP）：多组，第 k 组在基础音效上整体升 (k+1) 个八度；
 *    组数由页面上的点数决定（sharpGroupCount）
 *
 * assembleScale(count) 按“基础 → 降调 → 升调组”的顺序依次装配出与点一一对应的音效表。
 */

// 自然大调唱名（也用于展示）
export const NOTE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si']

// 基础音效组：do re mi fa sol la si（C4 ~ B4）
export const BASE_FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]

// 降调音效组：在基础音效上整体降一个八度
export const FLAT_FREQS = BASE_FREQS.map((f) => f / 2)

// 八度上标字符，用于展示升调音名（do¹ / do² …）
const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷']

// 升调音效组：第 groupIndex 组（0 起）在基础音效上整体升 (groupIndex+1) 个八度
export function buildSharpFreqs(groupIndex) {
  const oct = groupIndex + 1
  return BASE_FREQS.map((f) => f * Math.pow(2, oct))
}

/**
 * 根据点数确定需要的升调组数。
 * 装配顺序 = 基础(1组) → 降调(1组) → 升调组…，共需 ceil(count/7) 组，
 * 因此升调组数 = ceil(count/7) − 2（不足则取 0）。
 */
export function sharpGroupCount(count) {
  return Math.max(0, Math.ceil(count / 7) - 2)
}

/**
 * 装配与点一一对应的音效表（长度 = count）：
 * 顺序依次添加：基础 → 降调 → 升调组1 → 升调组2 → …
 * 返回项：{ index, deg, oct, freq, name, disp, title }
 *  - oct：相对基础的八度（基础=0，降调=−1，升调组 k=+k）
 *  - disp：带八度标记的唱名；title：可读说明
 */
export function assembleScale(count) {
  const n = Math.max(0, Math.floor(count))
  const groups = [BASE_FREQS, FLAT_FREQS]
  const sgc = sharpGroupCount(n)
  for (let k = 0; k < sgc; k++) groups.push(buildSharpFreqs(k))

  const table = []
  for (let i = 0; i < n; i++) {
    const g = Math.min(Math.floor(i / 7), groups.length - 1)
    const deg = i % 7
    const freq = groups[g][deg]
    let oct
    let disp
    let title
    if (g === 0) {
      // 基础音效组
      oct = 0
      disp = NOTE_NAMES[deg]
      title = NOTE_NAMES[deg]
    } else if (g === 1) {
      // 降调音效组
      oct = -1
      disp = NOTE_NAMES[deg] + '♭'
      title = NOTE_NAMES[deg] + '（降一个八度）'
    } else {
      // 升调音效组（g-1 即组别序号）
      const k = g - 1
      oct = k
      disp = NOTE_NAMES[deg] + SUP[Math.min(k, SUP.length - 1)]
      title = NOTE_NAMES[deg] + '（升 ' + k + ' 个八度）'
    }
    table.push({ index: i, deg, oct, freq, name: NOTE_NAMES[deg], disp, title })
  }
  return table
}
