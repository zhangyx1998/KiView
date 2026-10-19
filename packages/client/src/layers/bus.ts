// [P2-d] The layer browser's small event API for other parts of the page: ask the
// layer view of a board to pan (and zoom) to a point and mark it, e.g. a DRC item.
//
//   import { focusLayerView } from '../layers/bus'
//   focusLayerView({ board: 'Blinky', x: 120.5, y: 108.7, label: 'Clearance violation' })
//
// Every mounted layer browser of that board centres on the point (zooming in to at
// least `zoom` x fit, default 6) and draws a marker until the next click.

export interface LayerFocus {
  board: string
  x: number
  y: number
  /** Minimum zoom relative to "fit". Default 6. */
  zoom?: number
  /** Shown next to the marker. */
  label?: string
}

type Listener = (f: LayerFocus) => void
const listeners = new Set<Listener>()

export function focusLayerView(f: LayerFocus): void {
  for (const l of listeners) l(f)
}

/** Subscribe; returns the unsubscribe function. */
export function onLayerFocus(l: Listener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * What a tap on the layer canvas does: 'select' a part (cross-probing, when the board
 * has part data), highlight a 'net', or 'measure'. Exactly one acts on a tap.
 */
export type LayerTool = 'select' | 'net' | 'measure'
