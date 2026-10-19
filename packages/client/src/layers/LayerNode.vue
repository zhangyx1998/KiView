<script setup lang="ts">
// One layer on the stage: a <g> that hosts the cached, parsed layer <svg>.
// The element is moved (not copied) into the group; if it is somehow still shown
// elsewhere, a clone is used so neither place loses it.
import { onMounted, ref, watch } from 'vue'

const props = defineProps<{ node: SVGSVGElement }>()
const host = ref<SVGGElement | null>(null)

function attach(): void {
  const g = host.value
  if (!g) return
  const n = props.node.isConnected && props.node.parentNode !== g ? (props.node.cloneNode(true) as SVGSVGElement) : props.node
  g.replaceChildren(n)
}
onMounted(attach)
watch(() => props.node, attach)
</script>

<template>
  <g ref="host"></g>
</template>
