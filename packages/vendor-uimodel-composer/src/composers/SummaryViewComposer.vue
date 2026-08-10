<script setup lang="ts">
import type { EObject } from '@emfts/core';
import type { SummaryView } from '../generated/SummaryView';
import WidgetComposer from './WidgetComposer.vue';

defineProps<{
  component: SummaryView;
  model: EObject;
}>();
</script>

<template>
  <div class="uimodel-summary-view">
    <WidgetComposer
      v-for="field in component.summaryFields"
      :key="field.name"
      :widget="field"
      :model="model"
    />
  </div>
</template>
