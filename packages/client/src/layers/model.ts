// Layer grouping, presets, default look and the per-board session memory of the
// layer browser. Pure data helpers, no DOM.

import type { Board, BoardLayer, LayerKind, LayerSide } from '../types'

export type ViewSide = 'front' | 'back'
export type PresetId = 'front' | 'back' | 'copper' | 'all' | 'none'

export interface Preset { id: PresetId; label: string; key: string; title: string }

export const PRESETS: readonly Preset[] = [
  { id: 'front', label: 'Front', key: '1', title: 'Front copper, mask, silkscreen and edge; view from the front' },
  { id: 'back', label: 'Back', key: '2', title: 'Back copper, mask, silkscreen and edge; view from the back' },
  { id: 'copper', label: 'Copper', key: '3', title: 'All copper layers and the edge' },
  { id: 'all', label: 'All', key: '4', title: 'Every layer' },
  { id: 'none', label: 'None', key: '0', title: 'Hide every layer' },
]

export const EDGE_ID = 'Edge.Cuts'

/** Layer ids a preset turns on (filtered to the board's layers), and the side it implies. */
export function presetLayers(board: Board, id: PresetId): { ids: Set<string>; side: ViewSide | null } {
  const has = (l: BoardLayer) => {
    switch (id) {
      case 'front': return ['F.Cu', 'F.Mask', 'F.SilkS', EDGE_ID].includes(l.id)
      case 'back': return ['B.Cu', 'B.Mask', 'B.SilkS', EDGE_ID].includes(l.id)
      case 'copper': return l.kind === 'copper' || l.kind === 'edge'
      case 'all': return true
      case 'none': return false
    }
  }
  const side = id === 'front' ? 'front' : id === 'back' ? 'back' : null
  return { ids: new Set(board.layers.filter(has).map(l => l.id)), side }
}

/** Opacity per kind: copper translucent enough to see the layer below, mask faint, silkscreen nearly solid. */
const OPACITY: Record<LayerKind, number> = {
  copper: 0.78, mask: 0.38, paste: 0.55, silkscreen: 0.95, fab: 0.8, courtyard: 0.75, edge: 1, other: 0.8,
}
export const layerOpacity = (l: BoardLayer) => OPACITY[l.kind]

export interface LayerGroup { id: LayerSide; label: string; layers: BoardLayer[] }

const GROUP_LABEL: Record<LayerSide, string> = { front: 'Front', inner: 'Inner', back: 'Back', both: 'Both sides' }

/**
 * Groups in physical order as seen from `side`: the near side first and, within a
 * group, the layer nearest the viewer first, so the list always reads from the
 * viewer into the board (front view: F.CrtYd ... F.Cu, In1.Cu ..., B.Cu ... B.CrtYd).
 * "Both sides" (edge, user layers) comes last.
 */
export function groupLayers(layers: BoardLayer[], side: ViewSide): LayerGroup[] {
  const sides: LayerSide[] = side === 'front' ? ['front', 'inner', 'back', 'both'] : ['back', 'inner', 'front', 'both']
  const dir = side === 'front' ? -1 : 1
  return sides
    .map(s => ({ id: s, label: GROUP_LABEL[s], layers: layers.filter(l => l.side === s).sort((a, b) => dir * (a.order - b.order)) }))
    .filter(g => g.layers.length > 0)
}

// ---- session memory (per board, in memory only) ------------------------------------

export interface BoardMemory { enabled: Set<string>; side: ViewSide; soloRestore: Set<string> | null; soloId: string | null }
const memory = new Map<string, BoardMemory>()

export function recall(board: Board): BoardMemory {
  const m = memory.get(board.name)
  if (m) {
    const known = new Set(board.layers.map(l => l.id))
    const keep = (s: Set<string>) => new Set([...s].filter(id => known.has(id)))
    return { enabled: keep(m.enabled), side: m.side, soloRestore: m.soloRestore && keep(m.soloRestore), soloId: m.soloId && known.has(m.soloId) ? m.soloId : null }
  }
  const p = presetLayers(board, 'front')
  return { enabled: p.ids, side: 'front', soloRestore: null, soloId: null }
}

export function remember(board: Board, m: BoardMemory): void {
  memory.set(board.name, { enabled: new Set(m.enabled), side: m.side, soloRestore: m.soloRestore && new Set(m.soloRestore), soloId: m.soloId })
}
