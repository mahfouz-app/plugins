<!--
  The note's slides template CSS (see templateCss in sidecar.js), from the
  entry's `mahfouz:` headmatter. Nothing renders without a template.
-->
<script setup>
import { computed } from 'vue'
import { configs } from '@slidev/client'

const css = computed(() => configs.mahfouz?.css ?? '')
</script>

<template>
  <component :is="'style'" v-if="css">{{ css }}</component>
</template>
