// Session cache of layer SVGs, keyed by `layer.url` (the url carries the content
// key, so an entry never goes stale). Each SVG is fetched once, parsed once into an
// <svg> element that the stage mounts as a nested viewport, and kept for the session.
//
// The load state lives in a reactive map so the layer list can show per-layer
// loading / error marks; the parsed element itself is not made reactive.

import { markRaw, shallowReactive } from 'vue'

export type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; node: SVGSVGElement; bytes: number; ms: number }
  | { state: 'error'; message: string }

const states = shallowReactive(new Map<string, LoadState>())

export function layerState(url: string): LoadState | undefined {
  return states.get(url)
}

/**
 * Start loading `url` unless it is loaded or loading. `signal` belongs to the
 * board the request was made for: when that board is left the request is
 * aborted and forgotten, so a later visit starts it again.
 */
export function requestLayer(url: string, signal: AbortSignal): void {
  const cur = states.get(url)
  if (cur && cur.state !== 'error') return
  if (signal.aborted) return
  states.set(url, { state: 'loading' })
  const t0 = performance.now()
  fetch(url, { signal })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const node = parseLayer(text)
      if (signal.aborted) return
      states.set(url, { state: 'ready', node: markRaw(node), bytes: text.length, ms: performance.now() - t0 })
    })
    .catch((err: unknown) => {
      if (signal.aborted) {
        if (states.get(url)?.state === 'loading') states.delete(url)
        return
      }
      states.set(url, { state: 'error', message: err instanceof Error ? err.message : String(err) })
    })
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SHAPES = 'path,polygon,polyline,circle,ellipse,rect,line'
const COLOUR = /(fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})/g
const isBlackOrWhite = (c: string) => /^#(0{3}|0{6}|f{3}|f{6})$/i.test(c)

function parseLayer(text: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('not an SVG document')
  const svg = document.importNode(root, true) as unknown as SVGSVGElement
  // Nested viewport: x/y/width/height in the parent's user units (board mm) equal
  // to the viewBox, so every layer maps 1:1 onto board coordinates.
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length !== 4 || !vb.every(Number.isFinite)) throw new Error('SVG without a usable viewBox')
  svg.setAttribute('x', String(vb[0]))
  svg.setAttribute('y', String(vb[1]))
  svg.setAttribute('width', String(vb[2]))
  svg.setAttribute('height', String(vb[3]))
  svg.setAttribute('overflow', 'visible')
  rescueMaskedShapes(svg)
  maskToClip(svg)
  return svg
}

/**
 * Speed: an SVG <mask> costs an offscreen luminance surface per layer on every
 * repaint (measured: the Controller with all layers drops from 60 to about 45 fps
 * while zooming in software raster). The hole mask is only "everything minus some
 * circles and slots", so turn it into an even-odd clip path (a geometric clip, no
 * extra surface). Holes: filled circles, filled paths and round-capped stroked
 * straight segments (plotted slots). Anything else keeps the original mask.
 */
function maskToClip(svg: SVGSVGElement): void {
  const mask = svg.querySelector('defs > mask')
  const content = svg.querySelector(':scope > g[mask]')
  if (!mask || !content) return
  const backdrop = mask.querySelector(':scope > rect')
  if (!backdrop) return
  const n = (el: Element, a: string) => Number(el.getAttribute(a))
  const f = (v: number) => String(Math.round(v * 1e5) / 1e5)
  const holes = new Set<string>()
  const styleOf = (el: Element, prop: string): string | null => {
    for (let p: Element | null = el; p && p !== mask; p = p.parentElement) {
      const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(p.getAttribute('style') ?? '')
      if (m) return m[1]!.trim()
    }
    return null
  }
  for (const el of Array.from(mask.querySelectorAll('*'))) {
    if (el === backdrop) continue
    const t = el.getAttribute('transform')
    if (t && !/^\s*translate\(0[ ,]+0\)\s*scale\(1[ ,]+1\)\s*$/.test(t)) return
    if (el.tagName === 'g') continue
    if (el.tagName === 'circle') {
      const cx = n(el, 'cx'), cy = n(el, 'cy'), r = n(el, 'r')
      holes.add(`M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`)
    } else if (el.tagName === 'path') {
      const d = el.getAttribute('d') ?? ''
      const fill = styleOf(el, 'fill')
      if (fill && fill !== 'none') { holes.add(d.trim()); continue }
      const seg = /^\s*M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*$/.exec(d)
      const w = Number(styleOf(el, 'stroke-width'))
      if (!seg || !(w > 0)) return
      const [x1, y1, x2, y2] = seg.slice(1).map(Number) as [number, number, number, number]
      const r = w / 2, len = Math.hypot(x2 - x1, y2 - y1)
      if (len === 0) { holes.add(`M${f(x1 - r)} ${f(y1)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`); continue }
      const nx = (-(y2 - y1) / len) * r, ny = ((x2 - x1) / len) * r
      holes.add(`M${f(x1 + nx)} ${f(y1 + ny)}L${f(x2 + nx)} ${f(y2 + ny)}A${f(r)} ${f(r)} 0 0 0 ${f(x2 - nx)} ${f(y2 - ny)}` +
        `L${f(x1 - nx)} ${f(y1 - ny)}A${f(r)} ${f(r)} 0 0 0 ${f(x1 + nx)} ${f(y1 + ny)}Z`)
    } else return
  }
  const x = n(backdrop, 'x'), y = n(backdrop, 'y'), w = n(backdrop, 'width'), h = n(backdrop, 'height')
  const clip = document.createElementNS(SVG_NS, 'clipPath')
  clip.id = `${mask.id}-clip`
  clip.setAttribute('clipPathUnits', 'userSpaceOnUse')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('clip-rule', 'evenodd')
  path.setAttribute('d', `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z` + [...holes].join(''))
  clip.appendChild(path)
  mask.replaceWith(clip)
  content.removeAttribute('mask')
  content.setAttribute('clip-path', `url(#${clip.id})`)
}

/**
 * Work-around for the exporter (plugins/kicad/svg.ts) classifying KiCad's default
 * black wrapper group as "drill holes": shapes inside it that carry their own
 * layer colour (custom pads, filled polygons, logos) end up in the hole <mask>
 * and are never drawn. Move every such shape out of the mask into the drawn
 * content, keeping the transforms of its wrappers, and draw it in currentColor.
 * A no-op for SVGs that do not have the problem.
 */
function rescueMaskedShapes(svg: SVGSVGElement): void {
  const mask = svg.querySelector('defs > mask')
  if (!mask) return
  const content = svg.querySelector(':scope > g[mask]')
  if (!content) return
  const moved: Element[] = []
  for (const el of Array.from(mask.querySelectorAll(SHAPES))) {
    const style = el.getAttribute('style') ?? ''
    const colours = Array.from(style.matchAll(COLOUR), m => m[2]!)
    if (!colours.length || colours.every(isBlackOrWhite)) continue
    const transforms: string[] = []
    for (let p = el.parentElement; p && p !== mask; p = p.parentElement) {
      const t = p.getAttribute('transform')
      if (t) transforms.unshift(t)
    }
    el.setAttribute('style', style.replace(COLOUR, '$1:currentColor').replace(/(fill|stroke)-opacity\s*:\s*[\d.]+;?/g, ''))
    if (transforms.length) {
      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('transform', transforms.join(' '))
      g.appendChild(el)
      moved.push(g)
    } else moved.push(el)
  }
  if (moved.length) content.prepend(...moved)
}
