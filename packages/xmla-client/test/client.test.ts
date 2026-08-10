/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { wireNameOf } from '@daanse/emf-xml';
import { XmlaFaultError } from '@daanse/xmla-io';
import { XMLA_NAMESPACES } from '@daanse/xmla-model';
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
import { conversation, FixtureTransport } from '@daanse/xmla-testkit';
import type { XmlaModels } from '@daanse/xmla-model';
import { beforeAll, describe, expect, it } from 'vitest';

import { XmlaClient } from '../src/client.js';
import { sessionIdOf } from '../src/session.js';
import { XmlaHttpError } from '../src/transport.js';

let models: XmlaModels;

beforeAll(() => {
  models = bootstrapFromDisk();
});

function clientOver(transport: FixtureTransport, sessionId: string | null = null): XmlaClient {
  return new XmlaClient({ url: 'http://server/xmla', transport, models, sessionId });
}

/** The response recorded for the request at `position` in a conversation. */
function responseAfter(name: string, requestType: string): string {
  const each = conversation(name);
  for (let i = 0; i < each.messages.length - 1; i++) {
    const request = each.messages[i]!;
    const response = each.messages[i + 1]!;
    if (request.requestType === requestType && response.direction === 'response') {
      return each.text(response.file);
    }
  }
  throw new Error(`no recorded ${requestType} in ${name}`);
}

describe('sending a request', () => {
  it('quotes the SOAPAction, as every recorded client does', async () => {
    // A bare value is refused by some gateways and silently ignored by others,
    // and RFC 2616 defines the field as a quoted-string.
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    await clientOver(transport).discover('DISCOVER_DATASOURCES');

    expect(transport.sent[0]!.headers['SOAPAction']).toBe(`"${XMLA_NAMESPACES.SOAP_ACTION_DISCOVER}"`);
  });

  it('names the Execute action for an Execute', async () => {
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    await clientOver(transport).execute(null);

    expect(transport.sent[0]!.headers['SOAPAction']).toBe(`"${XMLA_NAMESPACES.SOAP_ACTION_EXECUTE}"`);
  });

  it('sends Basic credentials up front rather than waiting to be challenged', async () => {
    // XMLA servers commonly answer an unauthenticated request with a fault
    // instead of a WWW-Authenticate, so waiting to be asked means never being
    // asked.
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    const client = clientOver(transport).withCredentials({
      kind: 'basic',
      username: 'aladdin',
      password: 'open sesame',
    });
    await client.discover('DISCOVER_DATASOURCES');

    expect(transport.sent[0]!.headers['Authorization']).toBe('Basic YWxhZGRpbjpvcGVuIHNlc2FtZQ==');
  });

  it('sets the content type XMLA servers expect', async () => {
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    await clientOver(transport).discover('DISCOVER_DATASOURCES');

    expect(transport.sent[0]!.headers['Content-Type']).toBe('text/xml; charset=utf-8');
  });
});

describe('reading a response', () => {
  it('reads the rows into the class the model names for the request type', async () => {
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    const result = await clientOver(transport).discover('DISCOVER_DATASOURCES');

    expect(result.rows.length).toBeGreaterThan(0);
    const first = result.rows[0]!;
    const names = [...(first.eClass().getEAllStructuralFeatures() as never as Array<never>)]
      .filter((feature) => first.eIsSet(feature))
      .map((feature) => wireNameOf(feature));

    // DISCOVER_DATASOURCES names its columns in mixed case, unlike the
    // MDSCHEMA and DBSCHEMA rowsets. The adapter must not transform them.
    expect(names).toContain('DataSourceName');
  });

  it('hands back the inline schema, so it need not be asked for twice', async () => {
    // The dynamic path builds an EClass from exactly this, and a second request
    // to get it would be a second round trip for something already received.
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    const result = await clientOver(transport).discover('DISCOVER_DATASOURCES');

    expect(result.inlineSchema).toBeTruthy();
    expect(result.inlineSchema).toContain('element');
  });

  it('refuses a request type it has no class for, rather than answering nothing', async () => {
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));

    await expect(clientOver(transport).discover('DISCOVER_RESOURCE_POOLS')).rejects.toThrow(
      /no row class for DISCOVER_RESOURCE_POOLS/,
    );
  });
});

describe('when the server refuses', () => {
  const fault = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="${XMLA_NAMESPACES.SOAP_ENV}"><soap:Body><soap:Fault>
<faultcode>XMLAnalysisError.0xc10c0007</faultcode>
<faultstring>Server command results cannot be found</faultstring>
<detail><Error xmlns="${XMLA_NAMESPACES.EXCEPTION}" ErrorCode="3238133767"
  Description="The CubeName restriction is not valid." Source="Microsoft SQL Server 2016 Analysis Services"/>
</detail></soap:Fault></soap:Body></soap:Envelope>`;

  it('raises the fault rather than failing to parse a response that has no rows', async () => {
    // The fault is checked before the body is read. Parsing first would replace
    // the server's own explanation with a complaint about a missing <root>.
    const transport = FixtureTransport.answering(fault);

    await expect(clientOver(transport).discover('MDSCHEMA_CUBES')).rejects.toThrow(XmlaFaultError);
  });

  it('carries both what the fault said and what its detail said', async () => {
    // A SOAP 1.1 fault puts its children unqualified, and what a server really
    // says lives in the attributes of <Error> rather than in its text.
    const transport = FixtureTransport.answering(fault);

    try {
      await clientOver(transport).discover('MDSCHEMA_CUBES');
      expect.unreachable('should have raised');
    } catch (error) {
      const details = (error as XmlaFaultError).details;
      expect(details).toContain('Server command results cannot be found');
      expect(details).toContain('The CubeName restriction is not valid.');
    }
  });

  it('prefers the fault to the status code when both say something', async () => {
    const transport = new FixtureTransport([]);
    transport.send = () => Promise.resolve({ status: 500, body: fault, headers: {} });

    await expect(clientOver(transport).discover('MDSCHEMA_CUBES')).rejects.toThrow(XmlaFaultError);
  });

  it('reports the status when the body says nothing', async () => {
    const transport = new FixtureTransport([]);
    transport.send = () => Promise.resolve({ status: 503, body: 'Service Unavailable', headers: {} });

    await expect(clientOver(transport).discover('MDSCHEMA_CUBES')).rejects.toThrow(XmlaHttpError);
  });
});

describe('sessions', () => {
  it('finds the id in the response to a BeginSession', () => {
    const each = conversation('ssms-session');
    const begin = each.messages.find(
      (message) => message.direction === 'response' && message.file.includes('BeginSession'),
    );
    expect(begin, 'the recording has a BeginSession response').toBeTruthy();

    expect(sessionIdOf(each.text(begin!.file))).toBeTruthy();
  });

  it('carries the session on every later request', async () => {
    const each = conversation('ssms-session');
    const begin = each.messages.find(
      (message) => message.direction === 'response' && message.file.includes('BeginSession'),
    )!;
    const transport = FixtureTransport.answering(
      each.text(begin.file),
      responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'),
    );

    const opened = await clientOver(transport).beginSession();
    expect(opened.sessionId).toBeTruthy();

    await opened.discover('DISCOVER_DATASOURCES');
    // Byte for byte what SSMS and Excel send, short form and all.
    expect(transport.sent[1]!.body).toContain(
      `<Session xmlns="${XMLA_NAMESPACES.XMLA}" SessionId="${opened.sessionId}"/>`,
    );
  });

  it('leaves the client it was opened from without a session', async () => {
    // Immutability is not decoration here: a session opening underneath a caller
    // already using the sessionless client would change what that caller sends.
    const each = conversation('ssms-session');
    const begin = each.messages.find(
      (message) => message.direction === 'response' && message.file.includes('BeginSession'),
    )!;
    const transport = FixtureTransport.answering(each.text(begin.file));

    const before = clientOver(transport);
    const after = await before.beginSession();

    expect(before.sessionId).toBeNull();
    expect(after.sessionId).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('does not displace the other header blocks when it sets a session', async () => {
    // The Java client replaces the header list wholesale when it sets a
    // session, which drops a block the caller had asked for. That is the one
    // behaviour deliberately not carried over.
    const soap = models.named('soap')!;
    const versionClass = soap.getEClassifier('VersionHeader')!;
    const version = soap.getEFactoryInstance().create(versionClass);
    version.eSet(versionClass.getEStructuralFeature('sequence')!, 200);

    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));
    const client = new XmlaClient({
      url: 'http://server/xmla',
      transport,
      models,
      sessionId: 'S-1',
      extraSoapHeaders: [version],
    });
    await client.discover('DISCOVER_DATASOURCES');

    const sent = transport.sent[0]!.body;
    expect(sent, 'the session block').toContain('SessionId="S-1"');
    expect(sent, 'the block the caller asked for').toContain('<Version');
  });

  it('opens a session with an empty <Statement>, as every recorded client does', async () => {
    // Found by talking to a real server, not by reading recordings. An empty
    // <Command> with nothing inside is refused by a server that checks - the
    // Daanse one answers "the Execute request carries no command" - and a
    // recording of what a client sends never says what a server would refuse.
    const each = conversation('excel-pivot');
    const recorded = each.messages.find((message) => message.file.includes('request-execute-BeginSession'));
    expect(recorded, 'the corpus has a real BeginSession request').toBeTruthy();
    expect(each.text(recorded!.file), 'what Excel sends').toContain('<Command><Statement');

    const transport = FixtureTransport.answering(
      conversation('ssms-session').text(
        conversation('ssms-session').messages.find(
          (message) => message.direction === 'response' && message.file.includes('BeginSession'),
        )!.file,
      ),
    );
    await clientOver(transport).beginSession();

    expect(transport.sent[0]!.body, 'what we send').toContain('<Command><Statement/></Command>');
  });

  it('says so when the server opens no session', async () => {
    const transport = FixtureTransport.answering(responseAfter('ssms-connect', 'DISCOVER_DATASOURCES'));

    await expect(clientOver(transport).beginSession()).rejects.toThrow(/carried no <Session SessionId>/);
  });

  it('does nothing when asked to end a session it never had', async () => {
    const transport = FixtureTransport.answering();
    const client = clientOver(transport);

    expect(await client.endSession()).toBe(client);
    expect(transport.sent).toHaveLength(0);
  });
});
