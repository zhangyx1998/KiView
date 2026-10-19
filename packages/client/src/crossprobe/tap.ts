// Tell a click / tap from a drag on a pan-zoom canvas: a pointer that goes up within
// a few pixels of where it went down (and soon) is a tap at that point.

/** A pointer event on a button / link / field drawn over the canvas (not the canvas itself). */
export const onControl = (e: Event): boolean => !!(e.target as Element | null)?.closest?.('button, a, input, select, textarea, label')

export function tapDetector(onTap: (e: PointerEvent) => void, maxMove = 5, maxMs = 700) {
  let down: { id: number; x: number; y: number; t: number } | null = null
  let multi = false
  return {
    down(e: PointerEvent): void {
      if (onControl(e)) { down = null; return }
      if (down && down.id !== e.pointerId) { multi = true; return }
      if (e.button !== 0 && e.pointerType === 'mouse') return
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }
      multi = false
    },
    up(e: PointerEvent): void {
      const d = down
      if (!d || d.id !== e.pointerId) return
      down = null
      if (multi) return
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= maxMove && performance.now() - d.t <= maxMs) onTap(e)
    },
    cancel(): void { down = null },
  }
}
