/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventKind, XmlCursor } from '@eclipse-daanse/emf-xml';
import type { XmlaCell, XmlaCellset } from '@eclipse-daanse/xmla-workbench-adapter';

/**
 * The Daanse OLAP check suites, read as an oracle for this client.
 *
 * Every catalog the Daanse probe ships comes with a `check/checkSuite.xmi`:
 * what the catalog holds - cubes, dimensions, hierarchies, levels, measures,
 * KPIs - and MDX queries with the cell values they must answer. The server runs
 * them against itself at start-up. Read here, they become expectations for what
 * the same server must answer **over XMLA**, through this client: an
 * independent statement of the right answer, written by the people who wrote
 * the catalog, which is exactly what a compatibility kit lacks otherwise.
 *
 * Reading is by hand over the XML cursor rather than through an Ecore model of
 * `org.eclipse.daanse.olap.check`: the vocabulary is small, this repository
 * does not carry that model, and a reader that only knows the elements it uses
 * is the honest description of what is used.
 */

export interface AttributeCheck {
  /** HAS_ALL, VISIBLE, FORMAT_STRING, ... - null where the suite gives none. */
  readonly attributeType: string | null;
  readonly expectedValue: string | null;
  readonly expectedBoolean: boolean | null;
  readonly expectedAggregator: string | null;
}

export interface LevelCheck {
  readonly levelName: string;
  readonly attributes: readonly AttributeCheck[];
}

export interface HierarchyCheck {
  readonly hierarchyName: string;
  readonly levels: readonly LevelCheck[];
  readonly attributes: readonly AttributeCheck[];
}

export interface DimensionCheck {
  readonly dimensionName: string;
  readonly hierarchies: readonly HierarchyCheck[];
  readonly attributes: readonly AttributeCheck[];
}

export interface NamedObjectCheck {
  readonly name: string;
  readonly attributes: readonly AttributeCheck[];
}

export interface CubeCheck {
  readonly cubeName: string;
  readonly dimensions: readonly DimensionCheck[];
  readonly measures: readonly NamedObjectCheck[];
  readonly kpis: readonly NamedObjectCheck[];
  readonly namedSets: readonly NamedObjectCheck[];
  readonly attributes: readonly AttributeCheck[];
}

export interface CellCheck {
  readonly name: string;
  /** One entry per axis, in axis order; for a tabular answer row then column. Empty means the one cell. */
  readonly coordinates: readonly number[];
  readonly expectedValue: string | null;
  readonly expectedNumericValue: number | null;
  readonly tolerance: number | null;
  readonly checkFormattedValue: boolean;
}

export interface AxisCheck {
  readonly expectedPositionCount: number | null;
  readonly expectedFirstMemberUniqueName: string | null;
}

export interface QueryCheck {
  readonly name: string;
  readonly query: string;
  /** MDX unless the suite says SQL, which XMLA has no way to send. */
  readonly language: 'MDX' | 'SQL';
  readonly expectedRowCount: number | null;
  readonly expectedColumnCount: number | null;
  readonly cells: readonly CellCheck[];
  readonly axes: readonly AxisCheck[];
}

export interface CatalogCheck {
  readonly catalogName: string;
  readonly cubes: readonly CubeCheck[];
  readonly queries: readonly QueryCheck[];
}

export interface ConnectionCheck {
  readonly name: string;
  /** Roles the connection has to hold. Non-empty means an anonymous client cannot run it. */
  readonly roles: readonly string[];
  readonly catalogs: readonly CatalogCheck[];
}

export interface Suite {
  readonly name: string;
  /** Where it was read from, for a report to point at. */
  readonly file: string;
  readonly connections: readonly ConnectionCheck[];
}

/** A tree the size of the file, because the file is small and the vocabulary is flat. */
interface Node {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: Node[];
  text: string;
}

function parse(xml: string): Node {
  const cursor = XmlCursor.parse(xml);
  const root: Node = { name: '', attributes: {}, children: [], text: '' };
  const stack: Node[] = [root];
  let kind = cursor.next();
  while (kind !== null) {
    const top = stack[stack.length - 1]!;
    if (kind === EventKind.START) {
      const attributes: Record<string, string> = {};
      for (const attribute of cursor.attributes) {
        attributes[attribute.localName] = attribute.value;
      }
      const node: Node = { name: cursor.localName, attributes, children: [], text: '' };
      top.children.push(node);
      stack.push(node);
    } else if (kind === EventKind.END) {
      stack.pop();
    } else if (kind === EventKind.TEXT) {
      top.text += cursor.text;
    }
    kind = cursor.next();
  }
  const document = root.children[0];
  if (document === undefined) {
    throw new Error('the suite is empty');
  }
  return document;
}

function children(node: Node, name: string): Node[] {
  return node.children.filter((child) => child.name === name);
}

function attribute(node: Node, name: string): string | null {
  const value = node.attributes[name];
  return value === undefined ? null : value;
}

function number(node: Node, name: string): number | null {
  const text = attribute(node, name);
  if (text === null || text.trim() === '') {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function boolean(node: Node, name: string): boolean | null {
  const text = attribute(node, name);
  return text === null ? null : text.trim().toLowerCase() === 'true';
}

function attributeChecks(node: Node, elementName: string): AttributeCheck[] {
  return children(node, elementName).map((each) => ({
    attributeType: attribute(each, 'attributeType'),
    expectedValue: attribute(each, 'expectedValue'),
    expectedBoolean: boolean(each, 'expectedBoolean'),
    expectedAggregator: attribute(each, 'expectedAggregator'),
  }));
}

function namedObjects(node: Node, elementName: string, nameAttribute: string, attributeElement: string): NamedObjectCheck[] {
  return children(node, elementName).map((each) => ({
    name: attribute(each, nameAttribute) ?? '',
    attributes: attributeChecks(each, attributeElement),
  }));
}

/** Reads one `checkSuite.xmi`. */
export function readSuite(xml: string, file: string): Suite {
  const document = parse(xml);
  return {
    name: attribute(document, 'name') ?? file,
    file,
    connections: children(document, 'connectionChecks').map((connection) => ({
      name: attribute(connection, 'name') ?? '',
      roles: children(connection, 'connectionConfig').flatMap((config) =>
        children(config, 'roles')
          .map((role) => role.text.trim())
          .filter((role) => role !== ''),
      ),
      catalogs: children(connection, 'catalogChecks').map((catalog) => ({
        catalogName: attribute(catalog, 'catalogName') ?? '',
        cubes: children(catalog, 'cubeChecks').map((cube) => ({
          cubeName: attribute(cube, 'cubeName') ?? '',
          dimensions: children(cube, 'dimensionChecks').map((dimension) => ({
            dimensionName: attribute(dimension, 'dimensionName') ?? '',
            hierarchies: children(dimension, 'hierarchyChecks').map((hierarchy) => ({
              hierarchyName: attribute(hierarchy, 'hierarchyName') ?? '',
              levels: children(hierarchy, 'levelChecks').map((level) => ({
                levelName: attribute(level, 'levelName') ?? '',
                attributes: attributeChecks(level, 'levelAttributeChecks'),
              })),
              attributes: attributeChecks(hierarchy, 'hierarchyAttributeChecks'),
            })),
            attributes: attributeChecks(dimension, 'dimensionAttributeChecks'),
          })),
          measures: namedObjects(cube, 'measureChecks', 'measureName', 'measureAttributeChecks'),
          kpis: namedObjects(cube, 'kpiChecks', 'kpiName', 'kpiAttributeChecks'),
          namedSets: namedObjects(cube, 'namedSetChecks', 'namedSetName', 'namedSetAttributeChecks'),
          attributes: attributeChecks(cube, 'cubeAttributeChecks'),
        })),
        queries: children(catalog, 'queryChecks').map((query) => ({
          name: attribute(query, 'name') ?? '',
          query: attribute(query, 'query') ?? '',
          language: (attribute(query, 'queryLanguage') ?? 'MDX').toUpperCase() === 'SQL' ? 'SQL' : 'MDX',
          expectedRowCount: number(query, 'expectedRowCount'),
          expectedColumnCount: number(query, 'expectedColumnCount'),
          cells: children(query, 'cellChecks').map((cell) => ({
            name: attribute(cell, 'name') ?? '',
            coordinates: children(cell, 'coordinates')
              .map((coordinate) => Number(coordinate.text.trim()))
              .filter((coordinate) => Number.isFinite(coordinate)),
            expectedValue: attribute(cell, 'expectedValue'),
            expectedNumericValue: number(cell, 'expectedNumericValue'),
            tolerance: number(cell, 'tolerance'),
            checkFormattedValue: boolean(cell, 'checkFormattedValue') ?? false,
          })),
          axes: children(query, 'axisChecks').map((axis) => ({
            expectedPositionCount: number(axis, 'expectedPositionCount'),
            expectedFirstMemberUniqueName: attribute(axis, 'expectedFirstMemberUniqueName'),
          })),
        })),
      })),
    })),
  };
}

/**
 * Every suite under a catalog directory: `<dir>/<catalog>/check/checkSuite.xmi`,
 * which is how the Daanse probe lays them out.
 */
export function loadSuites(directory: string): Suite[] {
  if (!existsSync(directory)) {
    throw new Error(`no such directory: ${directory}`);
  }
  const suites: Suite[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = join(directory, entry.name, 'check', 'checkSuite.xmi');
    if (existsSync(file)) {
      suites.push(readSuite(readFileSync(file, 'utf8'), file));
    }
  }
  return suites.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * The cell a check's coordinates name, in the flat cellset.
 *
 * Two conventions, because the answers have two shapes. A dataset's
 * coordinates are one per axis, axis 0 first, and axis 0 varies fastest. A
 * tabular answer - a DRILLTHROUGH, a DMV - is written row first, then column,
 * and the adapter lays its rows out with the columns varying fastest. No
 * coordinates means the one cell a query without axes answers.
 */
export function cellOrdinal(coordinates: readonly number[], cellset: XmlaCellset, tabular: boolean): number {
  if (coordinates.length === 0) {
    return 0;
  }
  const columns = cellset.axes[0]?.tuples.length ?? 1;
  if (tabular) {
    const row = coordinates[0]!;
    const column = coordinates[1] ?? 0;
    return row * columns + column;
  }
  let ordinal = 0;
  let stride = 1;
  coordinates.forEach((coordinate, axis) => {
    ordinal += coordinate * stride;
    stride *= Math.max(cellset.axes[axis]?.tuples.length ?? 1, 1);
  });
  return ordinal;
}

/**
 * Whether a cell answers what the check expects, and if not, why.
 *
 * A numeric expectation is compared within its tolerance. A textual one is
 * compared as a number when both sides read as one - the suites write `2025.0`
 * for a year the server answers as `2025` - and as text otherwise. With
 * `checkFormattedValue` it is the formatted value that has to match, character
 * for character, because that is what the format string is being checked for.
 */
export function cellMismatch(check: CellCheck, cell: XmlaCell | undefined): string | null {
  if (cell === undefined) {
    return `${check.name}: no cell at ${JSON.stringify(check.coordinates)}`;
  }
  if (check.checkFormattedValue) {
    if (check.expectedValue !== null && cell.formattedValue !== check.expectedValue) {
      return `${check.name}: formatted ${JSON.stringify(cell.formattedValue)}, expected ${JSON.stringify(check.expectedValue)}`;
    }
    return null;
  }
  if (check.expectedNumericValue !== null) {
    const actual = asNumber(cell.value);
    const tolerance = check.tolerance ?? 0.000_001;
    if (actual === null || Math.abs(actual - check.expectedNumericValue) > tolerance) {
      return `${check.name}: ${JSON.stringify(cell.value)}, expected ${check.expectedNumericValue}`;
    }
    return null;
  }
  if (check.expectedValue !== null) {
    const expectedNumber = asNumber(check.expectedValue);
    const actualNumber = asNumber(cell.value);
    if (expectedNumber !== null && actualNumber !== null) {
      if (Math.abs(expectedNumber - actualNumber) > (check.tolerance ?? 0.000_001)) {
        return `${check.name}: ${JSON.stringify(cell.value)}, expected ${check.expectedValue}`;
      }
      return null;
    }
    const actualText = cell.value === null ? '' : String(cell.value);
    if (actualText !== check.expectedValue && cell.formattedValue !== check.expectedValue) {
      return `${check.name}: ${JSON.stringify(actualText)}, expected ${JSON.stringify(check.expectedValue)}`;
    }
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** MDMEASURE_AGGR_*, the numbers MDSCHEMA_MEASURES answers for MEASURE_AGGREGATOR. */
export const AGGREGATORS: Readonly<Record<string, number>> = {
  UNKNOWN: 0,
  SUM: 1,
  COUNT: 2,
  MIN: 3,
  MAX: 4,
  AVG: 5,
  VAR: 6,
  STD: 7,
  DISTINCT_COUNT: 8,
  NONE: 9,
  AVERAGEOFCHILDREN: 10,
  FIRSTCHILD: 11,
  LASTCHILD: 12,
  FIRSTNONEMPTY: 13,
  LASTNONEMPTY: 14,
  BYACCOUNT: 15,
  CALCULATED: 127,
};

/** A row of a schema rowset, by column name on the wire. */
export type Row = ReadonlyMap<string, string>;

/**
 * Whether one attribute check holds against the schema row that describes the
 * object, and if not, why. Null when it holds; `unmapped` when the suite's
 * attribute has no column in the rowset this client can read it from.
 *
 * The mapping is this project's, not the suite's: the suite speaks the OLAP
 * API's vocabulary (HAS_ALL, VISIBLE) and the rowsets speak [MS-SSAS]'s
 * (ALL_MEMBER, HIERARCHY_IS_VISIBLE). Where the two clearly name the same fact,
 * it is compared; where they do not, the check says so rather than guess.
 */
export function attributeMismatch(
  kind: 'cube' | 'dimension' | 'hierarchy' | 'level' | 'measure' | 'kpi' | 'namedSet',
  check: AttributeCheck,
  row: Row,
): string | null | 'unmapped' {
  const type = check.attributeType;
  const expectBoolean = check.expectedBoolean ?? (check.expectedValue === null ? null : check.expectedValue.trim().toLowerCase() === 'true');
  const compareBoolean = (column: string): string | null => {
    if (expectBoolean === null) {
      return null;
    }
    const actual = (row.get(column) ?? '').trim().toLowerCase() === 'true';
    return actual === expectBoolean ? null : `${type}: ${column}=${row.get(column) ?? ''}, expected ${expectBoolean}`;
  };
  const compareText = (column: string): string | null => {
    if (check.expectedValue === null) {
      return null;
    }
    const actual = row.get(column) ?? '';
    return actual === check.expectedValue ? null : `${type}: ${column}=${JSON.stringify(actual)}, expected ${JSON.stringify(check.expectedValue)}`;
  };

  switch (`${kind}:${type ?? ''}`) {
    case 'hierarchy:HAS_ALL': {
      if (expectBoolean === null) {
        return null;
      }
      // A hierarchy with an all level names its all member; one without has none.
      const hasAll = (row.get('ALL_MEMBER') ?? '').trim() !== '';
      return hasAll === expectBoolean ? null : `HAS_ALL: ALL_MEMBER=${JSON.stringify(row.get('ALL_MEMBER') ?? '')}, expected ${expectBoolean}`;
    }
    case 'hierarchy:ALL_MEMBER_NAME': {
      if (check.expectedValue === null) {
        return null;
      }
      // ALL_MEMBER is the all member's unique name; the suite gives its name.
      const all = row.get('ALL_MEMBER') ?? '';
      const matches = all === check.expectedValue || all.endsWith(`[${check.expectedValue}]`);
      return matches ? null : `ALL_MEMBER_NAME: ALL_MEMBER=${JSON.stringify(all)}, expected ${JSON.stringify(check.expectedValue)}`;
    }
    case 'hierarchy:VISIBLE':
      return compareBoolean('HIERARCHY_IS_VISIBLE');
    case 'dimension:VISIBLE':
      return compareBoolean('DIMENSION_IS_VISIBLE');
    case 'measure:VISIBLE':
      return compareBoolean('MEASURE_IS_VISIBLE');
    case 'measure:UNIQUE_NAME':
      return compareText('MEASURE_UNIQUE_NAME');
    case 'measure:FORMAT_STRING':
      return compareText('DEFAULT_FORMAT_STRING');
    case 'measure:DISPLAY_FOLDER':
      return compareText('MEASURE_DISPLAY_FOLDER');
    case 'measure:EXPRESSION':
      return compareText('EXPRESSION');
    case 'measure:AGGREGATOR': {
      if (check.expectedAggregator === null) {
        return null;
      }
      const expected = AGGREGATORS[check.expectedAggregator.toUpperCase()];
      if (expected === undefined) {
        return 'unmapped';
      }
      const actual = row.get('MEASURE_AGGREGATOR') ?? '';
      return String(expected) === actual.trim()
        ? null
        : `AGGREGATOR: MEASURE_AGGREGATOR=${actual}, expected ${expected} (${check.expectedAggregator})`;
    }
    case 'measure:':
      // A measure check with no type and a value: the name itself.
      return compareText('MEASURE_NAME');
    case 'kpi:VALUE':
      return compareText('KPI_VALUE');
    case 'kpi:GOAL':
      return compareText('KPI_GOAL');
    case 'kpi:STATUS':
      return compareText('KPI_STATUS');
    case 'kpi:TREND':
      return compareText('KPI_TREND');
    case 'kpi:DISPLAY_FOLDER':
      return compareText('KPI_DISPLAY_FOLDER');
    case 'namedSet:EXPRESSION':
      return compareText('EXPRESSION');
    case 'namedSet:DISPLAY_FOLDER':
      return compareText('SET_DISPLAY_FOLDER');
    default:
      return 'unmapped';
  }
}
