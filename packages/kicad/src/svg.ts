// Normalise a single-layer SVG plotted by `kicad-cli pcb export svg` (colour mode,
// page-size-mode 1, i.e. in absolute board coordinates) into a small, recolourable,
// inline-safe document with a viewBox shared by every layer of the board.
//
// Drill shapes are moved into an SVG <mask> so holes become real cut-outs; every
// drawn shape is kept and drawn in currentColor. See normaliseLayerSvg for how
// holes are told apart from content.

import type { Rect } from './types.ts'

export interface NormaliseOptions {
  viewBox: Rect
  color: string     // default colour when the page does not set one
  maskId: string    // id for the hole mask; unique per board + layer
  layerId: string
}

export interface NormaliseResult { svg: string; holeGroups: number; groups: number }

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)

interface Group { open: string; body: string }

/** Split markup into top-level <g>…</g> groups (other top-level markup is kept as body-only groups). */
function topLevelGroups(markup: string): Group[] {
  const out: Group[] = []
  const re = /<(\/?)g\b[^>]*?(\/?)>/g
  let depth = 0, openTag = '', bodyStart = 0, last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(markup))) {
    const closing = m[1] === '/', selfClosing = m[2] === '/'
    if (!closing) {
      if (selfClosing) continue
      if (depth === 0) {
        const between = markup.slice(last, m.index).trim()
        if (between) out.push({ open: '', body: between })
        openTag = m[0]; bodyStart = m.index + m[0].length
      }
      depth++
    } else {
      depth--
      if (depth === 0) {
        out.push({ open: openTag, body: markup.slice(bodyStart, m.index) })
        last = m.index + m[0].length
      }
      if (depth < 0) throw new Error('unbalanced </g>')
    }
  }
  const tail = markup.slice(last).trim()
  if (tail) out.push({ open: '', body: tail })
  return out
}

const isEmpty = (body: string) => body.replace(/<\/?g\b[^>]*>/g, '').trim() === ''

function compact(s: string): string {
  return s
    .replace(/(\d+)\.(\d+)/g, (_, i: string, f: string) => {
      const t = f.replace(/0+$/, '')
      return t ? `${i}.${t}` : i
    })
    .replace(/[ \t]*\n[ \t\n]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ \/>/g, '/>')
}

function recolour(s: string, colour: string): string {
  return s
    .replace(/(fill|stroke):\s*#[0-9a-fA-F]{6}/g, `$1:${colour}`)
    .replace(/\s*(fill|stroke)-opacity:\s*[\d.]+;?/g, '')
}

function innerMarkup(raw: string): string {
  const open = /<svg\b[^>]*>/.exec(raw)
  const close = raw.lastIndexOf('</svg>')
  if (!open || close < 0) throw new Error('not an SVG document')
  return raw.slice(open.index + open[0].length, close)
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<desc>[\s\S]*?<\/desc>/g, '')
    .replace(/<text\b[\s\S]*?<\/text>/g, '')        // invisible search text KiCad adds
    .replace(/<!--[\s\S]*?-->/g, '')
}

const groupKey = (g: Group) => g.open + g.body

/**
 * `withHoles` is the layer plotted with drill shapes (--drill-shape-opt 2), `withoutHoles`
 * the same layer plotted without them (--drill-shape-opt 0). KiCad paints drill shapes as
 * extra groups after the layer content, in white or black depending on the layer colour,
 * while the content itself may sit inside KiCad's black default group with per-element
 * colours (custom pads, filled polygons, logos). Colour therefore cannot tell holes from
 * content; the difference between the two plots can: every group of `withoutHoles` is
 * content, and the groups that only `withHoles` has are the holes.
 */
export function normaliseLayerSvg(withHoles: string, withoutHoles: string, o: NormaliseOptions): NormaliseResult {
  const inner = innerMarkup(withoutHoles)
  const contentGroups = topLevelGroups(inner)
  const remaining = new Map<string, number>()
  for (const g of contentGroups) remaining.set(groupKey(g), (remaining.get(groupKey(g)) ?? 0) + 1)
  const holeGroups: Group[] = []
  for (const g of topLevelGroups(innerMarkup(withHoles))) {
    const n = remaining.get(groupKey(g)) ?? 0
    if (n > 0) remaining.set(groupKey(g), n - 1)
    else holeGroups.push(g)
  }
  const missing = [...remaining.values()].reduce((a, b) => a + b, 0)
  if (missing) throw new Error(`${o.layerId}: plots with and without drill shapes differ in ${missing} content groups`)

  const groups = contentGroups.filter(g => !isEmpty(g.body))
  const content = groups.map(g => (g.open ? recolour(g.open, 'currentColor') + recolour(g.body, 'currentColor') + '</g>' : recolour(g.body, 'currentColor')))
  const holes = holeGroups.filter(g => !isEmpty(g.body))
    .map(g => (g.open ? recolour(g.open, '#000') + recolour(g.body, '#000') + '</g>' : `<g fill="#000">${recolour(g.body, '#000')}</g>`))

  const { x, y, width, height } = o.viewBox
  const vb = `${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)}`
  const xlink = /xlink:/.test(inner + holes.join('')) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : ''
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg"${xlink} viewBox="${vb}" width="${fmt(width)}mm" height="${fmt(height)}mm"` +
      ` data-layer="${o.layerId}" style="color:var(--layer-color, ${o.color})">`,
  ]
  if (holes.length) {
    parts.push(
      `<defs><mask id="${o.maskId}" maskUnits="userSpaceOnUse" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}">` +
        `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" fill="#fff"/>`,
      ...holes,
      '</mask></defs>',
      `<g mask="url(#${o.maskId})">`, ...content, '</g>',
    )
  } else {
    parts.push(...content)
  }
  parts.push('</svg>\n')
  return { svg: compact(parts.join('\n')), holeGroups: holes.length, groups: groups.length }
}

/** viewBox of an SVG document, as numbers (used for verification). */
export function readViewBox(svg: string): Rect | null {
  const m = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg)
  if (!m) return null
  const [x, y, width, height] = m[1]!.trim().split(/[\s,]+/).map(Number)
  return [x, y, width, height].every(v => Number.isFinite(v)) ? { x: x!, y: y!, width: width!, height: height! } : null
}
