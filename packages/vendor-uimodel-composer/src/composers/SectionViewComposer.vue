<script setup lang="ts">
import type { EObject } from '@emfts/core';
import type { SectionView } from '../generated/SectionView';
import FormViewComposer from './FormViewComposer.vue';

defineProps<{
  component: SectionView;
  model: EObject;
}>();
</script>

<template>
  <div class="uimodel-section-view">
    <FormViewComposer
      v-for="section in component.sections"
      :key="section.name"
      :component="section"
      :model="model"
    />
  </div>
</template>
