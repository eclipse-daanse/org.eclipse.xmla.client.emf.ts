/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EcoreXmlReader, EventKind, Unknown, XmlCursor, wireNameOf } from '@eclipse-daanse/emf-xml';
import type { EClass, EObject, EStructuralFeature } from '@emfts/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { RowsetCatalog, unresolvedFeatures } from '../src/index.js';
import { bootstrapFromDisk, WITHOUT_ENGINE } from '../src/node.js';
import type { XmlaModels } from '../src/index.js';
import { conversations, type RecordedMessage } from './fixtures.js';

/**
 * The reader against every recorded Discover response.
 *
 * The manifests are the point of this: they carry a row count per response that
 * we did not compute. Reading a response and getting that number back is the
 * strongest statement available here that the reader understands the wire, and
 * it is what M1 proved the library's own handler cannot do - it returned rows
 * with their scalar columns missing and reported no error.
 */
let models: XmlaModels;
let catalog: RowsetCatalog;

beforeAll(() => {
  models = bootstrapFromDisk();
  catalog = new RowsetCatalog(models);
});

/** Positions the cursor on `<root>` inside the response, or returns null. */
function moveToRoot(cursor: XmlCursor): boolean {
  while (true) {
    const kind = cursor.next();
    if (kind === null) {
      return false;
    }
    if (kind === EventKind.START && cursor.localName === 'root') {
      return true;
    }
  }
}

/** Reads every `<row>` of a rowset response as an instance of `rowClass`. */
function readRows(xml: string, rowClass: EClass): EObject[] {
  const cursor = XmlCursor.parse(xml);
  if (!moveToRoot(cursor)) {
    return [];
  }
  const reader = new EcoreXmlReader({ unknown: Unknown.FAIL });
  const rows: EObject[] = [];

  let depth = 0;
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START) {
      if (depth === 0 && cursor.localName === 'row') {
        rows.push(reader.read(cursor, rowClass));
      } else if (depth === 0 && cursor.namespaceURI === 'http://www.w3.org/2001/XMLSchema') {
        // The inline schema describes the rows; it is not one.
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

function setFeatures(row: EObject): EStructuralFeature[] {
  // getEAllStructuralFeatures answers a plain array here, unlike the EList that
  // getEStructuralFeatures answers. Both shapes occur, so neither is assumed.
  const all = row.eClass().getEAllStructuralFeatures() as unknown as EStructuralFeature[];
  return [...all].filter((feature) => row.eIsSet(feature));
}

describe('the bootstrap', () => {
  it('leaves nothing unresolved in any model but xmla', () => {
    // xmla is the only one referencing engine, so it is the only one the
    // omission can touch. Anything else showing up here means a model failed to
    // load or the order slipped - and that failure is otherwise silent.
    const damaged: string[] = [];
    for (const name of models.names) {
      if (name === 'xmla') {
        continue;
      }
      for (const feature of unresolvedFeatures(models.named(name)!)) {
        damaged.push(`${name}: ${feature}`);
      }
    }
    expect(damaged, damaged.slice(0, 10).join(', ')).toEqual([]);
  });

  it('leaves exactly the named features unresolved when engine is left out', () => {
    // Not a surprise to discover later: reading a feature whose type never
    // resolved returns rather than raising, so the cost of the omission is
    // written down and checked.
    const xmla = models.named('xmla');
    expect(xmla).toBeTruthy();
    expect(models.named('engine'), 'engine is off by default').toBeNull();
    expect([...unresolvedFeatures(xmla!)].sort()).toEqual([...WITHOUT_ENGINE].sort());
  });
});

describe('the rowset catalogue', () => {
  it('knows a request type for every rowset the model describes', () => {
    const types = catalog.requestTypes();
    expect(types.length).toBeGreaterThan(50);
    expect(types).toContain('MDSCHEMA_CUBES');
    expect(types).toContain('DISCOVER_SCHEMA_ROWSETS');
  });

  it('gives restrictions an order, because the mask is defined over it', () => {
    const restrictions = catalog.restrictionsOf('MDSCHEMA_CUBES');
    expect(restrictions.length).toBeGreaterThan(0);
    expect(restrictions.map((r) => r.ordinal)).toEqual(restrictions.map((_, i) => i));
    // 2^n - 1: every restriction supported, which is all the mask ever says.
    expect(catalog.restrictionsMaskOf('MDSCHEMA_CUBES')).toBe((1n << BigInt(restrictions.length)) - 1n);
  });
});

describe('reading the recorded Discover responses', () => {
  const responses: Array<[string, RecordedMessage, string]> = [];
  for (const conversation of conversations()) {
    for (const message of conversation.messages) {
      if (message.direction === 'response' && message.rows !== undefined && message.requestType !== undefined) {
        responses.push([`${conversation.name}/${message.file}`, message, conversation.directory]);
      }
    }
  }

  it('checks every recorded response, and skips none of them silently', () => {
    // A test that quietly passes on what it cannot handle turns a green suite
    // into no statement at all. So the corpus is counted, and every response in
    // it has to be one the catalogue can name a row class for.
    expect(responses.length, 'responses carrying a recorded row count').toBe(204);

    const unmodelled = responses
      .filter(([, message]) => catalog.forRequestType(message.requestType!) === null)
      .map(([label, message]) => `${label} (${message.requestType})`);
    expect(unmodelled, 'responses no static row class covers').toEqual([]);
  });

  it.each(responses)('%s', (_label, message, directory) => {
    const rowClass = catalog.forRequestType(message.requestType!);
    expect(rowClass, `no row class for ${message.requestType}`).not.toBeNull();

    const xml = readFileSync(join(directory, message.file), 'utf8');
    const rows = readRows(xml, rowClass!);
    expect(rows.length, `row count for ${message.file}`).toBe(message.rows);
  });

  it('sets the columns a row actually carries, not just the nested ones', () => {
    // The exact failure M1 measured: zero errors reported, and a row holding
    // only its nested collection while both scalar columns were dropped.
    const schemaRowsets = conversations()
      .flatMap((conversation) =>
        conversation.messages
          .filter((message) => message.requestType === 'DISCOVER_SCHEMA_ROWSETS' && message.direction === 'response')
          .map((message) => join(conversation.directory, message.file)),
      );
    expect(schemaRowsets.length).toBeGreaterThan(0);

    const rowClass = catalog.forRequestType('DISCOVER_SCHEMA_ROWSETS')!;
    const rows = readRows(readFileSync(schemaRowsets[0]!, 'utf8'), rowClass);
    expect(rows.length).toBeGreaterThan(0);

    const names = setFeatures(rows[0]!).map((feature) => wireNameOf(feature));
    expect(names).toContain('SchemaName');
    expect(names).toContain('Restrictions');
  });
});
