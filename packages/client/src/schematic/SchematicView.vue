<script setup lang="ts">
// Schematic pane: a sheet navigator (the hierarchy as a tree, with page numbers) and
// the selected sheet's SVG with the layer browser's pan / zoom.
//
// Cross-probing: kicad-cli's schematic SVG has no per-symbol grouping (text is
// stroked paths plus an invisible <text>), so the SVG is not searched. Instead the
// export reads every placed symbol from the .kicad_sch files and computes its box
// from the library graphics and pins with KiCad's symbol transform (schematic.ts);
// the SVG is plotted in the same sheet millimetres, so the boxes overlay exactly.
// A tap inside a box selects that part; a tap on a hierarchical sheet symbol (its
// box is in the child sheet's `symbolBox`) opens that sheet.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Board, SchematicSheetRef } from '../types'
import { niceStep, usePanZoom, type Rect } from '../layers/panZoom'
import LayerNode from '../layers/LayerNode.vue'
import { layerState, requestLayer } from '../layers/svgCache'
import { probe, selectedOn, toggle } from '../crossprobe/store'
import { onControl, tapDetector } from '../crossprobe/tap'

const props = defineProps<{ board: Board }>()

const sheets = computed<SchematicSheetRef[]>(() => props.board.schematic?.sheets ?? [])
const current = ref<string>('/')
const sheet = computed(() => sheets.value.find(s => s.path === current.value) ?? sheets.value[0] ?? null)

// ---- tree ------------------------------------------------------------------------------
interface Row { sheet: SchematicSheetRef; depth: number }
const tree = computed<Row[]>(() => {
  const kids = new Map<string | null, SchematicSheetRef[]>()
  for (const s of sheets.value) {
    const k = sheets.value.some(p => p.path === s.parent) ? s.parent : null
    kids.set(k, [...(kids.get(k) ?? []), s])
  }
  const out: Row[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of kids.get(parent) ?? []) { out.push({ sheet: s, depth }); walk(s.path, depth + 1) }
  }
  walk(null, 0)
  return out
})
const crumbs = computed(() => {
  const out: SchematicSheetRef[] = []
  for (let s = sheet.value; s; s = sheets.value.find(p => p.path === s!.parent) ?? null) {
    out.unshift(s)
    if (out.length > 40) break
  }
  return out
})
const children = computed(() => sheets.value.filter(s => s.parent === sheet.value?.path && s.symbolBox))

// ---- svg -------------------------------------------------------------------------------
let ctl: AbortController | null = null
watch(() => sheet.value?.url, url => { if (url && ctl) requestLayer(url, ctl.signal) })
const loaded = computed(() => {
  const st = sheet.value ? layerState(sheet.value.url) : undefined
  return st?.state === 'ready' ? st.node : null
})
const loadError = computed(() => {
  const st = sheet.value ? layerState(sheet.value.url) : undefined
  return st?.state === 'error' ? st.message : null
})
const paper = computed<Rect>(() => {
  const n = loaded.value
  if (!n) return { x: 0, y: 0, width: 297, height: 210 }
  return { x: Number(n.getAttribute('x')), y: Number(n.getAttribute('y')), width: Number(n.getAttribute('width')), height: Number(n.getAttribute('height')) }
})

// ---- pan / zoom ------------------------------------------------------------------------------
const canvas = ref<HTMLElement | null>(null)
const pz = usePanZoom(canvas, () => paper.value, () => false)
const { size, view, matrix, handlers } = pz
watch(paper, () => { if (pz.fitted.value) pz.fit() })
const zoomPct = computed(() => Math.round((view.k / pz.fitK()) * 100))
const scale = computed(() => {
  const mm = niceStep(110 / view.k)
  return { px: mm * view.k, label: `${mm} mm` }
})

// ---- selection ---------------------------------------------------------------------------------
const selected = computed(() => selectedOn(props.board.name))
const selectedBoxes = computed(() => {
  const set = new Set(selected.value)
  return (sheet.value?.symbols ?? []).filter(s => set.has(s.ref))
})
const elsewhere = computed(() => {
  // selected parts that are not on this sheet: where they are
  const here = new Set((sheet.value?.symbols ?? []).map(s => s.ref))
  return selected.value.filter(r => !here.has(r)).map(r => ({ ref: r, sheet: sheets.value.find(s => s.symbols.some(y => y.ref === r)) ?? null }))
})
const hover = ref<{ kind: 'symbol'; ref: string; box: Rect } | { kind: 'sheet'; path: string; name: string; box: Rect } | null>(null)

function hitAt(x: number, y: number) {
  const inside = (b: Rect) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
  let best: { ref: string; box: Rect } | null = null
  for (const s of sheet.value?.symbols ?? [])
    if (inside(s.bbox) && (!best || s.bbox.width * s.bbox.height < best.box.width * best.box.height)) best = { ref: s.ref, box: s.bbox }
  if (best) return { kind: 'symbol' as const, ...best }
  const c = children.value.find(s => inside(s.symbolBox!))
  return c ? { kind: 'sheet' as const, path: c.path, name: c.name, box: c.symbolBox! } : null
}

function local(e: PointerEvent) {
  const r = canvas.value!.getBoundingClientRect()
  return pz.toBoard(e.clientX - r.left, e.clientY - r.top)
}
const tap = tapDetector(e => {
  const p = local(e)
  const h = hitAt(p.x, p.y)
  if (h?.kind === 'sheet') openSheet(h.path)
  else toggle(props.board.name, h?.kind === 'symbol' ? h.ref : null, 'schematic')
})
function onDown(e: PointerEvent): void { if (onControl(e)) return; tap.down(e); handlers.onPointerDown(e) }
function onMove(e: PointerEvent): void {
  handlers.onPointerMove(e)
  const p = local(e)
  hover.value = hitAt(p.x, p.y)
}
function onUp(e: PointerEvent): void { handlers.onPointerUp(e); tap.up(e) }
function onLeave(e: PointerEvent): void { handlers.onPointerLeave(e); hover.value = null }

function openSheet(path: string): void {
  if (current.value === path) return
  current.value = path
  hover.value = null
  pz.fitted.value = true
  pz.fit()
}

/** Show a part: open its sheet (the current one if it is there) and centre on it. */
function focusRef(ref: string): void {
  const on = (s: SchematicSheetRef | null) => s?.symbols.find(y => y.ref === ref)
  const target = on(sheet.value) ? sheet.value : sheets.value.find(s => on(s)) ?? null
  if (!target) return
  if (target.path !== current.value) current.value = target.path
  const b = on(target)!.bbox
  // about four symbol sizes of context around it, never below "fit"
  const k = Math.min(size.w / (b.width * 4 + 20), size.h / (b.height * 4 + 20))
  view.k = Number.isFinite(k) && k > 0 ? Math.min(pz.maxK(), Math.max(pz.fitK(), k)) : pz.fitK()
  view.cx = b.x + b.width / 2
  view.cy = b.y + b.height / 2
  pz.fitted.value = false
}
watch(() => probe.seq, () => {
  if (probe.board !== props.board.name || probe.source === 'schematic' || !probe.refs.length) return
  focusRef(probe.refs[0]!)
})

// ---- per-board lifecycle ------------------------------------------------------------------------
function loadBoard(): void {
  ctl?.abort()
  ctl = new AbortController()
  current.value = sheets.value[0]?.path ?? '/'
  if (sheet.value) requestLayer(sheet.value.url, ctl.signal)
  pz.fitted.value = true
  pz.fit()
  const first = selected.value[0]
  if (!first) return
  if (size.w && size.h) { focusRef(first); return }
  // the pane has no size before its first layout: focus once it has
  const stop = watch(() => size.w * size.h, a => { if (a) { stop(); focusRef(first) } })
}
watch(() => props.board.name, loadBoard)

const treeOpen = ref(true)
const root = ref<HTMLElement | null>(null)
const narrow = ref(false)
let ro: ResizeObserver | null = null
const hovered = ref(false)
function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const r = root.value
  if (!r || !(hovered.value || r.contains(document.activeElement))) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  const k = e.key.toLowerCase()
  if (k === 'f') pz.fit()
  else if (k === '+' || k === '=') pz.zoomCentre(1.5)
  else if (k === '-' || k === '_') pz.zoomCentre(1 / 1.5)
  else if (k === 'u' || k === 'backspace') { const p = sheet.value?.parent; if (p) openSheet(p); else return }
  else if (k === 'escape') toggle(props.board.name, null, 'schematic')
  else return
  e.preventDefault()
}

onMounted(() => {
  pz.observe()
  loadBoard()
  ro = new ResizeObserver(es => {
    const w = es[0]!.contentRect.width
    const n = w < 560
    if (n !== narrow.value) treeOpen.value = !n
    narrow.value = n
  })
  ro.observe(root.value!)
  window.addEventListener('keydown', onKey)
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__schematic = {
      open: openSheet, focus: focusRef,
      state: () => ({ sheet: current.value, view: { ...view }, size: { ...size }, loaded: !!loaded.value }),
    }
  }
})
onBeforeUnmount(() => {
  ctl?.abort()
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
  if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__schematic
})
</script>

<template>
  <div ref="root" class="sch" :class="{ narrow }" tabindex="0" aria-label="Schematic"
       @pointerenter="hovered = true" @pointerleave="hovered = false">
    <aside v-if="treeOpen" class="tree" aria-label="Sheets">
      <div class="tree-title">Sheets</div>
      <button v-for="r in tree" :key="r.sheet.path" class="sheet-item" :aria-current="r.sheet.path === sheet?.path ? 'page' : undefined"
              :style="{ paddingLeft: `${8 + r.depth * 14}px` }" :title="`${r.sheet.source} · ${r.sheet.path}`"
              @click="openSheet(r.sheet.path); if (narrow) treeOpen = false">
        <span class="page mono">{{ r.sheet.page }}</span>
        <span class="name">{{ r.sheet.name }}</span>
      </button>
    </aside>

    <div ref="canvas" class="canvas" :class="{ pointing: hover }"
         @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp"
         @pointercancel="e => { handlers.onPointerUp(e); tap.cancel() }" @pointerleave="onLeave" @wheel="handlers.onWheel">
      <svg class="stage" :width="size.w" :height="size.h" aria-hidden="true">
        <g :transform="matrix">
          <LayerNode v-if="loaded" :node="loaded" />
          <rect v-for="c in children" :key="c.path" class="child-sheet" :x="c.symbolBox!.x" :y="c.symbolBox!.y"
                :width="c.symbolBox!.width" :height="c.symbolBox!.height" />
          <rect v-if="hover" class="hover" :x="hover.box.x - 0.4" :y="hover.box.y - 0.4"
                :width="hover.box.width + 0.8" :height="hover.box.height + 0.8" />
          <rect v-for="(s, i) in selectedBoxes" :key="`${s.ref}-${i}`" class="sel" :x="s.bbox.x - 0.8" :y="s.bbox.y - 0.8"
                :width="s.bbox.width + 1.6" :height="s.bbox.height + 1.6" rx="0.6" />
        </g>
      </svg>

      <div class="tools">
        <button class="tree-toggle" :aria-pressed="treeOpen" title="Sheet list" @click="treeOpen = !treeOpen">☰</button>
        <nav class="crumbs" aria-label="Sheet path">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i" class="sep">›</span>
            <button :aria-current="i === crumbs.length - 1 ? 'page' : undefined" @click="openSheet(c.path)">{{ c.name }}</button>
          </template>
        </nav>
        <button title="Fit the sheet in the pane (F)" @click="pz.fit()">Fit</button>
      </div>

      <p v-if="!sheets.length" class="note">No schematic for this board.</p>
      <p v-else-if="loadError" class="note">The sheet could not be loaded: {{ loadError }}</p>
      <p v-else-if="!loaded" class="note">Loading sheet…</p>

      <div v-if="hover" class="tip mono">
        {{ hover.kind === 'symbol' ? hover.ref : `Open sheet “${hover.name}”` }}
      </div>
      <div v-if="elsewhere.length" class="elsewhere">
        <template v-for="e in elsewhere" :key="e.ref">
          <button v-if="e.sheet" @click="focusRef(e.ref)">{{ e.ref }} is on “{{ e.sheet.name }}” →</button>
          <span v-else>{{ e.ref }} is not in the schematic</span>
        </template>
      </div>

      <div class="readout mono">
        <span class="where">{{ sheet ? `page ${sheet.page} · ${sheet.source}` : '' }}</span>
        <span class="scale"><span class="bar" :style="{ width: `${scale.px}px` }"></span>{{ scale.label }}</span>
        <span>{{ zoomPct }} %</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sch { position: relative; width: 100%; height: 100%; display: flex; min-height: 0; outline: none; background: var(--sheet-surround); }
.sch:focus-visible { box-shadow: inset 0 0 0 1px var(--pressed-line); }
.tree {
  flex: 0 0 190px; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 1px;
  border-right: 1px solid var(--line); background: var(--panel); padding: 6px 4px;
}
.narrow .tree { position: absolute; z-index: 3; inset: 0 auto 0 0; width: min(220px, 80%); padding-top: 40px; box-shadow: 4px 0 18px var(--shadow); }
.tree-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding: 2px 8px 6px; }
.sheet-item {
  display: flex; gap: 8px; align-items: baseline; text-align: left; border: 1px solid transparent; background: none;
  padding: 3px 8px; font-size: 13px; border-radius: var(--radius);
}
.sheet-item:hover { background: var(--panel-2); }
.sheet-item[aria-current='page'] { background: var(--current-bg); border-color: var(--pressed-line); }
.page { color: var(--muted); min-width: 1.5em; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.canvas { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; touch-action: none; cursor: grab; user-select: none; }
.canvas.pointing { cursor: pointer; }
.canvas:active { cursor: grabbing; }
.stage { position: absolute; inset: 0; display: block; pointer-events: none; }
.child-sheet { fill: var(--accent); fill-opacity: 0.06; stroke: none; }
.hover { fill: var(--accent); fill-opacity: 0.08; stroke: var(--accent); stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-dasharray: 4 3; }
.sel { fill: var(--select); fill-opacity: 0.18; stroke: var(--select); stroke-width: 2.5px; vector-effect: non-scaling-stroke; }

.tools { position: absolute; z-index: 4; top: 8px; left: 8px; right: 8px; display: flex; gap: 6px; align-items: center; pointer-events: none; }
.tools > * { pointer-events: auto; }
.tools button { font-size: 12px; padding: 2px 7px; background: var(--float-bg); }
.sch:not(.narrow) .tree-toggle[aria-pressed='true'] { display: none; }
.crumbs { display: flex; gap: 2px; align-items: center; flex-wrap: wrap; margin-right: auto; }
.crumbs .sep { color: var(--on-canvas-text); text-shadow: 0 1px 2px var(--on-canvas-shadow); }
.crumbs button[aria-current='page'] { border-color: var(--pressed-line); }

.note { position: absolute; inset: 0; margin: 0; display: grid; place-items: center; color: var(--muted); font-size: 12px; pointer-events: none; }
.tip {
  position: absolute; top: 40px; left: 10px; padding: 2px 8px; border-radius: var(--radius);
  background: var(--card-bg); border: 1px solid var(--line); pointer-events: none;
}
.elsewhere { position: absolute; right: 10px; top: 40px; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; font-size: 12px; }
.elsewhere button, .elsewhere span { background: var(--pressed-bg); border: 1px solid var(--pressed-line); border-radius: var(--radius); padding: 2px 8px; }
.readout {
  position: absolute; left: 8px; right: 8px; bottom: 6px; display: flex; align-items: flex-end; gap: 14px;
  font-size: 11px; color: var(--on-canvas-text); text-shadow: 0 1px 2px var(--on-canvas-shadow); pointer-events: none;
}
.where { margin-right: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scale { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.bar { height: 5px; border: 1px solid currentColor; border-top: 0; }
</style>
