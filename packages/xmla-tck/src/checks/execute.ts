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

import { FetchTransport } from '@eclipse-daanse/xmla-client';
import { XmlaFaultError } from '@eclipse-daanse/xmla-io';
import { WorkbenchXmlaClient } from '@eclipse-daanse/xmla-workbench-adapter';
import type { XmlaCellset } from '@eclipse-daanse/xmla-workbench-adapter';

import { fetchWithDeadline, notHere, short, text, verdict } from '../kit.js';
import type { Check, Context, Detail } from '../kit.js';
import { executeRaw } from '../mdx.js';

/**
 * Execute: a statement in, a dataset out.
 *
 * These go through the workbench adapter rather than the bare client, because
 * that is the path a consumer takes, and a cellset that reads wrong there is
 * the failure that matters.
 */
function workbench(context: Context, catalog: string): WorkbenchXmlaClient {
  return new WorkbenchXmlaClient({
    url: context.profile.url,
    transport: new FetchTransport({ fetch: fetchWithDeadline(context.profile.timeoutMs ?? 30_000) }),
    models: context.models,
    ...(context.profile.credentials === undefined ? {} : { credentials: context.profile.credentials }),
    catalog,
  });
}

/** The one query every check here starts from: the measures of the first cube. */
function measuresOfFirstCube(context: Context): Promise<{ catalog: string; cube: string; cellset: XmlaCellset }> {
  return context.memo('execute:measures', async () => {
    const { catalog, cube } = await context.target();
    const cellset = await workbench(context, catalog).execute(`SELECT [Measures].Members ON COLUMNS FROM [${cube}]`);
    return { catalog, cube, cellset };
  });
}

export const execute: readonly Check[] = [
  {
    id: 'E1',
    group: 'execute',
    title: 'an MDX statement on a cube the server has answers a dataset with axes and cells',
    level: 'must',
    spec: '[MS-SSAS] 2.2.4.2 Execute, 2.2.4.2.1.2 MDDataSet; XMLA 1.1, "Execute" with Format=Multidimensional',
    async run(context) {
      const { catalog, cube, cellset } = await measuresOfFirstCube(context);
      if (cellset.axes.length === 0) {
        throw new Error(`[${cube}] answered no axis`);
      }
      if (cellset.cells.length === 0) {
        throw new Error(`[${cube}] answered no cells`);
      }
      const measures = cellset.axes[0]!.tuples.map((tuple) => tuple[0]?.caption ?? '?');
      return `${catalog} / [${cube}]: ${measures.length} measure(s), ${cellset.cells.length} cell(s); ${short(
        measures.slice(0, 4).join(', '),
        80,
      )}`;
    },
  },
  {
    id: 'E2',
    group: 'execute',
    title: 'the dataset carries the slicer axis, even for a query without WHERE',
    level: 'should',
    spec: '[MS-SSAS] 2.2.4.2.1.2: the Axes element carries the SlicerAxis',
    async run(context) {
      const { cellset } = await measuresOfFirstCube(context);
      if (cellset.slicer === undefined) {
        throw new Error('no SlicerAxis in the answer');
      }
      return `${cellset.slicer.length} member(s) on the slicer`;
    },
  },
  {
    id: 'E3',
    group: 'execute',
    title: 'every cell has an ordinal within the axes, and axis 0 varies fastest',
    level: 'must',
    spec: '[MS-SSAS] 2.2.4.2.1.2: CellOrdinal, and how it is computed from the axis positions',
    async run(context) {
      const { cellset } = await measuresOfFirstCube(context);
      const positions = cellset.axes.reduce((product, axis) => product * Math.max(axis.tuples.length, 1), 1);
      const outside = cellset.cells.filter((cell) => cell.ordinal < 0 || cell.ordinal >= positions);
      if (outside.length > 0) {
        throw new Error(`${outside.length} cell(s) with an ordinal outside 0..${positions - 1}`);
      }
      const ordinals = cellset.cells.map((cell) => cell.ordinal);
      const unsorted = ordinals.some((ordinal, index) => index > 0 && ordinal <= ordinals[index - 1]!);
      if (unsorted) {
        throw new Error('cell ordinals are not strictly ascending');
      }
      return `${cellset.cells.length} cell(s) within ${positions} position(s)`;
    },
  },
  {
    id: 'E4',
    group: 'execute',
    title: 'a statement that is not MDX answers a fault the client reports as one',
    level: 'must',
    spec: 'SOAP 1.1 §4.4 Fault; [MS-SSAS] 2.2.4.2.2 - an Execute error is a SOAP fault',
    async run(context) {
      const { catalog } = await context.target();
      try {
        await workbench(context, catalog).execute('THIS IS NOT MDX');
      } catch (error) {
        if (error instanceof XmlaFaultError) {
          return `fault: ${short(error.message, 120)}`;
        }
        throw new Error(`refused, but not with a fault this client can read: ${short(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 160)}`);
      }
      throw new Error('the server answered a dataset for text that is not a statement');
    },
  },
  {
    id: 'E5',
    group: 'execute',
    title: 'a DMV statement answers a rowset through Execute, and it reads as one',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.3.2: $SYSTEM schema rowsets through Execute (an Analysis Services extension)',
    async run(context) {
      const { catalog } = await context.target();
      let cellset: XmlaCellset;
      try {
        cellset = await workbench(context, catalog).execute('SELECT * FROM $SYSTEM.DBSCHEMA_CATALOGS');
      } catch (error) {
        if (error instanceof XmlaFaultError) {
          notHere(`this server has no DMVs: ${short(error.message, 80)}`);
        }
        throw error;
      }
      if (cellset.cells.length === 0) {
        throw new Error('the DMV answered no rows');
      }
      return `${cellset.axes[1]?.tuples.length ?? '?'} row(s) as a cellset`;
    },
  },
  {
    id: 'E6',
    group: 'execute',
    title: 'the numbers come out of the database, not out of the server',
    level: 'must',
    spec: 'Not a protocol claim: the totals the server answers equal the totals computed from the file it was loaded from',
    async run(context) {
      const csvPath = context.profile.knownDataCsv;
      if (csvPath === undefined) {
        notHere('the profile names no csv the data came from');
      }
      const { client } = await context.connected();
      const cubes = await client.discover('MDSCHEMA_CUBES');
      const sales = cubes.rows.find((row) => text(row, 'CUBE_NAME') === 'Sales');
      if (sales === undefined) {
        notHere('this server has no Sales cube');
      }
      // The name is not enough: FoodMart has a Sales cube too, and its measures
      // are other measures entirely. Ask what this one holds first.
      const catalog = text(sales, 'CATALOG_NAME');
      const measures = await client.discover('MDSCHEMA_MEASURES', [
        { name: 'CATALOG_NAME', value: catalog },
        { name: 'CUBE_NAME', value: 'Sales' },
      ]);
      const held = new Set(measures.rows.map((row) => text(row, 'MEASURE_NAME')));
      if (!held.has('Amount') || !held.has('Quantity')) {
        notHere(`this Sales cube holds ${[...held].slice(0, 4).join(', ')} rather than Amount and Quantity - it is another Sales`);
      }

      const cellset = await workbench(context, catalog).execute(
        'SELECT {[Measures].[Amount], [Measures].[Quantity]} ON COLUMNS, [Region].[Region].Members ON ROWS FROM [Sales]',
      );
      const columns = cellset.axes[0]!.tuples.map((tuple) => tuple[0]!.caption);
      const rows = cellset.axes[1]!.tuples.map((tuple) => tuple[0]!.caption);
      const at = (row: number, column: number): number | string | null => {
        const cell = cellset.cells.find((each) => each.ordinal === row * columns.length + column);
        return cell === undefined ? null : cell.value;
      };

      // Both sides are computed from the same file, so a wrong total cannot
      // agree with a wrong expectation.
      const csv = readFileSync(csvPath, 'utf8')
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.split(',').map((cell) => cell.trim()));
      const expected = new Map<string, { amount: number; quantity: number }>();
      for (const [region, , , amount, quantity] of csv) {
        const sum = expected.get(region!) ?? { amount: 0, quantity: 0 };
        expected.set(region!, { amount: sum.amount + Number(amount), quantity: sum.quantity + Number(quantity) });
      }
      const total = [...expected.values()].reduce(
        (sum, each) => ({ amount: sum.amount + each.amount, quantity: sum.quantity + each.quantity }),
        { amount: 0, quantity: 0 },
      );

      const wrong: string[] = [];
      rows.forEach((caption, index) => {
        const want = caption.startsWith('All') ? total : expected.get(caption);
        if (want === undefined) {
          wrong.push(`${caption}: not a region the csv has`);
          return;
        }
        if (at(index, 0) !== want.amount) {
          wrong.push(`${caption} Amount ${at(index, 0)} != ${want.amount}`);
        }
        if (at(index, 1) !== want.quantity) {
          wrong.push(`${caption} Quantity ${at(index, 1)} != ${want.quantity}`);
        }
      });
      if (wrong.length > 0) {
        throw new Error(wrong.join('; '));
      }
      return `${rows.length} regions x ${columns.length} measures, every total matches the csv (all: ${total.amount} / ${total.quantity})`;
    },
  },
  {
    id: 'E7',
    group: 'execute',
    title: 'Format=Tabular answers the same query as a rowset, and it reads as one',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.3.2 Format property: Tabular returns a rowset rather than an MDDataSet',
    async run(context) {
      const { catalog, cube } = await context.target();
      const answer = await executeRaw(context, catalog, `SELECT [Measures].Members ON COLUMNS FROM [${cube}]`, {
        properties: { Format: 'Tabular' },
      });
      if (!answer.tabular) {
        throw new Error('asked for Tabular, answered a dataset');
      }
      if (answer.readError !== null) {
        throw new Error(`a rowset that does not read: ${short(answer.readError, 120)}`);
      }
      return `a rowset of ${answer.cellset?.axes[0]?.tuples.length ?? 0} column(s), ${answer.cellset?.cells.length ?? 0} cell(s)`;
    },
  },
  {
    id: 'E8',
    group: 'execute',
    title: 'Content=Schema answers the schema without data, Content=Data the data without schema',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.3.2 Content property: None, Schema, Data, SchemaData',
    async run(context) {
      const { catalog, cube } = await context.target();
      const statement = `SELECT [Measures].Members ON COLUMNS FROM [${cube}]`;
      const details: Detail[] = [];
      const schemaOnly = await executeRaw(context, catalog, statement, { properties: { Content: 'Schema' } });
      const cellsInSchemaOnly = schemaOnly.cellset?.cells.length ?? 0;
      details.push({
        name: 'Content=Schema',
        status: schemaOnly.hasInlineSchema && cellsInSchemaOnly === 0 ? 'pass' : 'fail',
        note: `${schemaOnly.hasInlineSchema ? 'schema' : 'no schema'}, ${cellsInSchemaOnly} cell(s)`,
      });
      const dataOnly = await executeRaw(context, catalog, statement, { properties: { Content: 'Data' } });
      const cellsInDataOnly = dataOnly.cellset?.cells.length ?? 0;
      details.push({
        name: 'Content=Data',
        status: !dataOnly.hasInlineSchema && cellsInDataOnly > 0 ? 'pass' : 'fail',
        note: `${dataOnly.hasInlineSchema ? 'schema' : 'no schema'}, ${cellsInDataOnly} cell(s)${dataOnly.readError === null ? '' : `; ${short(dataOnly.readError, 80)}`}`,
      });
      return verdict(details);
    },
  },
  {
    id: 'E9',
    group: 'execute',
    title: 'every AxisFormat is answered, and the client reads each',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.3.2 AxisFormat property: TupleFormat, ClusterFormat, CustomFormat',
    async run(context) {
      const { catalog, cube } = await context.target();
      const statement = `SELECT [Measures].Members ON COLUMNS FROM [${cube}]`;
      const details: Detail[] = [];
      for (const format of ['TupleFormat', 'ClusterFormat', 'CustomFormat']) {
        try {
          const answer = await executeRaw(context, catalog, statement, { properties: { AxisFormat: format } });
          const cells = answer.cellset?.cells.length ?? 0;
          details.push({
            name: `AxisFormat=${format}`,
            status: answer.readError === null && cells > 0 ? 'pass' : 'fail',
            note: answer.readError === null ? `${cells} cell(s)` : `answered, but the client cannot read it: ${short(answer.readError, 100)}`,
          });
        } catch (error) {
          details.push({ name: `AxisFormat=${format}`, status: 'fail', note: short(error instanceof Error ? error.message : String(error), 120) });
        }
      }
      return verdict(details);
    },
  },
  {
    id: 'E10',
    group: 'execute',
    title: 'BeginRange and EndRange narrow the cells to the range asked for',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.3.2 BeginRange and EndRange properties: the ordinals of the first and last cell returned',
    async run(context) {
      const { catalog, cube } = await context.target();
      const answer = await executeRaw(context, catalog, `SELECT [Measures].Members ON COLUMNS FROM [${cube}]`, {
        properties: { BeginRange: 0, EndRange: 0 },
      });
      const cells = answer.cellset?.cells ?? [];
      if (cells.length > 1 || cells.some((cell) => cell.ordinal !== 0)) {
        throw new Error(`asked for cell 0 only, answered ${cells.length} cell(s): ${cells.slice(0, 4).map((cell) => cell.ordinal).join(', ')}`);
      }
      return `${cells.length} cell(s), ordinal 0`;
    },
  },
  {
    id: 'E11',
    group: 'execute',
    title: 'CELL PROPERTIES asked for in the statement come back on the cells',
    level: 'should',
    spec: '[MS-SSAS] 2.2.4.2.1.2 CellData: the properties a statement names with CELL PROPERTIES',
    async run(context) {
      const { catalog, cube } = await context.target();
      const answer = await executeRaw(
        context,
        catalog,
        `SELECT [Measures].Members ON COLUMNS FROM [${cube}] CELL PROPERTIES VALUE, FORMATTED_VALUE, FORMAT_STRING`,
      );
      const cells = answer.cellset?.cells ?? [];
      if (cells.length === 0) {
        throw new Error('no cells');
      }
      const formatted = cells.filter((cell) => cell.formattedValue !== '').length;
      if (formatted === 0) {
        throw new Error(`${cells.length} cell(s), none with a FORMATTED_VALUE`);
      }
      return `${formatted} of ${cells.length} cell(s) carry a formatted value`;
    },
  },
  {
    id: 'E12',
    group: 'execute',
    title: 'the Catalog property routes a statement to another catalog',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.3.2 Catalog property: the database the statement runs against',
    async run(context) {
      const { client } = await context.connected();
      const { catalog } = await context.target();
      const others = (await client.discover('DBSCHEMA_CATALOGS')).rows
        .map((row) => text(row, 'CATALOG_NAME'))
        .filter((name) => name !== '' && name !== catalog);
      for (const other of others) {
        let cube: string | null = null;
        try {
          const cubes = await client.discover('MDSCHEMA_CUBES', [{ name: 'CATALOG_NAME', value: other }]);
          cube = cubes.rows.map((row) => text(row, 'CUBE_NAME')).find((name) => name !== '') ?? null;
        } catch {
          continue;
        }
        if (cube === null) {
          continue;
        }
        const answer = await executeRaw(context, other, `SELECT [Measures].Members ON COLUMNS FROM [${cube}]`);
        if ((answer.cellset?.cells.length ?? 0) === 0) {
          throw new Error(`${other} / [${cube}] answered no cells`);
        }
        return `${other} / [${cube}]: ${answer.cellset!.cells.length} cell(s), beside ${catalog}`;
      }
      notHere(`no second catalog with a cube beside ${JSON.stringify(catalog)}`);
    },
  },
  {
    id: 'E13',
    group: 'execute',
    title: 'a query on two axes answers columns times rows cells, ordinals in order',
    level: 'must',
    spec: '[MS-SSAS] 2.2.4.2.1.2: CellOrdinal over two axes, axis 0 varying fastest',
    async run(context) {
      const sample = await context.sample();
      if (sample.levelUniqueName === null) {
        notHere('the target cube has no level to put on a second axis');
      }
      const answer = await executeRaw(
        context,
        sample.catalog,
        `SELECT [Measures].Members ON COLUMNS, Head(${sample.levelUniqueName}.Members, 5) ON ROWS FROM [${sample.cube}]`,
      );
      if (answer.readError !== null || answer.cellset === null) {
        throw new Error(answer.readError ?? 'no cellset');
      }
      const columns = answer.cellset.axes[0]?.tuples.length ?? 0;
      const rows = answer.cellset.axes[1]?.tuples.length ?? 0;
      if (rows === 0) {
        throw new Error(`no positions on the row axis for ${sample.levelUniqueName}`);
      }
      const outside = answer.cellset.cells.filter((cell) => cell.ordinal < 0 || cell.ordinal >= columns * rows);
      if (outside.length > 0) {
        throw new Error(`${outside.length} cell(s) outside 0..${columns * rows - 1}`);
      }
      if (answer.cellset.cells.length > columns * rows) {
        throw new Error(`${answer.cellset.cells.length} cells for ${columns} x ${rows} positions`);
      }
      return `${columns} column(s) x ${rows} row(s), ${answer.cellset.cells.length} cell(s)`;
    },
  },
  {
    id: 'E14',
    group: 'execute',
    title: 'a WHERE clause puts its member on the slicer axis',
    level: 'should',
    spec: '[MS-SSAS] 2.2.4.2.1.2: the SlicerAxis carries the members of the WHERE clause',
    async run(context) {
      const sample = await context.sample();
      if (sample.memberUniqueName === null) {
        notHere('the target cube has no member to slice by');
      }
      const answer = await executeRaw(
        context,
        sample.catalog,
        `SELECT [Measures].Members ON COLUMNS FROM [${sample.cube}] WHERE (${sample.memberUniqueName})`,
      );
      if (answer.readError !== null || answer.cellset === null) {
        throw new Error(answer.readError ?? 'no cellset');
      }
      const slicer = answer.cellset.slicer ?? [];
      if (!slicer.some((member) => member.uniqueName === sample.memberUniqueName)) {
        throw new Error(
          `${sample.memberUniqueName} not on the slicer; it carries ${slicer.length === 0 ? 'nothing' : slicer.slice(0, 3).map((member) => member.uniqueName).join(', ')}`,
        );
      }
      return `${sample.memberUniqueName} on the slicer, with ${slicer.length - 1} other(s)`;
    },
  },
];
