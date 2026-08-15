/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
import type { XmlaModels } from '@daanse/xmla-model';
import { beforeAll, describe, expect, it } from 'vitest';

import { capabilitiesOf, propertiesOf } from '../src/connect.js';
import { XmlaClient } from '../src/client.js';
import { XmlaHttpError } from '../src/transport.js';
import type { Transport, XmlaHttpRequest, XmlaHttpResponse } from '../src/transport.js';

/**
 * Opening a connection, against a server that answers from a script.
 *
 * The order matters and so does what each step reads, so this drives a stand-in
 * transport rather than a live server: a recording says what a client sent, and
 * only a stand-in says what it does with an answer it does not like.
 */
let models: XmlaModels;

beforeAll(() => {
  models = bootstrapFromDisk();
});

const ROWSET_NS = 'urn:schemas-microsoft-com:xml-analysis:rowset';

function envelope(rows: string): string {
  return (
    '<?xml version="1.0"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
    '<DiscoverResponse xmlns="urn:schemas-microsoft-com:xml-analysis"><return>' +
    `<root xmlns="${ROWSET_NS}">${rows}</root>` +
    '</return></DiscoverResponse></soap:Body></soap:Envelope>'
  );
}

const PROPERTIES = envelope(
  '<row><PropertyName>MdpropMdxSubqueries</PropertyName><Value>1</Value></row>' +
    '<row><PropertyName>MdpropMdxFormulas</PropertyName><Value>3</Value></row>' +
    '<row><PropertyName>MdpropMdxDdlExtensions</PropertyName><Value>0</Value></row>',
);

const DATASOURCES = envelope(
  '<row><DataSourceName>Daanse</DataSourceName><DataSourceInfo>fedora</DataSourceInfo>' +
    '<ProviderName>Daanse</ProviderName><AuthenticationMode>Authenticated</AuthenticationMode></row>',
);

const CURRENT_CATALOG = envelope('<row><PropertyName>Catalog</PropertyName><Value>FoodMart</Value></row>');

/** A transport that answers from a queue and remembers what it was asked. */
class Scripted implements Transport {
  readonly sent: XmlaHttpRequest[] = [];

  constructor(private readonly answers: XmlaHttpResponse[]) {}

  send(request: XmlaHttpRequest): Promise<XmlaHttpResponse> {
    this.sent.push(request);
    const answer = this.answers.shift();
    if (answer === undefined) {
      throw new Error(`no scripted answer for request ${this.sent.length}`);
    }
    return Promise.resolve(answer);
  }
}

function ok(body: string): XmlaHttpResponse {
  return { status: 200, body, headers: {} };
}

function client(transport: Transport, credentials?: XmlaClient['options'] extends never ? never : undefined) {
  void credentials;
  return new XmlaClient({ url: 'http://server/xmla', transport, models });
}

function requestTypeOf(request: XmlaHttpRequest): string | null {
  return /<RequestType>([A-Z_]+)<\/RequestType>/.exec(request.body)?.[1] ?? null;
}

describe('opening a connection', () => {
  it('asks in the order a server expects, and no further', async () => {
    const transport = new Scripted([ok(PROPERTIES), ok(DATASOURCES), ok(CURRENT_CATALOG)]);

    const { info } = await client(transport).open();

    expect(transport.sent.map(requestTypeOf)).toEqual([
      'DISCOVER_PROPERTIES',
      'DISCOVER_DATASOURCES',
      'DISCOVER_PROPERTIES',
    ]);
    // DISCOVER_SCHEMA_ROWSETS is the largest answer a server gives and belongs
    // on first use, not here.
    expect(transport.sent.map(requestTypeOf)).not.toContain('DISCOVER_SCHEMA_ROWSETS');
    expect(info.dataSource.info).toBe('fedora');
    expect(info.dataSource.authenticationMode).toBe('Authenticated');
    expect(info.currentCatalog).toBe('FoodMart');
  });

  it('sends the DataSourceInfo back on every later request', async () => {
    const transport = new Scripted([ok(PROPERTIES), ok(DATASOURCES), ok(CURRENT_CATALOG), ok(envelope(''))]);

    const { client: connected } = await client(transport).open();
    await connected.discover('DBSCHEMA_CATALOGS');

    // The third is already the liveness probe, sent through the connected
    // client - so from there on every body carries it.
    expect(transport.sent[2]!.body).toContain('<DataSourceInfo>fedora</DataSourceInfo>');
    expect(transport.sent[3]!.body).toContain('<DataSourceInfo>fedora</DataSourceInfo>');
    expect(transport.sent[0]!.body, 'not before the server has named it').not.toContain('DataSourceInfo');
  });

  it('refuses a server that names no data source', async () => {
    const transport = new Scripted([ok(PROPERTIES), ok(envelope(''))]);

    await expect(client(transport).open()).rejects.toThrow(/no rows/i);
  });

  it('refuses a DataSourceInfo with nothing in it', async () => {
    // Exactly what cost a real client its connection: the column was declared
    // in the inline schema and empty in the row.
    const empty = envelope('<row><DataSourceName>Daanse</DataSourceName><DataSourceInfo/></row>');
    const transport = new Scripted([ok(PROPERTIES), ok(empty)]);

    await expect(client(transport).open()).rejects.toThrow(/DataSourceInfo/);
  });
});

describe('a server that challenges', () => {
  const challenge: XmlaHttpResponse = {
    status: 401,
    body: '',
    headers: { 'WWW-Authenticate': 'Basic realm="Daanse Probe"' },
  };

  it('is answered once, not twice', async () => {
    const transport = new Scripted([challenge, ok(PROPERTIES)]);
    const authenticated = new XmlaClient({
      url: 'http://server/xmla',
      transport,
      models,
      credentials: { kind: 'basic', username: 'probe|Administrator', password: 'x' },
    });

    await authenticated.discover('DISCOVER_PROPERTIES');

    expect(transport.sent).toHaveLength(2);
    for (const request of transport.sent) {
      expect(request.headers['Authorization'], 'sent up front as well').toMatch(/^Basic /);
    }
  });

  it('is reported rather than retried when there is nothing to send', async () => {
    const transport = new Scripted([challenge]);

    await expect(client(transport).discover('DISCOVER_PROPERTIES')).rejects.toThrow(XmlaHttpError);
    expect(transport.sent, 'no point asking again with the same nothing').toHaveLength(1);
  });

  it('is reported when it asks for Basic and the client holds a token', async () => {
    const transport = new Scripted([challenge]);
    const bearer = new XmlaClient({
      url: 'http://server/xmla',
      transport,
      models,
      credentials: { kind: 'bearer', token: 'abc' },
    });

    await expect(bearer.discover('DISCOVER_PROPERTIES')).rejects.toThrow(XmlaHttpError);
    expect(transport.sent).toHaveLength(1);
  });
});

describe('what the server says it can do', () => {
  it('reads the MDX masks as named bits', () => {
    const properties = propertiesOf([]);
    properties.set('MdpropMdxSubqueries', '1');
    properties.set('MdpropMdxFormulas', '3');
    properties.set('MdpropMdxDdlExtensions', '0');
    const capabilities = capabilitiesOf(properties);

    expect(capabilities.has('MDPROPVAL_MSQ_BASIC'), 'subselects without arbitrary shapes').toBe(true);
    expect(capabilities.has('MDPROPVAL_MSQ_ARBITRARYSHAPE')).toBe(false);
    expect(capabilities.has('MDPROPVAL_MF_WITH_CALCMEMBERS')).toBe(true);
    expect(capabilities.has('MDPROPVAL_MF_WITH_NAMEDSETS')).toBe(true);
    expect(capabilities.has('MDPROPVAL_MF_CREATE_CALCMEMBERS'), 'no standalone CREATE').toBe(false);
    expect(capabilities.ddlExtensions).toBe(0);
  });

  it('reads a missing mask as claiming nothing', () => {
    const capabilities = capabilitiesOf(new Map());

    expect(capabilities.subqueries).toBe(0);
    expect(capabilities.has('MDPROPVAL_MSQ_BASIC')).toBe(false);
  });
});
