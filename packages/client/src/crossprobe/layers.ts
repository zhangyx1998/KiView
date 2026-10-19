// Cross-probing in the 2D layer browser: the selected parts' boxes and pads drawn on
// top of the layer stack (board millimetres, the stage's own coordinates), a dashed
// outline under the cursor, a tap selects the part under it (the viewed side first),
// and a selection made elsewhere scrolls into view.
//
// The composable attaches its own pointer listeners to the canvas, next to the
// pan / zoom handlers, so the layer browser only mounts the overlay.

import { computed, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from 'vue'
import type { Pad } from '@kiview/kicad/types'
import type { Board, Footprint } from '../types'
import type { usePanZoom } from '../layers/panZoom'
import { partAt, useParts } from './data'
import { probe, selectedOn, toggle } from './store'
import { tapDetector } from './tap'

type PanZoom = ReturnType<typeof usePanZoom>

const f4 = (v: number) => Math.round(v * 1e4) / 1e4

/** Outline of a pad as an SVG path (board mm): circles as circles, the rest as rotated rectangles. */
export function padPath(p: Pad): string {
  const { x, y } = p.at
  const hw = p.size.width / 2, hh = p.size.height / 2
  if (p.shape === 'circle') return `M${f4(x - hw)} ${f4(y)}a${f4(hw)} ${f4(hw)} 0 1 0 ${f4(2 * hw)} 0a${f4(hw)} ${f4(hw)} 0 1 0 ${f4(-2 * hw)} 0Z`
  const a = (p.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [x + u! * cos + v! * sin, y - u! * sin + v! * cos])
  return 'M' + pts.map(([u, v]) => `${f4(u!)} ${f4(v!)}`).join('L') + 'Z'
}

/** `active`: taps and hover are ours (the layer browser's "Select" tool); off while a measure / net tool is chosen. */
export function useLayerProbe(board: () => Board, canvas: Ref<HTMLElement | null>, pz: PanZoom, side: () => 'front' | 'back',
                              active: () => boolean = () => true) {
  const { data } = useParts(() => (board().features.crossProbe?.available ? board().parts : null))
  const footprints = computed(() => data.value?.footprints ?? [])
  const hover = shallowRef<Footprint | null>(null)
  const selected = computed(() => {
    const refs = new Set(selectedOn(board().name))
    return refs.size ? footprints.value.filter(f => refs.has(f.ref)) : []
  })

  const local = (e: PointerEvent) => {
    const r = canvas.value!.getBoundingClientRect()
    return pz.toBoard(e.clientX - r.left, e.clientY - r.top)
  }
  const hit = (e: PointerEvent) => {
    const p = local(e)
    return partAt(footprints.value, p.x, p.y, side(), 2 / pz.view.k)
  }
  const tap = tapDetector(e => { if (active()) toggle(board().name, hit(e)?.ref ?? null, 'layers') })
  const onMove = (e: PointerEvent) => { hover.value = e.buttons || !active() ? null : hit(e) }
  watch(active, on => { if (!on) hover.value = null })
  const onLeave = () => { hover.value = null }

  // show a selection made in another view: centre on it when it is not in sight
  watch(() => probe.seq, () => {
    if (probe.board !== board().name || probe.source === 'layers' || !selected.value.length) return
    const xs = selected.value.flatMap(f => [f.bbox.x, f.bbox.x + f.bbox.width])
    const ys = selected.value.flatMap(f => [f.bbox.y, f.bbox.y + f.bbox.height])
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const a = pz.toBoard(0, 0), b = pz.toBoard(pz.size.w, pz.size.h)
    const vx0 = Math.min(a.x, b.x), vx1 = Math.max(a.x, b.x), vy0 = Math.min(a.y, b.y), vy1 = Math.max(a.y, b.y)
    if (x0 >= vx0 && x1 <= vx1 && y0 >= vy0 && y1 <= vy1) return
    pz.view.cx = (x0 + x1) / 2
    pz.view.cy = (y0 + y1) / 2
    pz.fitted.value = false
  })

  let el: HTMLElement | null = null
  onMounted(() => {
    el = canvas.value
    el?.addEventListener('pointerdown', tap.down)
    el?.addEventListener('pointerup', tap.up)
    el?.addEventListener('pointercancel', tap.cancel)
    el?.addEventListener('pointermove', onMove)
    el?.addEventListener('pointerleave', onLeave)
  })
  onBeforeUnmount(() => {
    el?.removeEventListener('pointerdown', tap.down)
    el?.removeEventListener('pointerup', tap.up)
    el?.removeEventListener('pointercancel', tap.cancel)
    el?.removeEventListener('pointermove', onMove)
    el?.removeEventListener('pointerleave', onLeave)
  })

  return {
    hover,
    selected,
    box: (f: Footprint, grow: number) => ({ x: f.bbox.x - grow, y: f.bbox.y - grow, width: f.bbox.width + 2 * grow, height: f.bbox.height + 2 * grow }),
    padPaths: (f: Footprint) => f.pads.filter(p => p.type !== 'np_thru_hole' || p.size.width > 0).map(padPath),
  }
}
