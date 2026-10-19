<script setup lang="ts">
// [P2-d] DRC / ERC report page: counts by severity (also filters), the violations
// grouped by section (violations, unconnected items, schematic parity) and type,
// each item with its location. For DRC, the board's layer view sits next to the
// list: clicking an item with a position pans it there (layers/bus.ts) and marks
// it; the arrow opens the board page at that spot (a deep link).
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { boardByName } from '../boards'
import PaneLoading from '../components/PaneLoading.vue'
import { formatViewLink } from '../deepLink'
import { focusLayerView } from '../layers/bus'
import type { CheckViolation } from '@kiview/kicad/types'
import type { CheckReport, Severity } from '../types'

const props = defineProps<{ name: string; report: string }>()
const LayerBrowser = defineAsyncComponent({ loader: () => import('../components/LayerBrowser.vue'), loadingComponent: PaneLoading })

const board = computed(() => boardByName(props.name) ?? null)
const kind = computed<'drc' | 'erc'>(() => (props.report === 'erc' ? 'erc' : 'drc'))
const summary = computed(() => board.value?.reports[kind.value] ?? null)
const feature = computed(() => board.value?.features[kind.value])

const data = shallowRef<CheckReport | null>(null)
const error = ref<string | null>(null)
watch(() => summary.value?.url, async url => {
  data.value = null
  error.value = null
  if (!url) return
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = (await r.json()) as CheckReport
    if (summary.value?.url === url) data.value = j
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}, { immediate: true })

// ---- filters, grouping --------------------------------------------------------------------
const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'error', label: 'Errors' }, { id: 'warning', label: 'Warnings' }, { id: 'exclusion', label: 'Excluded' }, { id: 'info', label: 'Info' },
]
const shown = ref<Record<Severity, boolean>>({ error: true, warning: true, exclusion: false, info: true })
function toggleSeverity(s: Severity): void { shown.value = { ...shown.value, [s]: !shown.value[s] } }

interface Group { type: string; title: string; severity: Severity; items: CheckViolation[] }
const sections = computed(() => {
  const d = data.value
  if (!d) return []
  const group = (list: CheckViolation[]): Group[] => {
    const m = new Map<string, Group>()
    for (const v of list) {
      if (!shown.value[v.severity]) continue
      const key = `${v.severity}:${v.type}`
      let g = m.get(key)
      if (!g) m.set(key, g = { type: v.type, title: titleOf(v), severity: v.severity, items: [] })
      g.items.push(v)
    }
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2, exclusion: 3 }
    return [...m.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || b.items.length - a.items.length)
  }
  return [
    { id: 'violations', label: kind.value === 'drc' ? 'Violations' : 'Violations', groups: group(d.violations), total: d.violations.length },
    { id: 'unconnected', label: 'Unconnected items', groups: group(d.unconnected), total: d.unconnected.length },
    { id: 'parity', label: 'Schematic parity', groups: group(d.parity), total: d.parity.length },
  ].filter(s => s.total > 0)
})
/** "Clearance violation (netclass ... actual 0.1 mm)" -> "Clearance violation"; types read better as titles. */
function titleOf(v: CheckViolation): string {
  const t = v.type.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}
const total = computed(() => (data.value ? data.value.violations.length + data.value.unconnected.length + data.value.parity.length : 0))

// ---- locating items -----------------------------------------------------------------------
const canLocate = computed(() => kind.value === 'drc' && !!board.value?.layers.length)
const selected = ref<string | null>(null)
const view = ref<HTMLElement | null>(null)
function locate(v: CheckViolation, i: number, key: string): void {
  const item = v.items[i]?.pos ? v.items[i] : v.items.find(x => x.pos)
  selected.value = key
  if (!item?.pos || !canLocate.value || !board.value) return
  focusLayerView({ board: board.value.name, x: item.pos.x, y: item.pos.y, label: v.description || titleOf(v) })
  if (narrow.value) view.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
const boardLink = (x: number, y: number) => ({
  name: 'board', params: { name: props.name },
  query: formatViewLink({ pane: 'layers', at: { x, y }, view: { x, y, z: 6 } }),
})
const fmt = (v: number) => (+v.toFixed(3)).toString()

// ---- layout ---------------------------------------------------------------------------------
const narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 820px)') : null
const narrow = ref(narrowQuery?.matches ?? false)
const onNarrow = (e: MediaQueryListEvent) => { narrow.value = e.matches }
onMounted(() => narrowQuery?.addEventListener('change', onNarrow))
onBeforeUnmount(() => narrowQuery?.removeEventListener('change', onNarrow))
</script>

<template>
  <Teleport defer to="#topbar-slot">
    <RouterLink v-if="board" :to="{ name: 'board', params: { name } }" class="crumb" :title="`Back to ${board.title}`">← {{ board.title }}</RouterLink>
    <span class="title">{{ kind.toUpperCase() }} report</span>
    <span class="spacer"></span>
    <nav v-if="board" class="switch" aria-label="Reports">
      <RouterLink :to="{ name: 'report', params: { name, report: 'drc' } }" :aria-current="kind === 'drc' ? 'page' : undefined">DRC</RouterLink>
      <RouterLink :to="{ name: 'report', params: { name, report: 'erc' } }" :aria-current="kind === 'erc' ? 'page' : undefined">ERC</RouterLink>
    </nav>
  </Teleport>

  <section v-if="!board" class="missing"><p>No board named <code>{{ name }}</code>.</p><RouterLink to="/">Back to all boards</RouterLink></section>

  <div v-else class="report" :class="{ narrow, solo: !canLocate }">
    <section class="list" aria-label="Report items">
      <header class="head">
        <h1>{{ board.title }} · {{ kind === 'drc' ? 'Design rules' : 'Electrical rules' }}</h1>
        <p v-if="data" class="meta muted">
          {{ total }} item{{ total === 1 ? '' : 's' }}<template v-if="data.kicadVersion"> · KiCad {{ data.kicadVersion }}</template><template v-if="data.date"> · {{ data.date.replace('T', ' ') }}</template>
        </p>
        <div v-if="summary" class="filters" role="group" aria-label="Severities">
          <button v-for="s in SEVERITIES" v-show="summary.counts[s.id] || s.id === 'error'" :key="s.id" :class="s.id"
                  :aria-pressed="shown[s.id]" :title="`${shown[s.id] ? 'Hide' : 'Show'} ${s.label.toLowerCase()}`" @click="toggleSeverity(s.id)">
            <span class="dot"></span>{{ summary.counts[s.id] }} {{ s.label.toLowerCase() }}
          </button>
        </div>
      </header>

      <p v-if="!summary" class="muted pad">
        {{ feature && !feature.available ? `No ${kind.toUpperCase()} report: ${feature.reason}.` : `The ${kind.toUpperCase()} has not run yet.` }}
      </p>
      <p v-else-if="error" class="pad err">The report could not be loaded: {{ error }}</p>
      <p v-else-if="!data" class="muted pad">Loading…</p>
      <p v-else-if="!total" class="pad ok">No {{ kind === 'drc' ? 'DRC' : 'ERC' }} violations.</p>
      <p v-else-if="!sections.length" class="muted pad">Nothing to show with these filters.</p>

      <section v-for="sec in sections" :key="sec.id" class="section">
        <h2>{{ sec.label }} <span class="muted">{{ sec.total }}</span></h2>
        <details v-for="g in sec.groups" :key="`${g.severity}:${g.type}`" class="group" :open="sec.groups.length <= 6 || g.severity === 'error'">
          <summary><span class="dot" :class="g.severity"></span><span class="gt">{{ g.title }}</span><span class="n">{{ g.items.length }}</span></summary>
          <ol>
            <li v-for="(v, vi) in g.items" :key="vi" :class="{ sel: selected?.startsWith(`${sec.id}:${g.type}:${vi}:`) }">
              <button class="desc" type="button" :disabled="!canLocate || !v.items.some(x => x.pos)" @click="locate(v, 0, `${sec.id}:${g.type}:${vi}:0`)">{{ v.description || g.title }}</button>
              <ul v-if="v.items.length">
                <li v-for="(it, ii) in v.items" :key="ii" :class="{ sel: selected === `${sec.id}:${g.type}:${vi}:${ii}` }">
                  <button v-if="it.pos && canLocate" class="item" type="button" :title="`Show ${fmt(it.pos.x)}, ${fmt(it.pos.y)} mm in the layer view`"
                          @click="locate(v, ii, `${sec.id}:${g.type}:${vi}:${ii}`)">
                    <span>{{ it.description }}</span><span class="pos mono">{{ fmt(it.pos.x) }}, {{ fmt(it.pos.y) }}</span>
                  </button>
                  <span v-else class="item static">
                    <span>{{ it.description }}</span>
                    <span v-if="it.pos" class="pos mono">{{ it.sheet ? `${it.sheet} · ` : '' }}{{ fmt(it.pos.x) }}, {{ fmt(it.pos.y) }}</span>
                  </span>
                  <RouterLink v-if="it.pos && canLocate" class="open" :to="boardLink(it.pos.x, it.pos.y)" title="Open the board page here">↗</RouterLink>
                </li>
              </ul>
            </li>
          </ol>
        </details>
      </section>
    </section>

    <section v-if="canLocate" ref="view" class="view" aria-label="Layer view">
      <LayerBrowser :board="board" />
    </section>
  </div>
</template>

<style scoped>
.crumb { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30vw; }
.crumb:hover { color: var(--text); }
.title { font-weight: 600; white-space: nowrap; }
.spacer { flex: 1; }
.switch { display: flex; gap: 2px; }
.switch a { padding: 3px 9px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); font-size: 12px; }
.switch a[aria-current='page'] { background: var(--pressed-bg); border-color: var(--pressed-line); }

.missing { padding: 24px; color: var(--muted); }
.report { display: flex; height: 100%; min-height: 0; }
.list { flex: 0 0 min(460px, 45%); min-width: 0; overflow: auto; border-right: 1px solid var(--line); background: var(--panel); }
.report.solo .list { flex: 1; max-width: 960px; margin: 0 auto; border-right: 0; }
.view { flex: 1; min-width: 0; min-height: 0; position: relative; }
.report.narrow { flex-direction: column; }
.report.narrow .list { flex: 1 1 50%; border-right: 0; border-bottom: 1px solid var(--line); }
.report.narrow .view { flex: 1 1 50%; min-height: 260px; }
.report.narrow.solo .list { flex: 1; }

.head { position: sticky; top: 0; z-index: 1; padding: 12px 14px 8px; background: var(--panel); border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 15px; }
.meta { margin: 2px 0 8px; font-size: 12px; }
.filters { display: flex; flex-wrap: wrap; gap: 4px; }
.filters button { font-size: 12px; padding: 2px 8px; display: inline-flex; align-items: center; gap: 6px; }
.filters button[aria-pressed='false'] { opacity: 0.55; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--excluded); flex: 0 0 auto; display: inline-block; }
.error .dot, .dot.error { background: var(--error); }
.warning .dot, .dot.warning { background: var(--warning); }
.info .dot, .dot.info { background: var(--accent); }
.pad { padding: 12px 14px; margin: 0; }
.muted { color: var(--muted); }
.err { color: var(--error); }
.ok { color: var(--ok); }

.section { padding: 4px 0 8px; }
h2 { margin: 10px 14px 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.group { margin: 0 8px; border-bottom: 1px solid var(--line); }
.group summary { display: flex; align-items: center; gap: 8px; padding: 6px 6px; cursor: pointer; list-style: none; }
.group summary::-webkit-details-marker { display: none; }
.group summary::before { content: '▸'; color: var(--muted); font-size: 10px; width: 8px; }
.group[open] summary::before { content: '▾'; }
.gt { flex: 1; min-width: 0; font-weight: 600; }
.n { color: var(--muted); font-variant-numeric: tabular-nums; }
ol { list-style: none; margin: 0 0 6px; padding: 0 0 0 16px; }
ol > li { padding: 3px 0; border-radius: var(--radius); }
ol > li.sel { background: var(--current-bg); }
button.desc, button.item { all: unset; box-sizing: border-box; cursor: pointer; display: block; width: 100%; padding: 2px 6px; border-radius: 4px; }
button.desc:disabled { cursor: default; }
button.desc:not(:disabled):hover, button.item:hover { background: var(--panel-2); }
button.desc:focus-visible, button.item:focus-visible { outline: 2px solid var(--accent); }
ul { list-style: none; margin: 0; padding: 0 0 0 10px; }
ul > li { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
ul > li.sel { color: var(--text); }
.item, button.item { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.item.static { padding: 2px 6px; }
.pos { white-space: nowrap; color: var(--muted); font-size: 11px; }
.open { padding: 0 6px; color: var(--muted); }
.open:hover { color: var(--accent); }
</style>
