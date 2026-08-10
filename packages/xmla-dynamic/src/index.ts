/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/**
 * The second path: the server describes itself, and the description becomes a
 * model.
 *
 * Every response carries an inline schema for its rows, so a rowset this
 * project never modelled is still readable and still renderable. What makes
 * that safe rather than clever is in `registry.ts` - the namespace collision it
 * avoids would otherwise replace the real model process-wide, silently.
 */
export { DynamicModelRegistry } from './registry.js';
export { buildRowClass, featureNameOf, parseInlineSchema } from './schema-import.js';
export type { DynamicRowset, ImportedColumn, ImportedSchema, RowClassOptions } from './schema-import.js';
export { RowsetResolver } from './resolver.js';
export type { Column, Divergence, Origin, ResolvedRowset, ResolverOptions } from './resolver.js';
