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
 * The XMLA Ecore models, bootstrapped into a live registry, and the catalogue
 * over them.
 *
 * Nothing here is generated code for a rowset. The models are the description,
 * and every question about a rowset - its columns, its restrictions, their order
 * - is answered by asking them.
 */
export { bootstrap, restoreEcoreWrappers, unresolvedFeatures } from './bootstrap.js';
export type { BootstrapOptions, ModelSource, XmlaModels } from './bootstrap.js';
export { ROWSET_ANNOTATION, RowsetCatalog } from './catalog.js';
export type { Restriction } from './catalog.js';
export { MODEL_ORDER } from './models.generated.js';
export type { ModelDescriptor } from './models.generated.js';
export { XMLA_NAMESPACES } from './namespaces.js';
