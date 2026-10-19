// Thumbnail fallback when the backend cannot render (no `pcb render` before KiCad 9,
// pcbnew-python, or a render that failed): a top view composed from layer SVGs, as an
// SVG file in Board.thumbnail (the cards show it with <img> like the PNG).
//
//   substrate   the outline box in the solder-mask colour, drill holes cut out
//   F.Cu        copper under the mask: the mask colour, lightened
//   F.Mask      mask openings in the surface finish colour (ENIG gold, HASL silver, ...)
//   F.SilkS     the silkscreen colour
//   Edge.Cuts   a dark outline
//
// Uses only exportLayerSvgs (layer plots with and without drill shapes, as the layers
// stage does) and the board file's stackup, so it works with every backend.

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { normaliseLayerSvg, type Rect, type Stackup } from '@kiview/kicad'

import type { StageContext } from './types.ts'

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)
const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_')

/** KiCad's stackup colour names (and #RRGGBB[AA]) as CSS hex. */
const NAMED: Record<string, string> = {
  'green': '#0f5a2a', 'light green': '#2e8b47', 'saturated green': '#127a1e', 'dark green': '#0b3d1c',
  'red': '#8f1c1c', 'light red': '#c83a3a', 'red/orange': '#c4501c',
  'blue': '#1b3f8f', 'light blue': '#3a72c8', 'purple': '#4b2a7a', 'yellow': '#c8b41e',
  'black': '#141414', 'matte black': '#1c1c1c', 'white': '#e8e8e8', 'grey': '#6b6b6b', 'gray': '#6b6b6b',
  'dark grey': '#3a3a3a', 'light grey': '#a8a8a8',
}

export function cssColour(name: string | null, fallback: string): string {
  if (!name) return fallback
  const n = name.trim()
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(n)
  if (hex) return `#${hex[1]}`
  return NAMED[n.toLowerCase()] ?? fallback
}

function mix(hex: string, other: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map(i => Number.parseInt(h.slice(i, i + 2), 16))
  const a = p(hex), b = p(other)
  return '#' + a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}

export function finishColour(finish: string | null): string {
  const f = (finish ?? '').toLowerCase()
  if (/enig|enepig|gold/.test(f)) return '#d6b25e'
  if (/osp|copper/.test(f)) return '#c8814a'
  return '#c9c9c9'   // HAL / HASL (lead-free), immersion tin / silver, none
}

export interface CompositeColours { substrate: string; copper: string; pads: string; silk: string; edge: string }

export function compositeColours(stackup: Stackup, maskOverride: string | null): CompositeColours {
  const substrate = cssColour(maskOverride ?? stackup.maskColor.front, NAMED.green!)
  return {
    substrate,
    copper: mix(substrate, '#ffffff', 0.16),
    pads: finishColour(stackup.finish),
    silk: cssColour(stackup.silkColor.front, substrate === NAMED.white ? '#141414' : '#f4f4f4'),
    edge: '#202020',
  }
}

/** Re-root a normalised layer SVG as a nested <svg> placed on the shared viewBox. */
function nest(svg: string, vb: Rect, colour: string): string {
  return svg.replace(/^<svg\b[^>]*>/, m => {
    const viewBox = /\bviewBox="[^"]*"/.exec(m)![0]
    const xlink = / xmlns:xlink="[^"]*"/.exec(m)?.[0] ?? ''
    return `<svg${xlink} x="${fmt(vb.x)}" y="${fmt(vb.y)}" width="${fmt(vb.width)}" height="${fmt(vb.height)}" ${viewBox} style="color:${colour}">`
  }).replace(/\s*$/, '')
}

/** Compose the layer SVGs (already normalised onto `vb`) into one top view. */
export function composeTopView(o: {
  vb: Rect; outline: Rect | null; layers: Partial<Record<'F.Cu' | 'F.Mask' | 'F.SilkS' | 'Edge.Cuts', string>>
  holesMaskId: string | null; colours: CompositeColours; pixels: { width: number; height: number }
}): string {
  const { vb, colours: c } = o
  const box = o.outline ?? vb
  const sub = `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.width)}" height="${fmt(box.height)}" rx="0.5" fill="${c.substrate}"/>`
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.width)} ${fmt(vb.height)}"` +
      ` width="${o.pixels.width}" height="${o.pixels.height}">`,
    o.holesMaskId ? `<g mask="url(#${o.holesMaskId})">${sub}</g>` : sub,
  ]
  if (o.layers['F.Cu']) parts.push(nest(o.layers['F.Cu'], vb, c.copper))
  if (o.layers['F.Mask']) parts.push(nest(o.layers['F.Mask'], vb, c.pads))
  if (o.layers['F.SilkS']) parts.push(nest(o.layers['F.SilkS'], vb, c.silk))
  if (o.layers['Edge.Cuts']) parts.push(nest(o.layers['Edge.Cuts'], vb, c.edge))
  parts.push('</svg>\n')
  return parts.join('\n')
}

/** Fit the board into the configured thumbnail box, keeping its aspect ratio. */
export function fitPixels(vb: Rect, box: { width: number; height: number }): { width: number; height: number } {
  const s = Math.min(box.width / vb.width, box.height / vb.height)
  return { width: Math.max(1, Math.round(vb.width * s)), height: Math.max(1, Math.round(vb.height * s)) }
}

export async function renderComposite(ctx: StageContext, mask: string | null, box: { width: number; height: number }):
  Promise<{ svg: string; width: number; height: number }> {
  const { info, backend } = ctx
  const snap = await ctx.snapshot()
  const wanted = (['F.Cu', 'F.Mask', 'F.SilkS', 'Edge.Cuts'] as const).filter(id => info.layers.some(l => l.name === id))
  if (!wanted.length) throw new Error('the board has none of F.Cu, F.Mask, F.SilkS, Edge.Cuts')
  const [withHoles, withoutHoles] = await Promise.all([
    ctx.sem.run(() => backend!.exportLayerSvgs(snap.pcb, [...wanted], { holes: true }, ctx.op(join(ctx.workDir, 'ta')))),
    ctx.sem.run(() => backend!.exportLayerSvgs(snap.pcb, [...wanted], { holes: false }, ctx.op(join(ctx.workDir, 'tb')))),
  ])
  const other = new Map(withoutHoles.map(f => [f.layer, f.file]))
  const m = 1
  const o = info.outline
  let vb: Rect | null = o && { x: o.x - m, y: o.y - m, width: o.width + 2 * m, height: o.height + 2 * m }
  const layers: Partial<Record<(typeof wanted)[number], string>> = {}
  let holesMaskId: string | null = null
  for (const f of withHoles) {
    const id = f.layer as (typeof wanted)[number]
    const nf = other.get(id)
    if (!nf) continue
    const raw = await readFile(f.file, 'utf8')
    if (!vb) {
      const v = /viewBox="([^"]+)"/.exec(raw)?.[1]?.split(/\s+/).map(Number)
      vb = v && v.length === 4 ? { x: v[0]!, y: v[1]!, width: v[2]!, height: v[3]! } : { x: 0, y: 0, width: 100, height: 100 }
    }
    const maskId = `thumb-${safe(ctx.src.name)}-${safe(id)}`
    const r = normaliseLayerSvg(raw, await readFile(nf, 'utf8'), { viewBox: vb, color: '#000', layerId: id, maskId })
    layers[id] = r.svg
    if (id === 'F.Cu' && r.holeGroups > 0) holesMaskId = maskId
  }
  if (!vb || !Object.keys(layers).length) throw new Error('no layers plotted for the thumbnail')
  const pixels = fitPixels(vb, box)
  const colours = compositeColours(info.stackup, mask)
  return { svg: composeTopView({ vb, outline: o, layers, holesMaskId, colours, pixels }), ...pixels }
}
