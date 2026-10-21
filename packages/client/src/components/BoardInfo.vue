<script setup lang="ts">
// [P2-d] Board facts for the board page's sidebar: size, layers, stackup, parts,
// pads, vias, holes, minimum track / clearance / ring, and the DRC / ERC summaries
// linking to their report pages. Everything comes from Board.stats and
// Board.reports; missing parts say why (Board.features).
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { reportRoute } from '../routes'
import type { Board, Severity } from '../types'

const props = defineProps<{ board: Board }>()
const s = computed(() => props.board.stats)

const mm = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : `${+v.toFixed(d)} mm`)
const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString())
const sum = (o: { smd: number; tht: number; other: number }) => o.smd + o.tht + o.other

const rows = computed(() => {
  const st = s.value
  if (!st) return []
  const r: [string, string, string?][] = []
  r.push(['Size', `${+st.size.width.toFixed(2)} × ${+st.size.height.toFixed(2)} mm`, st.area ? `area ${st.area} mm²` : undefined])
  r.push(['Thickness', mm(st.thickness)])
  r.push(['Layers', `${st.copperLayers} copper`, st.layerCount ? `${st.layerCount} in the layer table` : undefined])
  if (st.stackup) {
    const mask = st.stackup.maskColor, silk = st.stackup.silkColor
    if (mask.front || mask.back) r.push(['Mask', mask.front === mask.back || !mask.back ? mask.front ?? '—' : `${mask.front ?? '—'} / ${mask.back}`])
    if (silk.front || silk.back) r.push(['Silkscreen', silk.front === silk.back || !silk.back ? silk.front ?? '—' : `${silk.front ?? '—'} / ${silk.back}`])
    if (st.stackup.finish) r.push(['Finish', st.stackup.finish])
  }
  if (st.parts) {
    const p = st.parts
    r.push(['Parts', `${sum(p.front) + sum(p.back)}`, `front ${sum(p.front)} (${p.front.smd} SMD, ${p.front.tht} THT${p.front.other ? `, ${p.front.other} other` : ''}); back ${sum(p.back)} (${p.back.smd} SMD, ${p.back.tht} THT${p.back.other ? `, ${p.back.other} other` : ''})`])
  } else r.push(['Parts', `${st.footprints.front + st.footprints.back}`, `front ${st.footprints.front}, back ${st.footprints.back}`])
  r.push(['Pads', n(st.pads), st.padTypes ? `${st.padTypes.smd} SMD, ${st.padTypes.tht} THT, ${st.padTypes.npth} NPTH` : undefined])
  r.push(['Vias', n(st.vias), st.viaSizes?.map(v => `${v.count} × ${v.size}/${v.drill} mm${v.type !== 'through' ? ` ${v.type}` : ''}`).join(', ')])
  r.push(['Holes', `${st.holes.plated} plated, ${st.holes.nonPlated} NPTH`])
  if (st.tracks) r.push(['Tracks', n(st.tracks.count), `${st.tracks.length.toLocaleString()} mm; widths ${st.tracks.widths.map(w => w.width).join(', ')} mm`])
  return r
})

const mins = computed(() => {
  const st = s.value
  if (!st) return []
  const rule = st.rules
  return [
    ['Track', st.minTrack, rule?.minTrackWidth],
    ['Clearance', st.minClearance, rule?.minClearance],
    ['Drill', st.holes.minDiameter, rule?.minHoleDiameter],
    ['Annular ring', st.minAnnularRing ?? null, rule?.minViaAnnularRing],
  ] as [string, number | null, number | null | undefined][]
})

const drillRows = computed(() => s.value?.drills ?? [])
const stackRows = computed(() => s.value?.stackup?.layers ?? [])

const SEV: Severity[] = ['error', 'warning', 'exclusion']
const reports = computed(() => (['drc', 'erc'] as const).map(kind => {
  const r = props.board.reports[kind]
  const f = props.board.features[kind]
  return { kind, label: kind.toUpperCase(), summary: r, reason: !r && f && !f.available ? f.reason : null }
}))
const sevLabel: Record<Severity, string> = { error: 'errors', warning: 'warnings', exclusion: 'excluded', info: 'info' }
</script>

<template>
  <section class="board-info" aria-label="Board facts">
    <h3>Checks</h3>
    <ul class="checks">
      <li v-for="r in reports" :key="r.kind">
        <RouterLink v-if="r.summary" :to="reportRoute(board.name, r.kind)" class="check">
          <span class="kind">{{ r.label }}</span>
          <template v-if="SEV.some(k => r.summary!.counts[k])">
            <span v-for="k in SEV" v-show="r.summary.counts[k]" :key="k" class="count" :class="k">{{ r.summary.counts[k] }} {{ sevLabel[k] }}</span>
          </template>
          <span v-else class="count ok">clean</span>
        </RouterLink>
        <span v-else class="check off" :title="r.reason ?? ''"><span class="kind">{{ r.label }}</span><span class="count">{{ r.reason ? 'unavailable' : 'running…' }}</span></span>
      </li>
    </ul>

    <h3>Board</h3>
    <p v-if="!s" class="muted">{{ board.features.stats?.available === false ? `Statistics unavailable: ${board.features.stats.reason}` : 'Statistics not exported yet.' }}</p>
    <template v-else>
      <dl>
        <template v-for="[k, v, detail] in rows" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}<small v-if="detail">{{ detail }}</small></dd>
        </template>
      </dl>
      <h3>Minimums <small>used / rule</small></h3>
      <dl>
        <template v-for="[k, used, rule] in mins" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ mm(used, 3) }}<small v-if="rule">rule {{ mm(rule, 3) }}</small></dd>
        </template>
      </dl>
      <details v-if="drillRows.length">
        <summary>Drills ({{ drillRows.length }} sizes)</summary>
        <table class="mono">
          <tr v-for="(d, i) in drillRows" :key="i">
            <td>{{ d.width === d.height ? `⌀ ${d.width}` : `${d.width} × ${d.height}` }}</td>
            <td>{{ d.plated ? 'PTH' : 'NPTH' }}</td><td>{{ d.source }}</td><td class="r">{{ d.count }}</td>
          </tr>
        </table>
      </details>
      <details v-if="stackRows.length">
        <summary>Stackup ({{ stackRows.length }} layers)</summary>
        <table class="mono">
          <tr v-for="(l, i) in stackRows" :key="i">
            <td>{{ l.name }}</td>
            <td>{{ l.material ?? (l.type === 'copper' ? 'Cu' : l.color ?? l.type) }}</td>
            <td class="r">{{ l.thickness !== null ? `${+(l.thickness * 1000).toFixed(1)} µm` : '' }}</td>
          </tr>
        </table>
      </details>
      <p class="src muted">{{ s.source === 'file+kicad-cli' ? 'from the board file and kicad-cli' : 'from the board file' }}</p>
    </template>
  </section>
</template>

<style scoped>
.board-info { padding: 4px 4px 12px; font-size: 12px; border-top: 1px solid var(--line); margin-top: 10px; }
h3 {
  margin: 12px 2px 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
}
h3 small { text-transform: none; letter-spacing: 0; font-weight: 400; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.check {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 4px 6px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2);
}
a.check:hover, a.check:focus-visible { border-color: var(--accent); outline: none; }
.check.off { opacity: 0.7; }
.kind { font-weight: 600; min-width: 2.6em; }
.count { color: var(--muted); }
.count.error { color: var(--error); }
.count.warning { color: var(--warning); }
.count.ok { color: var(--ok); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; padding: 0 2px; }
dt { color: var(--muted); white-space: nowrap; }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
dd small { display: block; color: var(--muted); font-size: 11px; }
details { margin: 8px 2px 0; }
summary { cursor: pointer; color: var(--muted); }
table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 11px; }
td { padding: 1px 4px 1px 0; white-space: nowrap; }
td.r { text-align: right; }
.muted { color: var(--muted); }
.src { margin: 10px 2px 0; font-size: 11px; }
</style>
