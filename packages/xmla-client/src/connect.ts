/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { EObject, EStructuralFeature } from '@emfts/core';

import type { XmlaClient } from './client.js';

/**
 * Opening a connection the way a server expects it to be opened.
 *
 * A Discover on its own works against a forgiving server and fails oddly against
 * a strict one. The order below is what Analysis Services clients follow, and
 * each step exists because something reads its answer: the properties say what
 * the server can do, the data sources say what to call it and whether it will
 * demand a login, and only then is there a session to open.
 *
 * DISCOVER_SCHEMA_ROWSETS is deliberately absent. It is fetched lazily on the
 * first schema access, not here - it is the largest answer a server gives, and a
 * caller that only wants to run one query never needs it.
 */

/** What a server says about proving who you are. */
export type AuthenticationMode = 'Unauthenticated' | 'Authenticated' | 'Integrated' | 'unknown';

/** One data source, as DISCOVER_DATASOURCES describes it. */
export interface DataSource {
  readonly name: string;
  /** What a later request has to send back as its DataSourceInfo property. */
  readonly info: string;
  readonly providerName: string | null;
  readonly authenticationMode: AuthenticationMode;
}

/** What the server answered while the connection was being opened. */
export interface ConnectionInfo {
  readonly dataSource: DataSource;
  readonly properties: ReadonlyMap<string, string>;
  readonly capabilities: Capabilities;
  /** The catalog the server considers current, from the liveness probe. */
  readonly currentCatalog: string | null;
}

/**
 * What MDX this server admits to understanding.
 *
 * A client reads these before it generates anything. They are bitmasks, and the
 * bits have names in [MS-SSAS]; a mask claiming more than the engine does turns
 * "not supported" into a parse failure at the far end, so a client that asks is
 * better off than one that tries.
 */
export interface Capabilities {
  /** MDPROPVAL_MSQ_*: which subselect forms. */
  readonly subqueries: number;
  /** MDPROPVAL_MF_*: WITH and CREATE for calculated members and named sets. */
  readonly formulas: number;
  /** DRILLDOWNMEMBER, DRILLDOWNLEVEL and their -TOP/-BOTTOM forms. */
  readonly drillFunctions: number;
  readonly namedSets: number;
  readonly ddlExtensions: number;
  /** Whether a bit is set, by the specification's own name for it. */
  has(capability: CapabilityName): boolean;
}

/** The bits [MS-SSAS] names, and the property each belongs to. */
export const CAPABILITY_BITS = {
  MDPROPVAL_MSQ_BASIC: ['subqueries', 0x01],
  MDPROPVAL_MSQ_ARBITRARYSHAPE: ['subqueries', 0x02],
  MDPROPVAL_MSQ_NONVISUAL: ['subqueries', 0x04],
  MDPROPVAL_MSQ_CALCMEMBERS: ['subqueries', 0x08],
  MDPROPVAL_MSQ_CALCMEMBERS2: ['subqueries', 0x10],
  MDPROPVAL_MSQ_DRILLTHROUGH: ['subqueries', 0x20],
  MDPROPVAL_MF_WITH_CALCMEMBERS: ['formulas', 0x01],
  MDPROPVAL_MF_WITH_NAMEDSETS: ['formulas', 0x02],
  MDPROPVAL_MF_CREATE_CALCMEMBERS: ['formulas', 0x04],
  MDPROPVAL_MF_CREATE_NAMEDSETS: ['formulas', 0x08],
  MDPROPVAL_MF_SCOPE_SESSION: ['formulas', 0x10],
  MDPROPVAL_MF_SCOPE_GLOBAL: ['formulas', 0x20],
} as const satisfies Record<string, readonly [keyof Omit<Capabilities, 'has'>, number]>;

export type CapabilityName = keyof typeof CAPABILITY_BITS;

/**
 * The properties a client sends back once it has read them.
 *
 * `DataSourceInfo` is the one that matters and the one clients get wrong: a
 * server answers DISCOVER_DATASOURCES with it, and every later request is
 * expected to carry it back. A server that keys anything on it sees a stranger
 * on every request otherwise.
 */
export interface ConnectionProperties {
  readonly dataSourceInfo?: string;
  readonly catalog?: string;
}

/** Reads the value of one column out of a row, as text. */
export function columnOf(row: EObject, wireName: string): string | null {
  for (const feature of features(row)) {
    if (nameOf(feature) !== wireName || !row.eIsSet(feature)) {
      continue;
    }
    const value = row.eGet(feature);
    return value === null || value === undefined ? null : String(value);
  }
  return null;
}

function features(row: EObject): EStructuralFeature[] {
  return [...row.eClass().getEAllStructuralFeatures()];
}

/**
 * A feature's name on the wire.
 *
 * The model's ExtendedMetaData name where there is one - COLUMN_NAME rather than
 * columnName - and the feature's own name otherwise.
 */
function nameOf(feature: EStructuralFeature): string {
  const annotation = feature.getEAnnotation('http:///org/eclipse/emf/ecore/util/ExtendedMetaData');
  const named = annotation?.getDetails().getByKey('name');
  return named !== null && named !== undefined && named !== '' ? named : (feature.getName() ?? '');
}

/** The one row a server must give for a connection to mean anything. */
export function dataSourceOf(rows: readonly EObject[]): DataSource {
  if (rows.length === 0) {
    throw new Error(
      'DISCOVER_DATASOURCES came back with no rows. A client cannot open a connection to a ' +
        'server that names no data source.',
    );
  }
  const first = rows[0]!;
  // An empty DataSourceInfo is the server saying it needs none, not a fault.
  // Every conversation in the testkit shows it: ssms-connect, ssms-session,
  // powerbi-import and powerbi-live all answer `<DataSourceInfo/>`, and none
  // of those clients then sends the property on any request - 0 of 13 for
  // SSMS, 0 of 44 for Power BI live. Refusing it here refused every server
  // this project has ever recorded.
  const info = columnOf(first, 'DataSourceInfo') ?? '';
  return {
    name: columnOf(first, 'DataSourceName') ?? '',
    info,
    providerName: columnOf(first, 'ProviderName'),
    authenticationMode: authenticationModeOf(columnOf(first, 'AuthenticationMode')),
  };
}

function authenticationModeOf(text: string | null): AuthenticationMode {
  switch (text) {
    case 'Unauthenticated':
    case 'Authenticated':
    case 'Integrated':
      return text;
    default:
      return 'unknown';
  }
}

/** DISCOVER_PROPERTIES as a map of name to value. */
export function propertiesOf(rows: readonly EObject[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const row of rows) {
    const name = columnOf(row, 'PropertyName');
    if (name !== null && name !== '') {
      found.set(name, columnOf(row, 'Value') ?? '');
    }
  }
  return found;
}

/** The MDX capability masks, read out of a DISCOVER_PROPERTIES answer. */
export function capabilitiesOf(properties: ReadonlyMap<string, string>): Capabilities {
  const mask = (name: string): number => {
    const text = properties.get(name);
    if (text === undefined || text.trim() === '') {
      return 0;
    }
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : 0;
  };
  const masks = {
    subqueries: mask('MdpropMdxSubqueries'),
    formulas: mask('MdpropMdxFormulas'),
    drillFunctions: mask('MdpropMdxDrillFunctions'),
    namedSets: mask('MdpropMdxNamedSets'),
    ddlExtensions: mask('MdpropMdxDdlExtensions'),
  };
  return {
    ...masks,
    has(capability: CapabilityName): boolean {
      const [property, bit] = CAPABILITY_BITS[capability];
      return (masks[property] & bit) !== 0;
    },
  };
}

/**
 * Opens a connection: the properties, the data source, and a liveness probe.
 *
 * Returns a client carrying the DataSourceInfo the server named, and the
 * connection facts beside it. The client is a new one - the caller's is not
 * changed under its feet.
 */
export async function open(client: XmlaClient): Promise<{ client: XmlaClient; info: ConnectionInfo }> {
  // Unrestricted, and first: it is the capability probe, and every later
  // decision - which MDX to generate, whether to expect a challenge - reads it.
  const propertyRows = await client.discover('DISCOVER_PROPERTIES');
  const properties = propertiesOf(propertyRows.rows);

  // Over HTTP this is the second round trip of every connection. It has to
  // yield at least one row; the DataSourceInfo it carries travels back on
  // every later request, and an empty one means there is nothing to carry.
  const dataSourceRows = await client.discover('DISCOVER_DATASOURCES');
  const dataSource = dataSourceOf(dataSourceRows.rows);

  const connected =
    dataSource.info === ''
      ? client
      : client.withConnectionProperties({ dataSourceInfo: dataSource.info });

  // The liveness probe: one property, and the answer says which catalog the
  // server considers current. A server that answers this answers anything.
  const catalogRows = await connected.discover('DISCOVER_PROPERTIES', [
    { name: 'PropertyName', value: 'Catalog' },
  ]);
  const currentCatalog = catalogRows.rows.length === 0 ? null : columnOf(catalogRows.rows[0]!, 'Value');

  return {
    client: connected,
    info: {
      dataSource,
      properties,
      capabilities: capabilitiesOf(properties),
      currentCatalog: currentCatalog === '' ? null : currentCatalog,
    },
  };
}
