// Cross-probing in the 3D view: markers over the selected parts (see highlight3d.ts
// for why markers and not the part meshes). The view calls attach() with its Viewer
// once it exists (and null when it goes).

import { computed, onBeforeUnmount, watch } from 'vue'
import type { Object3D } from 'three'
import type { Board } from '../types'
import { useParts } from './data'
import { disposeMarkers, partMarkers } from './highlight3d'
import { selectedOn } from './store'

interface OverlayHost { setOverlay(o: Object3D | null): void }

export function use3dMarkers(board: () => Board) {
  const { data } = useParts(() => (board().features.crossProbe?.available ? board().parts : null))
  let host: OverlayHost | null = null
  let current: Object3D | null = null
  const selected = computed(() => {
    const refs = new Set(selectedOn(board().name))
    return refs.size ? (data.value?.footprints ?? []).filter(f => refs.has(f.ref)) : []
  })
  function apply(): void {
    const next = host ? partMarkers(board(), selected.value, data.value?.thickness) : null
    host?.setOverlay(next)
    disposeMarkers(current)
    current = next
  }
  watch([selected, () => board().bounds], apply)
  onBeforeUnmount(() => { host?.setOverlay(null); disposeMarkers(current); current = null; host = null })
  return {
    attach(h: OverlayHost | null): void { host = h; apply() },
    count: computed(() => selected.value.length),
  }
}
