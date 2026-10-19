<script setup lang="ts">
// 2D layer browser: the board's layer SVGs stacked over a dark background, with
// pan / zoom, a front / back view, a layer panel (groups, solo, presets) and
// readouts. Fills 100 % of its container.
//
// Rendering: every layer SVG is fetched once (only when it is first shown), parsed,
// and mounted inline as a nested <svg> inside one stage <g>; pan / zoom / mirror is a
// single SVG matrix on that <g>. The browser re-rasterises the vectors at the exact
// scale every frame (crisp at every zoom), recolouring is the `--layer-color`
// custom property, blending is plain group opacity, and hidden layers stay in the
// DOM with display:none so toggling is free. See src/layers/ for the parts.
//
// Dev-only debug hook (used for scripted screenshots / measurements; not in the
// production build): window.__layerBrowser = { preset(id), side(s), fit(), zoom(k, cx?, cy?), state(), stats() }.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Board, BoardLayer } from '../types'
import LayerList from '../layers/LayerList.vue'
import LayerNode from '../layers/LayerNode.vue'
import { EDGE_ID, PRESETS, groupLayers, layerOpacity, presetLayers, recall, remember, type PresetId, type ViewSide } from '../layers/model'
import { niceStep, usePanZoom } from '../layers/panZoom'
import { layerState, requestLayer } from '../layers/svgCache'
// [P2-d] tools (net highlight, measure, focus marker), deep link, theme-readable colours
import LayerTools from '../layers/LayerTools.vue'
import type { LayerTool } from '../layers/bus'
import { useLayerLink } from '../layers/link'
import { readableLayerColor } from '../layers/colors'
import { theme } from '../site'
// [P2-b] cross-probing
import { useLayerProbe } from '../crossprobe/layers'
// [assembly] the assembly pane's marks, caption and side
import AssemblyMarks from '../assembly/AssemblyMarks.vue'
import { asmView } from '../assembly/view'

const props = defineProps<{ board: Board }>()

// ---- layer state ---------------------------------------------------------------------
const enabled = shallowRef(new Set<string>())
const side = ref<ViewSide>('front')
const soloId = ref<string | null>(null)
let soloRestore: Set<string> | null = null

const hasEdge = computed(() => props.board.layers.some(l => l.id === EDGE_ID))
/** what is drawn: the user's choice plus the board edge whenever anything is shown */
const drawn = computed<ReadonlySet<string>>(() => {
  const s = new Set(enabled.value)
  if (s.size && hasEdge.value) s.add(EDGE_ID)
  return s
})
const edgeLocked = computed(() => [...enabled.value].some(id => id !== EDGE_ID))
const groups = computed(() => groupLayers(props.board.layers, side.value))

function setEnabled(s: Set<string>, keepSolo = false): void {
  enabled.value = s
  if (!keepSolo) { soloId.value = null; soloRestore = null }
}
function toggle(id: string): void {
  const s = new Set(enabled.value)
  if (drawn.value.has(id)) { s.delete(id) } else s.add(id)
  setEnabled(s)
}
function setGroup(ids: string[], on: boolean): void {
  const s = new Set(enabled.value)
  for (const id of ids) {
    if (on) s.add(id)
    else s.delete(id)
  }
  setEnabled(s)
}
function solo(id: string): void {
  if (soloId.value === id) {
    setEnabled(soloRestore ?? new Set())
    return
  }
  const restore = soloRestore ?? enabled.value
  setEnabled(new Set([id]), true)
  soloId.value = id
  soloRestore = restore
}
function applyPreset(id: PresetId): void {
  const p = presetLayers(props.board, id)
  setEnabled(p.ids)
  if (p.side) side.value = p.side
}
const activePreset = computed<PresetId | null>(() => {
  for (const p of PRESETS) {
    const want = presetLayers(props.board, p.id)
    const ids = want.ids
    if (ids.size === enabled.value.size && [...ids].every(i => enabled.value.has(i)) && (!want.side || want.side === side.value)) return p.id
  }
  return null
})
function retry(l: BoardLayer): void { if (ctl) requestLayer(l.url, ctl.signal) }

// ---- canvas, pan / zoom -------------------------------------------------------------
const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLElement | null>(null)
const pz = usePanZoom(canvas, () => props.board.bounds, () => side.value === 'back')
const { size, view, cursor, matrix, handlers } = pz

function onCanvasDown(e: PointerEvent): void {
  if (narrow.value) panelOpen.value = false
  handlers.onPointerDown(e)
}
// One tap, one meaning: the active tool takes the tap. Net highlight and measure ([P2-d],
// LayerTools) act on taps while chosen; with "Select" (the default when the board has
// part data) a tap selects the part under it ([P2-b] cross-probing) and the hover
// outline shows what a tap would pick.
const partsAvailable = computed(() => !!props.board.features.crossProbe?.available && !!props.board.parts)
const tool = ref<LayerTool>(partsAvailable.value ? 'select' : 'net')
watch(partsAvailable, ok => { if (ok && tool.value === 'net') tool.value = 'select'; else if (!ok && tool.value === 'select') tool.value = 'net' })
// cross-probing [P2-b]: selected parts drawn over the stack, tap to select, hover outline
const probe = useLayerProbe(() => props.board, canvas, pz, () => side.value, () => tool.value === 'select')
function flip(): void { side.value = side.value === 'front' ? 'back' : 'front' }

const zoomPct = computed(() => Math.round((view.k / pz.fitK()) * 100))
const scale = computed(() => {
  const mm = niceStep(110 / view.k)
  return { px: mm * view.k, label: mm >= 1 ? `${mm} mm` : `${Math.round(mm * 1000)} µm` }
})
const cursorText = computed(() => (cursor.value ? `${cursor.value.x.toFixed(2)}, ${cursor.value.y.toFixed(2)} mm` : '—'))

// ---- per-board lifecycle --------------------------------------------------------------
let ctl: AbortController | null = null
function loadBoard(b: Board): void {
  ctl?.abort()
  ctl = new AbortController()
  const m = recall(b)
  enabled.value = m.enabled
  side.value = m.side
  soloId.value = m.soloId
  soloRestore = m.soloRestore
  pz.fit()
}
watch(() => props.board, loadBoard, { immediate: true })
useLayerLink({ board: () => props.board, enabled, side, activePreset, pz, applyPreset, setEnabled })   // [P2-d]
watch([enabled, side, soloId], () => remember(props.board, { enabled: enabled.value, side: side.value, soloId: soloId.value, soloRestore }))
// [assembly] the assembly pane picks the side of its step: that side's copper / mask /
// silkscreen plus its fab drawing; its marks and caption are drawn over the stack
const asmShown = computed(() => asmView.board === props.board.name)
watch(() => asmView.sideSeq, () => {
  const s = asmView.side
  if (!asmShown.value || !s) return
  applyPreset(s)
  const fab = s === 'front' ? 'F.Fab' : 'B.Fab'
  if (props.board.layers.some(l => l.id === fab)) setEnabled(new Set([...enabled.value, fab]))
}, { immediate: true })

// fetch a layer the first time it is shown
watch([drawn, () => props.board], () => {
  if (!ctl) return
  for (const l of props.board.layers) if (drawn.value.has(l.id)) requestLayer(l.url, ctl.signal)
}, { immediate: true })

/** loaded layers of this board in stacking order for the current side (bottom first) */
const stack = computed(() => {
  const dir = side.value === 'front' ? 1 : -1
  return props.board.layers
    .map(l => ({ l, s: layerState(l.url) }))
    .filter((x): x is { l: BoardLayer; s: { state: 'ready'; node: SVGSVGElement; bytes: number; ms: number } } => x.s?.state === 'ready')
    .sort((a, b) => dir * (a.l.order - b.l.order))
})
const pending = computed(() => props.board.layers.filter(l => drawn.value.has(l.id) && layerState(l.url)?.state === 'loading').length)
const failed = computed(() => props.board.layers.filter(l => drawn.value.has(l.id) && layerState(l.url)?.state === 'error').length)

// ---- panel ----------------------------------------------------------------------------
const rootW = ref(0)
const narrow = computed(() => rootW.value > 0 && rootW.value < 560)
const panelOpen = ref(true)
watch(narrow, n => { panelOpen.value = !n })
let rootRo: ResizeObserver | null = null

// ---- keyboard: when the pane has focus or the pointer is over it ------------------------
const hover = ref(false)
function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const r = root.value
  if (!r || !(hover.value || r.contains(document.activeElement))) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'))) return
  const k = e.key.toLowerCase()
  const preset = PRESETS.find(p => p.key === k)
  if (k === 'f') pz.fit()
  else if (k === 'v') flip()
  else if (k === 'l') panelOpen.value = !panelOpen.value
  else if (k === '+' || k === '=') pz.zoomCentre(1.5)
  else if (k === '-' || k === '_') pz.zoomCentre(1 / 1.5)
  else if (preset) applyPreset(preset.id)
  else return
  e.preventDefault()
}

onMounted(() => {
  pz.observe()
  rootRo = new ResizeObserver(es => {
    const w = es[0]!.contentRect.width
    if (!rootW.value) panelOpen.value = w >= 560
    rootW.value = w
  })
  rootRo.observe(root.value!)
  window.addEventListener('keydown', onKey)
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__layerBrowser = {
      preset: applyPreset,
      side: (s: ViewSide) => { side.value = s },
      fit: pz.fit,
      zoom: (k: number, cx?: number, cy?: number) => { view.k = Math.min(pz.maxK(), k); if (cx !== undefined) view.cx = cx; if (cy !== undefined) view.cy = cy; pz.fitted.value = false },
      state: () => ({ board: props.board.name, side: side.value, enabled: [...enabled.value], view: { ...view }, size: { ...size }, pending: pending.value }),
      stats: () => props.board.layers.map(l => { const s = layerState(l.url); return { id: l.id, state: s?.state, bytes: s?.state === 'ready' ? s.bytes : null, ms: s?.state === 'ready' ? Math.round(s.ms) : null } }),
    }
  }
})
onBeforeUnmount(() => {
  ctl?.abort()
  rootRo?.disconnect()
  window.removeEventListener('keydown', onKey)
  if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__layerBrowser
})
</script>

<template>
  <div ref="root" class="lb" :class="{ narrow }" tabindex="0" aria-label="Layer browser"
       @pointerenter="hover = true" @pointerleave="hover = false">
    <aside v-if="panelOpen" class="panel">
      <div class="presets" role="group" aria-label="Presets">
        <button v-for="p in PRESETS" :key="p.id" :aria-pressed="activePreset === p.id"
                :title="`${p.title} (${p.key})`" @click="applyPreset(p.id)">{{ p.label }}</button>
      </div>
      <LayerList :groups="groups" :drawn="drawn" :edge-locked="edgeLocked" :solo-id="soloId"
                 @toggle="toggle" @solo="solo" @group="setGroup" @retry="retry" />
    </aside>

    <div ref="canvas" class="canvas"
         @pointerdown="onCanvasDown" @pointermove="handlers.onPointerMove"
         @pointerup="handlers.onPointerUp" @pointercancel="handlers.onPointerUp"
         @pointerleave="handlers.onPointerLeave" @wheel="handlers.onWheel" :class="{ pointing: probe.hover.value }">
      <svg class="stage" :width="size.w" :height="size.h" aria-hidden="true">
        <g :transform="matrix">
          <LayerNode v-for="x in stack" :key="x.l.url" v-show="drawn.has(x.l.id)" :node="x.s.node"
                     :class="{ edge: x.l.kind === 'edge' }"
                     :style="{ '--layer-color': readableLayerColor(x.l.color, theme.resolved), opacity: layerOpacity(x.l) }" />
        <g class="probe">
          <rect v-if="probe.hover.value" class="hover" v-bind="probe.box(probe.hover.value, 0.15)" />
          <g v-for="f in probe.selected.value" :key="f.ref" class="sel">
            <path v-for="(d, i) in probe.padPaths(f)" :key="i" :d="d" class="pad" />
            <rect v-bind="probe.box(f, 0.25)" rx="0.2" />
          </g>
        </g>
        <AssemblyMarks v-if="asmShown" :k="view.k" />
        </g>
      </svg>
      <LayerTools v-model:tool="tool" :selectable="partsAvailable" :board="board" :canvas="canvas" :pz="pz" :side="side" :drawn="drawn" />

      <div class="tools">
        <button class="panel-toggle" :aria-pressed="panelOpen" title="Layer list (L)" @click="panelOpen = !panelOpen">☰</button>
        <div class="seg" role="group" aria-label="View side">
          <button :aria-pressed="side === 'front'" title="View from the front (V flips)" @click="side = 'front'">Front</button>
          <button :aria-pressed="side === 'back'" title="View from the back, mirrored (V flips)" @click="side = 'back'">Back</button>
        </div>
        <button title="Fit the board in the pane (F)" @click="pz.fit()">Fit</button>
      </div>

      <div v-if="asmShown && asmView.caption" class="asm-caption" :class="{ empty: asmView.caption.empty }">
        <span class="mono">{{ asmView.caption.step }}</span> {{ asmView.caption.text }}
        <span v-if="asmView.caption.legend" class="legend"><span class="dot"></span>{{ asmView.caption.legend }}</span>
      </div>
      <p v-if="!board.layers.length" class="note">No layer drawings for this board.</p>
      <p v-else-if="!drawn.size" class="note">No layers shown. Pick a preset or a layer.</p>
      <p v-if="pending || failed" class="status">
        <template v-if="pending">loading {{ pending }} layer{{ pending > 1 ? 's' : '' }}…</template>
        <template v-if="pending && failed"> · </template>
        <template v-if="failed">{{ failed }} failed</template>
      </p>

      <div v-if="probe.hover.value" class="probe-tip mono">{{ probe.hover.value.ref }} · {{ probe.hover.value.value }}<template v-if="probe.hover.value.side !== side"> (other side)</template></div>
      <div class="readout mono">
        <span class="pos" title="Cursor position, board millimetres (KiCad coordinates)">{{ cursorText }}</span>
        <span class="scale" :title="`${(1000 / view.k).toFixed(1)} µm per pixel`">
          <span class="bar" :style="{ width: `${scale.px}px` }"></span>{{ scale.label }}
        </span>
        <span class="zoom" :title="`Zoom relative to fit; ${view.k.toFixed(2)} px/mm; + / - zoom, F fits`">{{ zoomPct }} %</span>
        <span v-if="side === 'back'" class="side-tag" title="Seen from the back (mirrored)">BACK</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lb { position: relative; width: 100%; height: 100%; display: flex; min-height: 0; outline: none; background: var(--canvas-bg); }
.lb:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--pressed-line); }

.panel {
  flex: 0 0 200px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--panel);
}
.narrow .panel {
  position: absolute;
  z-index: 3;
  inset: 0 auto 0 0;
  width: min(220px, 80%);
  box-shadow: 4px 0 18px var(--shadow);
  padding-top: 40px;
}
.presets { display: flex; flex-wrap: wrap; gap: 3px; padding: 8px 8px 4px; }
.presets button, .tools button { font-size: 12px; padding: 2px 7px; }

.canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  user-select: none;
}
.canvas:active { cursor: grabbing; }
.stage { position: absolute; inset: 0; display: block; pointer-events: none; }
.stage :deep(.edge > svg > g path) { vector-effect: non-scaling-stroke; stroke-width: 1.5px; }
.canvas.pointing { cursor: pointer; }
.probe rect, .probe path { vector-effect: non-scaling-stroke; }
.probe .hover { fill: var(--accent); fill-opacity: 0.1; stroke: var(--accent); stroke-width: 1px; stroke-dasharray: 4 3; }
.probe .sel rect { fill: var(--select); fill-opacity: 0.12; stroke: var(--select); stroke-width: 2px; }
.probe .sel .pad { fill: var(--select); fill-opacity: 0.55; stroke: var(--select-pad-line); stroke-width: 1px; }
.probe-tip { position: absolute; z-index: 4; top: 40px; right: 10px; padding: 2px 8px; border-radius: var(--radius); background: var(--card-bg); border: 1px solid var(--line); pointer-events: none; }

.tools { position: absolute; z-index: 4; top: 8px; left: 8px; right: 8px; display: flex; gap: 6px; flex-wrap: wrap; pointer-events: none; }
.tools > * { pointer-events: auto; }
.lb:not(.narrow) .panel-toggle[aria-pressed='true'] { display: none; }
.narrow .tools { left: 8px; }
.seg { display: flex; }
.seg button { border-radius: 0; }
.seg button:first-child { border-radius: var(--radius) 0 0 var(--radius); }
.seg button:last-child { border-radius: 0 var(--radius) var(--radius) 0; margin-left: -1px; }

.note, .status { position: absolute; margin: 0; color: var(--muted); font-size: 12px; pointer-events: none; }
.note { inset: 0; display: grid; place-items: center; }
.status { top: 40px; left: 10px; }
/* [assembly] the current step under the board */
.asm-caption {
  position: absolute; z-index: 5; left: 50%; transform: translateX(-50%); bottom: 26px; max-width: calc(100% - 16px);
  padding: 4px 12px; border-radius: 999px; background: var(--card-bg); border: 1px solid var(--line); font-size: 15px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
}
.asm-caption .legend { margin-left: 10px; font-weight: 400; color: var(--muted); }
.asm-caption.empty { color: var(--error); }
.asm-caption .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--pin1); margin-right: 5px; vertical-align: -1px; box-shadow: 0 0 0 2px var(--pin1-ring); }

.readout {
  position: absolute; left: 8px; right: 8px; bottom: 6px;
  display: flex; align-items: flex-end; gap: 14px; font-size: 11px; color: var(--muted);
  pointer-events: none;
}
.readout > * { pointer-events: auto; white-space: nowrap; }
.pos { margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.scale { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.bar { height: 5px; border: 1px solid var(--muted); border-top: 0; }
.side-tag { color: var(--side-tag); font-weight: 600; letter-spacing: 0.08em; }
</style>
