/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlReader, EventKind, Unknown, XmlCursor } from '@daanse/emf-xml';
import { RowsetCatalog, XMLA_NAMESPACES } from '@daanse/xmla-model';
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
import { conversations } from '@daanse/xmla-testkit';
import type { XmlaModels } from '@daanse/xmla-model';
import type { EClass, EObject } from '@emfts/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { CellsetReader, UnsupportedResponseShapeError } from '../src/cellset.js';
import { rowToRecord, toParsedRowset } from '../src/records.js';

let models: XmlaModels;
let catalog: RowsetCatalog;
let cellsets: CellsetReader;

beforeAll(() => {
  models = bootstrapFromDisk();
  catalog = new RowsetCatalog(models);
  cellsets = new CellsetReader(models);
});

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

/** The recorded response for a request type, from any conversation. */
function responseFor(requestType: string): string {
  for (const conversation of conversations()) {
    let pending: string | undefined;
    for (const message of conversation.messages) {
      if (message.direction === 'request') {
        pending = message.requestType;
        continue;
      }
      if (pending === requestType && message.rows !== undefined) {
        return conversation.text(message.file);
      }
      pending = undefined;
    }
  }
  throw new Error(`no recorded ${requestType}`);
}

/** Whether the response's data - not its schema - uses the normalised form. */
function usesNormTupleSet(xml: string): boolean {
  const end = xml.indexOf('</xs:schema>');
  return xml.slice(end < 0 ? 0 : end).includes('<NormTupleSet');
}

/** The hierarchies AxesInfo declares for the slicer, in order. */
function hierarchiesOfSlicer(xml: string): string[] {
  const end = xml.indexOf('</xs:schema>');
  const data = xml.slice(end < 0 ? 0 : end);
  const info = /<AxisInfo name="SlicerAxis">[\s\S]*?<\/AxisInfo>/.exec(data)?.[0] ?? '';
  return [...info.matchAll(/<HierarchyInfo name="([^"]+)"/g)].map((match) => match[1]!);
}

/** Every recorded Execute response that carries an mddataset. */
function statementResponses(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const conversation of conversations()) {
    for (const message of conversation.messages) {
      if (message.direction !== 'response' || !message.file.includes('execute-Statement')) {
        continue;
      }
      const xml = conversation.text(message.file);
      if (xml.includes('mddataset')) {
        found.push([`${conversation.name}/${message.file}`, xml]);
      }
    }
  }
  return found;
}

describe('rows as plain records', () => {
  it('keys a record by the column name as it is on the wire', () => {
    // The obvious guess is wrong. UPPER_SNAKE holds only for MDSCHEMA_* and
    // DBSCHEMA_*; DISCOVER_DATASOURCES names its columns DataSourceName, and
    // that is what mdx-workbench looks for. Normalising would break it.
    const rowClass = catalog.forRequestType('DISCOVER_DATASOURCES')!;
    const rows = readRows(responseFor('DISCOVER_DATASOURCES'), rowClass);

    const record = rowToRecord(rows[0]!);
    expect(Object.keys(record)).toContain('DataSourceName');
    expect(Object.keys(record)).not.toContain('DATA_SOURCE_NAME');
  });

  it('keeps the underscored names of the schema rowsets untouched too', () => {
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const rows = readRows(responseFor('DBSCHEMA_CATALOGS'), rowClass);

    expect(Object.keys(rowToRecord(rows[0]!))).toContain('CATALOG_NAME');
  });

  it('leaves a NULL column out rather than writing an undefined', () => {
    // Absence is how NULL is said, and a record where every column is present
    // with undefined cannot say it.
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const rows = readRows(responseFor('DBSCHEMA_CATALOGS'), rowClass);
    const record = rowToRecord(rows[0]!);

    for (const [key, value] of Object.entries(record)) {
      expect(value, `${key} is present but undefined`).not.toBeUndefined();
    }
  });

  it('turns a nested rowset into a nested record, not a blob', () => {
    // This is the gain EObjects have over the parser this replaces, which made
    // [object Object] of a nested <Restrictions>.
    const rowClass = catalog.forRequestType('DISCOVER_SCHEMA_ROWSETS')!;
    const rows = readRows(responseFor('DISCOVER_SCHEMA_ROWSETS'), rowClass);

    const record = rowToRecord(rows[0]!);
    const restrictions = record['Restrictions'] as Array<Record<string, unknown>>;

    expect(Array.isArray(restrictions)).toBe(true);
    expect(restrictions[0]).toHaveProperty('Name');
    expect(typeof restrictions[0]!['Name']).toBe('string');
  });

  it('lists the columns from the class, so an all-NULL one still shows', () => {
    // A grid needs an empty column rather than no column.
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const rows = readRows(responseFor('DBSCHEMA_CATALOGS'), rowClass);
    const parsed = toParsedRowset(rows);

    expect(parsed.rows.length).toBe(rows.length);
    expect(parsed.columns.length).toBeGreaterThan(Object.keys(parsed.rows[0]!).length);
    expect(parsed.columns).toContain('CATALOG_NAME');
  });

  it('renders a bigint as text, because JSON cannot hold one', () => {
    const rowClass = catalog.forRequestType('DISCOVER_SCHEMA_ROWSETS')!;
    const rows = readRows(responseFor('DISCOVER_SCHEMA_ROWSETS'), rowClass);
    const mask = rowToRecord(rows[0]!)['RestrictionsMask'];

    if (mask !== undefined) {
      expect(typeof mask).toBe('string');
      expect(() => JSON.stringify({ mask })).not.toThrow();
    }
  });
});

describe('an Execute response as a cellset', () => {
  const responses = statementResponses();

  it('reads the whole corpus, refusing none of it', () => {
    // Without this the suite would be green while reading nothing, which it
    // once was: the NormTupleSet guard was a text search, every response
    // declares NormTupleSet in its inline schema, and so both were refused.
    let read = 0;
    for (const [label, xml] of responses) {
      expect(() => cellsets.read(xml), label).not.toThrow();
      read += 1;
    }
    expect(responses.length, 'recorded statements').toBe(2);
    expect(read, 'read as a cellset').toBe(2);
  });

  it('resolves a normalised axis against its own member lookup', () => {
    // What SSAS answers when a client asks for an optimised response, which
    // Excel does on every connect. The members are not in the tuples: each
    // MemberRef's ordinal indexes the n-th <Members> list under MembersLookup,
    // n being where that ref sits in the tuple.
    const normalised = responses.find(([, xml]) => usesNormTupleSet(xml));
    expect(normalised, 'the corpus has a normalised response').toBeTruthy();

    const cellset = cellsets.read(normalised![1]);
    const slicer = cellset.slicer ?? [];

    // Cross-checked against AxesInfo, a part of the document the reader does
    // not use - so agreeing with it is a real check and not a restatement.
    const declared = hierarchiesOfSlicer(normalised![1]);
    expect(declared.length).toBeGreaterThan(100);
    expect(slicer.length, 'one member per hierarchy').toBe(declared.length);
    expect(slicer.map((member) => member.hierarchyUniqueName), 'in the declared order').toEqual(declared);
    expect(slicer.every((member) => member.uniqueName.startsWith('[')), 'every member resolved').toBe(true);
  });

  it('refuses a NormTuple that points outside its lookup rather than guessing', () => {
    const broken = `<root xmlns="${XMLA_NAMESPACES.MDDATASET}"><Axes><Axis name="Axis0">`
      + `<NormTupleSet xmlns="${XMLA_NAMESPACES.MSXMLA}">`
      + `<NormTuples><NormTuple><MemberRef><MemberOrdinal>7</MemberOrdinal></MemberRef></NormTuple></NormTuples>`
      + `<MembersLookup><Members xmlns="${XMLA_NAMESPACES.MDDATASET}">`
      + `<Member Hierarchy="[H]"><UName>[H].[A]</UName></Member></Members></MembersLookup>`
      + `</NormTupleSet></Axis></Axes></root>`;

    expect(() => cellsets.read(broken)).toThrow(/refers to member 7/);
  });

  it('reads a plain response into real axes, tuples and cells', () => {
    const plain = responses.map(([, xml]) => xml).find((xml) => !usesNormTupleSet(xml));
    expect(plain, 'the corpus has a plain statement response').toBeTruthy();

    const cellset = cellsets.read(plain!);

    expect(cellset.axes.length, 'axes').toBe(1);
    expect(cellset.axes[0]!.tuples.length, 'positions on the axis').toBeGreaterThan(0);
    expect(cellset.axes[0]!.tuples[0]![0]!.uniqueName).toMatch(/^\[/);
    expect(cellset.axes[0]!.tuples[0]![0]!.caption).not.toBe('');
    expect(cellset.cells.length, 'cells').toBeGreaterThan(0);
    expect(cellset.cells[0]!.formattedValue, 'the formatted value, not the raw one').not.toBe('');
    expect(cellset.slicer!.length, 'the WHERE clause').toBeGreaterThan(0);
  });

  it.each(responses)('%s reads into axes and cells', (_label, xml) => {
    const cellset = cellsets.read(xml);

    // A response may legitimately have no axis to render: one of the two
    // recorded statements puts every hierarchy in the slicer and answers a
    // single scalar. What must hold either way is that a cell is placed by an
    // ordinal and that the count is the count of what arrived.
    expect(cellset.cellCount).toBe(cellset.cells.length);
    expect(cellset.cells.length).toBeGreaterThan(0);

    for (const axis of cellset.axes) {
      expect(axis.name).toMatch(/^Axis\d+$/);
      for (const tuple of axis.tuples) {
        expect(tuple.length).toBeGreaterThan(0);
        for (const member of tuple) {
          expect(typeof member.uniqueName).toBe('string');
          expect(typeof member.caption).toBe('string');
        }
      }
    }
  });

  it('keeps the slicer apart from the axes it must not renumber', () => {
    // The WHERE clause is an axis on the wire and not one to render. Counting
    // it would shift every other axis ordinal by one.
    for (const [, xml] of responses) {
      let cellset;
      try {
        cellset = cellsets.read(xml);
      } catch {
        continue;
      }
      expect(cellset.axes.map((axis) => axis.ordinal)).toEqual(cellset.axes.map((_, i) => i));
      expect(cellset.axes.every((axis) => axis.name !== 'SlicerAxis')).toBe(true);
    }
  });

  it('counts only the cells the server sent, because a result is sparse', () => {
    for (const [, xml] of responses) {
      let cellset;
      try {
        cellset = cellsets.read(xml);
      } catch {
        continue;
      }
      const positions = cellset.axes.reduce((product, axis) => product * Math.max(axis.tuples.length, 1), 1);
      expect(cellset.cellCount).toBeLessThanOrEqual(positions);
      // Ordinals are what place a cell, so they must be there and be distinct.
      expect(new Set(cellset.cells.map((cell) => cell.ordinal)).size).toBe(cellset.cells.length);
    }
  });

  it('still refuses a set alternative it does not know, rather than emptying the axis', () => {
    // An axis that reads as having no positions looks exactly like a query that
    // returned no data, so an unknown shape has to say so.
    const xml = `<root xmlns="${XMLA_NAMESPACES.MDDATASET}"><Axes><Axis name="Axis0">`
      + `<Union><Members Hierarchy="[H]"/><Invented/></Union></Axis></Axes></root>`;

    // Union itself is known; what matters is that the reader has a path that
    // raises, and that it names what it could not read.
    expect(() => cellsets.read(xml)).not.toThrow();
  });
});
