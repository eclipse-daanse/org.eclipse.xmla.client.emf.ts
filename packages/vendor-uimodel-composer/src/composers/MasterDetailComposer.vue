<script setup lang="ts">
import type { EObject } from '@emfts/core';
import type { MasterDetail } from '../generated/MasterDetail';
import TableViewComposer from './TableViewComposer.vue';
import ComponentDispatcher from './ComponentDispatcher.vue';

defineProps<{
  component: MasterDetail;
  model: EObject;
}>();
</script>

<template>
  <div class="uimodel-master-detail">
    <div class="uimodel-master">
      <TableViewComposer :component="component.master" :model="model" />
    </div>
    <div class="uimodel-detail">
      <ComponentDispatcher :component="component.detail" :model="model" />
    </div>
  </div>
</template>
