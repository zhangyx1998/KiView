<script setup lang="ts">
// [assembly] The assembly pane's marks (view.ts), drawn in board mm over the Layers
// pane's stack; `k` is px per mm, for marks of a fixed screen size.
import { asmView } from './view.ts'

defineProps<{ k: number }>()
</script>

<template>
  <g class="asm-marks">
    <g v-for="m in asmView.marks" :key="m.ref">
      <rect v-if="m.placed" class="placed" :x="m.box.x - 0.2" :y="m.box.y - 0.2" :width="m.box.width + 0.4" :height="m.box.height + 0.4" rx="0.2" />
      <template v-if="m.pad">
        <path v-if="m.padD" :d="m.padD" class="pin1-pad" />
        <circle :cx="m.x" :cy="m.y" :r="Math.max(0.25, 5 / k)" class="pin1-dot" />
      </template>
    </g>
    <g v-for="f in asmView.empty" :key="f.ref" class="empty">
      <rect :x="f.bbox.x - 0.2" :y="f.bbox.y - 0.2" :width="f.bbox.width + 0.4" :height="f.bbox.height + 0.4" />
      <path :d="`M${f.bbox.x} ${f.bbox.y}L${f.bbox.x + f.bbox.width} ${f.bbox.y + f.bbox.height}M${f.bbox.x + f.bbox.width} ${f.bbox.y}L${f.bbox.x} ${f.bbox.y + f.bbox.height}`" />
    </g>
  </g>
</template>

<style scoped>
.placed { fill: var(--ok); fill-opacity: 0.22; stroke: var(--ok); stroke-width: 2px; vector-effect: non-scaling-stroke; }
.pin1-pad { fill: var(--pin1); fill-opacity: 0.9; stroke: var(--pin1-ring); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
.pin1-dot { fill: var(--pin1); stroke: var(--pin1-ring); stroke-width: 2px; vector-effect: non-scaling-stroke; }
.empty rect { fill: var(--error); fill-opacity: 0.12; stroke: var(--error); stroke-width: 2px; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
.empty path { stroke: var(--error); stroke-width: 2px; vector-effect: non-scaling-stroke; }
</style>
