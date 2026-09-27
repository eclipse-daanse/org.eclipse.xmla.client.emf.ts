/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import { EPackageRegistry } from '@emfts/core';
import type { EClass, EPackage } from '@emfts/core';

import { buildRowClass, parseInlineSchema } from './schema-import.js';
import type { DynamicRowset } from './schema-import.js';

/**
 * The dynamic models built for one server, kept apart from everything else.
 *
 * This exists because of one hazard, and the hazard is silent. The
 * `targetNamespace` of every inline schema is byte-identical to the static
 * rowset package's nsURI. Registering a dynamically built package under it -
 * which is what any obvious implementation would do - replaces the real rowset
 * model **for the whole process**, and everything afterwards reads against a
 * model that describes one rowset and claims to describe seventy.
 *
 * Three things keep that from happening, and all three are needed:
 *
 *  1. a private nsURI per server and request type, never the schema's own;
 *  2. registration here rather than in `EPackageRegistry.INSTANCE`;
 *  3. the wire namespace written literally onto the features, so reading still
 *     looks for elements where the server actually puts them.
 */
const PRIVATE_PREFIX = 'https://www.daanse.org/spec/xmla/rowset/dynamic';

/** The nsURI of each static rowset package, which a dynamic one must never be. */
const STATIC_ROWSET_NAMESPACES = ['core', 'relational', 'multidimensional', 'mining', 'server'].map(
  (kind) => `${XMLA_NAMESPACES.ROWSET}:${kind}`,
);

export class DynamicModelRegistry {
  private readonly serverKey: string;
  private readonly byRequestType = new Map<string, DynamicRowset>();

  /**
   * @param serverKey something that identifies this server - its URL will do.
   *                  It only has to differ between servers, so two of them
   *                  describing the same rowset differently do not collide.
   */
  constructor(serverKey: string) {
    this.serverKey = serverKey;
  }

  /** The private nsURI a request type's dynamic package is registered under. */
  nsURIFor(requestType: string): string {
    return `${PRIVATE_PREFIX}/${encodeURIComponent(this.serverKey)}/${encodeURIComponent(requestType)}`;
  }

  /**
   * Builds the row class for a request type from the schema its response
   * carried, or returns the one already built.
   */
  learn(requestType: string, inlineSchema: string): DynamicRowset {
    const existing = this.byRequestType.get(requestType);
    if (existing !== undefined) {
      return existing;
    }
    const schema = parseInlineSchema(inlineSchema);
    const built = buildRowClass(schema, { nsURI: this.nsURIFor(requestType), className: classNameFor(requestType) });
    this.byRequestType.set(requestType, built);
    return built;
  }

  rowClassFor(requestType: string): EClass | null {
    return this.byRequestType.get(requestType)?.rowClass ?? null;
  }

  get(requestType: string): DynamicRowset | null {
    return this.byRequestType.get(requestType) ?? null;
  }

  get learned(): string[] {
    return [...this.byRequestType.keys()];
  }

  /**
   * Every package built here, for a reader that needs to resolve across them.
   *
   * Shaped like the global registry's `values()` so it can be handed to the
   * reader in its place - which is the point: the reader never has to know
   * whether a class came from a file or from a response.
   */
  values(): Iterable<EPackage> {
    return [...this.byRequestType.values()].map((each) => each.ePackage);
  }

  /**
   * Asserts that nothing here has leaked into the global registry.
   *
   * Worth checking rather than trusting, because the failure is silent: the
   * static model would still answer, just wrongly, and no error would say so.
   */
  assertNotGlobal(): void {
    // Once there was one static rowset package and it could be found by the wire
    // namespace. There are now five, none of which carries that namespace as its
    // nsURI - the specification gives all rowsets one namespace and an EPackage
    // cannot be one of several sharing it - so each is checked by its own.
    for (const each of this.byRequestType.values()) {
      if (STATIC_ROWSET_NAMESPACES.some((nsURI) => EPackageRegistry.INSTANCE.getEPackage(nsURI) === each.ePackage)) {
        throw new Error(
          'a dynamically built package has replaced a static rowset model in the global registry',
        );
      }
      const registered = EPackageRegistry.INSTANCE.getEPackage(each.ePackage.getNsURI()!);
      if (registered !== null && registered !== undefined) {
        throw new Error(`the dynamic package ${each.ePackage.getNsURI()} is in the global registry`);
      }
    }
  }
}

/** MDSCHEMA_CUBES becomes MdschemaCubesRow, which is only ever a display name. */
function classNameFor(requestType: string): string {
  const parts = requestType.toLowerCase().split('_').filter((part) => part !== '');
  return `${parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}Row`;
}
