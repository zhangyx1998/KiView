<script setup lang="ts">
// Viewer page: board sidebar + peer panes (3D, Layers, Schematic, BOM, Assembly), any
// of them open side by side. The pane components are async chunks, mounted when their
// pane is first shown. Phones fold the board list and the pane toggles into one menu.
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { boards, boardByName } from '../boards'
import PaneLoading from '../components/PaneLoading.vue'
import FabDownload from '../components/FabDownload.vue'
import RevisionBadge from '../components/RevisionBadge.vue' // [P2-c]
// [P2-d] board facts sidebar, deep links, copy-link
import BoardInfo from '../components/BoardInfo.vue'
import CopyLink from '../components/CopyLink.vue'
import { useBoardLink } from '../linkState'
import { useHashSelection } from '../crossprobe/store'   // [P2-b] #part= cross-probe

const props = defineProps<{ name: string }>()

const BoardView3D = defineAsyncComponent({ loader: () => import('../components/BoardView3D.vue'), loadingComponent: PaneLoading })
const LayerBrowser = defineAsyncComponent({ loader: () => import('../components/LayerBrowser.vue'), loadingComponent: PaneLoading })

const board = computed(() => boardByName(props.name) ?? null)
const download = computed(() => board.value?.download)

// ---- layout state (remembered per browser) -----------------------------------
const store = {
  get(k: string): string | null { try { return localStorage.getItem(`viewer.${k}`) } catch { return null } },
  set(k: string, v: string): void { try { localStorage.setItem(`viewer.${k}`, v) } catch { /* ignore */ } },
}

const narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 820px)') : null
const narrow = ref(narrowQuery?.matches ?? false)
const onNarrow = (e: MediaQueryListEvent) => { narrow.value = e.matches }
onMounted(() => narrowQuery?.addEventListener('change', onNarrow))
onBeforeUnmount(() => narrowQuery?.removeEventListener('change', onNarrow))

const sidebarOpen = ref(!narrow.value && store.get('sidebar') !== 'closed')
watch(sidebarOpen, v => { if (!narrow.value) store.set('sidebar', v ? 'open' : 'closed') })
watch(() => props.name, () => { if (narrow.value) sidebarOpen.value = false })

// ---- the panes: peers, any of them open side by side, shown when the board has the feature ----
const SchematicView = defineAsyncComponent({ loader: () => import('../schematic/SchematicView.vue'), loadingComponent: PaneLoading })
const BomTable = defineAsyncComponent({ loader: () => import('../bom/BomTable.vue'), loadingComponent: PaneLoading })
const AssemblyPane = defineAsyncComponent({ loader: () => import('../assembly/AssemblyPane.vue'), loadingComponent: PaneLoading })   // [assembly]
const PANES = [
  { id: '3d', label: '3D', feature: null, component: BoardView3D },
  { id: 'layers', label: 'Layers', feature: null, component: LayerBrowser },
  { id: 'schematic', label: 'Schematic', feature: 'schematic', component: SchematicView },   // [P2-b]
  { id: 'bom', label: 'BOM', feature: 'bom', component: BomTable },                         // [P2-b]
  { id: 'assembly', label: 'Assembly', feature: 'crossProbe', component: AssemblyPane },    // [assembly]
] as const
type PaneId = (typeof PANES)[number]['id']
const IDS: readonly string[] = PANES.map(p => p.id)
const available = computed(() => PANES.filter(p => !p.feature || board.value?.features[p.feature]?.available))

/** Pane ids of a stored or linked list, or of the legacy mode + tab ("split" = 3D and the tab). */
function parsePanes(pane: string | null | undefined, tab: string | null | undefined): string[] | null {
  if (!pane) return null
  const t = tab && IDS.includes(tab) ? tab : 'layers'
  if (pane === 'split') return ['3d', t]
  if (pane === 'layers') return [t]
  const ids = pane.split(',').filter(id => IDS.includes(id))
  return ids.length ? ids : null
}
/** The panes the user has opened, in page order; some may be missing on the current board. */
const open = ref<string[]>(parsePanes(store.get('panes'), null)
  ?? parsePanes(store.get('mode'), store.get('tab'))   // the pre-panes mode / tab settings
  ?? (narrow.value ? ['3d'] : ['3d', 'layers']))
watch(open, o => store.set('panes', o.join(',')))
/** What is shown: the open panes the board has, else its first pane. */
const visible = computed(() => {
  const v = available.value.filter(p => open.value.includes(p.id))
  return v.length ? v : available.value.slice(0, 1)
})
const isVisible = (id: string) => visible.value.some(p => p.id === id)
const visibleIds = computed<string[]>(() => visible.value.map(p => p.id))

function toggle(id: PaneId): void {
  if (isVisible(id)) {
    if (visible.value.length > 1) open.value = visibleIds.value.filter(x => x !== id)
  } else {
    // the assembly steps mark their parts in the Layers pane: open it along
    const add = id === 'assembly' ? [id, 'layers'] : [id]
    open.value = IDS.filter(x => add.includes(x) || visibleIds.value.includes(x))
  }
}
// ?pane=3d,bom deep links [P2-d]; old links (?pane=split&tab=bom) still open the same view
useBoardLink(() => props.name, () => visibleIds.value, (pane, tab) => {
  const ids = parsePanes(pane, tab) ?? (tab && IDS.includes(tab) ? [...visibleIds.value.filter(x => x === '3d'), tab] : null)
  if (ids) open.value = ids
})
onBeforeUnmount(useHashSelection(() => props.name))   // #part=R5 deep links [P2-b]

/** Mounted once first shown, then only hidden: a pane keeps its view while closed. */
const mounted = ref(new Set<string>())
watch(visibleIds, ids => { if (ids.some(id => !mounted.value.has(id))) mounted.value = new Set([...mounted.value, ...ids]) }, { immediate: true })

// ---- draggable splitters: each pane's share is a flex weight ---------------------------
const weights = ref<Record<string, number>>((() => {
  try { return JSON.parse(store.get('weights') ?? '{}') as Record<string, number> } catch { return {} }
})())
const weight = (id: string) => weights.value[id] ?? 1
const MIN_PX = 120
const paneEls = new Map<string, HTMLElement>()
function setPaneEl(id: string, el: unknown): void { if (el instanceof HTMLElement) paneEls.set(id, el); else paneEls.delete(id) }
const size = (el: HTMLElement) => (narrow.value ? el.getBoundingClientRect().height : el.getBoundingClientRect().width)

/** Move the boundary between pane `b` and the visible pane before it by `delta` px. */
function shift(b: string, delta: number, from?: { sa: number; sb: number; w: number }): void {
  const i = visibleIds.value.indexOf(b)
  const a = visibleIds.value[i - 1]
  const ea = a && paneEls.get(a), eb = paneEls.get(b)
  if (!a || !ea || !eb) return
  const f = from ?? { sa: size(ea), sb: size(eb), w: weight(a) + weight(b) }
  const total = f.sa + f.sb
  const lo = Math.min(MIN_PX, total / 2)
  const sa = Math.min(total - lo, Math.max(lo, f.sa + delta))
  weights.value = { ...weights.value, [a]: (f.w * sa) / total, [b]: (f.w * (total - sa)) / total }
}
const saveWeights = () => store.set('weights', JSON.stringify(weights.value))
function startDrag(b: string, e: PointerEvent): void {
  const i = visibleIds.value.indexOf(b)
  const ea = paneEls.get(visibleIds.value[i - 1] ?? ''), eb = paneEls.get(b)
  if (!ea || !eb) return
  const from = { sa: size(ea), sb: size(eb), w: weight(visibleIds.value[i - 1]!) + weight(b) }
  const start = narrow.value ? e.clientY : e.clientX
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => shift(b, (narrow.value ? ev.clientY : ev.clientX) - start, from)
  const up = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', up)
    saveWeights()
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', up)
}
function nudge(b: string, e: KeyboardEvent): void {
  const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -40 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 40 : 0
  if (d) { shift(b, d); saveWeights(); e.preventDefault() }
}

// ---- phones: the board list and the pane toggles fold into one menu -----------------
const menuOpen = ref(false)
const menu = ref<HTMLElement | null>(null)
/** Fixed under the burger: the top bar clips anything that overflows it. */
const menuPos = ref({ top: '0px', right: '0px' })
function toggleMenu(e: MouseEvent): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  menuPos.value = { top: `${Math.round(r.bottom + 6)}px`, right: `${Math.round(window.innerWidth - r.right)}px` }
  menuOpen.value = !menuOpen.value
}
const onDocDown = (e: PointerEvent) => { if (menuOpen.value && !menu.value?.contains(e.target as Node)) menuOpen.value = false }
onMounted(() => document.addEventListener('pointerdown', onDocDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocDown, true))
watch(narrow, n => { if (!n) menuOpen.value = false })
watch(() => props.name, () => { menuOpen.value = false })
</script>

<template>
  <Teleport defer to="#topbar-slot">
    <button v-if="!narrow" class="side-toggle" :aria-pressed="sidebarOpen" title="Board list" @click="sidebarOpen = !sidebarOpen">☰</button>
    <template v-if="board">
      <span class="title">{{ board.title }}</span>
      <RevisionBadge :rev="board.rev" :name="board.name" :diff="board.diff" variant="bar" /><!-- [P2-c] -->
      <span class="spacer"></span>
      <FabDownload v-if="download" :download="download" variant="bar" />
      <CopyLink />
      <div v-if="!narrow" class="modes" role="group" aria-label="Panes">
        <button v-for="p in available" :key="p.id" :aria-pressed="isVisible(p.id)"
                :title="isVisible(p.id) ? `Close the ${p.label} pane` : `Open the ${p.label} pane`" @click="toggle(p.id)">{{ p.label }}</button>
      </div>
    </template>
    <div v-if="narrow" ref="menu" class="menu">
      <button class="burger" :aria-expanded="menuOpen" aria-haspopup="true" title="Boards and panes" @click="toggleMenu">☰</button>
      <div v-if="menuOpen" class="menu-list" role="menu" :style="menuPos">
        <button role="menuitem" @click="sidebarOpen = true; menuOpen = false">Boards…</button>
        <template v-if="board">
          <div class="menu-head">Panes</div>
          <button v-for="p in available" :key="p.id" role="menuitemcheckbox" :aria-checked="isVisible(p.id)"
                  :disabled="isVisible(p.id) && visible.length === 1" @click="toggle(p.id)">
            <span class="check">{{ isVisible(p.id) ? '✓' : '' }}</span>{{ p.label }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>

  <div class="viewer" :class="{ narrow, open: sidebarOpen }">
    <aside v-if="sidebarOpen" class="sidebar">
      <RouterLink to="/" class="back">← All boards</RouterLink>
      <nav>
        <RouterLink v-for="b in boards" :key="b.name" :to="{ name: 'board', params: { name: b.name } }"
                    class="item" :class="{ current: b.name === name }" :aria-current="b.name === name ? 'page' : undefined">
          <span class="icon">
            <img v-if="b.thumbnail" :src="b.thumbnail.url" alt="" loading="lazy" decoding="async" />
          </span>
          <span class="label">{{ b.title }}</span>
        </RouterLink>
      </nav>
      <!-- phones: the top bar has no room for the revision badge, the drawer shows it -->
      <div v-if="board && narrow" class="drawer-rev"><RevisionBadge :rev="board.rev" :name="board.name" :diff="board.diff" variant="card" /></div>
      <BoardInfo v-if="board" :board="board" />
    </aside>
    <div v-if="narrow && sidebarOpen" class="scrim" @click="sidebarOpen = false"></div>

    <section v-if="!board" class="missing">
      <p>No board named <code>{{ name }}</code>.</p>
      <RouterLink to="/">Back to all boards</RouterLink>
    </section>

    <section v-else class="panes" :class="narrow ? 'column' : 'row'">
      <template v-for="p in available" :key="p.id">
        <div v-if="isVisible(p.id) && p.id !== visibleIds[0]" class="splitter" role="separator" tabindex="0"
             :aria-orientation="narrow ? 'horizontal' : 'vertical'"
             @pointerdown.prevent="startDrag(p.id, $event)" @keydown="nudge(p.id, $event)"></div>
        <div v-if="mounted.has(p.id)" v-show="isVisible(p.id)" :ref="el => setPaneEl(p.id, el)" class="pane"
             :style="{ flex: `${weight(p.id)} 1 0` }">
          <header>
            <span>{{ p.label }}</span>
            <button v-if="visible.length > 1" class="close" :title="`Close the ${p.label} pane`" @click="toggle(p.id)">×</button>
          </header>
          <div class="body"><component :is="p.component" :board="board" /></div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
.modes { display: flex; gap: 4px; }
.side-toggle { padding: 2px 8px; }
/* the revision badge (P2-c) clips rather than run under the buttons; phones drop it */
.revb-bar { overflow: hidden; }
@media (max-width: 600px) { .revb-bar { display: none; } }
.menu { position: relative; }
.burger { padding: 2px 9px; font-size: 16px; line-height: 1.2; }
.menu-list {
  position: fixed;
  z-index: 20;
  min-width: 168px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: 0 6px 18px var(--shadow);
}
.menu-list button { border: 0; background: none; text-align: left; padding: 9px 10px; font-size: 14px; border-radius: var(--radius); }
.menu-list button:hover:not(:disabled) { background: var(--panel-2); }
.menu-list button:disabled { opacity: 0.55; }
.menu-head { padding: 8px 10px 2px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); border-top: 1px solid var(--line); margin-top: 4px; }
.check { display: inline-block; width: 1.4em; color: var(--accent); }
.drawer-rev { padding: 10px 6px 0; font-size: 12px; }
@media (min-width: 601px) { .drawer-rev { display: none; } }
@media (max-width: 820px) {
  .title { display: none; }   /* [P2-d] the drawer lists it */
}

.viewer { position: relative; display: flex; height: 100%; min-height: 0; }

.sidebar {
  flex: 0 0 236px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--panel);
  padding: 10px 8px;
}
.narrow .sidebar {
  position: absolute;
  z-index: 10;
  inset: 0 auto 0 0;
  width: min(300px, 86vw);
  box-shadow: 4px 0 18px var(--shadow);
}
.scrim { position: absolute; inset: 0; z-index: 9; background: var(--scrim); }
.back { color: var(--muted); font-size: 12px; padding: 2px 6px 10px; }
.back:hover { color: var(--text); }
nav { display: flex; flex-direction: column; gap: 2px; }
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--radius);
  border: 1px solid transparent;
}
.item:hover { background: var(--panel-2); }
.item.current { background: var(--current-bg); border-color: var(--pressed-line); }
.icon {
  flex: 0 0 44px;
  height: 28px;
  border-radius: 3px;
  background: var(--icon-bg);
  overflow: hidden;
}
.icon img { width: 100%; height: 100%; object-fit: contain; display: block; }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.missing { padding: 24px; color: var(--muted); }
.missing a { color: var(--accent); }

.panes { flex: 1; min-width: 0; min-height: 0; display: flex; }
.panes.row { flex-direction: row; }
.panes.column { flex-direction: column; }
.pane {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pane > header {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.pane > header { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.close { border: 0; background: none; padding: 0 4px; font-size: 14px; line-height: 1; color: var(--muted); }
.close:hover { color: var(--text); }
.pane > .body { position: relative; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.splitter { flex: 0 0 5px; background: var(--line); }
.row > .splitter { cursor: col-resize; }
.column > .splitter { cursor: row-resize; }
.splitter:hover, .splitter:focus-visible { background: var(--accent); outline: none; }
</style>
