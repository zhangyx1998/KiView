// Lazily fetched JSON assets of a board (bom.json, parts.json, netlist.json). Asset
// URLs are content-addressed, so a response is cached for the session by URL and
// shared by every view that asks for it.

import { shallowRef, watch, type ShallowRef } from 'vue'
import type { AssetRef, BomData, Footprint, NetlistData, PartsData } from '../types'

const cache = new Map<string, Promise<unknown>>()

export function fetchJson<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    p = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<T> })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export interface AssetState<T> { data: ShallowRef<T | null>; error: ShallowRef<string | null>; loading: ShallowRef<boolean> }

/** Reactive JSON asset: follows `ref()` (null = none); the data stays null until it arrives. */
export function useAsset<T>(ref: () => AssetRef | null | undefined): AssetState<T> {
  const data = shallowRef<T | null>(null)
  const error = shallowRef<string | null>(null)
  const loading = shallowRef(false)
  watch(() => ref()?.url ?? null, url => {
    data.value = null
    error.value = null
    if (!url) { loading.value = false; return }
    loading.value = true
    fetchJson<T>(url).then(d => { if (ref()?.url === url) { data.value = d; loading.value = false } })
      .catch((e: unknown) => { if (ref()?.url === url) { error.value = e instanceof Error ? e.message : String(e); loading.value = false } })
  }, { immediate: true })
  return { data, error, loading }
}

export const useParts = (ref: () => AssetRef | null | undefined) => useAsset<PartsData>(ref)
export const useBom = (ref: () => AssetRef | null | undefined) => useAsset<BomData>(ref)
export const useNetlist = (ref: () => AssetRef | null | undefined) => useAsset<NetlistData>(ref)

/**
 * The part under a board point: the smallest box containing it, parts of the side
 * being viewed first (the other side's parts only when none of this side's match).
 */
export function partAt(fps: readonly Footprint[], x: number, y: number, side: 'front' | 'back', slop = 0): Footprint | null {
  let best: Footprint | null = null
  let bestScore = Infinity
  for (const f of fps) {
    const b = f.bbox
    if (x < b.x - slop || x > b.x + b.width + slop || y < b.y - slop || y > b.y + b.height + slop) continue
    const score = (f.side === side ? 0 : 1e9) + b.width * b.height
    if (score < bestScore) { best = f; bestScore = score }
  }
  return best
}
