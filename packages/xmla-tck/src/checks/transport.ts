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
import type { Transport, XmlaHttpRequest, XmlaHttpResponse } from '@daanse/xmla-client';
import { XmlaFaultError } from '@daanse/xmla-io';
import type { EClass, EObject } from '@emfts/core';

import { fetchWithDeadline, short } from '../kit.js';
import type { Check } from '../kit.js';

/**
 * The wire: whether anything answers, and whether what answers is XMLA.
 *
 * T1 is the reachability probe. The runner stops after it when it fails,
 * because every later check would fail for the same reason and say less.
 */
export const transport: readonly Check[] = [
  {
    id: 'T1',
    group: 'transport',
    title: 'the endpoint answers a POST',
    level: 'must',
    spec: 'XMLA 1.1, "XML for Analysis Methods": Discover and Execute are SOAP calls over HTTP POST',
    async run(context) {
      const { url } = context.profile;
      const deadline = Date.now() + (context.profile.waitMs ?? 0);
      const fetch = fetchWithDeadline(context.profile.timeoutMs ?? 30_000);
      let lastError = 'no answer';
      do {
        try {
          // Anything that answers is enough; a bad request is still a server.
          const response = await fetch(url, { method: 'POST', body: '', headers: { 'Content-Type': 'text/xml' } });
          await response.text();
          return `HTTP ${response.status} to an empty POST`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error(`nothing answered at ${url}: ${short(lastError, 120)}`);
    },
  },
  {
    id: 'T2',
    group: 'transport',
    title: 'a Discover answers a DiscoverResponse whose root carries rows and an inline schema',
    level: 'must',
    spec: '[MS-SSAS] 2.2.4.1.1 DiscoverResponse; XMLA 1.1, "Discover" - the return element is a rowset with its schema inline',
    async run(context) {
      const result = await context.client().discover('DISCOVER_DATASOURCES');
      if (result.inlineSchema === null) {
        throw new Error('the response carried no inline xsd:schema, so the dynamic path has nothing to work from');
      }
      if (!result.inlineSchema.includes('targetNamespace')) {
        throw new Error('the inline schema lost its targetNamespace');
      }
      return `${result.rows.length} row(s), schema of ${result.inlineSchema.length} bytes`;
    },
  },
  {
    id: 'T3',
    group: 'transport',
    title: 'a request type the server does not know answers a SOAP Fault, reported as one',
    level: 'must',
    spec: 'SOAP 1.1 §4.4 Fault; [MS-SSAS] 2.2.4.1.2 - an error in a Discover is returned as a SOAP fault',
    async run(context) {
      try {
        await context.client().discoverRaw('DISCOVER_NO_SUCH_ROWSET_FOR_THE_TCK');
      } catch (error) {
        if (error instanceof XmlaFaultError) {
          return `fault: ${short(error.message, 120)}`;
        }
        // An HTTP status alone is a refusal a client cannot read anything from.
        throw new Error(`refused, but not with a fault this client can read: ${short(messageOf(error), 160)}`);
      }
      throw new Error('the server answered rows for a rowset that does not exist');
    },
  },
  {
    id: 'T4',
    group: 'transport',
    title: 'a ProtocolCapabilities header is accepted, and the request answered as without it',
    level: 'should',
    spec: '[MS-SSAS] 2.2.3.4 ProtocolCapabilities: a client announces what it can read; a server ignores what it does not know',
    async run(context) {
      const { client } = await context.connected();
      const soap = context.models.named('soap');
      const eClass = soap?.getEClassifier('ProtocolCapabilitiesHeader') as EClass | null | undefined;
      if (soap === null || eClass === null || eClass === undefined) {
        throw new Error('the soap model has no ProtocolCapabilitiesHeader');
      }
      const header: EObject = soap.getEFactoryInstance().create(eClass);
      const capability = eClass.getEStructuralFeature('capability');
      if (capability !== null && capability !== undefined) {
        // sX4 is what ADOMD.NET announces: the normalised tuple set.
        if (capability.isMany()) {
          (header.eGet(capability) as unknown as { add(value: string): void }).add('sX4');
        } else {
          header.eSet(capability, 'sX4');
        }
      }
      const announcing = new XmlaClient({
        url: context.profile.url,
        transport: context.transport,
        models: context.models,
        ...(context.profile.credentials === undefined ? {} : { credentials: context.profile.credentials }),
        connectionProperties: client.connectionProperties,
        extraSoapHeaders: [header],
      });
      const result = await announcing.discover('DISCOVER_DATASOURCES');
      const plain = await client.discover('DISCOVER_DATASOURCES');
      if (result.rows.length !== plain.rows.length) {
        throw new Error(`${result.rows.length} row(s) with the header, ${plain.rows.length} without`);
      }
      return `${result.rows.length} row(s), as without the header`;
    },
  },
  {
    id: 'T5',
    group: 'transport',
    title: 'a fault carries an error code beside its description',
    level: 'should',
    spec: '[MS-SSAS] 2.2.4.1.2 / 2.2.4.2.2: the fault detail is an Error element with ErrorCode and Description',
    async run(context) {
      const bytes = new Recording(context.transport);
      const client = new XmlaClient({
        url: context.profile.url,
        transport: bytes,
        models: context.models,
        ...(context.profile.credentials === undefined ? {} : { credentials: context.profile.credentials }),
      });
      try {
        await client.discoverRaw('DISCOVER_NO_SUCH_ROWSET_FOR_THE_TCK');
      } catch (error) {
        if (!(error instanceof XmlaFaultError)) {
          throw new Error(`no fault to look at: ${short(error instanceof Error ? error.message : String(error), 100)}`);
        }
        const body = bytes.last?.body ?? '';
        const code = /ErrorCode="([^"]*)"/.exec(body)?.[1] ?? /<(?:\w+:)?ErrorCode>([^<]*)</.exec(body)?.[1];
        const faultcode = /<faultcode>([^<]*)</.exec(body)?.[1];
        if (code === undefined || code === '') {
          throw new Error(`the fault names no ErrorCode${faultcode === undefined ? '' : ` (faultcode ${faultcode})`}`);
        }
        return `ErrorCode ${code}${faultcode === undefined ? '' : `, faultcode ${faultcode}`}`;
      }
      throw new Error('no fault to look at: the server answered rows');
    },
  },
];

/** A transport that remembers the last answer, for a check about the bytes of a fault. */
class Recording implements Transport {
  last: XmlaHttpResponse | null = null;

  constructor(private readonly inner: Transport) {}

  async send(request: XmlaHttpRequest): Promise<XmlaHttpResponse> {
    const response = await this.inner.send(request);
    this.last = response;
    return response;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
