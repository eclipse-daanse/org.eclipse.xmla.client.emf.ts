<script setup lang="ts">
import type { EObject } from '@emfts/core';
import type { FormView } from '../generated/FormView';
import WidgetComposer from './WidgetComposer.vue';

defineProps<{
  component: FormView;
  model: EObject;
}>();
</script>

<template>
  <div class="uimodel-form-view">
    <WidgetComposer
      v-for="field in component.fields"
      :key="field.name"
      :widget="field"
      :model="model"
    />
  </div>
</template>
