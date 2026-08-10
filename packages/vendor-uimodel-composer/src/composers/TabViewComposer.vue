<script setup lang="ts">
import type { EObject } from '@emfts/core';
import type { TabView } from '../generated/TabView';
import ComponentDispatcher from './ComponentDispatcher.vue';

defineProps<{
  component: TabView;
  model: EObject;
}>();
</script>

<template>
  <div class="uimodel-tab-view">
    <!--
      Tab shell is intentionally unstyled — consumer registers a styled
      tab container via the ComposerRegistry under the "TabView" key,
      or wraps UIModelComposer with their own tab layout.
      Each tab content is dispatched via ComponentDispatcher.
    -->
    <div
      v-for="tab in component.tabs"
      :key="tab.name"
      class="uimodel-tab-panel"
      :data-tab="tab.name"
    >
      <ComponentDispatcher :component="tab" :model="model" />
    </div>
  </div>
</template>
