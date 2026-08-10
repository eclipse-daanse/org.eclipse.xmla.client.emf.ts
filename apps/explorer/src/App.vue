<!--
 Copyright (c) 2026 Contributors to the Eclipse Foundation.

 This program and the accompanying materials are made
 available under the terms of the Eclipse Public License 2.0
 which is available at https://www.eclipse.org/legal/epl-2.0/

 SPDX-License-Identifier: EPL-2.0
-->
<script setup lang="ts">
import type { EObject } from '@emfts/core';
import { ref, shallowRef } from 'vue';

import RowsetTable from './RowsetTable.vue';
import type { ExplorerSession, RowsetEntry, RunResult } from './session.js';
import type { FieldModel, FormModel } from './ui-model.js';

/**
 * The screens: pick a rowset, fill in its restrictions, see the rows.
 *
 * The session is injected rather than built here, so the same app runs against
 * a live server and against the recorded conversations without a switch inside
 * it.
 */
const props = defineProps<{ session: ExplorerSession }>();

const rowsets = shallowRef<RowsetEntry[]>([]);
const selected = ref<string | null>(null);
const form = shallowRef<FormModel | null>(null);
const restrictions = shallowRef<EObject | null>(null);
const result = shallowRef<RunResult | null>(null);
const schema = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

void load();

async function load(): Promise<void> {
  busy.value = true;
  try {
    rowsets.value = await props.session.rowsets();
  } catch (caught) {
    error.value = message(caught);
  } finally {
    busy.value = false;
  }
}

function select(requestType: string): void {
  selected.value = requestType;
  result.value = null;
  error.value = null;
  const asked = props.session.restrictionsFor(requestType);
  form.value = asked.form;
  restrictions.value = asked.instance;
}

async function run(): Promise<void> {
  if (selected.value === null) {
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    result.value = await props.session.run(selected.value, restrictions.value);
    schema.value = result.value.inlineSchema;
  } catch (caught) {
    // Shown rather than swallowed. A fault says far more about what went wrong
    // than an empty grid does.
    error.value = message(caught);
    result.value = null;
  } finally {
    busy.value = false;
  }
}

function valueOf(field: FieldModel): string {
  const holder = restrictions.value;
  if (holder === null || !holder.eIsSet(field.feature)) {
    return '';
  }
  const value = holder.eGet(field.feature);
  return value === null || value === undefined ? '' : String(value);
}

function setValue(field: FieldModel, raw: string): void {
  const holder = restrictions.value;
  if (holder === null) {
    return;
  }
  if (raw === '') {
    // Cleared means unset, not empty - a restriction set to the empty string is
    // a filter for the empty string, which is not what an empty box means.
    holder.eUnset(field.feature);
    return;
  }
  holder.eSet(field.feature, field.widget === 'number' ? Number(raw) : raw);
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
</script>

<template>
  <main>
    <header>
      <h1>XMLA Explorer</h1>
      <p class="hint">
        Every rowset the model describes, plus any the server declares that it does not.
      </p>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="columns">
      <nav>
        <h2>Rowsets</h2>
        <ul>
          <li v-for="entry in rowsets" :key="entry.requestType">
            <button
              type="button"
              :class="{ active: entry.requestType === selected }"
              @click="select(entry.requestType)"
            >
              {{ entry.requestType }}
              <span v-if="entry.origin === 'unknown'" class="badge dynamic" title="declared by the server, not in the model">
                dynamic
              </span>
            </button>
          </li>
        </ul>
      </nav>

      <section>
        <template v-if="selected">
          <h2>{{ selected }}</h2>

          <form v-if="form" class="restrictions" @submit.prevent="run">
            <p class="hint">
              In the order the mask is defined over - which is the order the server states,
              not the order the specification's table lists.
            </p>
            <label v-for="field in form.fields" :key="field.label" :title="field.documentation ?? ''">
              <span>
                {{ field.label }}
                <em v-if="field.required" class="required">required</em>
              </span>
              <input
                :type="field.widget === 'number' ? 'number' : 'text'"
                :value="valueOf(field)"
                @input="setValue(field, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </form>
          <p v-else class="hint">This rowset takes no restrictions.</p>

          <button type="button" :disabled="busy" @click="run">
            {{ busy ? 'Running…' : 'Run' }}
          </button>

          <template v-if="result">
            <h3>
              Rows
              <span class="badge" :class="result.origin">{{ result.origin }}</span>
            </h3>
            <RowsetTable :table="result.table" :rows="result.rows" />

            <details v-if="schema">
              <summary>The schema the server sent, beside the class built from it</summary>
              <div class="side-by-side">
                <pre>{{ schema }}</pre>
                <ul>
                  <li v-for="column in result.table.columns" :key="column.label">
                    {{ column.label }} — {{ column.widget }}{{ column.many ? ' (many)' : '' }}
                  </li>
                </ul>
              </div>
            </details>
          </template>
        </template>
        <p v-else class="hint">Pick a rowset.</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
main { font-family: system-ui, sans-serif; padding: 1rem; }
h1 { font-size: 1.2rem; margin: 0; }
.hint { color: #666; font-size: 0.85rem; }
.error { background: #fee; border: 1px solid #c66; color: #900; padding: 0.5rem; border-radius: 4px; }
.columns { display: grid; grid-template-columns: 16rem 1fr; gap: 1rem; align-items: start; }
nav ul { list-style: none; margin: 0; padding: 0; max-height: 70vh; overflow-y: auto; }
nav button { width: 100%; text-align: left; border: 0; background: none; padding: 0.2rem 0.4rem; cursor: pointer; font-size: 0.85rem; }
nav button.active { background: #eef; font-weight: 600; }
.restrictions { display: grid; gap: 0.3rem; margin-bottom: 0.6rem; }
.restrictions label { display: grid; grid-template-columns: 16rem 1fr; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
.required { color: #c60; font-style: normal; font-size: 0.75rem; }
.badge { font-size: 0.7rem; padding: 0 0.3rem; border-radius: 3px; }
.badge.static { background: #efe; color: #363; }
.badge.dynamic { background: #ffe9d6; color: #a55; }
.side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
pre { background: #f6f6f6; font-size: 0.75rem; max-height: 20rem; overflow: auto; padding: 0.5rem; }
</style>
