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

import { EcoreXmlReader, EcoreXmlWriter, EventKind, Unknown, XmlCursor, XmlWriter, wireNameOf } from '@eclipse-daanse/emf-xml';
import type { EObject, EStructuralFeature } from '@emfts/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { RowsetCatalog, XMLA_NAMESPACES } from '../src/index.js';
import { bootstrapFromDisk } from '../src/node.js';
import { conversations } from './fixtures.js';

/**
 * Every recorded response, written back out and read again.
 *
 * This is what checks the writer, and it checks it against real data rather than
 * against examples chosen to suit it. If the writer drops a column, misnames it,
 * or writes a NULL where an empty string was, the second read produces something
 * different from the first and the comparison says which feature.
 *
 * It is deliberately not a byte comparison against the recording. Attribute
 * order, prefix choice and whitespace are all free in XML, and holding the
 * writer to a server's exact bytes would test formatting rather than meaning.
 * Three byte-level tests exist separately, for the forms where the bytes really
 * do matter.
 */
let catalog: RowsetCatalog;

beforeAll(() => {
  catalog = new RowsetCatalog(bootstrapFromDisk());
});

function moveToRoot(cursor: XmlCursor): boolean {
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START && cursor.localName === 'root') {
      return true;
    }
    kind = cursor.next();
  }
  return false;
}

function readRows(xml: string, rowClass: Parameters<EcoreXmlReader['read']>[1]): EObject[] {
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

/** The rows written back into a `<root>`, as a server would. */
function writeRows(rows: readonly EObject[]): string {
  const out = new XmlWriter();
  out.setDefaultNamespace(XMLA_NAMESPACES.ROWSET);
  out.writeStartElement(XMLA_NAMESPACES.ROWSET, 'root');
  out.writeDefaultNamespace(XMLA_NAMESPACES.ROWSET);
  const writer = new EcoreXmlWriter(XMLA_NAMESPACES.ROWSET);
  for (const row of rows) {
    writer.write(out, row, 'row');
  }
  out.writeEndElement();
  return out.toString();
}

function features(object: EObject): EStructuralFeature[] {
  return [...(object.eClass().getEAllStructuralFeatures() as unknown as EStructuralFeature[])];
}

/** Where two objects differ, as paths, or an empty list when they agree. */
function differences(left: EObject, right: EObject, path = ''): string[] {
  const found: string[] = [];
  if (left.eClass() !== right.eClass()) {
    return [`${path}: ${left.eClass().getName()} became ${right.eClass().getName()}`];
  }
  for (const feature of features(left)) {
    const here = path === '' ? wireNameOf(feature) : `${path}.${wireNameOf(feature)}`;
    const setLeft = left.eIsSet(feature);
    const setRight = right.eIsSet(feature);
    if (setLeft !== setRight) {
      // The distinction the writer exists to keep: unset means no element,
      // set to '' means <X/>, and clients read those differently.
      found.push(`${here}: ${setLeft ? 'set' : 'unset'} became ${setRight ? 'set' : 'unset'}`);
      continue;
    }
    if (!setLeft) {
      continue;
    }
    const a = left.eGet(feature);
    const b = right.eGet(feature);
    if (feature.isMany()) {
      const listA = [...(a as Iterable<unknown>)];
      const listB = [...(b as Iterable<unknown>)];
      if (listA.length !== listB.length) {
        found.push(`${here}: ${listA.length} values became ${listB.length}`);
        continue;
      }
      for (let i = 0; i < listA.length; i++) {
        found.push(...compare(listA[i], listB[i], `${here}[${i}]`));
      }
    } else {
      found.push(...compare(a, b, here));
    }
  }
  return found;
}

function compare(a: unknown, b: unknown, path: string): string[] {
  const aIsObject = typeof (a as { eClass?: unknown })?.eClass === 'function';
  const bIsObject = typeof (b as { eClass?: unknown })?.eClass === 'function';
  if (aIsObject && bIsObject) {
    return differences(a as EObject, b as EObject, path);
  }
  if (aIsObject !== bIsObject) {
    return [`${path}: object and value do not match`];
  }
  return String(a) === String(b) ? [] : [`${path}: '${String(a)}' became '${String(b)}'`];
}

describe('writing rows back out', () => {
  const cases: Array<[string, string, string, number]> = [];
  for (const conversation of conversations()) {
    for (const message of conversation.messages) {
      if (message.direction === 'response' && message.rows !== undefined && message.requestType !== undefined) {
        cases.push([
          `${conversation.name}/${message.file}`,
          join(conversation.directory, message.file),
          message.requestType,
          message.rows,
        ]);
      }
    }
  }

  it.each(cases)('%s survives a round trip', (_label, path, requestType, rows) => {
    const rowClass = catalog.forRequestType(requestType)!;
    const original = readRows(readFileSync(path, 'utf8'), rowClass);
    expect(original.length).toBe(rows);

    const written = writeRows(original);
    const again = readRows(written, rowClass);

    expect(again.length, 'row count after writing').toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      const found = differences(original[i]!, again[i]!);
      expect(found, `row ${i} of ${_label}`).toEqual([]);
    }
  });
});

describe('the bytes, where the bytes matter', () => {
  it('writes an unset column as no element, and an empty one as <X/>', () => {
    // Three forms a client tells apart, so they are checked as text rather than
    // through the round trip, which by construction cannot see the difference
    // between <X/> and <X></X>.
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const row = rowClass.getEPackage()!.getEFactoryInstance().create(rowClass);
    const name = rowClass.getEStructuralFeature('catalogName')!;
    const description = rowClass.getEStructuralFeature('description')!;

    row.eSet(name, 'Adventure Works');
    row.eSet(description, '');

    const xml = writeRows([row]);

    expect(xml).toContain('<CATALOG_NAME>Adventure Works</CATALOG_NAME>');
    expect(xml).toContain('<DESCRIPTION/>');
    expect(xml).not.toContain('<DESCRIPTION></DESCRIPTION>');
    // A column that was never set is simply absent - that is how NULL is said.
    expect(xml).not.toContain('ROLES');
  });

  it('declares the rowset namespace once, on the root', () => {
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const row = rowClass.getEPackage()!.getEFactoryInstance().create(rowClass);
    row.eSet(rowClass.getEStructuralFeature('catalogName')!, 'x');

    const xml = writeRows([row, row]);

    expect(xml.match(/xmlns="urn:schemas-microsoft-com:xml-analysis:rowset"/g)?.length).toBe(1);
    expect(xml.startsWith('<root xmlns="urn:schemas-microsoft-com:xml-analysis:rowset">')).toBe(true);
  });

  it('writes a boolean as a word, whichever form it was read from', () => {
    const rowClass = catalog.forRequestType('DISCOVER_PROPERTIES')!;
    const row = rowClass.getEPackage()!.getEFactoryInstance().create(rowClass);
    const isRequired = rowClass.getEStructuralFeature('isRequired');
    expect(isRequired, 'DISCOVER_PROPERTIES has an IsRequired column').toBeTruthy();

    row.eSet(isRequired!, true);
    expect(writeRows([row])).toContain('<IsRequired>true</IsRequired>');

    row.eSet(isRequired!, false);
    expect(writeRows([row])).toContain('<IsRequired>false</IsRequired>');
  });
});
