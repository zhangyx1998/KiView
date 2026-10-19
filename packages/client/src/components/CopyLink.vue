<script setup lang="ts">
// [P2-d] Copy a link to exactly this view (board, pane, layers, 2D view, 3D camera,
// highlighted net; see deepLink.ts). The URL is kept up to date as the view changes,
// so this writes any pending update and copies the address.
import { ref } from 'vue'
import { flushLink } from '../linkState'

const state = ref<'idle' | 'copied' | 'failed'>('idle')
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  flushLink()
  await new Promise(r => setTimeout(r, 30))   // let the router write the URL
  const url = location.href
  try {
    await navigator.clipboard.writeText(url)
    state.value = 'copied'
  } catch {
    // no clipboard permission (http, old browser): let the user copy it
    window.prompt('Link to this view:', url)
    state.value = 'failed'
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { state.value = 'idle' }, 1600)
}
</script>

<template>
  <button class="icon-btn copy-link" type="button" :title="state === 'copied' ? 'Link copied' : 'Copy a link to this view'"
          :aria-label="state === 'copied' ? 'Link copied' : 'Copy a link to this view'" @click="copy">
    <svg v-if="state !== 'copied'" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.6-2.6a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
        <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L2.9 9.4a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
      </g>
    </svg>
    <svg v-else viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</template>
