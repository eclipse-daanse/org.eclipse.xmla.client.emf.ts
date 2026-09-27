/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { text } from '../kit.js';
import type { Check } from '../kit.js';

/**
 * Opening a connection: the two rowsets every client reads before anything
 * else, and what it has to find in them.
 */

/** The properties XMLA 1.1 lists as standard. A server may add; it should not drop. */
const STANDARD_PROPERTIES = [
  'AxisFormat',
  'BeginRange',
  'Catalog',
  'Content',
  'DataSourceInfo',
  'EndRange',
  'Format',
  'LocaleIdentifier',
  'MDXSupport',
  'Password',
  'ProviderName',
  'ProviderVersion',
  'StateSupport',
  'Timeout',
  'UserName',
];

/** The ones the client itself reads or sends. Without these it cannot open a connection. */
const NEEDED_PROPERTIES = ['Catalog', 'Content', 'Format', 'DataSourceInfo', 'ProviderName'];

export const connection: readonly Check[] = [
  {
    id: 'C1',
    group: 'connection',
    title: 'DISCOVER_PROPERTIES, unrestricted, answers the properties a client reads first',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.7 DISCOVER_PROPERTIES; XMLA 1.1, "XML for Analysis Properties"',
    async run(context) {
      const result = await context.client().discover('DISCOVER_PROPERTIES');
      const names = new Set(result.rows.map((row) => text(row, 'PropertyName')).filter((name) => name !== ''));
      if (names.size === 0) {
        throw new Error('no row carried a PropertyName');
      }
      const missing = NEEDED_PROPERTIES.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(`${names.size} properties, but not ${missing.join(', ')}`);
      }
      const provider = result.rows.find((row) => text(row, 'PropertyName') === 'ProviderName');
      const version = result.rows.find((row) => text(row, 'PropertyName') === 'ProviderVersion');
      return `${names.size} properties; ${text(provider!, 'Value') || 'unnamed provider'} ${
        version === undefined ? '' : text(version, 'Value')
      }`.trim();
    },
  },
  {
    id: 'C2',
    group: 'connection',
    title: 'the standard XMLA 1.1 properties are all there',
    level: 'should',
    spec: 'XMLA 1.1, "XML for Analysis Properties" - the table of standard properties',
    async run(context) {
      const result = await context.client().discover('DISCOVER_PROPERTIES');
      const names = new Set(result.rows.map((row) => text(row, 'PropertyName')));
      const missing = STANDARD_PROPERTIES.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(`missing ${missing.join(', ')}`);
      }
      return `all ${STANDARD_PROPERTIES.length}`;
    },
  },
  {
    id: 'C3',
    group: 'connection',
    title: 'DISCOVER_DATASOURCES names at least one data source',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.2 DISCOVER_DATASOURCES; XMLA 1.1, "DISCOVER_DATASOURCES"',
    async run(context) {
      const result = await context.client().discover('DISCOVER_DATASOURCES');
      if (result.rows.length === 0) {
        throw new Error('no rows: a client cannot open a connection to a server that names no data source');
      }
      const first = result.rows[0]!;
      const name = text(first, 'DataSourceName');
      if (name === '') {
        throw new Error('the first row has no DataSourceName');
      }
      return `${result.rows.length} row(s); DataSourceName=${JSON.stringify(name)}, DataSourceInfo=${JSON.stringify(
        text(first, 'DataSourceInfo'),
      )}`;
    },
  },
  {
    id: 'C4',
    group: 'connection',
    title: 'the data source says how to authenticate, in the words the specification gives',
    level: 'should',
    spec: 'XMLA 1.1, "DISCOVER_DATASOURCES": AuthenticationMode is Unauthenticated, Authenticated or Integrated',
    async run(context) {
      const result = await context.client().discover('DISCOVER_DATASOURCES');
      const first = result.rows[0];
      if (first === undefined) {
        throw new Error('no rows');
      }
      const mode = text(first, 'AuthenticationMode');
      if (!['Unauthenticated', 'Authenticated', 'Integrated'].includes(mode)) {
        throw new Error(`AuthenticationMode is ${JSON.stringify(mode)}`);
      }
      return mode;
    },
  },
  {
    id: 'C5',
    group: 'connection',
    title: 'open() runs the order a server expects, and the DataSourceInfo it names is accepted back',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.2: the DataSourceInfo a server names is what a client sends on every later request',
    async run(context) {
      const { client, info } = await context.connected();
      // The first request that carries the DataSourceInfo back. A server that
      // keys on it and refuses its own value is one no client can talk to.
      const catalogs = await client.discover('DBSCHEMA_CATALOGS');
      return `DataSourceInfo=${JSON.stringify(info.dataSource.info)}, auth=${info.dataSource.authenticationMode}, catalog=${JSON.stringify(
        info.currentCatalog,
      )}; ${catalogs.rows.length} catalog(s) answered with it`;
    },
  },
  {
    id: 'C6',
    group: 'connection',
    title: 'a restriction on DISCOVER_PROPERTIES narrows the answer to that property',
    level: 'must',
    spec: 'XMLA 1.1, "Discover": Restrictions filter the rowset; [MS-SSAS] 3.1.4.2.2.1.3.7 PropertyName restriction',
    async run(context) {
      const { client } = await context.connected();
      const result = await client.discover('DISCOVER_PROPERTIES', [{ name: 'PropertyName', value: 'Catalog' }]);
      const others = result.rows.map((row) => text(row, 'PropertyName')).filter((name) => name !== 'Catalog');
      if (others.length > 0) {
        throw new Error(`asked for Catalog, answered ${others.slice(0, 3).join(', ')} as well`);
      }
      if (result.rows.length > 1) {
        throw new Error(`asked for one property, answered ${result.rows.length} rows`);
      }
      return result.rows.length === 0 ? 'no Catalog row (allowed: none is current)' : `Catalog=${JSON.stringify(text(result.rows[0]!, 'Value'))}`;
    },
  },
  {
    id: 'C7',
    group: 'connection',
    title: 'the MDX capability masks are readable',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.7: MdpropMdxSubqueries, MdpropMdxFormulas and the other bitmasks',
    async run(context) {
      const { info } = await context.connected();
      const named = ['MdpropMdxSubqueries', 'MdpropMdxFormulas', 'MdpropMdxDrillFunctions', 'MdpropMdxNamedSets'];
      const present = named.filter((name) => info.properties.has(name));
      if (present.length === 0) {
        throw new Error(`none of ${named.join(', ')} is reported`);
      }
      const held = (['MDPROPVAL_MSQ_BASIC', 'MDPROPVAL_MF_WITH_CALCMEMBERS', 'MDPROPVAL_MF_CREATE_CALCMEMBERS'] as const).filter(
        (bit) => info.capabilities.has(bit),
      );
      return `${present.length} of ${named.length} masks; subqueries=${info.capabilities.subqueries}, formulas=${info.capabilities.formulas}; ${
        held.length === 0 ? 'none of the three bits asked about' : held.join(', ')
      }`;
    },
  },
  {
    id: 'C8',
    group: 'connection',
    title: 'the catalog the server calls current is one it lists',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.7: the Catalog property; DBSCHEMA_CATALOGS lists what it may name',
    async run(context) {
      const { client, info } = await context.connected();
      if (info.currentCatalog === null) {
        return 'no current catalog, nothing to compare';
      }
      const catalogs = await client.discover('DBSCHEMA_CATALOGS');
      const names = catalogs.rows.map((row) => text(row, 'CATALOG_NAME'));
      if (!names.includes(info.currentCatalog)) {
        throw new Error(`current is ${JSON.stringify(info.currentCatalog)}, listed are ${names.join(', ')}`);
      }
      return info.currentCatalog;
    },
  },
];
