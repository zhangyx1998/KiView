<script setup lang="ts">
// [assembly] Assembly mode: a hand-assembly checklist built from the BOM groups. One
// step per BOM line and side (model.ts), in a default order (side as configured, SMD
// before THT, low before tall, package). Choosing a step selects its parts in the
// cross-probe store (so the 3D view, schematic and BOM follow) and, through view.ts,
// turns the Layers pane to the step's side and marks each part's pin 1 / cathode / + pad.
// Placed parts are ticked per refdes or per step and kept in localStorage per board,
// revision and variant; a JSON file moves a session between devices. DNP parts are only
// listed to leave empty. Board notes (ASSEMBLY.md, config) are shown on top; a print
// stylesheet turns the list into a paper checklist.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Board, Footprint } from '../types'
import { useBom, useNetlist, useParts } from '../crossprobe/data'
import { padPath } from '../crossprobe/layers'
import { probe, select } from '../crossprobe/store'
import { renderMarkdown } from './markdown.ts'
import { buildPlan, type Side, type Step } from './model.ts'
import { mirrored } from './polarity.ts'
import { exportProgress, loadProgress, parseProgress, progressKey, saveProgress } from './progress.ts'
import { asmView, clearAsmView, showSide, type AsmMark } from './view.ts'

const props = defineProps<{ board: Board }>()

// ---- data ------------------------------------------------------------------------------
const { data: bom, loading: bomLoading } = useBom(() => (props.board.features.bom?.available ? props.board.bom : null))
const { data: parts, loading: partsLoading, error: partsError } = useParts(() => (props.board.features.crossProbe?.available ? props.board.parts : null))
const { data: netlist } = useNetlist(() => (props.board.features.netlist?.available ? props.board.netlist : null))
const asm = computed(() => props.board.assembly ?? null)
/** Shown (mounted and not hidden with its pane): owns the keys, the selection, the marks, the print view. */
const active = ref(false)

// ---- variant (remembered per board) ------------------------------------------------------
const variantKey = () => `kiview.assembly-variant:${props.board.name}`
function storedVariant(): string | null {
  try { return localStorage.getItem(variantKey()) } catch { return null }
}
const variant = ref<string | null>(null)
watch(() => [props.board.name, asm.value?.variants.map(v => v.id).join()] as const, () => {
  const v = storedVariant()
  variant.value = asm.value?.variants.some(x => x.id === v) ? v : null
}, { immediate: true })
watch(variant, v => { try { if (v) localStorage.setItem(variantKey(), v); else localStorage.removeItem(variantKey()) } catch { /* ignore */ } })
const variantInfo = computed(() => asm.value?.variants.find(v => v.id === variant.value) ?? null)

const ready = computed(() => !!parts.value && !bomLoading.value)
const plan = computed(() => (ready.value
  ? buildPlan({ rows: bom.value?.rows ?? null, footprints: parts.value!.footprints, netlist: netlist.value, assembly: asm.value, variant: variant.value })
  : null))
const steps = computed<Step[]>(() => plan.value?.steps ?? [])
const allRefs = computed(() => new Set(steps.value.flatMap(s => s.refs)))
const fpByRef = computed(() => new Map((parts.value?.footprints ?? []).map(f => [f.ref, f] as const)))

// ---- progress ---------------------------------------------------------------------------
const key = computed(() => progressKey(props.board.name, props.board.rev.label, variant.value))
const placed = shallowRef(new Set<string>())
const currentId = ref<string | null>(null)
watch(key, k => {
  const s = loadProgress(k)
  placed.value = new Set(s.placed)
  currentId.value = s.current
}, { immediate: true })
const save = () => saveProgress(key.value, { placed: [...placed.value].filter(r => allRefs.value.has(r)).sort(), current: currentId.value })
watch([placed, currentId], save)

const placedCount = computed(() => steps.value.reduce((n, s) => n + s.refs.filter(r => placed.value.has(r)).length, 0))
const total = computed(() => plan.value?.total ?? 0)
const pct = computed(() => (total.value ? Math.round((placedCount.value / total.value) * 100) : 0))
const stepsDone = computed(() => steps.value.filter(s => s.refs.every(r => placed.value.has(r))).length)

const isPlaced = (ref: string) => placed.value.has(ref)
const stepState = (s: Step) => {
  const n = s.refs.filter(r => placed.value.has(r)).length
  return n === 0 ? 'todo' : n === s.refs.length ? 'done' : 'partial'
}
function setPlaced(refs: readonly string[], on: boolean): void {
  const next = new Set(placed.value)
  for (const r of refs) { if (on) next.add(r); else next.delete(r) }
  placed.value = next
}
const toggleRef = (ref: string) => setPlaced([ref], !placed.value.has(ref))
function toggleStep(s: Step): boolean {
  const on = stepState(s) !== 'done'
  setPlaced(s.refs, on)
  return on
}
function reset(): void {
  if (!placedCount.value && !currentId.value) return
  const what = variantInfo.value ? `${props.board.title} ${props.board.rev.label} (${variantInfo.value.label})` : `${props.board.title} ${props.board.rev.label}`
  if (!window.confirm(`Clear all ${placedCount.value} placed marks of ${what}?`)) return
  placed.value = new Set()
  currentId.value = steps.value[0]?.id ?? null
}

// ---- current step, highlighting -----------------------------------------------------------
const index = computed(() => {
  const i = steps.value.findIndex(s => s.id === currentId.value)
  return i >= 0 ? i : steps.value.length ? 0 : -1
})
const current = computed<Step | null>(() => steps.value[index.value] ?? null)
const showEmpty = ref(false)

function highlight(): void {
  if (showEmpty.value) {
    select(props.board.name, null, 'assembly')
    const sides = new Set((plan.value?.empty ?? []).map(e => e.side).filter(Boolean))
    if (sides.size === 1) showSide(props.board.name, [...sides][0] as Side)
    return
  }
  const s = current.value
  if (!s) return
  select(props.board.name, s.refs, 'assembly')
  if (s.side) showSide(props.board.name, s.side)
}
function go(i: number): void {
  const s = steps.value[Math.max(0, Math.min(steps.value.length - 1, i))]
  if (!s) return
  showEmpty.value = false
  currentId.value = s.id
}
const next = () => go(index.value + 1)
const prev = () => go(index.value - 1)
/** The next step that is not done (wrapping), else the next one. */
function nextOpen(): void {
  const n = steps.value.length
  for (let d = 1; d <= n; d++) {
    const s = steps.value[(index.value + d) % n]!
    if (stepState(s) !== 'done') { go((index.value + d) % n); return }
  }
}
watch([() => current.value?.id, showEmpty, active], () => { if (active.value) highlight() })

// a part picked in another view (2D tap, BOM, schematic, 3D): go to its step
watch(() => probe.seq, () => {
  if (probe.board !== props.board.name || probe.source === 'assembly' || probe.refs.length !== 1) return
  const r = probe.refs[0]!
  if (current.value?.refs.includes(r)) return
  const i = steps.value.findIndex(s => s.refs.includes(r))
  if (i >= 0) { currentId.value = steps.value[i]!.id; showEmpty.value = false; void reveal() }
})

const list = ref<HTMLElement | null>(null)
async function reveal(): Promise<void> {
  await nextTick()
  list.value?.querySelector('.step.current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
watch(() => current.value?.id, () => void reveal())

// ---- marks in the Layers pane (view.ts) ----------------------------------------------------
const marks = computed<AsmMark[]>(() => {
  const s = current.value
  if (!s || showEmpty.value) return []
  return s.parts.map(p => {
    const fp = p.footprint
    const pad = p.polarity && fp ? fp.pads.find(x => x.number === p.polarity!.pad) ?? null : null
    return {
      ref: p.ref, x: p.polarity?.at.x ?? 0, y: p.polarity?.at.y ?? 0, pad: p.polarity?.pad ?? null, kind: p.polarity?.kind ?? '',
      padD: pad ? padPath(pad) : null, box: fp?.bbox ?? { x: 0, y: 0, width: 0, height: 0 }, placed: placed.value.has(p.ref),
    }
  }).filter(m => m.box.width > 0)
})
const emptyMarks = computed(() => (showEmpty.value ? (plan.value?.empty ?? []).map(e => fpByRef.value.get(e.ref)).filter((f): f is Footprint => !!f) : []))
const legendText = (k: string) => (k === 'cathode' ? 'cathode' : k === 'plus' ? '+ pad' : 'pin 1')
watch([active, marks, emptyMarks, current, showEmpty, () => props.board.name], (_n, old) => {
  const prevBoard = old?.[5]
  if (prevBoard && prevBoard !== props.board.name) clearAsmView(prevBoard)
  if (!active.value) { clearAsmView(props.board.name); return }
  asmView.board = props.board.name
  asmView.marks = marks.value
  asmView.empty = emptyMarks.value
  const s = current.value
  asmView.caption = showEmpty.value
    ? { step: '', text: `Leave empty: ${(plan.value?.empty ?? []).map(e => e.ref).join(', ')}`, legend: null, empty: true }
    : s ? { step: `${index.value + 1}/${steps.value.length}`, text: `${s.value} · ${sideLabel(s.side)}`, legend: s.polarity ? legendText(s.polarity.kind) : null, empty: false }
      : null
}, { immediate: true })

// ---- notes ---------------------------------------------------------------------------------
const notes = computed(() => (asm.value?.notes ?? []).map(n => ({ source: n.source, html: renderMarkdown(n.markdown) })))
const variantNote = computed(() => (variantInfo.value?.note ? renderMarkdown(variantInfo.value.note) : ''))
const sideLabel = (s: Side | null) => (s === 'front' ? 'Top' : s === 'back' ? 'Bottom' : '—')
const mountLabel = { smd: 'SMD', tht: 'THT', other: 'other' } as const
const shortFp = (f: string) => f.slice(f.indexOf(':') + 1)
function polarityText(s: Step): string {
  if (!s.polarity) return ''
  // bottom parts: the board is turned over, so on the bench (and in the mirrored view) east and west swap
  if (!s.mixedDirections) return s.polarity.label + (s.side === 'back' && s.polarity.dir && /[EW]/.test(s.polarity.dir) ? ` (${mirrored(s.polarity.dir)} seen from the bottom)` : '')
  return `${s.polarity.kind === 'cathode' ? 'Cathode' : s.polarity.kind === 'plus' ? '+' : 'Pin 1'}: direction differs per part (see the marks)`
}
const polarityTitle = (s: Step) => (s.polarity?.source === 'pad-1'
  ? 'Pad 1 by KiCad footprint convention. Directions are board directions as in KiCad (top view, north up); for bottom parts the direction seen from the bottom is added.'
  : 'From the symbol pin. Directions are board directions as in KiCad (top view, north up); for bottom parts the direction seen from the bottom is added.')

// ---- export / import -------------------------------------------------------------------------
const message = ref<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null)
let msgTimer: ReturnType<typeof setTimeout> | null = null
function say(text: string, kind: 'ok' | 'warn' | 'error'): void {
  message.value = { text, kind }
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => { message.value = null }, kind === 'ok' ? 3000 : 8000)
}
function download(): void {
  const f = exportProgress({ board: props.board.name, rev: props.board.rev.label, variant: variant.value, placed: [...placed.value].filter(r => allRefs.value.has(r)), current: currentId.value })
  const blob = new Blob([JSON.stringify(f, null, 2) + '\n'], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${props.board.name}-${props.board.rev.label}${variant.value ? `-${variant.value}` : ''}-assembly.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
const fileInput = ref<HTMLInputElement | null>(null)
async function upload(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const text = await file.text()
  // the variant first, so the refs are checked against that variant's steps
  try {
    const v = (JSON.parse(text) as { variant?: unknown }).variant
    if (typeof v === 'string' && asm.value?.variants.some(x => x.id === v)) variant.value = v
    else if (v === null) variant.value = null
  } catch { /* parseProgress reports it */ }
  await nextTick()
  const r = parseProgress(text, props.board.name, props.board.rev.label, allRefs.value)
  if (!r.ok) { say(`Import failed: ${r.error}.`, 'error'); return }
  placed.value = new Set(r.file.placed)
  if (r.file.current && steps.value.some(s => s.id === r.file.current)) currentId.value = r.file.current
  say(`Imported ${r.file.placed.length} placed part${r.file.placed.length === 1 ? '' : 's'}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}.`, r.warnings.length ? 'warn' : 'ok')
}
const printNow = () => window.print()
const printDate = new Date().toISOString().slice(0, 10)

// ---- keyboard, layout ------------------------------------------------------------------
function onKey(e: KeyboardEvent): void {
  if (!active.value || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const t = e.target as HTMLElement | null
  // a control reached by keyboard keeps its own keys; one just clicked (no focus ring) does not
  const ownKeys = !!t && t.matches(':focus-visible')
  if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox'))) return
  const k = e.key
  if (k === 'j' || k === 'J' || k === 'ArrowDown') next()
  else if (k === 'k' || k === 'K' || k === 'ArrowUp') prev()
  else if (k === ' ' || k === 'Spacebar') {
    if (ownKeys && t && /^(BUTTON|A|INPUT)$/.test(t.tagName)) return
    if (t && t !== document.body) t.blur()   // no stray click on the control the mouse left focused
    if (current.value && toggleStep(current.value)) nextOpen()
  } else return
  e.preventDefault()
}
const root = ref<HTMLElement | null>(null)
const width = ref(0)
const narrow = computed(() => width.value > 0 && width.value < 700)
let ro: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // a closed pane is hidden, not unmounted: zero width means not shown
  ro = new ResizeObserver(es => { width.value = es[0]!.contentRect.width; active.value = width.value > 0 })
  if (root.value) ro.observe(root.value)
})
onBeforeUnmount(() => { active.value = false; clearAsmView(props.board.name); window.removeEventListener('keydown', onKey); ro?.disconnect(); if (msgTimer) clearTimeout(msgTimer) })
watch(plan, () => { if (active.value) highlight() })
</script>

<template>
  <div ref="root" class="asm" :class="{ narrow }">
    <section ref="list" class="list" aria-label="Assembly steps">
      <header class="head">
        <div class="progress" role="progressbar" :aria-valuenow="placedCount" aria-valuemin="0" :aria-valuemax="total"
             :aria-label="`${placedCount} of ${total} parts placed`">
          <div class="bar"><span :style="{ width: `${pct}%` }"></span></div>
          <span class="count"><b>{{ placedCount }}</b> / {{ total }} placed · {{ stepsDone }} / {{ steps.length }} steps</span>
        </div>
        <div class="controls">
          <button class="big" :disabled="index <= 0" title="Previous step (K or ↑)" @click="prev">◀ Prev</button>
          <button class="big primary" :disabled="!current" title="Mark the step placed and go to the next open one (Space)"
                  @click="current && toggleStep(current) && nextOpen()">{{ current && stepState(current) === 'done' ? 'Undo step' : 'Placed ✓' }}</button>
          <button class="big" :disabled="index >= steps.length - 1" title="Next step (J or ↓)" @click="next">Next ▶</button>
        </div>
      </header>
      <div class="tools">
        <label v-if="asm?.variants.length" class="variant">Variant
          <select v-model="variant" aria-label="Build variant">
            <option :value="null">As designed</option>
            <option v-for="v in asm.variants" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select>
        </label>
        <span class="spacer"></span>
        <button title="Download the progress as a JSON file" @click="download">Export</button>
        <button title="Load progress from a JSON file" @click="fileInput?.click()">Import</button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="upload" />
        <button title="Print the checklist" @click="printNow">Print</button>
        <button class="danger" title="Clear every placed mark of this board" @click="reset">Reset</button>
      </div>
      <p v-if="message" class="message" :class="message.kind" role="status">{{ message.text }}</p>

      <div v-if="variantNote" class="variant-note" v-html="variantNote"></div>
      <details v-if="notes.length" class="notes" open>
        <summary>Assembly notes</summary>
        <div v-for="n in notes" :key="n.source" class="note-block">
          <div class="md" v-html="n.html"></div>
          <p class="source">{{ n.source === 'config' ? 'from the site config' : n.source }}</p>
        </div>
      </details>

      <p v-if="partsError" class="pad err">The part data could not be loaded: {{ partsError }}</p>
      <p v-else-if="!ready" class="pad muted">{{ partsLoading || bomLoading ? 'Loading parts…' : 'This board has no part data.' }}</p>
      <p v-else-if="!steps.length" class="pad muted">Nothing to place.</p>

      <ol v-else class="steps">
        <li v-for="(s, i) in steps" :key="s.id" class="step" :class="[stepState(s), { current: i === index && !showEmpty }]">
          <div class="step-head" role="button" tabindex="0" :aria-current="i === index ? 'step' : undefined"
               @click="go(i)" @keydown.enter.prevent="go(i)">
            <input type="checkbox" class="check" :checked="stepState(s) === 'done'" :indeterminate="stepState(s) === 'partial'"
                   :aria-label="`All of ${s.value} placed`" @click.stop @change="toggleStep(s)" />
            <span class="num mono">{{ i + 1 }}</span>
            <span class="what">
              <span class="value">{{ s.value }}</span>
              <span class="pkg">{{ s.pkg }}</span>
            </span>
            <span class="side" :class="s.side ?? 'none'">{{ sideLabel(s.side) }}</span>
            <span class="qty mono">{{ s.refs.filter(isPlaced).length }}/{{ s.refs.length }}</span>
          </div>
          <div v-if="i === index && !showEmpty" class="detail">
            <dl>
              <div><dt>Footprint</dt><dd class="mono" :title="s.footprint">{{ shortFp(s.footprint) }}</dd></div>
              <div v-if="s.mpn"><dt>MPN</dt><dd class="mono">{{ s.mpn }}<template v-if="s.manufacturer"> · {{ s.manufacturer }}</template></dd></div>
              <div><dt>Mount</dt><dd>{{ mountLabel[s.mount] }} · {{ sideLabel(s.side) }} side · qty {{ s.refs.length }}</dd></div>
              <div v-if="s.designValue"><dt>Designed</dt><dd>{{ s.designValue }}</dd></div>
              <div v-if="s.description"><dt>Part</dt><dd>{{ s.description }}<a v-if="s.datasheet" :href="s.datasheet" target="_blank" rel="noopener noreferrer" class="ds"> datasheet ↗</a></dd></div>
            </dl>
            <p v-if="s.polarity" class="polarity" :title="polarityTitle(s)"><span class="dot"></span>{{ polarityText(s) }}</p>
            <div class="chips" role="group" :aria-label="`Parts of step ${i + 1}`">
              <button v-for="p in s.parts" :key="p.ref" class="chip" :class="{ on: isPlaced(p.ref) }" :aria-pressed="isPlaced(p.ref)"
                      :title="`${isPlaced(p.ref) ? 'Unmark' : 'Mark'} ${p.ref} placed`" @click="toggleRef(p.ref)">
                <span class="tick" aria-hidden="true">{{ isPlaced(p.ref) ? '✓' : '' }}</span>{{ p.ref }}<small v-if="s.mixedDirections && p.polarity?.dir" class="dir">{{ p.polarity.dir }}</small>
              </button>
            </div>
            <ul v-if="s.parts.some(p => p.notes.length)" class="part-notes">
              <li v-for="p in s.parts.filter(p => p.notes.length)" :key="p.ref"><b class="mono">{{ p.ref }}</b> {{ p.notes.join(' · ') }}</li>
            </ul>
          </div>
          <div v-else class="refs-line mono">{{ s.refs.join(' ') }}</div>
        </li>
      </ol>

      <section v-if="plan && plan.empty.length" class="leave-empty" :class="{ on: showEmpty }">
        <header>
          <h3>Leave empty <span class="muted">({{ plan.empty.length }})</span></h3>
          <button :aria-pressed="showEmpty" @click="showEmpty = !showEmpty">{{ showEmpty ? 'Back to the step' : 'Show on board' }}</button>
        </header>
        <ul>
          <li v-for="e in plan.empty" :key="e.ref">
            <b class="mono">{{ e.ref }}</b> <span>{{ e.value }}</span> <span class="muted">{{ shortFp(e.footprint) }} · {{ sideLabel(e.side) }}</span>
            <span v-if="e.notes.length" class="enote">{{ e.notes.join(' · ') }}</span>
          </li>
        </ul>
      </section>
      <p class="keys muted">J / K or ↓ / ↑: next / previous step · Space: step placed, on to the next open one</p>
    </section>

    <!-- the paper checklist: only printed (the rest of the app is hidden for print) -->
    <Teleport v-if="active" to="body">
      <div class="asm-print">
        <h1>{{ board.title }} · assembly checklist</h1>
        <p class="meta">{{ board.name }} · rev {{ board.rev.label }}<template v-if="variantInfo"> · variant {{ variantInfo.label }}</template> · {{ total }} parts in {{ steps.length }} steps · printed {{ printDate }}</p>
        <div v-for="n in notes" :key="n.source" class="md" v-html="n.html"></div>
        <table>
          <thead><tr><th>#</th><th>Done</th><th>Side</th><th>Value</th><th>Package</th><th>MPN</th><th>Qty</th><th>Refs</th><th>Polarity</th><th>Notes</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in steps" :key="s.id">
              <td>{{ i + 1 }}</td>
              <td class="box">{{ stepState(s) === 'done' ? '☑' : '☐' }}</td>
              <td>{{ sideLabel(s.side) }} {{ mountLabel[s.mount] }}</td>
              <td><b>{{ s.value }}</b></td>
              <td>{{ s.pkg }}</td>
              <td>{{ s.mpn }}</td>
              <td>{{ s.refs.length }}</td>
              <td class="refs"><span v-for="r in s.refs" :key="r">{{ isPlaced(r) ? '☑' : '☐' }}&nbsp;{{ r }}</span></td>
              <td>{{ polarityText(s) }}</td>
              <td>{{ s.parts.filter(p => p.notes.length).map(p => `${p.ref}: ${p.notes.join('; ')}`).join(' · ') }}</td>
            </tr>
          </tbody>
        </table>
        <template v-if="plan && plan.empty.length">
          <h2>Leave empty</h2>
          <p><span v-for="e in plan.empty" :key="e.ref" class="empty-item"><b>{{ e.ref }}</b> {{ e.value }}<template v-if="e.notes.length"> ({{ e.notes.join('; ') }})</template></span></p>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.asm { width: 100%; height: 100%; display: flex; min-height: 0; background: var(--bg); }
.list { flex: 1 1 auto; min-width: 0; overflow: auto; background: var(--panel); font-size: 16px; }

.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--pin1); margin-right: 5px; vertical-align: -1px; box-shadow: 0 0 0 2px var(--pin1-ring); }

.head { position: sticky; top: 0; z-index: 2; padding: 10px 12px 8px; background: var(--panel); border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.progress { display: flex; flex-direction: column; gap: 4px; }
.bar { height: 10px; border-radius: 5px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--ok); transition: width 0.2s; }
.count { font-size: 14px; color: var(--muted); }
.count b { color: var(--text); font-size: 18px; }
.controls { display: grid; grid-template-columns: 1fr 1.4fr 1fr; gap: 8px; }
.big { min-height: 48px; font-size: 17px; font-weight: 600; }
.big.primary { background: var(--pressed-bg); border-color: var(--pressed-line); }
button:disabled { opacity: 0.45; cursor: default; }
.tools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 8px 12px 0; }
.tools button { min-height: 36px; font-size: 14px; }
.tools .danger { color: var(--error); }
.spacer { flex: 1; }
.variant { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--muted); }
.variant select { font: inherit; font-size: 15px; min-height: 36px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 2px 6px; }
.message { margin: 6px 12px 0; font-size: 14px; }
.message.ok { color: var(--ok); }
.message.warn { color: var(--warning); }
.message.error { color: var(--error); }

.variant-note { margin: 10px 12px 0; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--panel-2); font-size: 15px; }
.variant-note :deep(p) { margin: 0; }
.notes { margin: 10px 12px 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
.notes summary { padding: 8px 10px; font-weight: 600; cursor: pointer; font-size: 15px; }
.note-block { padding: 0 12px 6px; border-top: 1px solid var(--line); }
.source { margin: 4px 0 6px; font-size: 12px; color: var(--muted); }
.md { font-size: 15px; line-height: 1.5; }
.md :deep(h3), .md :deep(h4), .md :deep(h5) { margin: 10px 0 4px; font-size: 16px; }
.md :deep(p) { margin: 6px 0; }
.md :deep(ul), .md :deep(ol) { margin: 6px 0; padding-left: 22px; }
.md :deep(code) { font-size: 13px; }
.md :deep(a) { color: var(--accent); text-decoration: underline; }
.md :deep(blockquote) { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--line-strong); color: var(--muted); }

.pad { padding: 14px; margin: 0; }
.muted { color: var(--muted); }
.err { color: var(--error); }

.steps { list-style: none; margin: 8px 0 0; padding: 0 8px; }
.step { border: 1px solid var(--line); border-radius: var(--radius); margin: 0 0 6px; background: var(--bg); scroll-margin-top: 140px; }
.step.done { opacity: 0.62; }
.step.current { opacity: 1; border-color: var(--select); box-shadow: 0 0 0 1px var(--select); background: var(--panel); }
.step-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; min-height: 52px; cursor: pointer; }
.step-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.check { width: 26px; height: 26px; flex: 0 0 auto; accent-color: var(--ok); cursor: pointer; margin: 0; }
.num { flex: 0 0 auto; min-width: 24px; color: var(--muted); font-size: 14px; text-align: right; }
.what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.value { font-size: 18px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.current .value { font-size: 22px; }
.pkg { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side { flex: 0 0 auto; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; border: 1px solid var(--line); }
.side.front { color: var(--accent); border-color: var(--accent); }
.side.back { color: var(--side-tag); border-color: var(--side-tag); background: var(--pressed-bg); }
.qty { flex: 0 0 auto; font-size: 15px; color: var(--muted); }
.done .qty { color: var(--ok); }
.refs-line { padding: 0 10px 8px 72px; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.detail { padding: 0 12px 12px; }
dl { margin: 0 0 8px; display: grid; gap: 2px; font-size: 15px; }
dl > div { display: flex; gap: 8px; }
dt { flex: 0 0 86px; color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
dd.mono { font-size: 14px; }
.ds { color: var(--accent); white-space: nowrap; }
.polarity { margin: 0 0 10px; padding: 8px 10px; border-radius: var(--radius); background: var(--panel-2); font-size: 17px; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  min-width: 76px; min-height: 48px; padding: 4px 12px; font-family: var(--mono); font-size: 18px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; background: var(--chip-bg); border: 2px solid var(--chip-line);
}
.chip .tick { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 4px; border: 2px solid var(--line-strong); font-size: 15px; line-height: 1; }
.chip.on { background: var(--ok-bg); border-color: var(--ok); }
.chip.on .tick { background: var(--ok); border-color: var(--ok); color: var(--ok-ink); }
.chip .dir { font-size: 12px; color: var(--muted); font-weight: 400; }
.part-notes { margin: 10px 0 0; padding: 8px 10px 8px 26px; border-radius: var(--radius); background: var(--note-bg); font-size: 15px; }
.part-notes li { margin: 2px 0; }

.leave-empty { margin: 12px 8px 0; border: 1px dashed var(--error); border-radius: var(--radius); padding: 8px 10px; }
.leave-empty.on { background: var(--panel-2); }
.leave-empty header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.leave-empty h3 { margin: 0; font-size: 16px; color: var(--error); }
.leave-empty button { min-height: 40px; font-size: 14px; }
.leave-empty ul { list-style: none; margin: 6px 0 0; padding: 0; font-size: 15px; }
.leave-empty li { padding: 4px 0; border-top: 1px solid var(--row-line); }
.enote { display: block; font-size: 14px; color: var(--muted); }
.keys { font-size: 13px; padding: 10px 12px 16px; margin: 0; }
@media (hover: none) { .keys { display: none; } }
</style>

<style>
/* [assembly] the paper checklist (teleported to <body>): hidden on screen; printing
   hides the app and prints only the list. Global on purpose (outside the app root). */
.asm-print { display: none; }
@media print {
  body:has(> .asm-print) > #app { display: none !important; }
  body:has(> .asm-print) { background: #fff; color: #000; }
  .asm-print { display: block; font: 11pt/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; }
  .asm-print h1 { font-size: 16pt; margin: 0 0 2pt; }
  .asm-print h2 { font-size: 13pt; margin: 12pt 0 4pt; }
  .asm-print .meta { margin: 0 0 8pt; color: #333; }
  .asm-print .md { font-size: 10pt; margin: 0 0 6pt; }
  .asm-print .md a { color: #000; }
  .asm-print table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .asm-print th, .asm-print td { border: 0.6pt solid #666; padding: 3pt 4pt; text-align: left; vertical-align: top; }
  .asm-print th { background: #eee; }
  .asm-print tr { break-inside: avoid; }
  .asm-print .box { font-size: 14pt; text-align: center; }
  .asm-print .refs span { display: inline-block; margin-right: 9pt; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .asm-print .empty-item { margin-right: 14pt; white-space: nowrap; }
  @page { margin: 12mm; }
}
</style>
