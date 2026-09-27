/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wireNameOf, XmlCursor } from '@eclipse-daanse/emf-xml';
import { XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import { bootstrapFromDisk } from '@eclipse-daanse/xmla-model/node';
import type { XmlaModels } from '@eclipse-daanse/xmla-model';
import type { EObject, EStructuralFeature } from '@emfts/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { RequestReader } from '../src/read-requests.js';
import { SoapEnvelopeCodec } from '../src/envelope.js';
import { writeDiscover, writeExecute } from '../src/requests.js';
import { XmlWriter } from '@eclipse-daanse/emf-xml';

/**
 * Every recorded request, read and compared against its manifest.
 *
 * The manifests carry the headers, the request type, the restrictions and the
 * properties of each message - facts captured from real clients rather than
 * derived here. Reading a request and getting them back is what says this
 * understands what Excel, Power BI and SSMS actually send.
 */
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'testkit',
  'fixtures',
  'conversations',
);

interface RecordedMessage {
  readonly file: string;
  readonly direction: 'request' | 'response';
  readonly headers: readonly string[];
  readonly headerNamespaces: readonly string[];
  readonly requestType?: string;
  readonly restrictions?: Readonly<Record<string, string>>;
  readonly properties?: Readonly<Record<string, string>>;
  readonly bodyElement?: string;
}

interface Case {
  readonly label: string;
  readonly path: string;
  readonly message: RecordedMessage;
}

function requests(): Case[] {
  const found: Case[] = [];
  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(FIXTURES, entry.name);
    const manifest = JSON.parse(readFileSync(join(directory, '_manifest.json'), 'utf8')) as {
      messages: RecordedMessage[];
    };
    for (const message of manifest.messages) {
      if (message.direction === 'request') {
        found.push({ label: `${entry.name}/${message.file}`, path: join(directory, message.file), message });
      }
    }
  }
  return found.sort((a, b) => (a.label < b.label ? -1 : 1));
}

let models: XmlaModels;
let codec: SoapEnvelopeCodec;
let reader: RequestReader;

beforeAll(() => {
  models = bootstrapFromDisk();
  codec = new SoapEnvelopeCodec(models);
  reader = new RequestReader(models);
});

/** A PropertyList as the flat map the manifests record. */
function propertiesOf(propertyList: EObject | null): Record<string, string> {
  if (propertyList === null) {
    return {};
  }
  const flat: Record<string, string> = {};
  const features = propertyList.eClass().getEAllStructuralFeatures() as unknown as EStructuralFeature[];
  for (const feature of features) {
    if (propertyList.eIsSet(feature)) {
      flat[wireNameOf(feature)] = String(propertyList.eGet(feature));
    }
  }
  return flat;
}

const ALL = requests();

describe('reading every recorded request', () => {
  it('found the whole corpus', () => {
    expect(ALL.length).toBe(352);
  });

  it.each(ALL.map((c) => [c.label, c] as const))('%s', (_label, testCase) => {
    const envelope = codec.read(readFileSync(testCase.path, 'utf8'));
    const expected = testCase.message;

    // Headers by local name as a set: a client may send them in any order, and
    // two clients send the same block under different namespaces.
    const headerNames = envelope.headers.map((header) => headerName(header));
    expect([...headerNames].sort(), 'header blocks').toEqual([...expected.headers].sort());

    // The manifests record bodyElement only for responses. For a request the
    // invariant worth stating is the one that ties the two fields together: a
    // message carries a requestType exactly when its body is a <Discover>.
    const expectedBody = expected.requestType === undefined ? 'Execute' : 'Discover';
    expect(envelope.bodyElement?.localName ?? null, 'body element').toBe(expectedBody);
    expect(envelope.bodyElement?.namespaceURI, 'body namespace').toBe(XMLA_NAMESPACES.XMLA);
  });
});

/** Whether the request wraps its restriction values, as Excel does. */
function usesNestedValues(xml: string): boolean {
  const list = restrictionListOf(xml);
  return list !== null && list.includes('<Value>');
}

function nestedValues(xml: string): string[] {
  const list = restrictionListOf(xml) ?? '';
  return [...list.matchAll(/<Value>([^<]*)<\/Value>/g)].map((match) => match[1]!);
}

function restrictionListOf(xml: string): string | null {
  const start = xml.indexOf('<RestrictionList>');
  if (start < 0) {
    return null;
  }
  return xml.slice(start, xml.indexOf('</RestrictionList>', start));
}

function headerName(header: EObject): string {
  const eClass = header.eClass();
  if (eClass.getName() === 'UnknownHeader') {
    return String(header.eGet(eClass.getEStructuralFeature('localName')!));
  }
  // The model names the class SessionHeader for the element <Session>.
  return eClass.getName()!.replace(/Header$/, '');
}

describe('reading a Discover request', () => {
  const discovers = ALL.filter((c) => c.message.requestType !== undefined);

  it('found Discover requests to check', () => {
    expect(discovers.length).toBeGreaterThan(150);
  });

  it.each(discovers.map((c) => [c.label, c] as const))('%s', (_label, testCase) => {
    const envelope = codec.read(readFileSync(testCase.path, 'utf8'));
    expect(envelope.bodyElement?.localName).toBe('Discover');

    const discover = reader.readDiscover(envelope.cursor);
    expect(discover.requestType, 'request type').toBe(testCase.message.requestType);

    const xml = readFileSync(testCase.path, 'utf8');
    const expectedRestrictions = testCase.message.restrictions ?? {};

    if (usesNestedValues(xml)) {
      // The manifests are lossy for exactly this shape. Excel writes
      // <PropertyName><Value>a</Value><Value>b</Value></PropertyName>, and the
      // capture recorded the wrapper's own text - which is empty. So the file
      // is the ground truth here, not the manifest, and the check is that every
      // <Value> becomes its own entry.
      expect(Object.values(expectedRestrictions), 'the manifest is empty for this shape').toEqual(
        Object.values(expectedRestrictions).map(() => ''),
      );
      expect(discover.restrictions.map((entry) => entry.value), 'one entry per <Value>').toEqual(
        nestedValues(xml),
      );
      expect(new Set(discover.restrictions.map((entry) => entry.name))).toEqual(
        new Set(Object.keys(expectedRestrictions)),
      );
    } else {
      // The unwrapped form, where the manifest says exactly what was sent.
      const asMap: Record<string, string> = {};
      for (const entry of discover.restrictions) {
        asMap[entry.name] = entry.value ?? '';
      }
      expect(asMap, 'restrictions').toEqual(expectedRestrictions);
    }

    expect(propertiesOf(discover.properties), 'properties').toEqual(testCase.message.properties ?? {});
  });
});

describe('writing a request back out', () => {
  const discovers = ALL.filter((c) => c.message.requestType !== undefined);

  it.each(discovers.map((c) => [c.label, c] as const))('%s survives a round trip', (_label, testCase) => {
    const envelope = codec.read(readFileSync(testCase.path, 'utf8'));
    const original = reader.readDiscover(envelope.cursor);

    const written = codec.write(envelope.headers, (out) => {
      writeDiscover(out, {
        requestType: original.requestType,
        restrictions: original.restrictions,
        properties: original.properties,
      });
    });

    const again = codec.read(written);
    const back = reader.readDiscover(again.cursor);

    expect(back.requestType).toBe(original.requestType);
    expect(back.restrictions).toEqual(original.restrictions);
    expect(propertiesOf(back.properties)).toEqual(propertiesOf(original.properties));
    expect(again.headers.map(headerName).sort()).toEqual(envelope.headers.map(headerName).sort());
  });
});

describe('the shapes where the bytes matter', () => {
  it('writes <PropertyList/> even when there is nothing in it', () => {
    // Leaving it out does not make msmdsrv fall back to its defaults; it makes
    // it reject the request.
    const out = new XmlWriter();
    writeDiscover(out, { requestType: 'DISCOVER_DATASOURCES' });

    expect(out.toString()).toContain('<PropertyList/>');
  });

  it('writes an empty <RestrictionList> rather than leaving it out', () => {
    const out = new XmlWriter();
    writeDiscover(out, { requestType: 'DISCOVER_DATASOURCES' });
    const xml = out.toString();

    expect(xml).toContain('<Restrictions><RestrictionList></RestrictionList></Restrictions>');
  });

  it('puts the envelope in the SOAP namespace and the body in the XMLA one', () => {
    const xml = codec.write([], (out) => writeDiscover(out, { requestType: 'DISCOVER_DATASOURCES' }));

    expect(xml).toContain(`<soap:Envelope xmlns:soap="${XMLA_NAMESPACES.SOAP_ENV}">`);
    expect(xml).toContain(`<Discover xmlns="${XMLA_NAMESPACES.XMLA}">`);
    expect(xml).toContain('<soap:Header>');
    expect(xml).toContain('<soap:Body>');
  });

  it('reads both restriction forms as the same thing', () => {
    // SSMS repeats the element; Excel nests the values. A caller must not be
    // able to tell which client it is talking to.
    const repeated = envelopeAround(
      '<Discover xmlns="urn:schemas-microsoft-com:xml-analysis"><RequestType>X</RequestType>'
        + '<Restrictions><RestrictionList><PropertyName>a</PropertyName><PropertyName>b</PropertyName>'
        + '</RestrictionList></Restrictions></Discover>',
    );
    const nested = envelopeAround(
      '<Discover xmlns="urn:schemas-microsoft-com:xml-analysis"><RequestType>X</RequestType>'
        + '<Restrictions><RestrictionList><PropertyName><Value>a</Value><Value>b</Value></PropertyName>'
        + '</RestrictionList></Restrictions></Discover>',
    );

    const fromRepeated = reader.readDiscover(codec.read(repeated).cursor).restrictions;
    const fromNested = reader.readDiscover(codec.read(nested).cursor).restrictions;

    expect(fromRepeated).toEqual([
      { name: 'PropertyName', value: 'a' },
      { name: 'PropertyName', value: 'b' },
    ]);
    expect(fromNested).toEqual(fromRepeated);
  });
});

function envelopeAround(body: string): string {
  return `<soap:Envelope xmlns:soap="${XMLA_NAMESPACES.SOAP_ENV}"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}
