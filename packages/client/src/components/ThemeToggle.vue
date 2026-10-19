<script setup lang="ts">
// [P2-d] Theme toggle: cycles auto -> light -> dark. The config's theme.appearance is
// the default; the choice is remembered per browser (site.ts).
import { computed } from 'vue'
import { setThemePref, theme, type ThemePref } from '../site'

const ORDER: ThemePref[] = ['auto', 'light', 'dark']
const next = computed(() => ORDER[(ORDER.indexOf(theme.pref) + 1) % ORDER.length]!)
const title = computed(() => `Theme: ${theme.pref}${theme.pref === 'auto' ? ` (${theme.resolved})` : ''}; click for ${next.value}`)
</script>

<template>
  <button class="icon-btn theme-toggle" type="button" :title="title" :aria-label="title" @click="setThemePref(next)">
    <svg v-if="theme.pref === 'auto'" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </svg>
    <svg v-else-if="theme.pref === 'light'" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </g>
    </svg>
    <svg v-else viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor" />
    </svg>
  </button>
</template>
