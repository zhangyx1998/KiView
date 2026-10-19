<script setup lang="ts">
// 3D board viewer: orbit / pan / zoom, view shortcuts (Top, Bottom, 3D, Fit,
// Reset) that animate and fit the board to the pane, an optional 10 mm grid.
//
// The model is fetched only while this pane is mounted and on screen, parsed in a
// worker, and the last few parsed models are kept so switching back is instant.
// The scene itself lives in ../viewer3d (Viewer: rendering and camera; models:
// loading and cache; views: poses and fitting).
//
// Development hook (dev server only): `window.__boardView3D` with
// `view('top' | 'bottom' | 'iso' | 'fit' | 'reset', animate?)` and `state()`;
// used by the screenshot checks.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Board } from '../types'
import { formatBytes } from '../format'
import { Viewer, type ViewCommand } from '../viewer3d/viewer'
import { cacheModel, cachedModel, isAbort, loadModel, releaseCachedGpu, type LoadedModel } from '../viewer3d/models'
import { setLinkPart, takeLinkPart } from '../linkState'   // [P2-d] deep link: the camera
import { use3dMarkers } from '../crossprobe/view3d'   // [P2-b] cross-probe markers

const props = defineProps<{ board: Board }>()

type Phase =
  | { phase: 'empty' }
  | { phase: 'waiting' }
  | { phase: 'loading'; received: number; total: number | null }
  | { phase: 'parsing'; bytes: number }
  | { phase: 'ready'; model: LoadedModel }
  | { phase: 'error'; message: string }

const state = shallowRef<Phase>({ phase: 'waiting' })
const webgl = ref<'ok' | 'lost' | 'unavailable'>('ok')
const webglMessage = ref('')
const grid = ref(true)

const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const toolbar = ref<HTMLElement | null>(null)
let viewer: Viewer | null = null
let shownUrl: string | null = null
let pending: { url: string; ctl: AbortController } | null = null
const visible = ref(false)
let hovered = false
const setHover = (v: boolean) => { hovered = v }

const mm = (v: number) => (Math.round(v * 10) / 10).toString()
const sizeLabel = computed(() => `${mm(props.board.size.width)} × ${mm(props.board.size.height)} mm`)
const stats = computed(() => {
  const s = state.value
  if (s.phase !== 'ready') return ''
  const m = s.model
  return `${formatBytes(m.bytes)}, ${Math.round(m.triangles).toLocaleString()} triangles`
    + `, overall ${mm(m.box.max.x - m.box.min.x)} × ${mm(m.box.max.y - m.box.min.y)} × ${mm(m.box.max.z - m.box.min.z)} mm`
    + ` (download ${Math.round(m.downloadMs)} ms, parse ${Math.round(m.parseMs)} ms)`
})

// ---- loading -----------------------------------------------------------------------

function show(model: LoadedModel | null): void {
  shownUrl = model?.url ?? null
  viewer?.setModel(model?.object ?? null, model?.box ?? null, model?.hull)
  const cam = model ? takeLinkPart(props.board.name, 'cam') : undefined   // [P2-d]
  if (cam) viewer?.setUserPose(cam)
}
// [P2-d] report the camera (debounced) for the URL
let camTimer: ReturnType<typeof setTimeout> | null = null
function onRender(): void {
  if (camTimer) clearTimeout(camTimer)
  camTimer = setTimeout(() => { camTimer = null; setLinkPart(props.board.name, { cam: viewer?.userPose() ?? undefined }) }, 250)
}

function cancelPending(): void {
  pending?.ctl.abort()
  pending = null
}

function sync(): void {
  const model = props.board.model
  if (!model) {
    cancelPending()
    show(null)
    state.value = { phase: 'empty' }
    return
  }
  if (!viewer) return
  if (shownUrl === model.url && state.value.phase === 'ready') return
  if (pending?.url === model.url) return
  cancelPending()
  const hit = cachedModel(model.url)
  if (hit) {
    show(hit)
    state.value = { phase: 'ready', model: hit }
    return
  }
  if (shownUrl) show(null)   // never leave another board's model on screen
  if (!visible.value) { state.value = { phase: 'waiting' }; return }
  void load(model.url, model.format)
}

async function load(url: string, format: 'vrml' | 'glb'): Promise<void> {
  const ctl = new AbortController()
  pending = { url, ctl }
  state.value = { phase: 'loading', received: 0, total: null }
  try {
    const m = await loadModel({ url, format }, ctl.signal, p => {
      if (ctl.signal.aborted) return
      state.value = p.phase === 'download'
        ? { phase: 'loading', received: p.received, total: p.total }
        : { phase: 'parsing', bytes: p.bytes }
    })
    if (ctl.signal.aborted) return
    pending = null
    cacheModel(m)
    if (import.meta.env.DEV) console.info(`[3d] ${url}: ${formatBytes(m.bytes)} downloaded in ${m.downloadMs.toFixed(0)} ms, parsed + merged in ${m.parseMs.toFixed(0)} ms, ${m.triangles} triangles`)
    if (props.board.model?.url !== url) { sync(); return }
    show(m)
    state.value = { phase: 'ready', model: m }
  } catch (e) {
    if (ctl.signal.aborted || isAbort(e)) return
    pending = null
    state.value = { phase: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

function retry(): void {
  if (webgl.value === 'unavailable') { createViewer(); return }
  cancelPending()
  shownUrl = null
  state.value = { phase: 'waiting' }
  sync()
}

watch(() => props.board.model?.url, () => sync())
watch(visible, v => { if (v) sync() })

// ---- viewer ---------------------------------------------------------------------------

function insets() {
  const r = root.value
  const t = toolbar.value
  const w = r?.clientWidth ?? 0
  const h = r?.clientHeight ?? 0
  const top = t && r ? t.getBoundingClientRect().bottom - r.getBoundingClientRect().top + 6 : 44
  const side = Math.max(12, Math.min(w, h) * 0.04)
  return { top: Math.max(top, side), right: side, bottom: Math.max(side, 26), left: side }
}

function createViewer(): void {
  if (!host.value || viewer) return
  try {
    viewer = new Viewer(host.value, {
      insets,
      onContextLost: lost => { webgl.value = lost ? 'lost' : 'ok' },
      onRender,
    })
    viewer.setGrid(grid.value)
    markers.attach(viewer)   // cross-probe markers [P2-b]
    webgl.value = 'ok'
    sync()
  } catch (e) {
    viewer = null
    webgl.value = 'unavailable'
    webglMessage.value = e instanceof Error ? e.message : String(e)
  }
}

const markers = use3dMarkers(() => props.board)

function command(c: ViewCommand): void {
  viewer?.view(c)
}

function toggleGrid(): void {
  grid.value = !grid.value
  viewer?.setGrid(grid.value)
}

function onDblClick(e: MouseEvent): void {
  viewer?.focusAt(e.clientX, e.clientY)
}

const keys: Record<string, () => void> = {
  t: () => command('top'),
  b: () => command('bottom'),
  i: () => command('iso'),
  '3': () => command('iso'),
  f: () => command('fit'),
  r: () => command('reset'),
  home: () => command('reset'),
  g: () => toggleGrid(),
}

function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const r = root.value
  if (!r) return
  const active = document.activeElement
  const focusedHere = !!active && r.contains(active)
  if (!focusedHere && !hovered) return
  // never steal keys from text fields elsewhere on the page
  if (!focusedHere && active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return
  const fn = keys[e.key.toLowerCase()]
  if (!fn) return
  e.preventDefault()
  fn()
}

let io: IntersectionObserver | null = null

onMounted(() => {
  createViewer()
  const r = root.value
  if (r && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(entries => {
      const e = entries[entries.length - 1]
      visible.value = !!e && e.isIntersecting && e.boundingClientRect.width > 0 && e.boundingClientRect.height > 0
    })
    io.observe(r)
  } else {
    visible.value = true
  }
  window.addEventListener('keydown', onKey)
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__boardView3D = {
      view: (c: ViewCommand, animate = true) => viewer?.view(c, animate),
      state: () => ({ phase: state.value.phase, webgl: webgl.value, board: props.board.name, stats: stats.value }),
    }
  }
})

onBeforeUnmount(() => {
  if (camTimer) clearTimeout(camTimer)
  cancelPending()
  io?.disconnect()
  window.removeEventListener('keydown', onKey)
  markers.attach(null)
  viewer?.dispose()
  viewer = null
  releaseCachedGpu()
  if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__boardView3D
})

const progress = computed(() => {
  const s = state.value
  if (s.phase === 'loading') {
    return s.total
      ? { text: `Downloading ${formatBytes(s.received)} of ${formatBytes(s.total)}`, fraction: s.received / s.total }
      : { text: `Downloading ${formatBytes(s.received)}`, fraction: null }
  }
  if (s.phase === 'parsing') return { text: `Parsing ${formatBytes(s.bytes)}…`, fraction: null }
  return null
})

const buttons: { cmd: ViewCommand; label: string; title: string }[] = [
  { cmd: 'top', label: 'Top', title: 'Top view, fitted (T)' },
  { cmd: 'bottom', label: 'Bottom', title: 'Bottom view, board turned over, fitted (B; press again to turn it 180°)' },
  { cmd: 'iso', label: '3D', title: '3D view, fitted (I or 3; press again to walk around the board)' },
  { cmd: 'fit', label: 'Fit', title: 'Fit the board, keep the direction (F)' },
  { cmd: 'reset', label: 'Reset', title: 'Back to the initial view (R or Home)' },
]
</script>

<template>
  <div ref="root" class="view3d" tabindex="0" aria-label="3D view of the board. Drag to rotate, right-drag or shift-drag to pan, wheel to zoom."
       @pointerenter="setHover(true)" @pointerleave="setHover(false)">
    <div ref="host" class="canvas-host" :class="{ hidden: state.phase !== 'ready' }" @dblclick="onDblClick"
         @pointerdown="root?.focus({ preventScroll: true })"></div>

    <div v-if="board.model && webgl === 'ok'" ref="toolbar" class="toolbar" role="toolbar" aria-label="View">
      <button v-for="b in buttons" :key="b.cmd" type="button" :title="b.title" :disabled="state.phase !== 'ready'"
              @click="command(b.cmd)">{{ b.label }}</button>
      <button type="button" title="Show a 10 mm grid under the board (G)" :aria-pressed="grid"
              :disabled="state.phase !== 'ready'" @click="toggleGrid">Grid</button>
    </div>

    <div v-if="state.phase === 'ready'" class="info mono" :title="stats">{{ sizeLabel }}<template v-if="grid"> · grid 10 mm</template></div>

    <div v-if="webgl === 'unavailable'" class="overlay">
      <div class="card">
        <strong>3D view unavailable</strong>
        <p>This browser could not start WebGL, which the 3D view needs. The layer view works without it.</p>
        <p class="muted mono">{{ webglMessage }}</p>
        <button type="button" @click="retry">Try again</button>
      </div>
    </div>
    <div v-else-if="webgl === 'lost'" class="overlay">
      <div class="card"><strong>Graphics context lost</strong><p>Waiting for the browser to restore it…</p></div>
    </div>
    <div v-else-if="state.phase === 'empty'" class="overlay">
      <div class="card">
        <strong>No 3D model</strong>
        <p>The 3D export of this board failed or has not run yet. The layer view still works; check the dev server log or <code>/__boards.json</code> for the export error.</p>
      </div>
    </div>
    <div v-else-if="state.phase === 'error'" class="overlay">
      <div class="card">
        <strong>The 3D model could not be loaded</strong>
        <p class="err">{{ state.message }}</p>
        <button type="button" @click="retry">Retry</button>
      </div>
    </div>
    <div v-else-if="progress" class="overlay" aria-live="polite">
      <div class="card progress">
        <span>{{ progress.text }}</span>
        <div class="bar" :class="{ indeterminate: progress.fraction === null }">
          <div :style="progress.fraction !== null ? { width: `${(progress.fraction * 100).toFixed(1)}%` } : {}"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view3d {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--view3d-bg);
  outline: none;
  user-select: none;
  -webkit-user-select: none;
}
.view3d:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.canvas-host { position: absolute; inset: 0; }
.canvas-host.hidden { visibility: hidden; }

.toolbar {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  pointer-events: none;
}
.toolbar button {
  pointer-events: auto;
  padding: 2px 9px;
  font-size: 12px;
  background: var(--float-bg);
  backdrop-filter: blur(4px);
}
.toolbar button:disabled { opacity: 0.45; cursor: default; }
.toolbar button:nth-child(5) { margin-right: 6px; }

.info {
  position: absolute;
  left: 10px;
  bottom: 7px;
  font-size: 11px;
  color: var(--muted);
  pointer-events: auto;
  text-shadow: 0 1px 2px var(--shadow);
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  pointer-events: none;
}
.card {
  pointer-events: auto;
  max-width: 360px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card-bg);
  font-size: 13px;
}
.card p { margin: 6px 0 10px; color: var(--text); }
.card .muted { color: var(--muted); word-break: break-word; }
.err { color: var(--error); word-break: break-word; }
.progress { display: grid; gap: 8px; min-width: 220px; color: var(--muted); font-variant-numeric: tabular-nums; }
.bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; position: relative; }
.bar > div { height: 100%; background: var(--accent); transition: width 0.1s linear; }
.bar.indeterminate > div { position: absolute; width: 35%; animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { from { left: -35%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .bar.indeterminate > div { animation: none; width: 100%; opacity: 0.5; } }
</style>
