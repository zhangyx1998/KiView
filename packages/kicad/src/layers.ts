// Which layers of a board get an SVG, and how they are described in the manifest.

import type { LayerEntry, LayerKind, LayerSide } from './types.ts'

export interface LayerSpec {
  id: string
  name: string
  kind: LayerKind
  side: LayerSide
  color: string
  /** Rank used to derive `order`; lower is further back when viewed from the front. */
  rank: number
}

const INNER_COLORS = ['#7fc87f', '#ce7d2c', '#4fcbcb', '#db628b', '#a7a7ff', '#c2c200', '#ff8f8f', '#8fd4ff']

// Fixed (non-copper) layers. rank: back side below the copper stack, front side above it.
const FIXED: Record<string, Omit<LayerSpec, 'id' | 'rank'> & { rank: number }> = {
  'B.CrtYd': { name: 'Back courtyard', kind: 'courtyard', side: 'back', color: '#26e9ff', rank: -60 },
  'B.Fab': { name: 'Back fabrication', kind: 'fab', side: 'back', color: '#88a0d0', rank: -50 },
  'B.Adhes': { name: 'Back adhesive', kind: 'other', side: 'back', color: '#e594f0', rank: -45 },
  'B.SilkS': { name: 'Back silkscreen', kind: 'silkscreen', side: 'back', color: '#e8b2a7', rank: -40 },
  'B.Paste': { name: 'Back paste', kind: 'paste', side: 'back', color: '#00c2c2', rank: -30 },
  'B.Mask': { name: 'Back solder mask', kind: 'mask', side: 'back', color: '#02ffee', rank: -20 },
  'F.Mask': { name: 'Front solder mask', kind: 'mask', side: 'front', color: '#d864ff', rank: 20 },
  'F.Paste': { name: 'Front paste', kind: 'paste', side: 'front', color: '#b4a0a0', rank: 30 },
  'F.SilkS': { name: 'Front silkscreen', kind: 'silkscreen', side: 'front', color: '#f2eda1', rank: 40 },
  'F.Adhes': { name: 'Front adhesive', kind: 'other', side: 'front', color: '#8473d1', rank: 45 },
  'F.Fab': { name: 'Front fabrication', kind: 'fab', side: 'front', color: '#afafaf', rank: 50 },
  'F.CrtYd': { name: 'Front courtyard', kind: 'courtyard', side: 'front', color: '#ff26e2', rank: 60 },
  'Edge.Cuts': { name: 'Edge cuts', kind: 'edge', side: 'both', color: '#e6e8e3', rank: 70 },
  'Margin': { name: 'Margin', kind: 'other', side: 'both', color: '#ff26e2', rank: 80 },
  'Dwgs.User': { name: 'User drawings', kind: 'other', side: 'both', color: '#c2c2c2', rank: 81 },
  'Cmts.User': { name: 'User comments', kind: 'other', side: 'both', color: '#5994dc', rank: 82 },
  'Eco1.User': { name: 'User Eco1', kind: 'other', side: 'both', color: '#b4dbd2', rank: 83 },
  'Eco2.User': { name: 'User Eco2', kind: 'other', side: 'both', color: '#d8c852', rank: 84 },
}

// Kinds that are exported whenever the layer table has them; anything else
// ('other') only when some board item is actually drawn on it.
const ALWAYS: ReadonlySet<LayerKind> = new Set(['copper', 'silkscreen', 'mask', 'paste', 'fab', 'courtyard', 'edge'])

/** Copper layers in physical order from front (F.Cu) to back (B.Cu). */
function copperOrder(layers: LayerEntry[]): LayerEntry[] {
  const cu = layers.filter(l => /^(F|B|In\d+)\.Cu$/.test(l.name))
  const pos = (n: string) => (n === 'F.Cu' ? 0 : n === 'B.Cu' ? 1000 : Number(n.slice(2, -3)))
  return cu.sort((a, b) => pos(a.name) - pos(b.name))
}

export function selectLayers(layers: LayerEntry[], used: Set<string>): LayerSpec[] {
  const out: LayerSpec[] = []
  const cu = copperOrder(layers)
  cu.forEach((l, i) => {
    // front copper sits just below the front mask; back copper just above the back mask
    const rank = 10 - (i / Math.max(1, cu.length - 1)) * 20   // F.Cu = 10 ... B.Cu = -10
    if (l.name === 'F.Cu') out.push({ id: l.name, name: 'Front copper', kind: 'copper', side: 'front', color: '#c83434', rank })
    else if (l.name === 'B.Cu') out.push({ id: l.name, name: 'Back copper', kind: 'copper', side: 'back', color: '#4d7fc4', rank })
    else {
      const k = Number(l.name.slice(2, -3))
      out.push({ id: l.name, name: `Inner copper ${k}`, kind: 'copper', side: 'inner', color: INNER_COLORS[(k - 1) % INNER_COLORS.length]!, rank })
    }
  })
  for (const l of layers) {
    if (l.name.endsWith('.Cu')) continue
    const fixed = FIXED[l.name]
    let spec: LayerSpec
    if (fixed) spec = { id: l.name, ...fixed }
    else {
      const m = /^User\.(\d+)$/.exec(l.name)
      const label = l.userName && l.userName !== l.name ? l.userName : m ? `User ${m[1]}` : l.name
      spec = { id: l.name, name: label, kind: 'other', side: 'both', color: '#c2c2c2', rank: 90 + (m ? Number(m[1]) : 50) }
    }
    if (ALWAYS.has(spec.kind) || used.has(l.name)) out.push(spec)
  }
  return out.sort((a, b) => a.rank - b.rank)
}
