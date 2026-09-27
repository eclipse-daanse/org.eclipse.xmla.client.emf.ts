/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlReader, EventKind, Unknown, wireNameOf, XmlCodecError, XmlCursor } from '@eclipse-daanse/emf-xml';
import { DynamicModelRegistry } from '@eclipse-daanse/xmla-dynamic';
import { XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import type { XmlaModels } from '@eclipse-daanse/xmla-model';
import type { EClass, EObject, EStructuralFeature } from '@emfts/core';

/** The flattened shape mdx-workbench renders. */
export interface XmlaCellsetMember {
  uniqueName: string;
  caption: string;
  hierarchyUniqueName?: string;
}

export interface XmlaCellsetAxis {
  /** Axis0, Axis1, ... as in the MDDataSet. */
  name: string;
  ordinal: number;
  /** Each tuple is one position on the axis: one member per hierarchy. */
  tuples: XmlaCellsetMember[][];
}

export interface XmlaCell {
  /** The XMLA cell ordinal: axis 0 varies fastest. */
  ordinal: number;
  value: number | string | null;
  formattedValue: string;
}

export interface XmlaCellset {
  axes: XmlaCellsetAxis[];
  /** SlicerAxis members - the WHERE clause - when there is one. */
  slicer?: XmlaCellsetMember[];
  cells: XmlaCell[];
  cellCount: number;
}

/**
 * A set alternative this reader does not know.
 *
 * Raised rather than answered with empty axes, because an axis that reads as
 * having no positions looks exactly like a query that returned no data.
 */
export class UnsupportedResponseShapeError extends Error {
  constructor(shape: string) {
    super(
      `this response uses ${shape}, which is not read yet. `
        + 'Ask for a plain response by leaving the optimisation properties unset.',
    );
    this.name = 'UnsupportedResponseShapeError';
  }
}

/**
 * Turns an Execute response into the flat cellset.
 *
 * Everything below reads through the models, so the axes, the tuples and the
 * cell properties come out of the same reader that reads every other message.
 */
export class CellsetReader {
  private readonly mdDatasetClass: EClass;
  private readonly reader = new EcoreXmlReader({ unknown: Unknown.SKIP });
  private readonly dynamic: DynamicModelRegistry;

  constructor(models: XmlaModels) {
    this.dynamic = new DynamicModelRegistry('cellset');
    const mddataset = models.named('mddataset');
    if (mddataset === null) {
      throw new Error('the mddataset model is not loaded');
    }
    const eClass = mddataset.getEClassifier('MdDataset') as EClass | null;
    if (eClass === null || eClass === undefined) {
      throw new Error('the mddataset model has no MdDataset');
    }
    this.mdDatasetClass = eClass;
  }

  /**
   * The MdDataset behind a response, unflattened.
   *
   * A consumer that walks the dataset itself - one porting off a client that
   * handed back parsed XML - needs the tree rather than the cellset. Answers
   * null for a response that carries a rowset instead, because there is no
   * dataset to give.
   */
  readDataset(xml: string): EObject | null {
    const cursor = XmlCursor.parse(xml);
    if (!moveTo(cursor, 'root')) {
      throw new Error('the response carries no <root>');
    }
    if (cursor.namespaceURI === XMLA_NAMESPACES.ROWSET) {
      return null;
    }
    return this.reader.read(cursor, this.mdDatasetClass);
  }

  read(xml: string): XmlaCellset {
    // The check happens on the model, in tuplesOf, not on the text. Searching
    // the text for NormTupleSet matches the inline schema, which declares it in
    // every response whether or not the data uses it - so a plain response was
    // refused as if it were an optimised one.
    const cursor = XmlCursor.parse(xml);
    if (!moveTo(cursor, 'root')) {
      throw new Error('the response carries no <root>');
    }
    if (cursor.namespaceURI === XMLA_NAMESPACES.ROWSET) {
      // A DMV or a DRILLTHROUGH: the server answers a rowset rather than an
      // mddataset. Which one came back is read off the namespace of <root>
      // rather than guessed from the statement text - the server has already
      // decided, and reading the answer beats parsing the question.
      return tabularCellset(xml, this.dynamic);
    }
    const dataset = this.reader.read(cursor, this.mdDatasetClass);
    return toCellset(dataset);
  }
}

/** Maps a read MdDataset onto the flat shape. */
export function toCellset(dataset: EObject): XmlaCellset {
  const axesHolder = child(dataset, 'axes');
  const axes: XmlaCellsetAxis[] = [];
  let slicer: XmlaCellsetMember[] | undefined;

  if (axesHolder !== null) {
    let ordinal = 0;
    for (const axis of children(axesHolder, 'axis')) {
      const name = String(value(axis, 'name') ?? `Axis${ordinal}`);
      const tuples = tuplesOf(axis);
      if (name === 'SlicerAxis') {
        // The WHERE clause is an axis on the wire but not one to render, so it
        // travels separately and does not shift the ordinals of the others.
        slicer = tuples.flat();
        continue;
      }
      axes.push({ name, ordinal, tuples });
      ordinal += 1;
    }
  }

  const cells = cellsOf(dataset);
  return {
    axes,
    ...(slicer === undefined ? {} : { slicer }),
    cells,
    // The count of cells the server actually sent. A result is sparse: a cell
    // with no value is simply absent, so this is not the product of the axis
    // lengths and must not be computed as one.
    cellCount: cells.length,
  };
}

/**
 * The positions of an axis.
 *
 * An axis holds a *list* of set alternatives, not one - the model has
 * `Axis.setType` as many-valued, and a CrossProduct is a set that holds further
 * sets. Reading it as a single value is why this returned no tuples at all
 * until it was measured against a real response.
 */
function tuplesOf(axis: EObject): XmlaCellsetMember[][] {
  return children(axis, 'setType').flatMap((set) => tuplesOfSet(set));
}

function tuplesOfSet(set: EObject): XmlaCellsetMember[][] {
  const kind = set.eClass().getName();

  if (kind === 'TuplesType') {
    return children(set, 'tuple').map((tuple) => children(tuple, 'member').map(memberOf));
  }
  if (kind === 'MembersType') {
    // One member per position, which is what an axis over a single hierarchy
    // looks like.
    return children(set, 'member').map((member) => [memberOf(member)]);
  }
  if (kind === 'NormTupleSet') {
    return normTuples(set);
  }
  if (kind === 'SetListType' || kind === 'Union') {
    // A CrossProduct or a Union: the alternatives it holds, concatenated. Their
    // order is the order of the positions.
    return children(set, 'setType').flatMap((inner) => tuplesOfSet(inner));
  }
  throw new UnsupportedResponseShapeError(kind ?? 'an unnamed set');
}

/**
 * The positions of a normalised axis.
 *
 * This is what SSAS answers when a client asks for an optimised response, which
 * Excel does on every connect. The members are not in the tuples: each
 * `<NormTuple>` holds one `<MemberRef>` per hierarchy, and its `MemberOrdinal`
 * indexes into the *n*-th `<Members>` list under `<MembersLookup>`, where *n* is
 * the position of that MemberRef within the tuple. So a member repeated across
 * a thousand positions travels once instead of a thousand times - which is the
 * whole point of the form, and the reason it cannot be read by walking the axis.
 */
function normTuples(set: EObject): XmlaCellsetMember[][] {
  // One list of members per hierarchy, in the order the hierarchies appear
  // inside a tuple.
  const lookup = child(set, 'membersLookup');
  const byHierarchy: XmlaCellsetMember[][] = lookup === null
    ? []
    : children(lookup, 'members').map((members) => children(members, 'member').map(memberOf));

  const tuplesHolder = child(set, 'normTuples');
  if (tuplesHolder === null) {
    return [];
  }

  return children(tuplesHolder, 'normTuple').map((tuple) => {
    const refs = children(tuple, 'memberRef');
    return refs.map((ref, hierarchy) => {
      const ordinal = Number(value(ref, 'memberOrdinal') ?? 0);
      const member = byHierarchy[hierarchy]?.[ordinal];
      if (member === undefined) {
        // A reference into a lookup that does not have it. Guessing would put a
        // silently wrong member on an axis, which is worse than saying so.
        throw new XmlCodecError(
          `a NormTuple refers to member ${ordinal} of hierarchy ${hierarchy}, `
            + `and the lookup has ${byHierarchy[hierarchy]?.length ?? 0} there`,
        );
      }
      return member;
    });
  });
}

function memberOf(member: EObject): XmlaCellsetMember {
  const properties = new Map<string, string>();
  for (const property of children(member, 'any')) {
    const tagName = value(property, 'tagName');
    const text = value(property, 'value');
    if (tagName !== null && tagName !== undefined) {
      properties.set(String(tagName), text === null || text === undefined ? '' : String(text));
    }
  }
  const uniqueName = properties.get('UName') ?? properties.get('UniqueName') ?? '';
  const caption = properties.get('Caption') ?? uniqueName;
  const hierarchy = value(member, 'hierarchy');

  return {
    uniqueName,
    caption,
    ...(hierarchy === null || hierarchy === undefined ? {} : { hierarchyUniqueName: String(hierarchy) }),
  };
}

function cellsOf(dataset: EObject): XmlaCell[] {
  const cellData = child(dataset, 'cellData');
  if (cellData === null) {
    return [];
  }
  return children(cellData, 'cell').map((cell) => {
    const ordinal = Number(value(cell, 'cellOrdinal') ?? 0);
    const raw = child(cell, 'value');
    const properties = new Map<string, string>();
    for (const property of children(cell, 'any')) {
      const tagName = value(property, 'tagName');
      const text = value(property, 'value');
      if (tagName !== null && tagName !== undefined) {
        properties.set(String(tagName), text === null || text === undefined ? '' : String(text));
      }
    }
    const value_ = raw === null ? (properties.get('Value') ?? null) : (value(raw, 'value') ?? null);
    const formatted = properties.get('FmtValue') ?? properties.get('FORMATTED_VALUE') ?? '';

    return {
      ordinal,
      value: coerce(value_),
      formattedValue: formatted === '' && value_ !== null ? String(value_) : formatted,
    };
  });
}

/** A cell value as a number where it is one, and as text otherwise. */
function coerce(value: unknown): number | string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const text = String(value);
  const asNumber = Number(text);
  return text.trim() !== '' && !Number.isNaN(asNumber) ? asNumber : text;
}

/**
 * A tabular answer as a cellset.
 *
 * The columns become one axis and the values become the cells, which is what
 * lets a DMV result land in the same grid as an MDX one. The column class is
 * built from the schema the response carried, because a DMV rowset is not in
 * any model - `$SYSTEM.DISCOVER_CONNECTIONS` is whatever that server has.
 */
function tabularCellset(xml: string, registry: DynamicModelRegistry): XmlaCellset {
  const schemaCursor = XmlCursor.parse(xml);
  let kind = schemaCursor.next();
  let schema: string | null = null;
  while (kind !== null) {
    if (kind === EventKind.START && schemaCursor.namespaceURI === XMLA_NAMESPACES.XSD
      && schemaCursor.localName === 'schema') {
      schema = schemaCursor.rawElement();
      break;
    }
    kind = schemaCursor.next();
  }
  if (schema === null) {
    throw new Error('a tabular response with no inline schema, so its columns are unknown');
  }

  const rowClass = registry.learn(`tabular:${hash(schema)}`, schema).rowClass;
  const reader = new EcoreXmlReader({ unknown: Unknown.SKIP });
  const rows: EObject[] = [];

  const cursor = XmlCursor.parse(xml);
  if (!moveTo(cursor, 'root')) {
    return { axes: [], cells: [], cellCount: 0 };
  }
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

  const columns = [...(rowClass.getEAllStructuralFeatures() as unknown as EStructuralFeature[])];
  const cells: XmlaCell[] = [];
  rows.forEach((row, rowIndex) => {
    columns.forEach((feature, columnIndex) => {
      if (!row.eIsSet(feature)) {
        return;
      }
      const value = row.eGet(feature);
      cells.push({
        // Axis 0 varies fastest, as everywhere else in a cellset.
        ordinal: rowIndex * columns.length + columnIndex,
        value: coerce(value),
        formattedValue: value === null || value === undefined ? '' : String(value),
      });
    });
  });

  return {
    axes: [
      {
        name: 'Axis0',
        ordinal: 0,
        tuples: columns.map((feature) => [{ uniqueName: wireNameOf(feature), caption: wireNameOf(feature) }]),
      },
      { name: 'Axis1', ordinal: 1, tuples: rows.map((_, index) => [{ uniqueName: `Row${index}`, caption: `${index}` }]) },
    ],
    cells,
    cellCount: cells.length,
  };
}

/** Enough to tell two schemas apart within one connection. */
function hash(text: string): string {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    value = (value * 31 + text.charCodeAt(i)) | 0;
  }
  return String(value >>> 0);
}

function moveTo(cursor: XmlCursor, localName: string): boolean {
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START && cursor.localName === localName) {
      return true;
    }
    if (kind === EventKind.START && cursor.namespaceURI === XMLA_NAMESPACES.XSD) {
      cursor.skipSubtree();
    }
    kind = cursor.next();
  }
  return false;
}

function feature(object: EObject, name: string): EStructuralFeature | null {
  const found = object.eClass().getEStructuralFeature(name);
  if (found !== null && found !== undefined) {
    return found;
  }
  // Fall back on the wire name, so a caller can say what it sees on the wire.
  for (const each of object.eClass().getEAllStructuralFeatures() as unknown as EStructuralFeature[]) {
    if (wireNameOf(each) === name) {
      return each;
    }
  }
  return null;
}

function child(object: EObject, name: string): EObject | null {
  const found = feature(object, name);
  if (found === null || !object.eIsSet(found)) {
    return null;
  }
  const value = object.eGet(found);
  return typeof (value as { eClass?: unknown })?.eClass === 'function' ? (value as EObject) : null;
}

function children(object: EObject, name: string): EObject[] {
  const found = feature(object, name);
  if (found === null || !object.eIsSet(found)) {
    return [];
  }
  const value = object.eGet(found);
  if (found.isMany()) {
    return [...(value as Iterable<EObject>)];
  }
  return typeof (value as { eClass?: unknown })?.eClass === 'function' ? [value as EObject] : [];
}

function value(object: EObject, name: string): unknown {
  const found = feature(object, name);
  return found === null || !object.eIsSet(found) ? null : object.eGet(found);
}
