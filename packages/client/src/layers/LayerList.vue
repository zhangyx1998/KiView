<script setup lang="ts">
// The layer panel: groups (in physical order from the viewer), each layer with a
// visibility toggle, colour swatch, name, load state and a solo button.
import type { BoardLayer } from '../types'
import { EDGE_ID, type LayerGroup } from './model'
import { layerState } from './svgCache'
import { readableLayerColor } from './colors'   // [P2-d]
import { theme } from '../site'

const props = defineProps<{
  groups: LayerGroup[]
  drawn: ReadonlySet<string>
  edgeLocked: boolean
  soloId: string | null
}>()
const emit = defineEmits<{
  toggle: [id: string]
  solo: [id: string]
  group: [ids: string[], on: boolean]
  retry: [layer: BoardLayer]
}>()

function groupState(g: LayerGroup): 'on' | 'off' | 'mixed' {
  const n = g.layers.filter(l => props.drawn.has(l.id)).length
  return n === 0 ? 'off' : n === g.layers.length ? 'on' : 'mixed'
}
const locked = (l: BoardLayer) => l.id === EDGE_ID && props.edgeLocked
function status(l: BoardLayer): 'loading' | 'error' | null {
  if (!props.drawn.has(l.id)) return null
  const s = layerState(l.url)
  return s?.state === 'loading' ? 'loading' : s?.state === 'error' ? 'error' : null
}
function errorText(l: BoardLayer): string {
  const s = layerState(l.url)
  return s?.state === 'error' ? `Failed to load (${s.message}); click to retry` : ''
}
</script>

<template>
  <div class="list">
    <p v-if="!groups.length" class="empty">This board has no layer drawings.</p>
    <section v-for="g in groups" :key="g.id" class="group">
      <label class="ghead" :title="`Show or hide all ${g.label.toLowerCase()} layers`">
        <input type="checkbox" :checked="groupState(g) === 'on'" :indeterminate="groupState(g) === 'mixed'"
               @change="emit('group', g.layers.map(l => l.id), groupState(g) !== 'on')" />
        <span>{{ g.label }}</span>
      </label>
      <ul>
        <li v-for="l in g.layers" :key="l.id" :class="{ off: !drawn.has(l.id), solo: soloId === l.id }">
          <label :title="locked(l) ? 'The board edge is always shown with other layers' : `${l.id} · ${l.kind}`">
            <input type="checkbox" :checked="drawn.has(l.id)" :disabled="locked(l)" @change="emit('toggle', l.id)" />
            <span class="swatch" :style="{ background: readableLayerColor(l.color, theme.resolved) }"></span>
            <span class="name">{{ l.name }}</span>
          </label>
          <span v-if="status(l) === 'loading'" class="mark spin" title="Loading"></span>
          <button v-else-if="status(l) === 'error'" class="mark err" :title="errorText(l)" @click="emit('retry', l)">!</button>
          <button class="solo-btn" :aria-pressed="soloId === l.id"
                  :title="soloId === l.id ? 'Restore the previous layers' : `Show only ${l.name}`"
                  @click="emit('solo', l.id)">S</button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.list { font-size: 12px; padding: 4px 0 8px; }
.empty { color: var(--muted); padding: 8px 10px; margin: 0; }
.group + .group { border-top: 1px solid var(--line); margin-top: 4px; padding-top: 2px; }
.ghead {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px 2px;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); cursor: pointer;
}
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: center; padding: 0 4px 0 8px; gap: 4px; }
li:hover { background: var(--panel-2); }
li.off .name { color: var(--muted); }
li.off .swatch { opacity: 0.35; }
li.solo { background: var(--current-bg); }
li > label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
input { margin: 0; }
.swatch { flex: 0 0 10px; height: 10px; border-radius: 2px; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mark { flex: 0 0 auto; }
.spin {
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.err {
  width: 16px; height: 16px; padding: 0; line-height: 14px; font-size: 11px; font-weight: 700;
  background: #5a1d1d; border-color: #a33; color: #ffb3b3; border-radius: 50%;
}
.solo-btn {
  flex: 0 0 auto; padding: 0 5px; font-size: 10px; line-height: 16px; color: var(--muted);
  visibility: hidden;
}
li:hover .solo-btn, .solo-btn[aria-pressed='true'], .solo-btn:focus-visible { visibility: visible; }
@media (hover: none) { .solo-btn { visibility: visible; } }
</style>
