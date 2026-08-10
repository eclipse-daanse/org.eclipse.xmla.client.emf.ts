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
import { RowsetCatalog } from '@daanse/xmla-model';
import type { XmlaModels } from '@daanse/xmla-model';
import type { EObject } from '@emfts/core';

import { CellsetReader } from './cellset.js';
import type { XmlaCellset } from './cellset.js';
import { rowToRecord } from './records.js';

/**
 * The surface `@mdx-workbench/xmla-soap` exposes, over this client.
 *
 * The point is that swapping is one import. So this mirrors `XmlaSoapClient`
 * method for method - `connect`, `discover`, `execute`, `endSession`,
 * `setCatalog`, `currentSessionId` - and answers the same plain shapes:
 * `Array<Record<string, unknown>>` for a discover, `XmlaCellset` for an
 * execute.
 *
 * What changes underneath is everything: the rows are read against the models
 * rather than out of a DOM, a rowset the models never described is read from
 * the schema the response carried, and a nested rowset comes back as a nested
 * record rather than as `[object Object]`.
 */
export interface WorkbenchClientOptions {
  readonly url: string;
  readonly transport: Transport;
  readonly models: XmlaModels;
  readonly credentials?: Credentials;
  readonly catalog?: string;
  readonly dataSourceInfo?: string;
  /** Open a server session on `connect`, as the SOAP client's option does. */
  readonly useSession?: boolean;
}

export class WorkbenchXmlaClient {
  private readonly options: WorkbenchClientOptions;
  private readonly resolver: RowsetResolver;
  private readonly cellsets: CellsetReader;
  private client: XmlaClient;
  private catalogName: string | undefined;

  constructor(options: WorkbenchClientOptions) {
    this.options = options;
    this.catalogName = options.catalog;
    this.cellsets = new CellsetReader(options.models);
    this.resolver = new RowsetResolver(new RowsetCatalog(options.models), options.url);
    this.client = new XmlaClient({
      url: options.url,
      transport: options.transport,
      models: options.models,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
  }

  /** The session id, or undefined - `undefined` rather than null, as there. */
  get currentSessionId(): string | undefined {
    return this.client.sessionId ?? undefined;
  }

  setCatalog(name: string): void {
    this.catalogName = name;
  }

  /**
   * Opens a session if asked to, then lists the catalogs as a connectivity
   * check - which is what the SOAP client does, and what the workbench's first
   * screen shows.
   */
  async connect(): Promise<{ catalogs: Array<Record<string, unknown>> }> {
    if (this.options.useSession === true && this.client.sessionId === null) {
      this.client = await this.client.beginSession();
    }
    return { catalogs: await this.discover('DBSCHEMA_CATALOGS') };
  }

  async endSession(): Promise<void> {
    this.client = await this.client.endSession();
  }

  /**
   * One Discover, as plain records.
   *
   * A request type the models do not describe is read from the schema its own
   * response carried, so the workbench can ask for anything a server offers
   * rather than only what was modelled - which the SOAP client could not do
   * either way, because it had no models to fall short of.
   */
  async discover(
    requestType: string,
    restrictions?: Record<string, unknown>,
    properties?: Record<string, string | number>,
  ): Promise<Array<Record<string, unknown>>> {
    const entries = Object.entries(restrictions ?? {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => ({ name, value: String(value) }));

    const xml = await this.client.discoverRaw(requestType, entries, this.propertyList(properties));
    const resolved = this.resolver.resolve(requestType, this.client.schemaOf(xml));
    return this.client.readRows(xml, resolved.rowClass).rows.map((row) => rowToRecord(row));
  }

  /**
   * One MDX statement, as a cellset.
   *
   * DMV and DRILLTHROUGH statements answer a rowset rather than an mddataset,
   * and the workbench sends both through here. Which shape came back is decided
   * by what the response contains rather than by guessing from the statement
   * text - a `$SYSTEM` query and a `SELECT` are told apart by the server, and
   * reading the answer is more reliable than parsing the question.
   */
  async execute(statement: string, properties?: Record<string, string | number>): Promise<XmlaCellset> {
    const command = this.statementCommand(statement);
    const xml = await this.client.execute(command, this.propertyList(properties));
    return this.cellsets.read(xml);
  }

  /** A `<Statement>` command carrying the MDX. */
  private statementCommand(statement: string): EObject {
    const xmla = this.options.models.named('xmla');
    if (xmla === null) {
      throw new Error('the xmla model is not loaded');
    }
    const eClass = xmla.getEClassifier('Statement');
    if (eClass === null || eClass === undefined) {
      throw new Error('the xmla model has no Statement');
    }
    const command = xmla.getEFactoryInstance().create(eClass as never);
    const text = (eClass as never as { getEStructuralFeature(name: string): unknown }).getEStructuralFeature(
      'statement',
    );
    if (text !== null && text !== undefined) {
      command.eSet(text as never, statement);
    }
    return command;
  }

  /**
   * The `PropertyList` a request carries.
   *
   * `Catalog` and `DataSourceInfo` are set from the connection, as the SOAP
   * client sets them, and anything the caller passes wins over both.
   */
  private propertyList(extra?: Record<string, string | number>): EObject | null {
    const xmla = this.options.models.named('xmla');
    if (xmla === null) {
      return null;
    }
    const eClass = xmla.getEClassifier('PropertyList') as never as
      | { getEStructuralFeature(name: string): unknown; getName(): string }
      | null;
    if (eClass === null || eClass === undefined) {
      return null;
    }
    const properties = xmla.getEFactoryInstance().create(eClass as never);

    const values: Record<string, string | number | undefined> = {
      Catalog: this.catalogName,
      DataSourceInfo: this.options.dataSourceInfo,
      ...extra,
    };
    let any = false;
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined || value === '') {
        continue;
      }
      const feature = featureByWireName(properties, name);
      if (feature !== null) {
        properties.eSet(feature, String(value));
        any = true;
      }
    }
    // An empty PropertyList is written anyway - the server insists on the
    // element - so null here only means "nothing to put in it".
    return any ? properties : null;
  }
}

/** A PropertyList feature by the name a property has on the wire. */
function featureByWireName(properties: EObject, wireName: string): never | null {
  const features = properties.eClass().getEAllStructuralFeatures() as unknown as Array<{
    getName(): string;
    getEAnnotation(source: string): { getDetails(): { getByKey(key: string): string | undefined } } | null;
  }>;
  for (const feature of features) {
    const annotation = feature.getEAnnotation('http:///org/eclipse/emf/ecore/util/ExtendedMetaData');
    const name = annotation?.getDetails().getByKey('name') ?? feature.getName();
    if (name === wireName) {
      return feature as never;
    }
  }
  return null;
}
