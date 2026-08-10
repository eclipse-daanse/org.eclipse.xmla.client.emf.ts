/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { bootstrap } from './bootstrap.js';
import type { BootstrapOptions, ModelSource, XmlaModels } from './bootstrap.js';
import { MODEL_ORDER } from './models.generated.js';
import { MODEL_TEXT } from './models/index.generated.js';

/**
 * Bootstrapping without a filesystem.
 *
 * The same models the Node loader reads from disk, inlined as strings by
 * `scripts/sync-ecore.mjs`, so a bundler needs no raw-import syntax of its own.
 * `npm run check:sync` fails if the two ever disagree.
 */
export interface BrowserBootstrapOptions extends BootstrapOptions {
  /**
   * Load the optional models too - today only `engine`, 868 KB of DDL types
   * whose absence costs exactly 18 features, all on commands a client never
   * sends. Off by default, and the more so here: it is a third of the bytes a
   * browser would have to fetch.
   */
  readonly includeOptional?: boolean;
}

export function modelSources(includeOptional = false): ModelSource[] {
  return MODEL_ORDER.filter((model) => includeOptional || !model.optional).map((model) => {
    const ecore = MODEL_TEXT[model.name];
    if (ecore === undefined) {
      throw new Error(`no inlined text for ${model.name}; run 'npm run sync:ecore'`);
    }
    return { name: model.name, nsURI: model.nsURI, ecore };
  });
}

export function bootstrapInBrowser(options: BrowserBootstrapOptions = {}): XmlaModels {
  return bootstrap(modelSources(options.includeOptional ?? false), options);
}
