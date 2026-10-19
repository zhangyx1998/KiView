// [P2-d] The layer browser's part of a deep link: visible layers (as a preset when
// they match one), the view side, and the 2D view (centre and zoom relative to fit,
// so a link frames the same area on any screen). See ../deepLink.ts.

import { watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Board } from '../types'
import { setLinkPart, takeLinkPart } from '../linkState'
import { PRESETS, type PresetId, type ViewSide } from './model'
import type { usePanZoom } from './panZoom'

export function useLayerLink(o: {
  board: () => Board
  enabled: ShallowRef<Set<string>>
  side: Ref<ViewSide>
  activePreset: ComputedRef<PresetId | null>
  pz: ReturnType<typeof usePanZoom>
  applyPreset: (id: PresetId) => void
  setEnabled: (s: Set<string>) => void
}): void {
  const { pz } = o

  // take the link's layers / side / view when a board is shown
  watch(() => o.board().name, name => {
    const preset = takeLinkPart(name, 'preset')
    const layers = takeLinkPart(name, 'layers')
    const side = takeLinkPart(name, 'side')
    const view = takeLinkPart(name, 'view')
    const p = PRESETS.find(x => x.id === preset)
    if (p) o.applyPreset(p.id)
    else if (layers) {
      const known = new Set(o.board().layers.map(l => l.id))
      o.setEnabled(new Set(layers.filter(id => known.has(id))))
    }
    if (side) o.side.value = side
    if (view) {
      const go = () => {
        pz.view.k = Math.min(pz.maxK(), Math.max(pz.minK(), pz.fitK() * view.z))
        pz.view.cx = view.x
        pz.view.cy = view.y
        pz.fitted.value = false
      }
      if (pz.size.w && pz.size.h) go()
      else { const stop = watch(() => pz.size.w * pz.size.h, a => { if (a) { stop(); go() } }) }
    }
  }, { immediate: true })

  // report the current state
  watch([o.enabled, o.side, o.activePreset, () => pz.view.cx, () => pz.view.cy, () => pz.view.k, pz.fitted], () => {
    const preset = o.activePreset.value
    const part: Parameters<typeof setLinkPart>[1] = {
      preset: preset ?? undefined,
      layers: preset ? undefined : [...o.enabled.value],
      side: o.side.value === 'back' ? 'back' : undefined,
    }
    // zoom is relative to "fit", which needs the canvas size: while the pane is hidden
    // (another tab of the pane, size 0) keep the last view in the link
    if (pz.size.w && pz.size.h) part.view = pz.fitted.value ? undefined : { x: pz.view.cx, y: pz.view.cy, z: pz.view.k / pz.fitK() }
    setLinkPart(o.board().name, part)
  }, { immediate: true })
}
