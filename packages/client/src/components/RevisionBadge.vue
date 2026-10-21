<script setup lang="ts">
// The board's revision: label (VERSION, tag, title-block rev or hash), the git
// commit with a mark when the project dir has uncommitted changes, and, when a
// revision diff was built (config revision.diff), a link to the changes page.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { diffRoute } from '../routes'
import type { BoardDiff, BoardRevision } from '../types'

const props = defineProps<{ rev: BoardRevision; name: string; diff?: BoardDiff | null; variant?: 'card' | 'bar' }>()

const details = computed(() => {
  const r = props.rev
  const g = r.git
  return [
    r.version && `version ${r.version}`,
    g?.tag && `tag ${g.tag}`,
    g?.describe && g.describe !== g.tag && `describe ${g.describe}`,
    r.titleBlock && `title block rev ${r.titleBlock}`,
    g && `commit ${g.short} (${g.date.slice(0, 10)})${g.subject ? `: ${g.subject}` : ''}`,
    g?.dirty && 'uncommitted changes in the project',
    `board file hash ${r.hash}`,
  ].filter(Boolean).join('\n')
})
const changes = computed(() => {
  const d = props.diff
  if (!d || !d.base) return null
  const since = d.base.tag ?? d.base.short
  return { since, summary: d.summary, title: `Changes since ${since} (${d.ref}): ${d.summary}` }
})
</script>

<template>
  <span class="revb" :class="`revb-${variant ?? 'bar'}`">
    <span class="label mono" :title="details" tabindex="0">rev {{ rev.label }}</span>
    <span v-if="rev.git" class="commit mono" :title="details">
      {{ rev.git.short }}<span v-if="rev.git.dirty" class="dirty" title="uncommitted changes in the project" aria-label="modified">●</span>
    </span>
    <RouterLink v-if="changes" class="changes" :to="diffRoute(name)" :title="changes.title" @click.stop>
      Δ {{ changes.since }}<span class="summary">: {{ changes.summary }}</span>
    </RouterLink>
  </span>
</template>

<style scoped>
.revb { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; color: var(--muted); }
.commit { opacity: 0.85; }
.dirty { color: #e7c169; margin-left: 2px; font-size: 9px; vertical-align: 1px; }
.changes { color: var(--accent); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.changes:hover { text-decoration: underline; }
.revb-card { font-size: 12px; }
.revb-card .summary { display: none; }
@media (max-width: 820px) {
  .revb-bar .commit, .revb-bar .summary { display: none; }
}
</style>
