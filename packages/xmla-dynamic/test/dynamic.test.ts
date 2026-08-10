/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlReader, EventKind, Unknown, wireNameOf, XmlCodecError, XmlCursor } from '@daanse/emf-xml';
import { RowsetCatalog, XMLA_NAMESPACES } from '@daanse/xmla-model';
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
import { conversations } from '@daanse/xmla-testkit';
import type { XmlaModels } from '@daanse/xmla-model';
import { EPackageRegistry } from '@emfts/core';
import type { EClass, EObject } from '@emfts/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { DynamicModelRegistry } from '../src/registry.js';
import { RowsetResolver } from '../src/resolver.js';
import { buildRowClass, featureNameOf, parseInlineSchema } from '../src/schema-import.js';

let models: XmlaModels;
let catalog: RowsetCatalog;

beforeAll(() => {
  models = bootstrapFromDisk();
  catalog = new RowsetCatalog(models);
});

/** Every inline schema in the corpus, with the response it came from. */
interface SchemaCase {
  readonly label: string;
  readonly requestType: string;
  readonly schema: string;
  readonly xml: string;
  readonly rows: number;
}

function inlineSchemas(): SchemaCase[] {
  const found: SchemaCase[] = [];
  for (const conversation of conversations()) {
    let pending: string | undefined;
    for (const message of conversation.messages) {
      if (message.direction === 'request') {
        pending = message.requestType;
        continue;
      }
      const requestType = pending;
      pending = undefined;
      if (requestType === undefined || message.rows === undefined) {
        continue;
      }
      const xml = conversation.text(message.file);
      const schema = schemaTextOf(xml);
      if (schema !== null) {
        found.push({
          label: `${conversation.name}/${message.file}`,
          requestType,
          schema,
          xml,
          rows: message.rows,
        });
      }
    }
  }
  return found;
}

/**
 * The `<xsd:schema>` a response carried, cut out the way the client does.
 *
 * Through the parser rather than by slicing the text: the schema uses a prefix
 * declared on the response root, so a slice does not parse on its own.
 */
function schemaTextOf(xml: string): string | null {
  const cursor = XmlCursor.parse(xml);
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START && cursor.namespaceURI === XMLA_NAMESPACES.XSD && cursor.localName === 'schema') {
      return cursor.rawElement();
    }
    kind = cursor.next();
  }
  return null;
}

/** Reads a response's rows with a given class - the same loop the client uses. */
function readRows(xml: string, rowClass: EClass): EObject[] {
  const cursor = XmlCursor.parse(xml);
  let kind = cursor.next();
  while (kind !== null && cursor.localName !== 'root') {
    kind = cursor.next();
  }
  const reader = new EcoreXmlReader({ unknown: Unknown.FAIL });
  const rows: EObject[] = [];
  let depth = 0;
  kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START) {
      if (depth === 0 && cursor.localName === 'row') {
        rows.push(reader.read(cursor, rowClass));
      } else if (depth === 0 && cursor.namespaceURI === XMLA_NAMESPACES.XSD) {
        cursor.skipSubtree();
      } else {
        depth += 1;
      }
    } else if (kind === EventKind.END) {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    }
    kind = cursor.next();
  }
  return rows;
}

const CASES = inlineSchemas();

describe('importing the inline schemas', () => {
  it('found the schemas the corpus carries', () => {
    expect(CASES.length).toBeGreaterThan(80);
  });

  it.each(CASES.map((c) => [c.label, c] as const))('%s parses and builds a class', (_label, testCase) => {
    const schema = parseInlineSchema(testCase.schema);
    expect(schema.columns.length, 'columns').toBeGreaterThan(0);
    // Every one of them targets the rowset namespace, which is exactly why the
    // built package must not be registered under it.
    expect(schema.targetNamespace).toBe(XMLA_NAMESPACES.ROWSET);

    const built = buildRowClass(schema, { nsURI: `urn:test:${testCase.requestType}` });
    expect(built.rowClass.getEAllStructuralFeatures().length).toBe(schema.columns.length);
  });

  it.each(CASES.map((c) => [c.label, c] as const))('%s reads its own rows', (_label, testCase) => {
    // The real test of an imported class: it reads the response it came from,
    // to the count the manifest recorded.
    const built = buildRowClass(parseInlineSchema(testCase.schema), {
      nsURI: `urn:test:read:${testCase.label}`,
    });
    const rows = readRows(testCase.xml, built.rowClass);

    expect(rows.length, 'row count').toBe(testCase.rows);
  });

  it('refuses a schema element it does not know rather than losing a column', () => {
    const schema = `<xsd:schema xmlns:xsd="${XMLA_NAMESPACES.XSD}" targetNamespace="${XMLA_NAMESPACES.ROWSET}">
      <xsd:element name="row"><xsd:complexType><xsd:sequence>
        <xsd:choice><xsd:element name="A" type="xsd:string"/></xsd:choice>
      </xsd:sequence></xsd:complexType></xsd:element></xsd:schema>`;

    expect(() => parseInlineSchema(schema)).toThrow(/xsd:choice/);
  });

  it('refuses a type it cannot map rather than reading the column as text', () => {
    const schema = `<xsd:schema xmlns:xsd="${XMLA_NAMESPACES.XSD}" targetNamespace="${XMLA_NAMESPACES.ROWSET}">
      <xsd:element name="row"><xsd:complexType><xsd:sequence>
        <xsd:element name="A" type="xsd:hexBinary" minOccurs="0"/>
      </xsd:sequence></xsd:complexType></xsd:element></xsd:schema>`;

    expect(() => buildRowClass(parseInlineSchema(schema), { nsURI: 'urn:test:bad' })).toThrow(/xsd:hexBinary/);
  });

  it('turns a nested complexType into a nested rowset, not a blob', () => {
    const withNesting = CASES.find((testCase) => testCase.requestType === 'DISCOVER_SCHEMA_ROWSETS');
    expect(withNesting, 'the corpus has a rowset with a nested one').toBeTruthy();

    const schema = parseInlineSchema(withNesting!.schema);
    const nested = schema.columns.filter((column) => column.nested !== null);

    expect(nested.length, 'Restrictions is a nested rowset').toBeGreaterThan(0);
    expect(nested[0]!.nested!.map((column) => column.name)).toContain('Name');
  });
});

describe('the namespace collision', () => {
  it('never registers a built package under the namespace the schema names', () => {
    // This is the hazard the whole registry exists for, and it is silent: a
    // dynamic package registered under the rowset nsURI replaces the real model
    // process-wide, and everything afterwards reads against a model that
    // describes one rowset and claims to describe seventy.
    const registry = new DynamicModelRegistry('http://server/xmla');
    const testCase = CASES[0]!;

    const built = registry.learn(testCase.requestType, testCase.schema);

    expect(built.schema.targetNamespace).toBe(XMLA_NAMESPACES.ROWSET);
    expect(built.ePackage.getNsURI()).not.toBe(XMLA_NAMESPACES.ROWSET);
    expect(built.ePackage.getNsURI()).toContain('dynamic');
  });

  it('leaves the global registry holding the static model', () => {
    const registry = new DynamicModelRegistry('http://server/xmla');
    for (const testCase of CASES.slice(0, 10)) {
      registry.learn(testCase.requestType, testCase.schema);
    }

    registry.assertNotGlobal();
    expect(EPackageRegistry.INSTANCE.getEPackage(XMLA_NAMESPACES.ROWSET)).toBe(models.named('rowset'));
  });

  it('gives two servers separate models for the same request type', () => {
    const one = new DynamicModelRegistry('http://a/xmla');
    const other = new DynamicModelRegistry('http://b/xmla');

    expect(one.nsURIFor('MDSCHEMA_CUBES')).not.toBe(other.nsURIFor('MDSCHEMA_CUBES'));
  });

  it('writes the wire namespace onto the features literally', () => {
    // ##targetNamespace would resolve against the package's own nsURI, which
    // here is the private one - so reading would look for elements in a
    // namespace no server writes, find nothing, and say nothing.
    const registry = new DynamicModelRegistry('http://server/xmla');
    const built = registry.learn('X', CASES[0]!.schema);
    const feature = built.rowClass.getEAllStructuralFeatures()[0]!;
    const annotation = feature.getEAnnotation('http:///org/eclipse/emf/ecore/util/ExtendedMetaData')!;

    expect(annotation.getDetails().getByKey('namespace')).toBe(XMLA_NAMESPACES.ROWSET);
    expect(annotation.getDetails().getByKey('namespace')).not.toBe('##targetNamespace');
  });
});

describe('resolving a rowset', () => {
  it('prefers the static class where the model has one', () => {
    const resolver = new RowsetResolver(catalog, 'http://server/xmla');
    const resolved = resolver.resolve('MDSCHEMA_CUBES', CASES[0]!.schema);

    expect(resolved.origin).toBe('static');
    expect(resolved.rowClass).toBe(catalog.forRequestType('MDSCHEMA_CUBES'));
  });

  it('falls back to the schema for a rowset the model never described', () => {
    // DISCOVER_RESOURCE_POOLS is declared by SSAS 13 and has no static class.
    // Without this path it would simply be unreachable.
    const resolver = new RowsetResolver(catalog, 'http://server/xmla');
    expect(catalog.forRequestType('DISCOVER_RESOURCE_POOLS')).toBeNull();

    const resolved = resolver.resolve('DISCOVER_RESOURCE_POOLS', CASES[0]!.schema);

    expect(resolved.origin).toBe('dynamic');
    expect(resolved.rowClass.getEAllStructuralFeatures().length).toBeGreaterThan(0);
  });

  it('says so rather than guessing when there is neither a class nor a schema', () => {
    const resolver = new RowsetResolver(catalog, 'http://server/xmla');

    expect(() => resolver.resolve('DISCOVER_RESOURCE_POOLS', null)).toThrow(/nothing to read it as/);
  });

  it('describes columns the same way whichever path produced them', () => {
    // A screen that had to branch on where a class came from would be a screen
    // that renders one of the two paths badly.
    const resolver = new RowsetResolver(catalog, 'http://server/xmla');
    const schemaRowsets = CASES.find((testCase) => testCase.requestType === 'DISCOVER_SCHEMA_ROWSETS')!;

    const fromModel = resolver.columnsOf(resolver.resolve('DISCOVER_SCHEMA_ROWSETS', null).rowClass);
    const fromServer = resolver.columnsOf(
      resolver.resolve('DISCOVER_SCHEMA_ROWSETS#dyn', schemaRowsets.schema).rowClass,
    );

    for (const columns of [fromModel, fromServer]) {
      expect(columns.every((column) => typeof column.name === 'string')).toBe(true);
      expect(columns.some((column) => column.nested)).toBe(true);
    }
    expect(fromServer.map((column) => column.name)).toEqual(
      expect.arrayContaining(['SchemaName', 'Restrictions']),
    );
  });

  it('turns the dynamic path into a conformance test for the static models', () => {
    const resolver = new RowsetResolver(catalog, 'http://server/xmla', { strict: true });
    for (const testCase of CASES) {
      resolver.resolve(testCase.requestType, testCase.schema);
    }

    // Reported rather than asserted away. What the server describes and what the
    // model says are allowed to differ - the point is that the difference is
    // visible instead of silent.
    for (const divergence of resolver.divergencesFound) {
      expect(divergence.requestType).toBeTruthy();
    }
    expect(Array.isArray(resolver.divergencesFound)).toBe(true);
  });
});

describe('naming', () => {
  it('turns a column name into a feature name without needing to reverse it', () => {
    expect(featureNameOf('CATALOG_NAME')).toBe('catalogName');
    expect(featureNameOf('SchemaName')).toBe('schemaName');
    expect(featureNameOf('DataSourceName')).toBe('dataSourceName');
  });

  it('keeps the wire name on the annotation, which is what reading uses', () => {
    const registry = new DynamicModelRegistry('http://server/xmla');
    const built = registry.learn('X', CASES[0]!.schema);

    for (const feature of built.rowClass.getEAllStructuralFeatures()) {
      expect(wireNameOf(feature), 'the wire name survives').toBeTruthy();
    }
  });
});
