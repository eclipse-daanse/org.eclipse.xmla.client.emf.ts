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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { XmlaCellset } from '@eclipse-daanse/xmla-workbench-adapter';
import { describe, expect, it } from 'vitest';

import { attributeMismatch, cellMismatch, cellOrdinal, loadSuites, readSuite } from '../src/suites.js';
import type { CellCheck } from '../src/suites.js';

/**
 * The suite reader and the comparisons, on five suites copied from the Daanse
 * probe. What a server answers is the server's business; that the
 * expectations are read right and compared right is this file's.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'suites');

function suite(name: string) {
  const file = join(FIXTURES, name, 'check', 'checkSuite.xmi');
  return readSuite(readFileSync(file, 'utf8'), file);
}

describe('reading a suite', () => {
  it('finds the catalog, its cube, the measure and the query with its cell and axis', () => {
    const minimal = suite('tutorial.cube.minimal');
    expect(minimal.name).toBe('MinimalCubeSuite');
    expect(minimal.connections).toHaveLength(1);
    const [connection] = minimal.connections;
    expect(connection!.roles).toEqual([]);
    const [catalog] = connection!.catalogs;
    expect(catalog!.catalogName).toBe('Daanse Tutorial - Cube Minimal');
    expect(catalog!.cubes.map((cube) => cube.cubeName)).toEqual(['MinimalCube']);
    expect(catalog!.cubes[0]!.measures.map((measure) => measure.name)).toEqual(['Measure-Sum']);

    const [query] = catalog!.queries;
    expect(query!.query).toBe('SELECT [Measures].[Measure-Sum] ON COLUMNS FROM [MinimalCube]');
    expect(query!.language).toBe('MDX');
    expect(query!.cells).toEqual([
      {
        name: 'CellValue-MeasureSum-Total',
        coordinates: [0],
        expectedValue: null,
        expectedNumericValue: 63,
        tolerance: 0.001,
        checkFormattedValue: false,
      },
    ]);
    expect(query!.axes).toEqual([{ expectedPositionCount: 1, expectedFirstMemberUniqueName: '[Measures].[Measure-Sum]' }]);
  });

  it('reads dimensions, hierarchies, levels and the attribute checks on them', () => {
    const hasAll = suite('tutorial.cube.hierarchy.hasall');
    const cube = hasAll.connections[0]!.catalogs[0]!.cubes[0]!;
    expect(cube.dimensions).toHaveLength(1);
    const hierarchies = cube.dimensions[0]!.hierarchies;
    expect(hierarchies.map((each) => each.hierarchyName)).toEqual([
      'Hierarchy - with HasAll',
      'Hierarchy - with HasAll and Names',
      'Hierarchy - Without HasAll',
    ]);
    expect(hierarchies[1]!.attributes).toEqual([
      { attributeType: 'HAS_ALL', expectedValue: null, expectedBoolean: true, expectedAggregator: null },
      { attributeType: 'ALL_MEMBER_NAME', expectedValue: 'theAllMemberName', expectedBoolean: null, expectedAggregator: null },
    ]);
    expect(hierarchies[2]!.levels.map((level) => level.levelName)).toEqual(['theLevel']);
    // A measure check with no attribute type: the name itself.
    expect(cube.measures[0]!.attributes[0]).toEqual({
      attributeType: null,
      expectedValue: 'theMeasure',
      expectedBoolean: null,
      expectedAggregator: null,
    });
  });

  it('reads KPIs and their parts, and a query with no coordinates for its one cell', () => {
    const kpi = suite('tutorial.kpi.intro');
    const cube = kpi.connections[0]!.catalogs[0]!.cubes[0]!;
    expect(cube.kpis.map((each) => each.name)).toEqual(['Kpi1', 'Kpi2', 'Kpi3']);
    expect(cube.kpis[2]!.attributes.map((each) => each.attributeType)).toEqual(['VALUE', 'DISPLAY_FOLDER']);
    const [query] = kpi.connections[0]!.catalogs[0]!.queries;
    expect(query!.expectedColumnCount).toBe(0);
    expect(query!.cells[0]!.coordinates).toEqual([]);
    expect(query!.cells[0]!.expectedValue).toBe('63.0');
  });

  it('reads a DRILLTHROUGH with row and column coordinates and formatted-value checks', () => {
    const tck = suite('tck.hierarchy.levelswithsamenames');
    const query = tck.connections[0]!.catalogs[0]!.queries.find((each) => each.query.startsWith('DRILLTHROUGH'));
    expect(query).toBeDefined();
    expect(query!.expectedRowCount).toBe(4);
    expect(query!.expectedColumnCount).toBe(8);
    expect(query!.cells[1]!.coordinates).toEqual([0, 1]);
    expect(query!.cells[2]!.checkFormattedValue).toBe(true);
  });

  it('reads the roles a connection needs', () => {
    const guarded = suite('tutorial.access.cubegrand');
    expect(guarded.connections[0]!.roles).toEqual(['role1']);
  });

  it('loads every suite under a catalog directory, sorted', () => {
    const all = loadSuites(FIXTURES);
    expect(all.map((each) => each.file.split('/').at(-3))).toEqual([
      'tck.hierarchy.levelswithsamenames',
      'tutorial.access.cubegrand',
      'tutorial.cube.hierarchy.hasall',
      'tutorial.cube.minimal',
      'tutorial.kpi.intro',
    ]);
  });
});

function cellset(columns: number, rows: number): XmlaCellset {
  const axes = [{ name: 'Axis0', ordinal: 0, tuples: Array.from({ length: columns }, () => []) }];
  if (rows > 0) {
    axes.push({ name: 'Axis1', ordinal: 1, tuples: Array.from({ length: rows }, () => []) });
  }
  return { axes, cells: [], cellCount: columns * Math.max(rows, 1) };
}

describe('finding the cell', () => {
  it('reads dataset coordinates per axis, axis 0 fastest', () => {
    const grid = cellset(3, 4);
    expect(cellOrdinal([], grid, false)).toBe(0);
    expect(cellOrdinal([2], grid, false)).toBe(2);
    expect(cellOrdinal([1, 2], grid, false)).toBe(1 + 2 * 3);
  });

  it('reads tabular coordinates as row then column', () => {
    const table = cellset(8, 4);
    expect(cellOrdinal([0], table, true)).toBe(0);
    expect(cellOrdinal([0, 1], table, true)).toBe(1);
    expect(cellOrdinal([2, 3], table, true)).toBe(2 * 8 + 3);
  });
});

describe('comparing a cell', () => {
  const check = (overrides: Partial<CellCheck>): CellCheck => ({
    name: 'c',
    coordinates: [0],
    expectedValue: null,
    expectedNumericValue: null,
    tolerance: null,
    checkFormattedValue: false,
    ...overrides,
  });
  const cell = (value: number | string | null, formattedValue = String(value ?? '')) => ({ ordinal: 0, value, formattedValue });

  it('reports a cell that is not there', () => {
    expect(cellMismatch(check({}), undefined)).toMatch(/no cell/);
  });

  it('compares a numeric expectation within its tolerance', () => {
    expect(cellMismatch(check({ expectedNumericValue: 63, tolerance: 0.001 }), cell(63.0004))).toBeNull();
    expect(cellMismatch(check({ expectedNumericValue: 63, tolerance: 0.001 }), cell(63.1))).toMatch(/expected 63/);
    expect(cellMismatch(check({ expectedNumericValue: 63 }), cell('sixty-three'))).toMatch(/expected 63/);
  });

  it('compares a textual expectation as a number when both sides read as one', () => {
    // The suites write 2025.0 for a year the server answers as 2025.
    expect(cellMismatch(check({ expectedValue: '2025.0' }), cell(2025))).toBeNull();
    expect(cellMismatch(check({ expectedValue: '63.0' }), cell('63'))).toBeNull();
    expect(cellMismatch(check({ expectedValue: '63.0' }), cell(64))).toMatch(/expected 63.0/);
  });

  it('compares text as text, and accepts the formatted value too', () => {
    expect(cellMismatch(check({ expectedValue: 'Berlin' }), cell('Berlin'))).toBeNull();
    expect(cellMismatch(check({ expectedValue: 'Berlin' }), cell('Bonn'))).toMatch(/expected "Berlin"/);
    expect(cellMismatch(check({ expectedValue: '1,234' }), cell(1234, '1,234'))).toBeNull();
  });

  it('compares the formatted value character for character when asked to', () => {
    expect(cellMismatch(check({ expectedValue: '63.00', checkFormattedValue: true }), cell(63, '63.00'))).toBeNull();
    expect(cellMismatch(check({ expectedValue: '63.', checkFormattedValue: true }), cell(63, '63'))).toMatch(/formatted "63"/);
  });
});

describe('comparing an attribute', () => {
  const attribute = (attributeType: string | null, expected: Partial<{ value: string; boolean: boolean; aggregator: string }> = {}) => ({
    attributeType,
    expectedValue: expected.value ?? null,
    expectedBoolean: expected.boolean ?? null,
    expectedAggregator: expected.aggregator ?? null,
  });
  const row = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('reads HAS_ALL off whether the hierarchy names an all member', () => {
    expect(attributeMismatch('hierarchy', attribute('HAS_ALL', { boolean: true }), row({ ALL_MEMBER: '[D].[H].[All]' }))).toBeNull();
    expect(attributeMismatch('hierarchy', attribute('HAS_ALL', { boolean: false }), row({ ALL_MEMBER: '' }))).toBeNull();
    expect(attributeMismatch('hierarchy', attribute('HAS_ALL', { boolean: false }), row({ ALL_MEMBER: '[D].[H].[All]' }))).toMatch(/HAS_ALL/);
    // The suites also write it as a value.
    expect(attributeMismatch('hierarchy', attribute('HAS_ALL', { value: 'true' }), row({ ALL_MEMBER: '[D].[H].[All]' }))).toBeNull();
  });

  it('matches the all member name against the unique name the rowset gives', () => {
    expect(
      attributeMismatch('hierarchy', attribute('ALL_MEMBER_NAME', { value: 'All Years' }), row({ ALL_MEMBER: '[Year].[Year].[All Years]' })),
    ).toBeNull();
    expect(attributeMismatch('hierarchy', attribute('ALL_MEMBER_NAME', { value: 'All' }), row({ ALL_MEMBER: '[Year].[Year].[All Years]' }))).toMatch(
      /ALL_MEMBER_NAME/,
    );
  });

  it('maps visibility, format string, unique name and aggregator onto their columns', () => {
    expect(attributeMismatch('measure', attribute('VISIBLE', { boolean: true }), row({ MEASURE_IS_VISIBLE: 'true' }))).toBeNull();
    expect(attributeMismatch('dimension', attribute('VISIBLE', { boolean: true }), row({ DIMENSION_IS_VISIBLE: 'false' }))).toMatch(/VISIBLE/);
    expect(attributeMismatch('measure', attribute('FORMAT_STRING', { value: '$#,##0.00' }), row({ DEFAULT_FORMAT_STRING: '$#,##0.00' }))).toBeNull();
    expect(attributeMismatch('measure', attribute('UNIQUE_NAME', { value: '[Measures].[M]' }), row({ MEASURE_UNIQUE_NAME: '[Measures].[M]' }))).toBeNull();
    expect(attributeMismatch('measure', attribute('AGGREGATOR', { aggregator: 'COUNT' }), row({ MEASURE_AGGREGATOR: '2' }))).toBeNull();
    expect(attributeMismatch('measure', attribute('AGGREGATOR', { aggregator: 'COUNT' }), row({ MEASURE_AGGREGATOR: '1' }))).toMatch(/AGGREGATOR/);
    expect(attributeMismatch('measure', attribute(null, { value: 'theMeasure' }), row({ MEASURE_NAME: 'theMeasure' }))).toBeNull();
    expect(attributeMismatch('kpi', attribute('VALUE', { value: '[Measures].[M]' }), row({ KPI_VALUE: '[Measures].[M]' }))).toBeNull();
  });

  it('says so where the suite names a fact no rowset column carries', () => {
    expect(attributeMismatch('cube', attribute('VISIBLE', { boolean: true }), row({}))).toBe('unmapped');
    expect(attributeMismatch('level', attribute('IS_UNIQUE', { boolean: true }), row({}))).toBe('unmapped');
    expect(attributeMismatch('measure', attribute('DATA_TYPE', { value: 'Integer' }), row({}))).toBe('unmapped');
  });
});
