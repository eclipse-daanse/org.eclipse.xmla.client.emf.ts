<script setup lang="ts">
import { provide } from 'vue';
import type { EObject } from '@emfts/core';
import type { UIModel } from '../generated/UIModel';
import {
  COMPOSER_REGISTRY_KEY,
  createComposerRegistry,
  type ComposerRegistry,
} from '../composables/useComposerRegistry';
import { evaluateBoolean } from '../utils/evaluateExpression';
import ComponentDispatcher from './ComponentDispatcher.vue';
import FormViewComposer from './FormViewComposer.vue';
import SectionViewComposer from './SectionViewComposer.vue';
import TabViewComposer from './TabViewComposer.vue';
import SummaryViewComposer from './SummaryViewComposer.vue';
import TableViewComposer from './TableViewComposer.vue';
import MasterDetailComposer from './MasterDetailComposer.vue';

const props = defineProps<{
  /** The loaded UIModel instance */
  uiModel: UIModel;
  /** The domain EObject to render */
  model: EObject;
  /**
   * Optional registry override — use to inject additional or replacement composers.
   * If omitted, the default registry (FormView, TableView, …) is used.
   */
  composerRegistry?: ComposerRegistry;
}>();

// Build and provide the ComposerRegistry for this subtree
const registry =
  props.composerRegistry ??
  createComposerRegistry({
    FormView: FormViewComposer,
    SectionView: SectionViewComposer,
    TabView: TabViewComposer,
    SummaryView: SummaryViewComposer,
    TableView: TableViewComposer,
    MasterDetail: MasterDetailComposer,
  });

provide(COMPOSER_REGISTRY_KEY, registry);

/**
 * Whether the UIModel applies to the current domain object.
 * filterExpression absence = applies to all.
 */
function modelApplies(): boolean {
  return evaluateBoolean(props.uiModel.filterExpression, props.model);
}
</script>

<template>
  <template v-if="modelApplies()">
    <ComponentDispatcher
      v-for="component in uiModel.components"
      :key="component.name"
      :component="component"
      :model="model"
    />
  </template>
</template>
