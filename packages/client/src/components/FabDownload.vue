<script setup lang="ts">
// Link to a board's fabrication bundle (the zip to upload to a PCB fab), with a
// badge when the board file still lacks something an order needs, and a file list:
// per deliverable (generic bundle) what is inside, or why it was skipped / failed.
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { BoardDownload, FabItem } from '../types'
import { formatBytes } from '../format'

const props = defineProps<{ download: BoardDownload; variant?: 'card' | 'bar' }>()

const open = ref(false)
const toggle = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })
const base = (f: string) => f.slice(f.lastIndexOf('/') + 1)
/** Items of the generic bundle, or the plain file list of a custom one. */
const items = computed<FabItem[]>(() => props.download.items ?? [{
  id: 'gerbers', label: 'Files', required: false, status: 'ok', files: props.download.contents, reason: null,
}])
const mark = { ok: '✓', skipped: '–', failed: '✕' } as const

function onDoc(e: Event): void {
  const t = e.target as Node
  if (!panel.value?.contains(t) && !toggle.value?.contains(t)) close()
}
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') close() }
function close(): void {
  open.value = false
  document.removeEventListener('pointerdown', onDoc, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', close)
}
async function show(): Promise<void> {
  if (open.value) { close(); return }
  const r = toggle.value!.getBoundingClientRect()
  open.value = true
  pos.value = { top: r.bottom + 6, left: r.left }
  await nextTick()
  const w = panel.value?.offsetWidth ?? 320
  pos.value = { top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) }
  document.addEventListener('pointerdown', onDoc, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', close)
}
onBeforeUnmount(close)

const linkTitle = computed(() =>
  `Download ${props.download.filename}` +
  (props.download.contents.length ? `:\n${props.download.contents.map(f => `• ${f}`).join('\n')}` : ', ready to upload to a PCB fab'))
const badgeTitle = computed(() =>
  'Incomplete. Missing:\n' + props.download.missing.map(m => `• ${m}`).join('\n'))
</script>

<template>
  <span class="fab" :class="`fab-${variant ?? 'card'}`">
    <a class="link" :href="download.url" :download="download.filename" :title="linkTitle" @click.stop>
      <svg class="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v2.5h11V11" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="label">Fab files</span>
      <span class="size">· {{ formatBytes(download.bytes) }}</span>
    </a>
    <button ref="toggle" class="list-toggle" type="button" :aria-expanded="open" aria-haspopup="dialog"
            :title="`What is in ${download.filename}`" @click.stop="show">
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
      <span class="visually-hidden">File list</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="panel" class="fab-panel" role="dialog" :aria-label="`Contents of ${download.filename}`"
           :style="{ top: `${pos.top}px`, left: `${pos.left}px` }">
        <header>
          <a :href="download.url" :download="download.filename" class="mono">{{ download.filename }}</a>
          <span class="muted">{{ formatBytes(download.bytes) }}</span>
        </header>
        <p v-if="download.status === 'incomplete'" class="warn">Incomplete: {{ download.missing.join('; ') }}</p>
        <ul>
          <li v-for="it in items" :key="it.id" :class="`st-${it.status}`">
            <div class="row">
              <span class="st" :title="it.status">{{ mark[it.status] }}</span>
              <span class="lbl">{{ it.label }}</span>
              <span v-if="it.required" class="req" title="needed for a bare-board order">order</span>
            </div>
            <div v-if="it.reason" class="reason">{{ it.reason }}</div>
            <div v-for="f in it.files" :key="f" class="file mono" :title="f">{{ base(f) }}</div>
          </li>
        </ul>
      </div>
    </Teleport>
    <span v-if="download.status === 'incomplete'" class="badge" tabindex="0" role="note"
          :title="badgeTitle" :aria-label="badgeTitle"><span class="long">incomplete</span><span class="short">!</span></span>
  </span>
</template>

<style scoped>
.list-toggle { padding: 0 4px; line-height: 0; height: 18px; display: inline-flex; align-items: center; background: transparent; border-color: transparent; color: var(--muted); }
.list-toggle:hover, .list-toggle[aria-expanded='true'] { color: var(--text); border-color: var(--line); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.fab-panel {
  position: fixed;
  z-index: 100;
  width: min(360px, calc(100vw - 16px));
  max-height: min(70vh, 520px);
  overflow: auto;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  font-size: 12px;
  white-space: normal;
}
.fab-panel header { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.fab-panel header a { color: var(--accent); overflow: hidden; text-overflow: ellipsis; }
.fab-panel .muted { color: var(--muted); white-space: nowrap; }
.fab-panel .warn { margin: 0 0 6px; color: #e7c169; }
.fab-panel ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.fab-panel .row { display: flex; align-items: center; gap: 6px; }
.fab-panel .st { width: 12px; text-align: center; }
.fab-panel .st-ok .st { color: #6fcf8f; }
.fab-panel .st-skipped { color: var(--muted); }
.fab-panel .st-failed .st, .fab-panel .st-failed .reason { color: #ef7d6d; }
.fab-panel .req { font-size: 10px; padding: 0 5px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); }
.fab-panel .reason { margin-left: 18px; color: var(--muted); }
.fab-panel .file { margin-left: 18px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fab { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.link { display: inline-flex; align-items: center; gap: 5px; }
.icon { flex: 0 0 auto; }
.size { color: var(--muted); }
.badge {
  padding: 0 6px;
  border-radius: 9px;
  border: 1px solid #6b5521;
  background: #2e2513;
  color: #e7c169;
  font-size: 11px;
  line-height: 17px;
  cursor: help;
}
.badge .short { display: none; }

/* home page card footer (class names unlike the page's own: a child's root also gets the parent's scoped styles) */
.fab-card .link { color: var(--text); font-size: 12px; }
.fab-card .link:hover, .fab-card .link:focus-visible { color: var(--accent); outline: none; }
.fab-card .link:hover .size { color: inherit; }

/* top bar: styled like the toolbar buttons */
.fab-bar .link {
  padding: 3px 10px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.fab-bar .link:hover, .fab-bar .link:focus-visible { border-color: #3a414b; outline: none; }
@media (max-width: 820px) {
  .fab-bar .link { padding: 3px 7px; }
  .fab-bar .label, .fab-bar .size { display: none; }
  .fab-bar { gap: 4px; }
  .fab-bar .badge { padding: 0 6px; font-weight: 700; }
  .fab-bar .badge .long { display: none; }
  .fab-bar .badge .short { display: inline; }
}
</style>
