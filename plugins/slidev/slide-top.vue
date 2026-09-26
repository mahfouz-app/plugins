<!--
  The note's slides template logo, header and footer, drawn on every slide
  (in the dev server and in `slidev export`). The cover logo, when the
  template has one, replaces the logo on slide 1.
-->
<script setup>
import { computed } from 'vue'
import { configs, useSlideContext } from '@slidev/client'
import { layerHtml } from './header-footer.js'

const { $page, $nav } = useSlideContext()
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
