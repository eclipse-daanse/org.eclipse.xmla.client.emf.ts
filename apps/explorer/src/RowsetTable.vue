<!--
 Copyright (c) 2026 Contributors to the Eclipse Foundation.

 This program and the accompanying materials are made
 available under the terms of the Eclipse Public License 2.0
 which is available at https://www.eclipse.org/legal/epl-2.0/

 SPDX-License-Identifier: EPL-2.0
-->
<script setup lang="ts">
import type { EObject, EStructuralFeature } from '@emfts/core';

import type { ColumnModel } from './ui-model.js';

/**
 * A grid over any row class, static or dynamic.
 *
 * Two things it does that a `Record<string, unknown>` renderer cannot, and they
 * are the reason EObjects are carried this far: a nested rowset folds into an
 * inner table rather than a JSON blob, and an unset column is shown as NULL
 * rather than as an empty string, because those say different things.
 */
const props = defineProps<{ columns: readonly ColumnModel[]; rows: readonly EObject[]; limit?: number }>();

function shown(): readonly EObject[] {
  const limit = props.limit ?? 200;
  return props.rows.length <= limit ? props.rows : props.rows.slice(0, limit);
}

function isSet(row: EObject, feature: EStructuralFeature): boolean {
  // Asked before the value is fetched: reading a many-valued feature would
  // materialise its list and make it count as set from then on.
  return row.eIsSet(feature);
}

function scalar(row: EObject, field: ColumnModel): string {
  const value = row.eGet(field.feature);
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function nestedRows(row: EObject, field: ColumnModel): EObject[] {
  const value = row.eGet(field.feature);
  if (field.many) {
    return [...(value as Iterable<EObject>)];
  }
  return value === null || value === undefined ? [] : [value as EObject];
}

function nestedColumns(field: ColumnModel): readonly ColumnModel[] {
  return field.nested ?? [];
}
</script>

<template>
  <div class="grid-wrap">
    <p class="count">
      {{ rows.length }} row{{ rows.length === 1 ? '' : 's' }}
      <span v-if="rows.length > shown().length"> — showing the first {{ shown().length }}</span>
    </p>
    <table class="grid">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.label" :title="column.documentation ?? ''">
            {{ column.label }}
            <span v-if="column.widget === 'table'" class="badge">nested</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in shown()" :key="index">
          <td v-for="column in columns" :key="column.label">
            <span v-if="!isSet(row, column.feature)" class="null">NULL</span>
            <RowsetTable
              v-else-if="column.widget === 'table'"
              :columns="nestedColumns(column)"
              :rows="nestedRows(row, column)"
            />
            <span v-else>{{ scalar(row, column) }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.grid-wrap { overflow-x: auto; }
.count { color: #666; font-size: 0.85rem; margin: 0 0 0.4rem; }
.grid { border-collapse: collapse; font-size: 0.85rem; }
.grid th, .grid td { border: 1px solid #ddd; padding: 0.2rem 0.45rem; text-align: left; vertical-align: top; }
.grid th { background: #f6f6f6; position: sticky; top: 0; white-space: nowrap; }
.null { color: #aaa; font-style: italic; }
.badge { background: #eef; color: #446; font-size: 0.7rem; padding: 0 0.3rem; border-radius: 3px; margin-left: 0.3rem; }
</style>
