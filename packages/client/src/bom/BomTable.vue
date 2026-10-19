<script setup lang="ts">
// Interactive BOM: grouped (one line per identical part) or ungrouped (one line per
// reference), sortable by any column, a search over refdes / value / MPN, and
// not-in-BOM parts in their own section. DNP parts are left out of the table (owner
// rule: a DNP part never appears in a BOM; the Assembly tab lists them to leave empty)
// unless the config's bom.showDnp lists them in their own section. A reference chip
// selects that part, a line selects all its references (cross-probe store).
import { computed, nextTick, onActivated, ref, watch } from 'vue'
import type { Board, BomRow } from '../types'
import { useBom } from '../crossprobe/data'
import { probe, select, selectedOn } from '../crossprobe/store'
import { expandRows, matches, sections, shortFootprint, sortRows, visibleRows, type Sort, type SortKey } from './model'

const props = defineProps<{ board: Board }>()

const { data, error, loading } = useBom(() => props.board.bom)

const store = {
  get(k: string): string | null { try { return localStorage.getItem(`bom.${k}`) } catch { return null } },
  set(k: string, v: string): void { try { localStorage.setItem(`bom.${k}`, v) } catch { /* ignore */ } },
}
const grouped = ref(store.get('grouped') !== 'false')
watch(grouped, v => store.set('grouped', String(v)))
const query = ref('')
const sort = ref<Sort>({ key: 'refs', dir: 1 })

/** Field columns: all but Datasheet (a link on the value) and Description (the line's tooltip). */
const fieldCols = computed(() => (data.value?.fields ?? []).filter(f => f !== 'Datasheet' && f !== 'Description'))

/** BOM lines shown at all: DNP lines only with bom.showDnp (Board.bomOptions). */
const showDnp = computed(() => props.board.bomOptions?.showDnp ?? false)
const bomRows = computed<BomRow[]>(() => visibleRows(data.value?.rows ?? [], showDnp.value))
const hasDatasheets = computed(() => bomRows.value.some(r => /^https?:\/\//.test(r.fields.Datasheet ?? '')))

const rows = computed<BomRow[]>(() => {
  const all = bomRows.value
  const list = grouped.value ? all : expandRows(all)
  return sortRows(list.filter(r => matches(r, query.value)), sort.value)
})
const parts = computed(() => sections(rows.value))
const totals = computed(() => {
  const s = sections(bomRows.value)
  return { lines: s.fitted.length, parts: s.fitted.reduce((n, r) => n + r.quantity, 0), dnp: s.dnp.reduce((n, r) => n + r.quantity, 0) }
})

function sortBy(key: SortKey): void {
  sort.value = sort.value.key === key ? { key, dir: sort.value.dir === 1 ? -1 : 1 } : { key, dir: 1 }
}
const arrow = (key: SortKey) => (sort.value.key === key ? (sort.value.dir === 1 ? '▲' : '▼') : '')
const ariaSort = (key: SortKey) => (sort.value.key === key ? (sort.value.dir === 1 ? 'ascending' : 'descending') : 'none')

// ---- selection ------------------------------------------------------------------------
const selected = computed(() => new Set(selectedOn(props.board.name)))
const rowSelected = (r: BomRow) => r.refs.some(x => selected.value.has(x))
function pickRow(r: BomRow): void {
  const same = r.refs.length === selected.value.size && r.refs.every(x => selected.value.has(x))
  select(props.board.name, same ? null : r.refs, 'bom')
}
function pickRef(ref: string): void {
  const only = selected.value.size === 1 && selected.value.has(ref)
  select(props.board.name, only ? null : ref, 'bom')
}

const scroller = ref<HTMLElement | null>(null)
async function reveal(): Promise<void> {
  const ref0 = selectedOn(props.board.name)[0]
  if (!ref0) return
  // a selected part hidden by the search: clear the search so it can be shown
  if (!rows.value.some(r => r.refs.includes(ref0)) && bomRows.value.some(r => r.refs.includes(ref0))) query.value = ''
  await nextTick()
  scroller.value?.querySelector(`[data-refs~="${CSS.escape(ref0)}"]`)?.scrollIntoView({ block: 'nearest' })
}
watch(() => probe.seq, () => { if (probe.source !== 'bom') void reveal() })
watch(data, () => void reveal())   // a deep-linked part, once the BOM has arrived
onActivated(() => void reveal())

const datasheet = (r: BomRow) => (/^https?:\/\//.test(r.fields.Datasheet ?? '') ? r.fields.Datasheet! : null)
const SECTIONS = [
  { id: 'fitted', title: '' },
  { id: 'dnp', title: 'Do not populate' },
  { id: 'excluded', title: 'Not in BOM' },
] as const
</script>

<template>
  <div class="bom">
    <div class="toolbar">
      <input v-model="query" type="search" class="search" placeholder="Search refdes, value, MPN" aria-label="Search the BOM"
             @keydown.esc="query = ''" />
      <div class="seg" role="group" aria-label="Grouping">
        <button :aria-pressed="grouped" title="One line per identical part" @click="grouped = true">Grouped</button>
        <button :aria-pressed="!grouped" title="One line per reference" @click="grouped = false">Per part</button>
      </div>
      <span class="count mono" v-if="data">
        {{ totals.lines }} lines · {{ totals.parts }} parts<template v-if="totals.dnp"> · {{ totals.dnp }} DNP</template>
      </span>
    </div>

    <div ref="scroller" class="scroll">
      <p v-if="loading" class="note">Loading BOM…</p>
      <p v-else-if="error" class="note">The BOM could not be loaded: {{ error }}</p>
      <table v-else-if="data">
        <thead>
          <tr>
            <th class="refs" :aria-sort="ariaSort('refs')" @click="sortBy('refs')">Refs {{ arrow('refs') }}</th>
            <th v-if="grouped" class="qty" :aria-sort="ariaSort('quantity')" @click="sortBy('quantity')">Qty {{ arrow('quantity') }}</th>
            <th :aria-sort="ariaSort('value')" @click="sortBy('value')">Value {{ arrow('value') }}</th>
            <th :aria-sort="ariaSort('footprint')" @click="sortBy('footprint')">Footprint {{ arrow('footprint') }}</th>
            <th v-for="f in fieldCols" :key="f" :aria-sort="ariaSort(`field:${f}`)" @click="sortBy(`field:${f}`)">{{ f }} {{ arrow(`field:${f}`) }}</th>
            <th v-if="hasDatasheets" class="ds" title="Datasheet">DS</th>
          </tr>
        </thead>
        <template v-for="sec in SECTIONS" :key="sec.id">
          <tbody v-if="parts[sec.id].length || (sec.id === 'fitted' && !rows.length)" :class="sec.id">
            <tr v-if="sec.title" class="section"><th :colspan="99">{{ sec.title }} ({{ parts[sec.id].reduce((n, r) => n + r.quantity, 0) }})</th></tr>
            <tr v-if="sec.id === 'fitted' && !rows.length"><td :colspan="99" class="empty">No part matches “{{ query }}”.</td></tr>
            <tr v-for="r in parts[sec.id]" :key="r.refs.join(',')" :data-refs="r.refs.join(' ')" :class="{ sel: rowSelected(r) }"
                :title="r.fields.Description ?? ''" @click="pickRow(r)">
              <td class="refs">
                <button v-for="x in r.refs" :key="x" class="chip mono" :class="{ on: selected.has(x) }"
                        :title="`Show ${x}`" @click.stop="pickRef(x)">{{ x }}</button>
              </td>
              <td v-if="grouped" class="qty mono">{{ r.quantity }}</td>
              <td class="value">{{ r.value }}</td>
              <td class="fp" :title="r.footprint">{{ shortFootprint(r.footprint) }}</td>
              <td v-for="f in fieldCols" :key="f" class="field">{{ r.fields[f] ?? '' }}</td>
              <td v-if="hasDatasheets" class="ds">
                <a v-if="datasheet(r)" :href="datasheet(r)!" target="_blank" rel="noopener noreferrer" title="Datasheet" @click.stop>↗</a>
              </td>
            </tr>
          </tbody>
        </template>
      </table>
    </div>
  </div>
</template>

<style scoped>
.bom { width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
.toolbar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; border-bottom: 1px solid var(--line); }
.search {
  flex: 1 1 180px; min-width: 120px; max-width: 320px; font: inherit; font-size: 13px; color: var(--text);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 3px 8px;
}
.search:focus { outline: none; border-color: var(--accent); }
.seg { display: flex; }
.seg button { border-radius: 0; font-size: 12px; padding: 2px 8px; }
.seg button:first-child { border-radius: var(--radius) 0 0 var(--radius); }
.seg button:last-child { border-radius: 0 var(--radius) var(--radius) 0; margin-left: -1px; }
.count { color: var(--muted); margin-left: auto; white-space: nowrap; }

.scroll { flex: 1; min-height: 0; overflow: auto; }
.note { color: var(--muted); font-size: 12px; padding: 16px; margin: 0; }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12.5px; }
thead th {
  position: sticky; top: 0; z-index: 1; background: var(--panel); text-align: left; font-weight: 600; color: var(--muted);
  padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; cursor: pointer; user-select: none;
}
thead th:hover { color: var(--text); }
td { padding: 4px 8px; border-bottom: 1px solid var(--row-line); vertical-align: top; }
tbody tr:not(.section) { cursor: pointer; }
tbody tr:not(.section):hover td { background: var(--row-hover); }
tr.sel td { background: var(--select-bg) !important; }
tr.sel td:first-child { box-shadow: inset 3px 0 0 var(--select); }
.section th { text-align: left; padding: 10px 8px 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dnp); border-bottom: 1px solid var(--line); }
tbody.excluded .section th { color: var(--muted); }
tbody.dnp td, tbody.excluded td { color: var(--muted); }
tbody.dnp .value { text-decoration: line-through; text-decoration-color: var(--dnp); }
.refs { min-width: 90px; max-width: 280px; }
.chip {
  display: inline-block; margin: 0 3px 2px 0; padding: 0 5px; font-size: 11.5px; line-height: 18px;
  border-radius: 4px; background: var(--chip-bg); border: 1px solid var(--chip-line); color: var(--text);
}
.chip:hover { border-color: var(--accent); }
.chip.on { background: var(--select); border-color: var(--select); color: var(--select-ink); }
.qty { text-align: right; }
.value { white-space: nowrap; }
.fp { white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.field { white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.ds { text-align: center; }
.ds a { color: var(--accent); }
.empty { color: var(--muted); padding: 14px 8px; }
</style>
