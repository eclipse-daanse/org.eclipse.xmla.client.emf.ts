/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { XMLA_NAMESPACES } from '@daanse/xmla-model';
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
import { conversation, FixtureTransport } from '@daanse/xmla-testkit';
import type { XmlaModels } from '@daanse/xmla-model';
import { beforeAll, describe, expect, it } from 'vitest';

import { WorkbenchXmlaClient } from '../src/workbench-client.js';

/**
 * The adapter against the surface mdx-workbench actually consumes.
 *
 * `@mdx-workbench/xmla-soap` exposes `XmlaSoapClient` with `connect`,
 * `discover`, `execute`, `endSession`, `setCatalog` and `currentSessionId`, and
 * answers `Array<Record<string, unknown>>` and `XmlaCellset`. If swapping is to
 * be one import, this has to match all of it - so the shapes are asserted here
 * rather than assumed to line up.
 */
let models: XmlaModels;

beforeAll(() => {
  models = bootstrapFromDisk();
});

function responseFor(requestType: string): string {
  for (const each of ['ssms-connect', 'excel-pivot', 'powerbi-live']) {
    const recorded = conversation(each);
    let pending: string | undefined;
    for (const message of recorded.messages) {
      if (message.direction === 'request') {
        pending = message.requestType;
        continue;
      }
      if (pending === requestType && message.rows !== undefined) {
        return recorded.text(message.file);
      }
      pending = undefined;
    }
  }
  throw new Error(`no recorded ${requestType}`);
}

function clientOver(transport: FixtureTransport, options: Partial<{ catalog: string; useSession: boolean }> = {}) {
  return new WorkbenchXmlaClient({
    url: 'http://server/xmla',
    transport,
    models,
    dataSourceInfo: 'Provider=Daanse',
    ...options,
  });
}

describe('the surface mdx-workbench consumes', () => {
  it('has every method XmlaSoapClient has', () => {
    const client = clientOver(FixtureTransport.answering());

    // Named one by one rather than by counting: a missing method is what makes
    // the swap more than one import.
    for (const name of ['connect', 'discover', 'execute', 'endSession', 'setCatalog']) {
      expect(typeof (client as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
    expect('currentSessionId' in client).toBe(true);
    // undefined rather than null, which is what the SOAP client answers.
    expect(client.currentSessionId).toBeUndefined();
  });

  it('answers a discover as plain records, keyed as the wire names them', async () => {
    const transport = FixtureTransport.answering(responseFor('DISCOVER_DATASOURCES'));

    const rows = await clientOver(transport).discover('DISCOVER_DATASOURCES');

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // Not DATA_SOURCE_NAME: this rowset names its columns in mixed case, and the
    // workbench looks for exactly this.
    expect(Object.keys(rows[0]!)).toContain('DataSourceName');
  });

  it('connects by listing the catalogs, as the SOAP client does', async () => {
    const transport = FixtureTransport.answering(responseFor('DBSCHEMA_CATALOGS'));

    const { catalogs } = await clientOver(transport).connect();

    expect(Array.isArray(catalogs)).toBe(true);
    expect(catalogs.length).toBeGreaterThan(0);
    expect(Object.keys(catalogs[0]!)).toContain('CATALOG_NAME');
  });

  it('opens a session on connect when asked, and reports its id', async () => {
    const session = conversation('ssms-session');
    const begin = session.messages.find(
      (message) => message.direction === 'response' && message.file.includes('BeginSession'),
    )!;
    const transport = FixtureTransport.answering(session.text(begin.file), responseFor('DBSCHEMA_CATALOGS'));

    const client = clientOver(transport, { useSession: true });
    await client.connect();

    expect(client.currentSessionId).toBeTruthy();
    expect(transport.sent[1]!.body, 'the catalogs went out inside the session').toContain('<Session');
  });

  it('sends the catalog it was given, and the one it was later told', async () => {
    const transport = FixtureTransport.answering(
      responseFor('DBSCHEMA_CATALOGS'),
      responseFor('DBSCHEMA_CATALOGS'),
    );
    const client = clientOver(transport, { catalog: 'First' });

    await client.discover('DBSCHEMA_CATALOGS');
    expect(transport.sent[0]!.body).toContain('<Catalog>First</Catalog>');

    client.setCatalog('Second');
    await client.discover('DBSCHEMA_CATALOGS');
    expect(transport.sent[1]!.body).toContain('<Catalog>Second</Catalog>');
  });

  it('passes restrictions through, and leaves out the empty ones', async () => {
    const transport = FixtureTransport.answering(responseFor('DBSCHEMA_CATALOGS'));

    await clientOver(transport).discover('DBSCHEMA_CATALOGS', {
      CATALOG_NAME: 'Adventure Works',
      SCHEMA_NAME: '',
      UNSET: undefined,
    });

    const sent = transport.sent[0]!.body;
    expect(sent).toContain('<CATALOG_NAME>Adventure Works</CATALOG_NAME>');
    expect(sent, 'an empty restriction is not a filter for the empty string').not.toContain('SCHEMA_NAME');
    expect(sent).not.toContain('UNSET');
  });
});

describe('what the swap buys', () => {
  it('reads a rowset the models never described, which the SOAP client could not', async () => {
    // The DOM parser it replaces reads whatever arrives, but has no way to tell
    // a column's type or to know a rowset exists. This reads it against a class
    // built from the schema the response carried.
    const transport = FixtureTransport.answering(responseFor('DBSCHEMA_CATALOGS'));

    const rows = await clientOver(transport).discover('DISCOVER_RESOURCE_POOLS');

    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!)).toContain('CATALOG_NAME');
  });

  it('gives a nested rowset as a nested record, not as [object Object]', async () => {
    const transport = FixtureTransport.answering(responseFor('DISCOVER_SCHEMA_ROWSETS'));

    const rows = await clientOver(transport).discover('DISCOVER_SCHEMA_ROWSETS');
    const restrictions = rows[0]!['Restrictions'] as Array<Record<string, unknown>>;

    expect(Array.isArray(restrictions)).toBe(true);
    expect(restrictions[0]).toHaveProperty('Name');
    expect(String(restrictions[0]!['Name'])).not.toBe('[object Object]');
  });

  it('reads a tabular answer as a cellset, so a DMV lands in the same grid', async () => {
    // A DMV or a DRILLTHROUGH answers a rowset rather than an mddataset, and
    // which one came back is read off the namespace of <root> rather than
    // guessed from the statement text.
    const transport = FixtureTransport.answering(responseFor('DBSCHEMA_CATALOGS'));

    const cellset = await clientOver(transport).execute('SELECT * FROM $SYSTEM.DBSCHEMA_CATALOGS');

    expect(cellset.axes.length, 'columns on one axis, rows on the other').toBe(2);
    expect(cellset.axes[0]!.tuples.length, 'a column per column').toBeGreaterThan(0);
    expect(cellset.cells.length).toBeGreaterThan(0);
    expect(cellset.cellCount).toBe(cellset.cells.length);
    expect(cellset.axes[0]!.tuples.some((tuple) => tuple[0]!.caption === 'CATALOG_NAME')).toBe(true);
  });

  it('reads a multidimensional answer as the same cellset', async () => {
    const statement = conversation('ssms-session').messages.find(
      (message) => message.direction === 'response' && message.file.includes('execute-Statement'),
    )!;
    const transport = FixtureTransport.answering(conversation('ssms-session').text(statement.file));

    const cellset = await clientOver(transport).execute('SELECT FROM [Adventure Works]');

    expect(cellset.axes.length).toBeGreaterThan(0);
    expect(cellset.cells.length).toBeGreaterThan(0);
  });

  it('sends the MDX as a <Statement>, which is what a server dispatches on', async () => {
    const statement = conversation('ssms-session').messages.find(
      (message) => message.direction === 'response' && message.file.includes('execute-Statement'),
    )!;
    const transport = FixtureTransport.answering(conversation('ssms-session').text(statement.file));

    await clientOver(transport).execute('SELECT FROM [Adventure Works]');

    const sent = transport.sent[0]!.body;
    expect(sent).toContain('<Command><Statement>SELECT FROM [Adventure Works]</Statement></Command>');
    expect(transport.sent[0]!.headers['SOAPAction']).toBe(`"${XMLA_NAMESPACES.SOAP_ACTION_EXECUTE}"`);
  });
});
