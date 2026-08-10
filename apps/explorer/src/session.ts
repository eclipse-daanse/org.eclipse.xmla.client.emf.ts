/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { XmlaClient } from '@daanse/xmla-client';
import type { Credentials, Transport } from '@daanse/xmla-client';
import { RowsetResolver } from '@daanse/xmla-dynamic';
import type { Origin } from '@daanse/xmla-dynamic';
import { RowsetCatalog } from '@daanse/xmla-model';
import type { XmlaModels } from '@daanse/xmla-model';
import type { EObject } from '@emfts/core';

import { formViewForEClass, tableViewForEClass } from './ui-model.js';
import type { FormModel, TableModel } from './ui-model.js';

/**
 * One connection, and everything the screens ask of it.
 *
 * The point of this class is the shape of `run`: it answers the same thing
 * whether the rowset came from a `.ecore` or from a schema the server sent a
 * moment ago. Nothing above it branches on `origin` - that field is there to be
 * shown as a badge, not to be switched on.
 */
export interface RowsetEntry {
  readonly requestType: string;
  readonly origin: Origin | 'unknown';
  readonly guid: string | null;
  readonly source: string | null;
}

export interface RunResult {
  readonly requestType: string;
  readonly origin: Origin;
  readonly table: TableModel;
  readonly rows: readonly EObject[];
  readonly inlineSchema: string | null;
}

export interface RestrictionsForm {
  readonly form: FormModel | null;
  readonly instance: EObject | null;
  readonly required: readonly string[];
}

export class ExplorerSession {
  private readonly models: XmlaModels;
  private readonly catalog: RowsetCatalog;
  private readonly resolver: RowsetResolver;
  private client: XmlaClient;

  constructor(options: {
    url: string;
    transport: Transport;
    models: XmlaModels;
    credentials?: Credentials;
  }) {
    this.models = options.models;
    this.catalog = new RowsetCatalog(options.models);
    this.resolver = new RowsetResolver(this.catalog, options.url);
    this.client = new XmlaClient({
      url: options.url,
      transport: options.transport,
      models: options.models,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
  }

  get sessionId(): string | null {
    return this.client.sessionId;
  }

  async openSession(): Promise<void> {
    this.client = await this.client.beginSession();
  }

  async closeSession(): Promise<void> {
    this.client = await this.client.endSession();
  }

  /**
   * The rowsets to offer.
   *
   * What the model knows, plus anything the server declared that it does not -
   * which is the list a user should see, not the one this project happens to
   * have modelled.
   */
  async rowsets(): Promise<RowsetEntry[]> {
    const known = new Map<string, RowsetEntry>();
    for (const requestType of this.catalog.requestTypes()) {
      const eClass = this.catalog.forRequestType(requestType)!;
      known.set(requestType, {
        requestType,
        origin: 'static',
        guid: this.catalog.guidOf(eClass),
        source: this.catalog.sourceOf(eClass),
      });
    }

    try {
      const declared = await this.client.discover('DISCOVER_SCHEMA_ROWSETS');
      for (const row of declared.rows) {
        const name = String(read(row, 'schemaName') ?? '');
        if (name !== '' && !known.has(name)) {
          // The server says it can answer this and the model has never heard of
          // it. SSAS 13 declares DISCOVER_RESOURCE_POOLS, for one.
          known.set(name, { requestType: name, origin: 'unknown', guid: null, source: 'declared by the server' });
        }
      }
    } catch {
      // A server that will not describe itself still has the rowsets the model
      // knows; losing the extra ones is not a reason to show nothing.
    }
    return [...known.values()].sort((a, b) => (a.requestType < b.requestType ? -1 : 1));
  }

  /** The form for a request type's restrictions, or null where it accepts none. */
  restrictionsFor(requestType: string): RestrictionsForm {
    const eClass = this.catalog.restrictionsClassFor(requestType);
    if (eClass === null) {
      return { form: null, instance: null, required: [] };
    }
    const required = this.catalog.requiredRestrictionsOf(requestType);
    return {
      form: formViewForEClass(eClass, required),
      instance: eClass.getEPackage()!.getEFactoryInstance().create(eClass),
      required,
    };
  }

  /**
   * Runs a Discover and answers in one shape, whichever path produced the class.
   */
  async run(requestType: string, restrictions: EObject | null): Promise<RunResult> {
    const entries = restrictions === null ? [] : toEntries(restrictions);

    // The response is fetched once and read afterwards. For a rowset the model
    // does not describe, the class to read it with is built from the schema the
    // same response carried - so asking twice would be asking for something
    // already in hand.
    const xml = await this.client.discoverRaw(requestType, entries);
    const resolved = this.resolver.resolve(requestType, this.client.schemaOf(xml));
    const read = this.client.readRows(xml, resolved.rowClass);

    return {
      requestType,
      origin: resolved.origin,
      table: tableViewForEClass(resolved.rowClass),
      rows: read.rows,
      inlineSchema: read.inlineSchema,
    };
  }
}

/** The restrictions a filled-in form stands for, as wire entries. */
export function toEntries(restrictions: EObject): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  const eClass = restrictions.eClass();
  for (let i = 0; i < eClass.getEStructuralFeatures().size(); i++) {
    const feature = eClass.getEStructuralFeatures().get(i)!;
    if (!restrictions.eIsSet(feature)) {
      continue;
    }
    const value = restrictions.eGet(feature);
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const name = featureWireName(feature);
    if (feature.isMany()) {
      for (const each of value as Iterable<unknown>) {
        entries.push({ name, value: String(each) });
      }
    } else {
      entries.push({ name, value: String(value) });
    }
  }
  return entries;
}

function featureWireName(feature: { getName(): string | null; getEAnnotation(source: string): unknown }): string {
  const annotation = feature.getEAnnotation('http:///org/eclipse/emf/ecore/util/ExtendedMetaData') as
    | { getDetails(): { getByKey(key: string): string | undefined } }
    | null;
  const name = annotation?.getDetails().getByKey('name');
  return name === undefined || name === '' ? (feature.getName() ?? '') : name;
}

function read(object: EObject, featureName: string): unknown {
  const feature = object.eClass().getEStructuralFeature(featureName);
  return feature === null || feature === undefined || !object.eIsSet(feature) ? null : object.eGet(feature);
}
