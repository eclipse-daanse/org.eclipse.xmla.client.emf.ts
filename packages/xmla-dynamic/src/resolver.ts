/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { wireNameOf } from '@eclipse-daanse/emf-xml';
import type { RowsetCatalog } from '@eclipse-daanse/xmla-model';
import type { EClass, EStructuralFeature } from '@emfts/core';

import { DynamicModelRegistry } from './registry.js';

/**
 * Where a row class comes from, and the seam between the two paths.
 *
 * Static is preferred: it carries documentation, the OLE DB GUID, the source
 * the column list came from, and types chosen by hand. Dynamic is the fallback,
 * and it is what makes a rowset this project never described still usable.
 */
export type Origin = 'static' | 'dynamic';

export interface ResolvedRowset {
  readonly requestType: string;
  readonly rowClass: EClass;
  readonly origin: Origin;
}

/** One column, described the same way whichever path produced it. */
export interface Column {
  readonly name: string;
  readonly feature: EStructuralFeature;
  readonly many: boolean;
  readonly nested: boolean;
}

export interface ResolverOptions {
  /**
   * Import the inline schema even when the static class wins, and compare.
   *
   * Off by default because it costs a parse per response. On, the dynamic path
   * becomes a conformance test for the static models: anything the server
   * describes that the model does not have, or types the two disagree about,
   * is reported instead of going unnoticed.
   */
  readonly strict?: boolean;
}

export interface Divergence {
  readonly requestType: string;
  readonly onlyInModel: readonly string[];
  readonly onlyOnServer: readonly string[];
}

export class RowsetResolver {
  private readonly catalog: RowsetCatalog;
  private readonly dynamic: DynamicModelRegistry;
  private readonly strict: boolean;
  private readonly divergences: Divergence[] = [];

  constructor(catalog: RowsetCatalog, serverKey: string, options: ResolverOptions = {}) {
    this.catalog = catalog;
    this.dynamic = new DynamicModelRegistry(serverKey);
    this.strict = options.strict ?? false;
  }

  get registry(): DynamicModelRegistry {
    return this.dynamic;
  }

  /** What the static model knows, before any response has been seen. */
  staticFor(requestType: string): EClass | null {
    return this.catalog.forRequestType(requestType);
  }

  /**
   * The class to read a response of this type with.
   *
   * `inlineSchema` is what the response carried. Passing it lets an unmodelled
   * rowset resolve; withholding it restricts this to what the model already
   * describes.
   */
  resolve(requestType: string, inlineSchema: string | null): ResolvedRowset {
    const known = this.catalog.forRequestType(requestType);

    if (known !== null) {
      if (this.strict && inlineSchema !== null) {
        this.compare(requestType, known, inlineSchema);
      }
      return { requestType, rowClass: known, origin: 'static' };
    }
    if (inlineSchema === null) {
      throw new Error(
        `${requestType} is not in the model and no inline schema came with it, so there is nothing to read it as`,
      );
    }
    return { requestType, rowClass: this.dynamic.learn(requestType, inlineSchema).rowClass, origin: 'dynamic' };
  }

  /**
   * The columns of a row class, in the one shape the UI ever sees.
   *
   * Deliberately identical for both origins. A screen that had to branch on
   * where a class came from would be a screen that renders one of the two paths
   * badly.
   */
  columnsOf(rowClass: EClass): Column[] {
    const features = rowClass.getEAllStructuralFeatures() as unknown as EStructuralFeature[];
    return [...features].map((feature) => ({
      name: wireNameOf(feature),
      feature,
      many: feature.isMany(),
      nested: isNested(feature),
    }));
  }

  /** What strict mode has found so far. */
  get divergencesFound(): readonly Divergence[] {
    return this.divergences;
  }

  private compare(requestType: string, known: EClass, inlineSchema: string): void {
    let fromServer: Set<string>;
    try {
      fromServer = new Set(
        this.dynamic
          .learn(`${requestType}#strict`, inlineSchema)
          .schema.columns.map((column) => column.name),
      );
    } catch {
      // A schema this importer cannot read is a finding of its own, but not one
      // to raise while someone is trying to read a response the static model
      // handles perfectly well.
      return;
    }
    const fromModel = new Set(this.columnsOf(known).map((column) => column.name));

    const onlyInModel = [...fromModel].filter((name) => !fromServer.has(name)).sort();
    const onlyOnServer = [...fromServer].filter((name) => !fromModel.has(name)).sort();
    if (onlyInModel.length > 0 || onlyOnServer.length > 0) {
      this.divergences.push({ requestType, onlyInModel, onlyOnServer });
    }
  }
}

function isNested(feature: EStructuralFeature): boolean {
  const type = feature.getEType() as { getEStructuralFeatures?: unknown } | null;
  return typeof type?.getEStructuralFeatures === 'function';
}
