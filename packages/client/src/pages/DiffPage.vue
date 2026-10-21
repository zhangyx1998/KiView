<script setup lang="ts">
// "Changes since <ref>" (config revision.diff): the build-time summary, the changed
// layers and parts, and per layer an overlay of the base revision and now:
//   Diff  — added geometry green, removed red, unchanged grey (slider: its opacity);
//   Blend — the two revisions cross-faded (slider: before ... after).
// Both SVGs of a layer share one viewBox; they are rasterised into canvases and
// compared per pixel. Drag to pan, wheel to zoom, double-click to fit.
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { boardByName } from '../boards'
import { boardRoute } from '../routes'
import { site } from '../site'
import type { LayerDiff } from '../types'

const props = defineProps<{ name: string }>()
const board = computed(() => boardByName(props.name) ?? null)
const diff = computed(() => board.value?.diff ?? null)

const showUnchanged = ref(false)
const visible = computed(() => (diff.value?.layers ?? []).filter(l => showUnchanged.value || l.status !== 'unchanged'))
const selectedId = ref<string | null>(null)
const selected = computed<LayerDiff | null>(() =>
  diff.value?.layers.find(l => l.id === selectedId.value && l.status !== 'unchanged') ??
  diff.value?.layers.find(l => l.status !== 'unchanged') ?? null)
watch(selected, l => { if (l) selectedId.value = l.id }, { immediate: true })

const mode = ref<'diff' | 'blend'>('diff')
const amount = ref(0.35)            // diff: unchanged opacity; blend: 0 = before, 1 = after
watch(mode, m => { amount.value = m === 'diff' ? 0.35 : 0.5 })

// ---- rasterising ------------------------------------------------------------------
const MAX_PX = 4096
interface Raster { w: number; h: number; before: Uint8ClampedArray | null; after: Uint8ClampedArray | null }
const raster = shallowRef<Raster | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const cache = new Map<string, Promise<HTMLImageElement>>()

function image(url: string): Promise<HTMLImageElement> {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob() }).then(b => new Promise((res, rej) => {
      const img = new Image()
      img.onload = () => res(img)
      img.onerror = () => rej(new Error('cannot decode the SVG'))
      img.src = URL.createObjectURL(new Blob([b], { type: 'image/svg+xml' }))
    }))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

function alpha(img: HTMLImageElement | null, w: number, h: number): Uint8ClampedArray | null {
  if (!img) return null
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0, w, h)
  return g.getImageData(0, 0, w, h).data
}

let token = 0
watch([selected, diff], async ([l, d]) => {
  raster.value = null
  error.value = null
  if (!l || !d) return
  const t = ++token
  loading.value = true
  try {
    const [b, a] = await Promise.all([l.before ? image(l.before) : null, l.after ? image(l.after) : null])
    if (t !== token) return
    const s = MAX_PX / Math.max(d.bounds.width, d.bounds.height)
    const w = Math.max(1, Math.round(d.bounds.width * s)), h = Math.max(1, Math.round(d.bounds.height * s))
    raster.value = { w, h, before: alpha(b, w, h), after: alpha(a, w, h) }
  } catch (e) {
    if (t === token) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (t === token) loading.value = false
  }
}, { immediate: true })

const canvas = ref<HTMLCanvasElement | null>(null)
const counts = ref({ added: 0, removed: 0 })
const ADDED = [46, 204, 113], REMOVED = [235, 87, 87], SAME = [138, 145, 155]

function hexRgb(c: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c)
  const n = m ? parseInt(m[1]!, 16) : 0xc8c8c8
  return [n >> 16, (n >> 8) & 255, n & 255]
}

function paint(): void {
  const r = raster.value, cv = canvas.value, l = selected.value
  if (!r || !cv || !l) return
  cv.width = r.w
  cv.height = r.h
  const g = cv.getContext('2d')!
  const out = g.createImageData(r.w, r.h)
  const o = out.data, b = r.before, a = r.after
  const k = amount.value
  const col = hexRgb(l.color)
  let added = 0, removed = 0
  for (let i = 3; i < o.length; i += 4) {
    const pb = b ? b[i]! : 0, pa = a ? a[i]! : 0
    if (mode.value === 'diff') {
      const inB = pb > 96, inA = pa > 96
      const c = inA && !inB ? ADDED : inB && !inA ? REMOVED : inA ? SAME : null
      if (!c) continue
      if (c === ADDED) added++
      else if (c === REMOVED) removed++
      o[i - 3] = c[0]!; o[i - 2] = c[1]!; o[i - 1] = c[2]!
      o[i] = c === SAME ? Math.round(255 * k) : 255
    } else {
      const v = pb * (1 - k) + pa * k
      if (v < 1) continue
      o[i - 3] = col[0]!; o[i - 2] = col[1]!; o[i - 1] = col[2]!
      o[i] = v
    }
  }
  g.putImageData(out, 0, 0)
  if (mode.value === 'diff') counts.value = { added, removed }
}
let frame = 0
watch([raster, amount, mode, canvas], () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint) })

// ---- pan / zoom (CSS transform of the canvas) ------------------------------------------
const stage = ref<HTMLElement | null>(null)
const view = reactive({ x: 0, y: 0, k: 1 })
const fitScale = ref(1)
function fit(): void {
  const el = stage.value, r = raster.value
  if (!el || !r) return
  const s = Math.min((el.clientWidth - 24) / r.w, (el.clientHeight - 24) / r.h)
  fitScale.value = Math.max(1e-3, s)
  view.k = fitScale.value
  view.x = (el.clientWidth - r.w * s) / 2
  view.y = (el.clientHeight - r.h * s) / 2
}
watch(raster, (r, old) => { if (r && (!old || old.w !== r.w || old.h !== r.h)) requestAnimationFrame(fit) })
function wheel(e: WheelEvent): void {
  const el = stage.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002))
  const k = Math.min(fitScale.value * 16, Math.max(fitScale.value / 4, view.k * f))
  view.x = sx - ((sx - view.x) * k) / view.k
  view.y = sy - ((sy - view.y) * k) / view.k
  view.k = k
}
function drag(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  let lx = e.clientX, ly = e.clientY
  const move = (ev: PointerEvent) => { view.x += ev.clientX - lx; view.y += ev.clientY - ly; lx = ev.clientX; ly = ev.clientY }
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
let ro: ResizeObserver | null = null
onMounted(() => { ro = new ResizeObserver(fit); if (stage.value) ro.observe(stage.value) })
onBeforeUnmount(() => {
  ro?.disconnect()
  for (const p of cache.values()) void p.then(img => URL.revokeObjectURL(img.src), () => {})
})

const statusLabel: Record<LayerDiff['status'], string> = { changed: 'changed', added: 'new', removed: 'removed', unchanged: 'same' }
const partGroups = computed(() => {
  const p = diff.value?.parts
  if (!p) return []
  return (['added', 'removed', 'moved', 'changed'] as const).filter(k => p[k].length).map(k => ({ k, refs: p[k] }))
})
const since = computed(() => diff.value?.base ? (diff.value.base.tag ?? diff.value.base.short) : null)
</script>

<template>
  <Teleport defer to="#topbar-slot">
    <template v-if="board">
      <RouterLink :to="boardRoute(name)" class="crumb">← {{ board.title }}</RouterLink>
      <span class="title">Changes<template v-if="since"> since <span class="mono">{{ since }}</span></template></span>
    </template>
  </Teleport>

  <section v-if="!board || !diff" class="empty">
    <p v-if="!board">No board named <code>{{ name }}</code>.</p>
    <p v-else>No revision diff for this board. Turn it on with <code>revision: { diff: true }</code> in the config
      (the project must be in a git repository).</p>
    <RouterLink v-if="!site.single" to="/">Back to all boards</RouterLink>
  </section>

  <div v-else class="diff">
    <aside class="side">
      <div class="summary">
        <p class="line">{{ diff.summary }}</p>
        <p v-if="diff.base" class="base">
          against <span class="mono">{{ diff.base.short }}</span><template v-if="diff.base.tag"> ({{ diff.base.tag }})</template>,
          {{ diff.base.date.slice(0, 10) }}<br /><span class="subject">{{ diff.base.subject }}</span>
        </p>
        <p v-if="board.rev.git?.dirty" class="base">now: working copy with uncommitted changes</p>
        <p v-if="diff.outlineChanged" class="base">The board outline changed.</p>
      </div>

      <template v-if="diff.layers.length">
        <h3>Layers</h3>
        <ul class="layers">
          <li v-for="l in visible" :key="l.id">
            <button :aria-pressed="selected?.id === l.id" :disabled="l.status === 'unchanged'" @click="selectedId = l.id">
              <span class="swatch" :style="{ background: l.color }"></span>
              <span class="lname">{{ l.name }}</span>
              <span class="chip" :class="`chip-${l.status}`">{{ statusLabel[l.status] }}</span>
            </button>
          </li>
        </ul>
        <label class="check"><input v-model="showUnchanged" type="checkbox" /> show unchanged layers</label>
      </template>

      <template v-if="partGroups.length">
        <h3>Parts</h3>
        <dl class="parts">
          <template v-for="g in partGroups" :key="g.k">
            <dt>{{ g.k }} ({{ g.refs.length }})</dt>
            <dd class="mono">{{ g.refs.join(', ') }}</dd>
          </template>
        </dl>
      </template>
      <p v-else-if="diff.base && !diff.parts" class="hint">Part changes appear once footprints are parsed.</p>
    </aside>

    <section class="view">
      <div class="tools">
        <div class="modes" role="group" aria-label="View">
          <button :aria-pressed="mode === 'diff'" @click="mode = 'diff'">Diff</button>
          <button :aria-pressed="mode === 'blend'" @click="mode = 'blend'">Blend</button>
        </div>
        <label class="slider">
          <span>{{ mode === 'diff' ? 'unchanged' : 'before' }}</span>
          <input v-model.number="amount" type="range" min="0" max="1" step="0.01"
                 :aria-label="mode === 'diff' ? 'Opacity of unchanged geometry' : 'Before / after'" />
          <span v-if="mode === 'blend'">after</span>
        </label>
        <span v-if="mode === 'diff' && raster" class="legend">
          <span class="key add"></span>added <span class="key rem"></span>removed <span class="key same"></span>unchanged
        </span>
        <button class="fit" title="Fit (double-click)" @click="fit">Fit</button>
      </div>
      <div ref="stage" class="stage" @wheel.prevent="wheel" @pointerdown="drag" @dblclick="fit">
        <canvas v-show="raster" ref="canvas" class="canvas"
                :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }"></canvas>
        <p v-if="!selected" class="msg">{{ diff.note ?? 'No layer changed.' }}</p>
        <p v-else-if="error" class="msg">Cannot show {{ selected.name }}: {{ error }}</p>
        <p v-else-if="loading" class="msg">Loading {{ selected.name }}…</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.crumb { color: var(--muted); white-space: nowrap; }
.crumb:hover { color: var(--text); }
.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { padding: 24px; color: var(--muted); }
.empty a { color: var(--accent); }

.diff { display: flex; height: 100%; min-height: 0; }
.side {
  flex: 0 0 260px;
  overflow: auto;
  padding: 12px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  font-size: 13px;
}
.summary .line { margin: 0 0 6px; font-weight: 600; }
.base { margin: 0 0 6px; color: var(--muted); font-size: 12px; }
.subject { color: var(--text); }
h3 { margin: 14px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.layers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.layers button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: transparent;
  border-color: transparent;
  padding: 4px 6px;
}
.layers button:hover:not(:disabled) { background: var(--panel-2); }
.layers button:disabled { cursor: default; opacity: 0.55; }
.swatch { flex: 0 0 10px; height: 10px; border-radius: 2px; }
.lname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--line); color: var(--muted); }
.chip-changed { color: #e7c169; border-color: #6b5521; }
.chip-added { color: #6fcf8f; border-color: #2f6b45; }
.chip-removed { color: #ef7d6d; border-color: #7a3a33; }
.check { display: flex; gap: 6px; align-items: center; margin-top: 8px; color: var(--muted); font-size: 12px; }
.parts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 12px; }
.parts dt { color: var(--muted); text-transform: capitalize; }
.parts dd { margin: 0; word-break: break-word; }
.hint { color: var(--muted); font-size: 12px; margin-top: 14px; }

.view { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: 12px;
}
.modes { display: flex; gap: 4px; }
.slider { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.slider input { width: 140px; }
.legend { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }
.key { width: 10px; height: 10px; border-radius: 2px; display: inline-block; margin-left: 6px; }
.key.add { background: rgb(46, 204, 113); }
.key.rem { background: rgb(235, 87, 87); }
.key.same { background: rgb(138, 145, 155); }
.fit { margin-left: auto; }
.stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: #0d0f12; cursor: grab; touch-action: none; }
.stage:active { cursor: grabbing; }
.canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; image-rendering: auto; }
.msg { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); pointer-events: none; }

@media (max-width: 820px) {
  .diff { flex-direction: column; }
  .side { flex: 0 0 auto; max-height: 40%; border-right: 0; border-bottom: 1px solid var(--line); }
  .crumb { display: none; }
}
</style>
