// [P2-d] Layer colours readable on the canvas of either theme. The suggested colours
// (KiCad-like, chosen for a dark canvas) are kept when they contrast enough with the
// canvas; otherwise they are mixed towards black (light canvas) or white (dark
// canvas) until they reach a 3:1 contrast ratio, keeping their hue. Pure functions.

import type { ResolvedTheme } from '../site'

export const CANVAS_BG: Record<ResolvedTheme, string> = { dark: '#0b0c0e', light: '#f4f3ee' }
const MIN_CONTRAST = 3

type Rgb = [number, number, number]

function parse(c: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, d => d + d) : m[1]!
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb
}
const hex = (c: Rgb) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')

function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function contrast(a: string, b: string): number {
  const x = parse(a), y = parse(b)
  if (!x || !y) return 21
  const l1 = luminance(x), l2 = luminance(y)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const cache = new Map<string, string>()

/** `color` adjusted to read on the canvas of `theme` (non-hex colours pass through). */
export function readableLayerColor(color: string, theme: ResolvedTheme): string {
  const key = `${theme}:${color}`
  const hit = cache.get(key)
  if (hit) return hit
  const rgb = parse(color)
  let out = color
  if (rgb) {
    const bg = CANVAS_BG[theme]
    const target: Rgb = theme === 'light' ? [0, 0, 0] : [255, 255, 255]
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const c = hex(rgb.map((v, i) => v + (target[i]! - v) * t) as Rgb)
      out = c
      if (contrast(c, bg) >= MIN_CONTRAST) break
    }
  }
  cache.set(key, out)
  return out
}
