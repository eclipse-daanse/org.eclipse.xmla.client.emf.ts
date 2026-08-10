<!--
 Copyright (c) 2026 Contributors to the Eclipse Foundation.

 This program and the accompanying materials are made
 available under the terms of the Eclipse Public License 2.0
 which is available at https://www.eclipse.org/legal/epl-2.0/

 SPDX-License-Identifier: EPL-2.0
-->
<script setup lang="ts">
import type { EObject, EStructuralFeature } from '@emfts/core';
import { computed } from 'vue';

import { widgetKindFor } from './ui-model.js';

/**
 * One restriction, as an input.
 *
 * The registry ships editors that label a field with the **feature name** -
 * `catalogName`. What a user recognises is the wire name, `CATALOG_NAME`: it is
 * what [MS-SSAS] calls it, what a server's own DISCOVER_SCHEMA_ROWSETS returns,
 * and what appears in every example anyone has read. The UIModel carries it on
 * `widget.label`, and this is what honours it.
 *
 * The other thing it gets right: clearing the box **unsets** the feature rather
 * than setting it to the empty string. Those are different restrictions - one
 * asks for everything, the other asks for rows whose column is empty - and the
 * whole reader and writer take care to keep them apart.
 */
const props = defineProps<{
  eObject: EObject;
  feature: EStructuralFeature;
  custom?: { rawWidget?: { label?: string; required?: boolean } };
}>();

const label = computed(() => props.custom?.rawWidget?.label ?? props.feature.getName() ?? '');
const required = computed(() => props.custom?.rawWidget?.required === true);

const kind = computed(() => widgetKindFor(props.feature.getEType()));
const inputType = computed(() => {
  switch (kind.value) {
    case 'number':
      return 'number';
    case 'date':
      return 'datetime-local';
    case 'checkbox':
      return 'checkbox';
    default:
      return 'text';
  }
});

const value = computed(() => {
  if (!props.eObject.eIsSet(props.feature)) {
    return '';
  }
  const held = props.eObject.eGet(props.feature);
  return held === null || held === undefined ? '' : String(held);
});

const checked = computed(() => value.value === 'true');

function write(raw: string): void {
  if (raw === '') {
    props.eObject.eUnset(props.feature);
    return;
  }
  props.eObject.eSet(props.feature, kind.value === 'number' ? Number(raw) : raw);
}

function toggle(on: boolean): void {
  props.eObject.eSet(props.feature, on);
}
</script>

<template>
  <label class="xmla-widget">
    <span class="name">
      {{ label }}
      <em v-if="required" class="required">required</em>
    </span>
    <input
      v-if="inputType === 'checkbox'"
      type="checkbox"
      :checked="checked"
      @change="toggle(($event.target as HTMLInputElement).checked)"
    />
    <input
      v-else
      :type="inputType"
      :value="value"
      @input="write(($event.target as HTMLInputElement).value)"
    />
  </label>
</template>

<style scoped>
.xmla-widget { display: grid; grid-template-columns: 18rem 1fr; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
.name { font-family: ui-monospace, monospace; }
.required { color: #c60; font-style: normal; font-size: 0.75rem; margin-left: 0.3rem; }
</style>
