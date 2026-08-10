<script setup lang="ts">
import { computed } from 'vue';
import type { EObject } from '@emfts/core';
import type { WidgetComponent } from '../generated/WidgetComponent';
import { useVisibility } from '../composables/useVisibility';
import { useWidgetConfig } from '../composables/useWidgetConfig';
import { useComponentRegistry } from '@emfts/vue-registry';

const props = defineProps<{
  widget: WidgetComponent;
  model: EObject;
}>();

const { getComponentForFeature } = useComponentRegistry();

const visible = useVisibility(
  () => props.widget.visibilityCondition,
  () => props.model
);

const resolvedStyle = useWidgetConfig(() => props.widget);

const widgetVueComponent = computed(() =>
  getComponentForFeature(props.widget.feature, props.model)
);

/** Context passed via 'custom' so registered widget components can read UIModel config. */
const uiContext = computed(() => ({
  eObject: props.model,
  feature: props.widget.feature,
  eClass: props.model.eClass?.(),
  custom: {
    resolvedStyle: resolvedStyle.value,
    rawWidget: props.widget,
  },
}));
</script>

<template>
  <component
    :is="widgetVueComponent"
    v-if="visible && widgetVueComponent"
    v-bind="uiContext"
  />
</template>
