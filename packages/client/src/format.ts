import type { Board } from './types'

const mm = (v: number) => (Math.round(v * 10) / 10).toString()

export function boardFacts(b: Board): string {
  return `${mm(b.size.width)} × ${mm(b.size.height)} mm · ${b.copperLayers} copper layers`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
