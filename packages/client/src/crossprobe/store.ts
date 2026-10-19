// The cross-probe store: which part(s) are selected on the current board. Every view
// (BOM, 2D layers, 3D, schematic) reads it to highlight and writes it on click, so
// selecting a part anywhere shows it everywhere.
//
// Deep link: the selection is mirrored into the URL hash as `#part=R5` (several refs:
// `#part=C1,C2`). Only the `part` key is ours; other `key=value` pairs in the hash
// (other deep links) are kept as they are. The hash is written with replaceState
// (no history entry per click), keeping the router's history.state.

import { reactive, readonly, watch } from 'vue'

export type ProbeSource = 'bom' | 'layers' | '3d' | 'schematic' | 'url' | 'assembly'

interface State {
  /** Board the selection belongs to. */
  board: string | null
  /** Selected references; the first is the "primary" one views focus on. */
  refs: string[]
  /** Who made the selection (a view does not re-focus on its own clicks). */
  source: ProbeSource | null
  /** Bumped on every select, so views can re-focus on a repeated selection. */
  seq: number
}

const state = reactive<State>({ board: null, refs: [], source: null, seq: 0 })
export const probe = readonly(state)

export function select(board: string, refs: string[] | string | null, source: ProbeSource): void {
  const list = refs === null ? [] : Array.isArray(refs) ? [...new Set(refs)] : [refs]
  state.board = board
  state.refs = list
  state.source = source
  state.seq++
}

/** Click on a part: select it, or clear when it is already the only selection. */
export function toggle(board: string, ref: string | null, source: ProbeSource): void {
  if (!ref || (state.board === board && state.refs.length === 1 && state.refs[0] === ref)) select(board, null, source)
  else select(board, ref, source)
}

export function clear(board: string): void { if (state.refs.length) select(board, null, 'url') }

export function isSelected(board: string, ref: string): boolean {
  return state.board === board && state.refs.includes(ref)
}

export function selectedOn(board: string): readonly string[] {
  return state.board === board ? state.refs : []
}

// ---- URL hash ------------------------------------------------------------------------

/** Hash pairs in order; a bare `#/x` style hash is left alone. */
function hashPairs(): [string, string][] {
  const h = location.hash.replace(/^#/, '')
  if (!h || h.startsWith('/')) return []
  return h.split('&').filter(Boolean).map(p => {
    const i = p.indexOf('=')
    return i < 0 ? [decodeURIComponent(p), ''] : [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))]
  })
}

export function refsFromHash(): string[] {
  const v = hashPairs().find(([k]) => k === 'part')?.[1]
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : []
}

function writeHash(refs: string[]): void {
  const pairs = hashPairs().filter(([k]) => k !== 'part')
  if (refs.length) pairs.push(['part', refs.join(',')])
  const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%2F/gi, '/')
  const hash = pairs.map(([k, v]) => (v ? `${enc(k)}=${enc(v)}` : enc(k))).join('&')
  const url = location.pathname + location.search + (hash ? `#${hash}` : '')
  if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', url)
}

/**
 * Bind the store to a board page: take the selection from the hash on entry and on
 * hash edits, write it back on change, clear it when the board changes.
 */
export function useHashSelection(board: () => string): () => void {
  const fromHash = () => {
    const refs = refsFromHash()
    const name = board()
    const cur = selectedOn(name)
    if (refs.join(',') !== cur.join(',') || state.board !== name) select(name, refs, 'url')
  }
  const stopBoard = watch(board, fromHash, { immediate: true })
  const stopWrite = watch(() => [state.board, state.refs] as const, ([b, refs]) => {
    if (b === board()) writeHash([...refs])
  })
  window.addEventListener('hashchange', fromHash)
  return () => { stopBoard(); stopWrite(); window.removeEventListener('hashchange', fromHash) }
}
