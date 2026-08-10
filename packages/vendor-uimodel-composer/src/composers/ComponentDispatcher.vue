<script setup lang="ts">
import { computed } from 'vue';
import type { EObject } from '@emfts/core';
import type { Component as UiComponent } from '../generated/Component';
import { useComposerRegistry } from '../composables/useComposerRegistry';

const props = defineProps<{
  component: UiComponent;
  model: EObject;
}>();

const registry = useComposerRegistry();

const composer = computed(() => {
  const eclassName = props.component.eClass?.()?.getName?.() ?? '';
  const found = registry.getComposer(eclassName);
  if (!found) {
    console.warn(`[uimodel-composer] No composer registered for EClass "${eclassName}"`);
  }
  return found ?? null;
});
</script>

<template>
  <component
    :is="composer"
    v-if="composer"
    :component="component"
    :model="model"
  />
</template>
