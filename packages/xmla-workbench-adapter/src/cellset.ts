/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlReader, EventKind, Unknown, wireNameOf, XmlCursor } from '@daanse/emf-xml';
import { XMLA_NAMESPACES } from '@daanse/xmla-model';
import type { XmlaModels } from '@daanse/xmla-model';
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
 * An Execute response answers in one of two shapes, and this is raised for the
 * one not handled yet.
 *
 * `NormTupleSet` is the optimised form SSAS sends when a client asks for it -
 * which Excel does, on every connect. It puts the tuples in a normalised side
 * structure rather than in the axis, so an implementation that walks the axis
 * finds nothing there and reports an empty result. Raising is the honest answer
 * until it is implemented: the alternative is a chart of no data that looks
 * like a query returning nothing.
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

  constructor(models: XmlaModels) {
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

  read(xml: string): XmlaCellset {
    // The check happens on the model, in tuplesOf, not on the text. Searching
    // the text for NormTupleSet matches the inline schema, which declares it in
    // every response whether or not the data uses it - so a plain response was
    // refused as if it were an optimised one.
    const cursor = XmlCursor.parse(xml);
    if (!moveTo(cursor, 'root')) {
      throw new Error('the response carries no <root>');
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
    // Excel asks for this on every connect. The tuples live in a normalised
    // side structure rather than in the axis, so walking the axis finds nothing
    // and would report a query that returned no data.
    throw new UnsupportedResponseShapeError('NormTupleSet');
  }
  if (kind === 'SetListType' || kind === 'Union') {
    // A CrossProduct or a Union: the alternatives it holds, concatenated. Their
    // order is the order of the positions.
    return children(set, 'setType').flatMap((inner) => tuplesOfSet(inner));
  }
  throw new UnsupportedResponseShapeError(kind ?? 'an unnamed set');
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
