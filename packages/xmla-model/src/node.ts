/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrap } from './bootstrap.js';
import type { BootstrapOptions, ModelSource, XmlaModels } from './bootstrap.js';
import { MODEL_ORDER } from './models.generated.js';

/**
 * Loading the models from disk, for Node.
 *
 * Kept apart from `bootstrap` so the core stays free of any filesystem: the
 * browser gets the same models as inlined strings, and both go through the same
 * loader.
 */
const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'model');

export interface NodeBootstrapOptions extends BootstrapOptions {
  /**
   * Load the optional models too - today only `engine`, 868 KB of DDL types.
   *
   * Off by default. Leaving it out costs exactly 18 features, all of them on
   * commands that deploy database objects, and saves about 240 ms of a 620 ms
   * bootstrap. It is a deliberate choice rather than an accident because the
   * failure is silent: reading a feature with an unresolved type returns instead
   * of raising.
   */
  readonly includeOptional?: boolean;
}

export function modelSources(includeOptional = false): ModelSource[] {
  return MODEL_ORDER.filter((model) => includeOptional || !model.optional).map((model) => ({
    name: model.name,
    nsURI: model.nsURI,
    ecore: readFileSync(join(MODEL_DIR, `${model.name}.ecore`), 'utf8'),
  }));
}

export function bootstrapFromDisk(options: NodeBootstrapOptions = {}): XmlaModels {
  return bootstrap(modelSources(options.includeOptional ?? false), options);
}

/**
 * The features left unresolved by leaving `engine` out, named rather than implied.
 *
 * All 18 are on commands that deploy or reprocess database objects - Alter,
 * Create, Process, Batch, NotifyTableChange and the out-of-line bindings those
 * carry. None is on the read path of an OLAP client, which is what makes the
 * omission affordable. The list is asserted in the tests so that a model change
 * widening it has to be looked at rather than absorbed.
 */
export const WITHOUT_ENGINE: readonly string[] = [
  'Alter.objectDefinition',
  'Batch.dataSource',
  'Batch.dataSourceView',
  'Batch.errorConfiguration',
  'Create.objectDefinition',
  'NotifyTableChange.tableNotifications',
  'OutOfLineBinding.customRollupColumn',
  'OutOfLineBinding.customRollupPropertiesColumn',
  'OutOfLineBinding.nameColumn',
  'OutOfLineBinding.skippedLevelsColumn',
  'OutOfLineBinding.source',
  'OutOfLineBinding.unaryOperatorColumn',
  'OutOfLineBinding.valueColumn',
  'OutOfLineBindingColumn.source',
  'OutOfLineBindingTranslation.source',
  'Process.dataSource',
  'Process.dataSourceView',
  'Process.errorConfiguration',
];
