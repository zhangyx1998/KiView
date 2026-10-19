<script setup lang="ts">
// [P2-d] Layer-browser tools, drawn over the layer stage with the same pan / zoom
// matrix:
//   - Net highlight (N): click a pad, via, track or zone to highlight its whole net
//     (copper geometry from Board.geometry; disabled with the reason when absent).
//   - Measure (M): distance, dx / dy and angle between two clicks, snapping to pad
//     and via centres when the geometry is loaded.
//   - Select (S, only with part data): taps belong to the cross-probe selection in
//     LayerBrowser (crossprobe/layers.ts); the tools here ignore them.
//   - Focus marker: focusLayerView() (layers/bus.ts) or a link's `at=` centres the
//     view on a point and marks it.
// Clicks are taps on the canvas (press and release without dragging), so panning
// and pinching keep working. Esc clears.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Board, GeometryData } from '../types'
import { setLinkPart, takeLinkPart } from '../linkState'
import { onLayerFocus, type LayerFocus, type LayerTool } from './bus'
import { hitTest, snapPoint } from './hitTest'
import type { usePanZoom } from './panZoom'
import type { ViewSide } from './model'

const props = defineProps<{
  board: Board
  canvas: HTMLElement | null
  pz: ReturnType<typeof usePanZoom>
  side: ViewSide
  drawn: ReadonlySet<string>
  /** The active tool (v-model:tool); the parent owns it so the part selection knows when taps are its. */
  tool: LayerTool
  /** The board has part data, so 'select' is offered. */
  selectable: boolean
}>()
const emit = defineEmits<{ 'update:tool': [LayerTool] }>()
const tool = computed<LayerTool>({ get: () => props.tool, set: t => emit('update:tool', t) })
/** Where M toggles back to: select when offered, else net. */
const homeTool = computed<LayerTool>(() => (props.selectable ? 'select' : 'net'))

// ---- geometry (fetched once per URL) -------------------------------------------------
const cache = new Map<string, Promise<GeometryData>>()
function fetchGeometry(url: string): Promise<GeometryData> {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<GeometryData> })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}
const geometry = shallowRef<GeometryData | null>(null)
const geoError = ref<string | null>(null)
const unavailable = computed(() => {
  if (geoError.value) return `net highlight unavailable: ${geoError.value}`
  if (!props.board.geometry) {
    const f = props.board.features.stats
    return `net highlight unavailable${f && !f.available ? `: ${f.reason}` : ': no copper geometry for this board'}`
  }
  return null
})
watch(() => props.board.geometry?.url, url => {
  geometry.value = null
  geoError.value = null
  if (!url) return
  fetchGeometry(url).then(g => {
    if (props.board.geometry?.url !== url) return
    geometry.value = g
    applyPendingNet()
  }, e => { geoError.value = e instanceof Error ? e.message : String(e) })
}, { immediate: true })

// ---- selection state ---------------------------------------------------------------------
const net = ref<number | null>(null)
const netHit = ref<string>('')
const pointA = ref<{ x: number; y: number; label?: string } | null>(null)
const pointB = ref<{ x: number; y: number; label?: string } | null>(null)
const marker = ref<{ x: number; y: number; label?: string } | null>(null)
let pendingNet: string | undefined

function clear(): void {
  net.value = null
  pointA.value = pointB.value = null
  marker.value = null
}
watch(() => props.board.name, name => {
  clear()
  pendingNet = takeLinkPart(name, 'net')
  const at = takeLinkPart(name, 'at')
  if (at) requestAnimationFrame(() => focus({ board: name, x: at.x, y: at.y }))
  applyPendingNet()
}, { immediate: true })
function applyPendingNet(): void {
  const g = geometry.value
  if (!g || !pendingNet) return
  const i = g.nets.indexOf(pendingNet)
  if (i > 0) { net.value = i; netHit.value = '' }
  pendingNet = undefined
}
watch(net, n => setLinkPart(props.board.name, { net: n && geometry.value ? geometry.value.nets[n] : undefined }))

/** Copper layers to pick from, nearest to the viewer first (all of them when no copper is shown). */
const pickLayers = computed(() => {
  const cu = geometry.value?.copper ?? []
  const shown = cu.filter(l => props.drawn.has(l))
  const list = shown.length ? shown : cu
  return props.side === 'front' ? list : [...list].reverse()
})

// ---- taps ------------------------------------------------------------------------------------
const down = new Map<number, { x: number; y: number; t: number }>()
let gestureMulti = false
let hovering = false
function local(e: PointerEvent) {
  const r = props.canvas!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function onDown(e: PointerEvent): void {
  if ((e.target as Element | null)?.closest('button, .chip')) return
  if (down.size === 0) gestureMulti = false
  down.set(e.pointerId, { ...local(e), t: performance.now() })
  if (down.size > 1) gestureMulti = true
}
function onUp(e: PointerEvent): void {
  const d = down.get(e.pointerId)
  down.delete(e.pointerId)
  if (!d || gestureMulti) return
  const p = local(e)
  if (Math.hypot(p.x - d.x, p.y - d.y) > 6 || performance.now() - d.t > 700) return
  tap(props.pz.toBoard(p.x, p.y))
}
function onCancel(e: PointerEvent): void { down.delete(e.pointerId) }

function tap(p: { x: number; y: number }): void {
  marker.value = null
  if (tool.value === 'select') return   // the part selection takes this tap
  const k = props.pz.view.k
  if (tool.value === 'measure') {
    const s = snapPoint(geometry.value, p.x, p.y, 10 / k)
    const q = s ?? p
    if (!pointA.value || pointB.value) { pointA.value = q; pointB.value = null }
    else pointB.value = q
    return
  }
  const g = geometry.value
  if (!g) return
  const hit = hitTest(g, p.x, p.y, pickLayers.value, 3 / k)
  if (!hit || hit.net === 0) { net.value = null; netHit.value = hit ? `${hit.label} (no net)` : ''; return }
  net.value = hit.net
  netHit.value = hit.label
}

// ---- focus (bus, link) -------------------------------------------------------------------------
function focus(f: LayerFocus): void {
  if (f.board !== props.board.name) return
  const pz = props.pz
  const go = () => {
    const kMin = pz.fitK() * (f.zoom ?? 6)
    pz.view.k = Math.min(pz.maxK(), Math.max(pz.view.k, kMin))
    pz.view.cx = f.x
    pz.view.cy = f.y
    pz.fitted.value = false
    marker.value = { x: f.x, y: f.y, label: f.label }
  }
  if (pz.size.w) go()
  else { const stop = watch(() => pz.size.w, w => { if (w) { stop(); go() } }) }
}
const offFocus = onLayerFocus(focus)

// ---- keys ------------------------------------------------------------------------------------
function onKey(e: KeyboardEvent): void {
  if (!hovering || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  const k = e.key.toLowerCase()
  if (k === 'escape') clear()
  else if (k === 'm') setTool(tool.value === 'measure' ? homeTool.value : 'measure')
  else if (k === 'n') setTool('net')
  else if (k === 's' && props.selectable) setTool('select')
  else return
  e.preventDefault()
}
function setTool(t: LayerTool): void {
  tool.value = t
  if (t !== 'measure') pointA.value = pointB.value = null
}
watch(tool, t => { if (props.canvas) props.canvas.style.cursor = t === 'measure' ? 'crosshair' : '' }, { immediate: true })

const enter = () => { hovering = true }
const leave = () => { hovering = false }
let bound: HTMLElement | null = null
function bind(el: HTMLElement | null): void {
  if (bound) {
    bound.removeEventListener('pointerdown', onDown, true)
    bound.removeEventListener('pointerup', onUp, true)
    bound.removeEventListener('pointercancel', onCancel, true)
    bound.removeEventListener('pointerenter', enter)
    bound.removeEventListener('pointerleave', leave)
  }
  bound = el
  if (!el) return
  el.addEventListener('pointerdown', onDown, true)
  el.addEventListener('pointerup', onUp, true)
  el.addEventListener('pointercancel', onCancel, true)
  el.addEventListener('pointerenter', enter)
  el.addEventListener('pointerleave', leave)
}
watch(() => props.canvas, bind)
onMounted(() => { bind(props.canvas); window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => { bind(null); offFocus(); window.removeEventListener('keydown', onKey) })

// ---- drawing ------------------------------------------------------------------------------------
const k = computed(() => props.pz.view.k)
const netItems = computed(() => {
  const g = geometry.value, n = net.value
  if (!g || !n) return null
  const tracks = g.tracks.filter(t => t.net === n)
  const len = tracks.reduce((s, t) => { let l = 0; for (let i = 0; i + 3 < t.pts.length; i += 2) l += Math.hypot(t.pts[i + 2]! - t.pts[i]!, t.pts[i + 3]! - t.pts[i + 1]!); return s + l }, 0)
  return {
    name: g.nets[n] ?? '?',
    tracks: tracks.map(t => ({ ...t, d: 'M' + t.pts.join(' ') })),
    vias: g.vias.filter(v => v.net === n),
    pads: g.pads.filter(p => p.net === n),
    zones: g.zones.filter(z => z.net === n).map(z => z.pts.join(' ')),
    length: len,
  }
})
const live = computed(() => (tool.value === 'measure' && pointA.value && !pointB.value ? props.pz.cursor.value : null))
const measureEnd = computed(() => pointB.value ?? live.value)
const measure = computed(() => {
  const a = pointA.value, b = measureEnd.value
  if (!a || !b) return null
  const dx = b.x - a.x, dy = b.y - a.y
  return { a, b, dx, dy, d: Math.hypot(dx, dy), angle: (Math.atan2(-dy, dx) * 180) / Math.PI }
})
const f3 = (v: number) => v.toFixed(3)
const padRx = (p: GeometryData['pads'][number]) =>
  p.shape === 'oval' ? Math.min(p.size.width, p.size.height) / 2 : p.shape === 'roundrect' ? Math.min(p.size.width, p.size.height) * 0.25 : 0
</script>

<template>
  <div class="layer-tools">
    <svg class="overlay" :width="pz.size.w" :height="pz.size.h" aria-hidden="true">
      <g :transform="pz.matrix.value">
        <template v-if="netItems">
          <rect class="veil" :x="board.bounds.x" :y="board.bounds.y" :width="board.bounds.width" :height="board.bounds.height" />
          <polygon v-for="(z, i) in netItems.zones" :key="`z${i}`" class="zone" :points="z" />
          <path v-for="(t, i) in netItems.tracks" :key="`t${i}`" class="track" :d="t.d" :stroke-width="t.width" />
          <g v-for="(p, i) in netItems.pads" :key="`p${i}`" :transform="`translate(${p.at.x} ${p.at.y}) rotate(${-p.rotation})`">
            <circle v-if="p.shape === 'circle'" class="pad" :r="p.size.width / 2" />
            <rect v-else class="pad" :x="-p.size.width / 2" :y="-p.size.height / 2" :width="p.size.width" :height="p.size.height" :rx="padRx(p)" />
            <ellipse v-if="p.drill" class="drill" :rx="p.drill.width / 2" :ry="p.drill.height / 2" />
          </g>
          <g v-for="(v, i) in netItems.vias" :key="`v${i}`">
            <circle class="pad" :cx="v.at.x" :cy="v.at.y" :r="v.size / 2" />
            <circle class="drill" :cx="v.at.x" :cy="v.at.y" :r="v.drill / 2" />
          </g>
        </template>
        <g v-if="measure" class="measure">
          <line :x1="measure.a.x" :y1="measure.a.y" :x2="measure.b.x" :y2="measure.b.y" />
          <circle :cx="measure.a.x" :cy="measure.a.y" :r="4 / k" />
          <circle :cx="measure.b.x" :cy="measure.b.y" :r="4 / k" />
        </g>
        <g v-if="marker" class="marker">
          <circle :cx="marker.x" :cy="marker.y" :r="14 / k" />
          <line :x1="marker.x - 22 / k" :y1="marker.y" :x2="marker.x - 8 / k" :y2="marker.y" />
          <line :x1="marker.x + 8 / k" :y1="marker.y" :x2="marker.x + 22 / k" :y2="marker.y" />
          <line :x1="marker.x" :y1="marker.y - 22 / k" :x2="marker.x" :y2="marker.y - 8 / k" />
          <line :x1="marker.x" :y1="marker.y + 8 / k" :x2="marker.x" :y2="marker.y + 22 / k" />
        </g>
      </g>
    </svg>

    <div class="bar" role="group" aria-label="Tools" @pointerdown.stop>
      <button v-if="selectable" :aria-pressed="tool === 'select'" title="Select: click a part to show it in every view (S)"
              @click="setTool('select')">Select</button>
      <button :aria-pressed="tool === 'net'" :disabled="!!unavailable" :title="unavailable ?? 'Net highlight: click a pad, via, track or zone (N)'"
              @click="setTool('net')">Net</button>
      <button :aria-pressed="tool === 'measure'" title="Measure: click two points; snaps to pad and via centres (M)"
              @click="setTool(tool === 'measure' ? homeTool : 'measure')">Measure</button>
    </div>

    <div v-if="netItems || measure || (tool === 'measure') || marker?.label" class="chip mono" @pointerdown.stop>
      <template v-if="tool === 'measure'">
        <template v-if="measure">
          <strong>{{ f3(measure.d) }} mm</strong>
          <span>dx {{ f3(measure.dx) }}</span><span>dy {{ f3(measure.dy) }}</span><span>{{ measure.angle.toFixed(1) }}°</span>
        </template>
        <span v-else class="hint">click the first point</span>
      </template>
      <template v-else-if="netItems">
        <strong class="net" :title="netHit">{{ netItems.name }}</strong>
        <span>{{ netItems.pads.length }} pads</span>
        <span v-if="netItems.vias.length">{{ netItems.vias.length }} vias</span>
        <span v-if="netItems.tracks.length">{{ netItems.length.toFixed(1) }} mm track</span>
      </template>
      <template v-else-if="marker?.label"><span class="label">{{ marker.label }}</span></template>
      <button class="x" title="Clear (Esc)" aria-label="Clear" @click="clear">×</button>
    </div>
  </div>
</template>

<style scoped>
.layer-tools { position: absolute; inset: 0; pointer-events: none; }
.overlay { position: absolute; inset: 0; display: block; }
.veil { fill: var(--canvas-bg); opacity: 0.62; }
.track { fill: none; stroke: var(--highlight); stroke-linecap: round; stroke-linejoin: round; }
.zone { fill: var(--highlight); fill-opacity: 0.16; stroke: var(--highlight); stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-dasharray: 4 3; }
.pad { fill: var(--highlight); }
.drill { fill: var(--canvas-bg); }
.measure line { stroke: var(--accent); stroke-width: 2px; vector-effect: non-scaling-stroke; }
.measure circle { fill: none; stroke: var(--accent); stroke-width: 2px; vector-effect: non-scaling-stroke; }
.marker circle, .marker line { fill: none; stroke: var(--highlight); stroke-width: 2.5px; vector-effect: non-scaling-stroke; }
.marker circle { animation: pulse 1.2s ease-in-out 3; }
@keyframes pulse { 50% { stroke-opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .marker circle { animation: none; } }

.bar { position: absolute; z-index: 4; top: 8px; right: 8px; display: flex; pointer-events: auto; }
.bar button { font-size: 12px; padding: 2px 7px; border-radius: 0; background: var(--float-bg); }
.bar button:first-child { border-radius: var(--radius) 0 0 var(--radius); }
.bar button:last-child { border-radius: 0 var(--radius) var(--radius) 0; margin-left: -1px; }
.bar button[aria-pressed='true'] { background: var(--pressed-bg); }
.bar button:disabled { opacity: 0.45; cursor: not-allowed; }

.chip {
  position: absolute; z-index: 4; left: 8px; bottom: 30px; max-width: calc(100% - 16px);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 3px 4px 3px 9px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--card-bg); font-size: 11px; pointer-events: auto;
}
.chip strong { color: var(--text); }
.chip .net { color: var(--highlight); max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip span { color: var(--muted); }
.chip .hint { font-style: italic; }
.chip .x { padding: 0 6px; line-height: 16px; font-size: 13px; }
</style>
