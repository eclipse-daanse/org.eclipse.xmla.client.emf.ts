<script setup lang="ts">
import { computed } from 'vue';
import type { EObject } from '@emfts/core';
import type { TableView } from '../generated/TableView';
import { useComposerRegistry } from '../composables/useComposerRegistry';

const props = defineProps<{
  component: TableView;
  model: EObject;
}>();

/**
 * TableView delegates to a consumer-registered Vue component.
 * Register under the key "TableViewRenderer" in the ComposerRegistry.
 */
const registry = useComposerRegistry();
const renderer = computed(() => registry.getComposer('TableViewRenderer'));
</script>

<template>
  <component
    :is="renderer"
    v-if="renderer"
    :component="component"
    :model="model"
  />
  <div v-else class="uimodel-table-view-placeholder">
    <!-- No TableViewRenderer registered. Call registry.register("TableViewRenderer", MyTable) -->
  </div>
</template>
