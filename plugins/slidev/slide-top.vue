<!--
  The note's slides template logo, header and footer, drawn on every slide
  (in the dev server and in `slidev export`). The cover logo, when the
  template has one, replaces the logo on slide 1.

  It also stamps its slide's page element (`.slidev-page`) with
  `data-layout` and `data-class` (layout-stamp.js), which a template's
  stylesheet scopes its layout sections and variants on. It stamps with or
  without a template: cheap, and the CSS contract stays uniform.
-->
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { configs, useSlideContext } from '@slidev/client'
import { layerHtml } from './header-footer.js'
import { deckDefaults, slideClass, slideLayout, stampPage } from './layout-stamp.js'

const { $page, $nav, $frontmatter } = useSlideContext()
const anchor = ref(null)
const layout = computed(() => slideLayout($frontmatter, deckDefaults($nav.value), $page.value))
const cls = computed(() => slideClass($frontmatter?.class))
// The page is the wrapper this component renders in; `flush: 'post'` runs
// after Vue has patched it, so a re-render can't race the stamp.
const stamp = () => stampPage(anchor.value?.closest('.slidev-page'), { layout: layout.value, cls: cls.value })
onMounted(stamp)
watch([layout, cls], stamp, { flush: 'post' })
const t = computed(() => configs.mahfouz ?? null)
const logo = computed(() => {
  if (!t.value) return null
  if ($page.value === 1 && t.value.coverLogo) return t.value.coverLogo
  return t.value.logo ?? null
})
const position = computed(() => t.value?.logoPosition ?? 'top-right')
const total = computed(() => $nav.value?.total ?? 1)
const header = computed(() => layerHtml(t.value, 'header', $page.value, total.value))
const footer = computed(() => layerHtml(t.value, 'footer', $page.value, total.value))
</script>

<template>
  <span ref="anchor" class="mahfouz-anchor" hidden />
  <img v-if="logo" :src="logo" alt="" class="mahfouz-logo" :class="`mahfouz-logo--${position}`">
  <div v-if="header" class="mahfouz-header" v-html="header" />
  <div v-if="footer" class="mahfouz-footer" v-html="footer" />
</template>

<style>
.mahfouz-logo {
  position: absolute;
  z-index: 10;
  max-width: 160px;
  max-height: 48px;
  object-fit: contain;
  pointer-events: none;
}
.mahfouz-logo--top-left { top: 20px; left: 24px; }
.mahfouz-logo--top-right { top: 20px; right: 24px; }
.mahfouz-logo--bottom-left { bottom: 20px; left: 24px; }
.mahfouz-logo--bottom-right { bottom: 20px; right: 24px; }
.mahfouz-header {
  position: absolute;
  z-index: 10;
  left: 200px;
  right: 200px;
  top: 14px;
  text-align: center;
  font-size: 12px;
  opacity: 0.7;
  pointer-events: none;
}
.mahfouz-footer {
  position: absolute;
  z-index: 10;
  left: 200px;
  right: 200px;
  bottom: 14px;
  text-align: center;
  font-size: 12px;
  opacity: 0.7;
  pointer-events: none;
}
.mahfouz-header img, .mahfouz-footer img { display: inline-block; height: 1.2em; vertical-align: middle; }
</style>
