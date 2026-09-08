/**
 * 彩虹色工具（与点一一对应）
 * -------------------------------------------------
 * 彩虹两端点色：红(0°) 与 紫(285°)。
 * 第 i 个点（0 起，共 total 个）按“页面自身顺序”（如从内到外、从快到慢）取色：
 *  - 两个端点（i=0 与 i=total−1）分别取彩虹两个端点色
 *  - 中间点按彩虹色渐变的顺序依次标注
 */
export const RAINBOW_HUE_START = 0   // 红
export const RAINBOW_HUE_END = 285  // 紫（靛蓝偏紫）

// 七段彩虹名称（用于图例/提示文案）
export const RAINBOW_NAMES = ['红', '橙', '黄', '绿', '蓝', '靛', '紫']
const RAINBOW_NAME_HUES = [0, 30, 55, 130, 205, 240, 285]

export function hsl(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)` }
export function hsla(h, s, l, a) { return `hsla(${h}, ${s}%, ${l}%, ${a})` }

// 第 i 个点（共 total 个）的彩虹色相：端点取两端色，中间线性渐变
export function rainbowHue(i, total) {
  if (total <= 1) return RAINBOW_HUE_START
  const t = i / (total - 1)
  return RAINBOW_HUE_START + (RAINBOW_HUE_END - RAINBOW_HUE_START) * t
}

// 最近的彩虹名称（用于提示文案）
export function nearestRainbowName(hue) {
  let best = RAINBOW_NAMES[0]
  let bestD = Infinity
  for (let k = 0; k < RAINBOW_NAME_HUES.length; k++) {
    const d = Math.abs(RAINBOW_NAME_HUES[k] - hue)
    if (d < bestD) { bestD = d; best = RAINBOW_NAMES[k] }
  }
  return best
}

// 第 i 个点（共 total 个）的一组配色：主体 / 亮部 / 暗部
export function rainbowColors(i, total, sat = 92) {
  const h = rainbowHue(i, total)
  return {
    hue: h,
    color: hsl(h, sat, 62),
    light: hsl(h, sat + 4, 82),
    dark: hsl(h, sat - 4, 44),
  }
}
