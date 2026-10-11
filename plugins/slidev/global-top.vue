<!--
  The note's slides template CSS, from the entry's `mahfouz:` headmatter:
  the app's `stylesheet`, or templateCss in sidecar.js for an app that
  predates it. Injected as a text node (Vue sets `textContent`), so a
  `</style>` inside the template's raw css can't break out of the element.
  Nothing renders without a template.

  While the template's fonts (`fontFamilies`) load and the page's images
  decode, it renders a hidden `.slidev-slide-loading` marker, which
  `slidev export` waits to detach before it renders (PDF and PowerPoint
  both export through the print view, where the export's locator is
  `body`; `--per-slide` would scope it to one slide, and the sidecar never
  passes it). In print this component renders once per slide, so there is
  one marker and one style element per printed slide, each waiting on its
  own. The wait is capped (asset-wait.js), so an offline export finishes
  with the fallback fonts. The marker renders at mount: the export only
  waits on markers already in the DOM when it looks.
-->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { configs } from '@slidev/client'
import { waitForAssets } from './asset-wait.js'

const css = computed(() => configs.mahfouz?.css ?? '')
const families = Array.isArray(configs.mahfouz?.fontFamilies) ? configs.mahfouz.fontFamilies : []
const pending = ref(Boolean(configs.mahfouz))

onMounted(async () => {
  if (!pending.value) return
  try {
    await waitForAssets({ fonts: document.fonts, families, images: document.images })
  } finally {
    pending.value = false
  }
})
</script>

<template>
  <component :is="'style'" v-if="css">{{ css }}</component>
  <div v-if="pending" class="slidev-slide-loading mahfouz-assets-pending" aria-hidden="true" style="display:none" />
</template>
