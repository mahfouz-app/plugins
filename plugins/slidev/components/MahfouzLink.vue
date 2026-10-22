<!--
  A wikilink to a note that's part of the presented deck (wikilinks.js
  writes `<MahfouzLink :part="k">`): a link to that part's first slide. The
  slide is found at runtime, from the slides' `mahfouzPart` (each part's
  importer slide in the stub spreads it to every slide of that note), because
  Slidev caches a transformed slide and slide numbers shift as slides are
  added. With no such slide (a hidden part, a part left out of the deck), and
  in print, it's the label alone.
-->
<script setup>
import { computed } from 'vue'
import { useNav } from '@slidev/client'

const props = defineProps({ part: { type: Number, required: true } })
const { slides, isPrintMode } = useNav()
const target = computed(() => slides.value.find((s) => s.meta?.slide?.frontmatter?.mahfouzPart === props.part)?.no ?? null)
</script>

<template>
  <RouterLink v-if="target !== null && !isPrintMode" :to="String(target)" class="mahfouz-link" @click="$event.target?.blur?.()">
    <slot />
  </RouterLink>
  <slot v-else />
</template>
