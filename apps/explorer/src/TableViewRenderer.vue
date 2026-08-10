<!--
 Copyright (c) 2026 Contributors to the Eclipse Foundation.

 This program and the accompanying materials are made
 available under the terms of the Eclipse Public License 2.0
 which is available at https://www.eclipse.org/legal/epl-2.0/

 SPDX-License-Identifier: EPL-2.0
-->
<script setup lang="ts">
import type { EObject } from '@emfts/core';
import { computed, inject } from 'vue';

import RowsetTable from './RowsetTable.vue';
import { columnsForEClass, ROWS_KEY } from './ui-model.js';
import type { ColumnModel } from './ui-model.js';

/**
 * The grid the composer asks for.
 *
 * `TableViewComposer` renders nothing itself: it looks up the key
 * `TableViewRenderer` in the registry and delegates. Registering here rather
 * than rendering the grid beside the composer is the difference between using
 * the seam it provides and going around it - and an unregistered key renders a
 * silent empty placeholder, which is exactly the failure this project keeps
 * trying to avoid.
 *
 * Rows arrive by injection rather than as the composer's `model`, because that
 * is one EObject and a rowset is a list of them. The columns come from the
 * TableView's own target class, so this knows no rowset by name either.
 */
const props = defineProps<{ component: { targetClasses?: unknown[] }; model: EObject }>();

const rows = inject(ROWS_KEY, () => [] as readonly EObject[], true);

const columns = computed<readonly ColumnModel[]>(() => {
  const target = props.component.targetClasses?.[0];
  if (target === undefined || target === null) {
    return [];
  }
  return columnsForEClass(target as never);
});
</script>

<template>
  <RowsetTable :columns="columns" :rows="rows()" />
</template>
