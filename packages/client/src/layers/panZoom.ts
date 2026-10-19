// Pan / zoom state of the layer stage, in board millimetres.
//
// View: the board point (cx, cy) sits at the pane centre, k = CSS pixels per mm,
// mirror = -1 for the back view (mirrored about the vertical axis). Screen mapping:
//   sx = w/2 + k*mirror*(x - cx),  sy = h/2 + k*(y - cy)
// The stage applies it as one SVG matrix on a <g>, so the browser re-rasterises the
// vectors at the exact scale every frame (crisp at any zoom).
//
// Input: one pointer drags (mouse, pen, one finger); two touch pointers pinch
// (zoom about the midpoint while the midpoint pans). Wheel: a mouse wheel notch or
// ctrl+wheel (trackpad pinch) zooms towards the cursor; a trackpad two-finger scroll
// (pixel deltas, horizontal component or small steps) pans.

import { computed, onBeforeUnmount, reactive, ref, type Ref } from 'vue'

export interface Rect { x: number; y: number; width: number; height: number }

export const MAX_K = 20          // px per mm, i.e. 50 um per CSS pixel
const MIN_FIT_FRACTION = 0.25    // zoom out to a quarter of "fit"
const MAX_FIT_MULTIPLE = 2       // a small board on a big pane can still zoom past fit

export function usePanZoom(el: Ref<HTMLElement | null>, bounds: () => Rect, mirrored: () => boolean) {
  const size = reactive({ w: 0, h: 0 })
  const view = reactive({ cx: 0, cy: 0, k: 1 })
  const cursor = ref<{ x: number; y: number } | null>(null)
  /** true until the user pans or zooms; a resize then re-fits instead of keeping the view */
  const fitted = ref(true)

  const mx = () => (mirrored() ? -1 : 1)

  function fitK(): number {
    const b = bounds()
    if (!size.w || !size.h || !b.width || !b.height) return 1
    const margin = Math.max(10, Math.min(size.w, size.h) * 0.04)
    return Math.max(1e-3, Math.min((size.w - 2 * margin) / b.width, (size.h - 2 * margin) / b.height))
  }
  const minK = () => fitK() * MIN_FIT_FRACTION
  /** 50 um per pixel, or twice the fit scale when the fit is already finer than that */
  const maxK = () => Math.max(MAX_K, fitK() * MAX_FIT_MULTIPLE)

  function fit(): void {
    const b = bounds()
    view.cx = b.x + b.width / 2
    view.cy = b.y + b.height / 2
    view.k = fitK()
    fitted.value = true
  }

  const toBoard = (sx: number, sy: number) => ({ x: view.cx + (sx - size.w / 2) / (view.k * mx()), y: view.cy + (sy - size.h / 2) / view.k })

  function zoomAt(sx: number, sy: number, factor: number): void {
    const p = toBoard(sx, sy)
    const k = Math.min(maxK(), Math.max(minK(), view.k * factor))
    view.k = k
    view.cx = p.x - (sx - size.w / 2) / (k * mx())
    view.cy = p.y - (sy - size.h / 2) / k
    fitted.value = false
  }
  function zoomCentre(factor: number): void { zoomAt(size.w / 2, size.h / 2, factor) }

  function panBy(dx: number, dy: number): void {
    view.cx -= dx / (view.k * mx())
    view.cy -= dy / view.k
    fitted.value = false
  }

  /** SVG matrix for the stage group */
  const matrix = computed(() => {
    const a = view.k * mx(), d = view.k
    const e = size.w / 2 - a * view.cx, f = size.h / 2 - d * view.cy
    return `matrix(${a} 0 0 ${d} ${e} ${f})`
  })

  // ---- input ---------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>()
  let pinch: { dist: number; mx: number; my: number } | null = null
  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.value!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function pinchState() {
    const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    el.value!.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, local(e))
    if (pointers.size === 2) pinch = pinchState()
  }
  function onPointerMove(e: PointerEvent): void {
    const p = local(e)
    cursor.value = toBoard(p.x, p.y)
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    pointers.set(e.pointerId, p)
    if (pointers.size === 1) panBy(p.x - prev.x, p.y - prev.y)
    else if (pointers.size === 2 && pinch) {
      const s = pinchState()
      if (pinch.dist > 0) zoomAt(s.mx, s.my, s.dist / pinch.dist)
      panBy(s.mx - pinch.mx, s.my - pinch.my)
      pinch = s
    }
  }
  function onPointerUp(e: PointerEvent): void {
    pointers.delete(e.pointerId)
    pinch = pointers.size === 2 ? pinchState() : null
  }
  function onPointerLeave(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) cursor.value = null
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    const p = local(e)
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.h : 1
    const dx = e.deltaX * unit, dy = e.deltaY * unit
    const mouseNotch = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy))
    if (e.ctrlKey || mouseNotch) zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)))
    else panBy(-dx, -dy)
    cursor.value = toBoard(p.x, p.y)
  }

  // ---- size -----------------------------------------------------------------------
  let ro: ResizeObserver | null = null
  /** Track the pane size; fit on the first real size and on resizes until the user moves the view. */
  function observe(): void {
    ro = new ResizeObserver(entries => {
      const r = entries[0]!.contentRect
      size.w = r.width
      size.h = r.height
      if (r.width && r.height && fitted.value) fit()
    })
    ro.observe(el.value!)
  }
  onBeforeUnmount(() => ro?.disconnect())

  return {
    size, view, cursor, fitted, matrix, minK, maxK, fitK,
    fit, zoomAt, zoomCentre, panBy, toBoard, observe,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onWheel },
  }
}

/** Largest 1-2-5 step not above `mm`. */
export function niceStep(mm: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(mm)))
  const f = mm / p
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p
}
