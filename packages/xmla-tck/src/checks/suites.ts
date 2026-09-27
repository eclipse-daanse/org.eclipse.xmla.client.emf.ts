/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { wireNameOf } from '@daanse/emf-xml';
import type { DiscoverResult, XmlaClient } from '@daanse/xmla-client';
import { CellsetReader } from '@daanse/xmla-workbench-adapter';
import type { XmlaCellset } from '@daanse/xmla-workbench-adapter';
import type { EClass, EObject } from '@emfts/core';

import { notHere, short, text, verdict } from '../kit.js';
import type { Check, Context, Detail } from '../kit.js';
import { attributeMismatch, cellMismatch, cellOrdinal, loadSuites } from '../suites.js';
import type { CatalogCheck, CubeCheck, QueryCheck, Row, Suite } from '../suites.js';

/**
 * The Daanse check suites, run over XMLA.
 *
 * A profile that names the probe's `catalog/` directory gets these. Each suite
 * says what its catalog holds and what its queries answer; the checks ask the
 * server the same things through this client and compare. The suites were
 * written against the OLAP API and pass there, so a difference here is in the
 * XMLA layer or in this client - which is the layer this kit is about.
 *
 * Connections that need a role are left out: this client speaks to the server
 * anonymously, and the role-protected catalogs are not visible to it by design.
 */
interface Visible {
  readonly suite: Suite;
  readonly catalog: CatalogCheck;
}

interface Applicable {
  readonly visible: Visible[];
  readonly hidden: string[];
  readonly needRole: string[];
}

function suites(context: Context): Promise<Suite[]> {
  return context.memo('suites', async () => {
    const directory = context.profile.checkSuitesDir;
    if (directory === undefined) {
      notHere('the profile names no check-suite directory');
    }
    const loaded = loadSuites(directory);
    if (loaded.length === 0) {
      notHere(`no <catalog>/check/checkSuite.xmi under ${directory}`);
    }
    return loaded;
  });
}

/** The catalogs the suites name, sorted by whether this client can see them. */
function applicable(context: Context): Promise<Applicable> {
  return context.memo('suites:applicable', async () => {
    const all = await suites(context);
    const { client } = await context.connected();
    const listed = new Set((await client.discover('DBSCHEMA_CATALOGS')).rows.map((row) => text(row, 'CATALOG_NAME')));
    const visible: Visible[] = [];
    const hidden = new Set<string>();
    const needRole = new Set<string>();
    for (const suite of all) {
      for (const connection of suite.connections) {
        for (const catalog of connection.catalogs) {
          if (connection.roles.length > 0) {
            needRole.add(catalog.catalogName);
          } else if (listed.has(catalog.catalogName)) {
            visible.push({ suite, catalog });
          } else {
            hidden.add(catalog.catalogName);
          }
        }
      }
    }
    return { visible, hidden: [...hidden].sort(), needRole: [...needRole].sort() };
  });
}

/** The schema rowsets of one catalog, each fetched once and read as plain rows. */
interface CatalogSchema {
  cubes: Row[];
  dimensions: Row[];
  hierarchies: Row[];
  levels: Row[];
  measures: Row[];
  kpis(): Promise<Row[]>;
  sets(): Promise<Row[]>;
  /** MDSCHEMA_CUBES again, with ShowHiddenCubes - what a cube marked invisible is listed under. */
  hiddenCubes(): Promise<Row[]>;
}

/** A PropertyList carrying `ShowHiddenCubes=true`, the property a hidden cube is listed under. */
function showHiddenCubes(context: Context): EObject | null {
  const xmla = context.models.named('xmla');
  const eClass = xmla?.getEClassifier('PropertyList') as EClass | null | undefined;
  if (xmla === null || eClass === null || eClass === undefined) {
    return null;
  }
  const feature = eClass.getEStructuralFeature('showHiddenCubes');
  if (feature === null || feature === undefined) {
    return null;
  }
  const list = xmla.getEFactoryInstance().create(eClass);
  list.eSet(feature, true);
  return list;
}

function rowsOf(result: DiscoverResult): Row[] {
  return result.rows.map((row) => {
    const map = new Map<string, string>();
    for (const feature of row.eClass().getEAllStructuralFeatures()) {
      if (row.eIsSet(feature) && !feature.isMany()) {
        const value = row.eGet(feature);
        map.set(wireNameOf(feature), value === null || value === undefined ? '' : String(value));
      }
    }
    return map;
  });
}

function schemaOf(context: Context, catalogName: string): Promise<CatalogSchema> {
  return context.memo(`suites:schema:${catalogName}`, async () => {
    const { client } = await context.connected();
    const restricted = (requestType: string): Promise<Row[]> =>
      client.discover(requestType, [{ name: 'CATALOG_NAME', value: catalogName }]).then(rowsOf);
    const [cubes, dimensions, hierarchies, levels, measures] = await Promise.all([
      restricted('MDSCHEMA_CUBES'),
      restricted('MDSCHEMA_DIMENSIONS'),
      restricted('MDSCHEMA_HIERARCHIES'),
      restricted('MDSCHEMA_LEVELS'),
      restricted('MDSCHEMA_MEASURES'),
    ]);
    let kpis: Promise<Row[]> | null = null;
    let sets: Promise<Row[]> | null = null;
    let hidden: Promise<Row[]> | null = null;
    return {
      cubes,
      dimensions,
      hierarchies,
      levels,
      measures,
      kpis: () => (kpis ??= restricted('MDSCHEMA_KPIS')),
      sets: () => (sets ??= restricted('MDSCHEMA_SETS')),
      hiddenCubes: () =>
        (hidden ??= client
          .discover('MDSCHEMA_CUBES', [{ name: 'CATALOG_NAME', value: catalogName }], showHiddenCubes(context))
          .then(rowsOf)
          .catch(() => [])),
    };
  });
}

const inCube = (cube: string) => (row: Row) => row.get('CUBE_NAME') === cube;

/** Where each object of a cube check sits in the schema, or a note that it does not. */
interface Located {
  readonly missing: string[];
  /** Cubes listed only when asked with ShowHiddenCubes: hidden by the catalog, not missing from the server. */
  readonly hidden: string[];
  readonly attributes: Array<{ readonly kind: Parameters<typeof attributeMismatch>[0]; readonly check: Parameters<typeof attributeMismatch>[1]; readonly row: Row | null; readonly at: string }>;
}

async function locate(schema: CatalogSchema, cube: CubeCheck, catalogName: string): Promise<Located> {
  const missing: string[] = [];
  const hidden: string[] = [];
  const attributes: Located['attributes'] = [];
  const where = `${catalogName} / [${cube.cubeName}]`;

  let cubeRow = schema.cubes.find(inCube(cube.cubeName));
  if (cubeRow === undefined) {
    // A cube the catalog marks invisible is left out of MDSCHEMA_CUBES, as
    // [MS-SSAS] has it, and listed when asked with ShowHiddenCubes. The suite,
    // written against the OLAP API, sees it either way.
    cubeRow = (await schema.hiddenCubes()).find(inCube(cube.cubeName));
    if (cubeRow === undefined) {
      missing.push(`${where}: cube not in MDSCHEMA_CUBES, not even with ShowHiddenCubes`);
      return { missing, hidden, attributes };
    }
    hidden.push(where);
  }
  for (const check of cube.attributes) {
    attributes.push({ kind: 'cube', check, row: cubeRow, at: where });
  }

  for (const dimension of cube.dimensions) {
    const dimensionRow = schema.dimensions.find(
      (row) => inCube(cube.cubeName)(row) && row.get('DIMENSION_NAME') === dimension.dimensionName,
    );
    if (dimensionRow === undefined) {
      missing.push(`${where}: dimension ${JSON.stringify(dimension.dimensionName)} not in MDSCHEMA_DIMENSIONS`);
      continue;
    }
    for (const check of dimension.attributes) {
      attributes.push({ kind: 'dimension', check, row: dimensionRow, at: `${where} ${dimension.dimensionName}` });
    }
    const dimensionUnique = dimensionRow.get('DIMENSION_UNIQUE_NAME') ?? '';
    for (const hierarchy of dimension.hierarchies) {
      const hierarchyRow = schema.hierarchies.find(
        (row) =>
          inCube(cube.cubeName)(row) &&
          row.get('DIMENSION_UNIQUE_NAME') === dimensionUnique &&
          row.get('HIERARCHY_NAME') === hierarchy.hierarchyName,
      );
      if (hierarchyRow === undefined) {
        missing.push(`${where}: hierarchy ${JSON.stringify(hierarchy.hierarchyName)} of ${dimension.dimensionName} not in MDSCHEMA_HIERARCHIES`);
        continue;
      }
      const at = `${where} ${dimension.dimensionName}.${hierarchy.hierarchyName}`;
      for (const check of hierarchy.attributes) {
        attributes.push({ kind: 'hierarchy', check, row: hierarchyRow, at });
      }
      const hierarchyUnique = hierarchyRow.get('HIERARCHY_UNIQUE_NAME') ?? '';
      for (const level of hierarchy.levels) {
        const levelRow = schema.levels.find(
          (row) =>
            inCube(cube.cubeName)(row) &&
            row.get('HIERARCHY_UNIQUE_NAME') === hierarchyUnique &&
            row.get('LEVEL_NAME') === level.levelName,
        );
        if (levelRow === undefined) {
          missing.push(`${at}: level ${JSON.stringify(level.levelName)} not in MDSCHEMA_LEVELS`);
          continue;
        }
        for (const check of level.attributes) {
          attributes.push({ kind: 'level', check, row: levelRow, at: `${at}.${level.levelName}` });
        }
      }
    }
  }

  for (const measure of cube.measures) {
    const measureRow = schema.measures.find(
      (row) => inCube(cube.cubeName)(row) && row.get('MEASURE_NAME') === measure.name,
    );
    if (measureRow === undefined) {
      missing.push(`${where}: measure ${JSON.stringify(measure.name)} not in MDSCHEMA_MEASURES`);
      continue;
    }
    for (const check of measure.attributes) {
      attributes.push({ kind: 'measure', check, row: measureRow, at: `${where} [Measures].[${measure.name}]` });
    }
  }

  if (cube.kpis.length > 0) {
    const kpis = await schema.kpis();
    for (const kpi of cube.kpis) {
      const kpiRow = kpis.find((row) => inCube(cube.cubeName)(row) && row.get('KPI_NAME') === kpi.name);
      if (kpiRow === undefined) {
        missing.push(`${where}: KPI ${JSON.stringify(kpi.name)} not in MDSCHEMA_KPIS`);
        continue;
      }
      for (const check of kpi.attributes) {
        attributes.push({ kind: 'kpi', check, row: kpiRow, at: `${where} KPI ${kpi.name}` });
      }
    }
  }

  if (cube.namedSets.length > 0) {
    const sets = await schema.sets();
    for (const set of cube.namedSets) {
      const setRow = sets.find((row) => inCube(cube.cubeName)(row) && row.get('SET_NAME') === set.name);
      if (setRow === undefined) {
        missing.push(`${where}: named set ${JSON.stringify(set.name)} not in MDSCHEMA_SETS`);
        continue;
      }
      for (const check of set.attributes) {
        attributes.push({ kind: 'namedSet', check, row: setRow, at: `${where} set ${set.name}` });
      }
    }
  }

  return { missing, hidden, attributes };
}

/**
 * Every cube check of every visible catalog, located once.
 *
 * A catalog whose schema rowsets the server refuses is recorded under
 * `refused` and the others are still looked at: one broken catalog on a
 * server of ninety is one finding, not ninety.
 */
function located(context: Context): Promise<{ cubes: Array<Located & { readonly where: string }>; refused: string[] }> {
  return context.memo('suites:located', async () => {
    const { visible } = await applicable(context);
    const cubes: Array<Located & { readonly where: string }> = [];
    const refused: string[] = [];
    for (const { catalog } of visible) {
      let schema: CatalogSchema;
      try {
        schema = await schemaOf(context, catalog.catalogName);
      } catch (error) {
        refused.push(`${catalog.catalogName}: ${short(error instanceof Error ? error.message : String(error), 140)}`);
        continue;
      }
      for (const cube of catalog.cubes) {
        try {
          cubes.push({ ...(await locate(schema, cube, catalog.catalogName)), where: `${catalog.catalogName} / [${cube.cubeName}]` });
        } catch (error) {
          refused.push(`${catalog.catalogName} / [${cube.cubeName}]: ${short(error instanceof Error ? error.message : String(error), 140)}`);
        }
      }
    }
    return { cubes, refused };
  });
}

/**
 * One statement, executed with the catalog set, read as a cellset - and
 * whether the answer was a rowset rather than a dataset, because the two lay
 * their cells out differently.
 */
async function executeIn(
  context: Context,
  client: XmlaClient,
  catalogName: string,
  statement: string,
): Promise<{ cellset: XmlaCellset; tabular: boolean }> {
  const xmla = context.models.named('xmla');
  if (xmla === null) {
    throw new Error('the xmla model is not loaded');
  }
  const statementClass = xmla.getEClassifier('Statement') as EClass | null;
  if (statementClass === null || statementClass === undefined) {
    throw new Error('the xmla model has no Statement');
  }
  const command: EObject = xmla.getEFactoryInstance().create(statementClass);
  const textFeature = statementClass.getEStructuralFeature('statement');
  if (textFeature !== null && textFeature !== undefined) {
    command.eSet(textFeature, statement);
  }
  const xml = await client.withConnectionProperties({ catalog: catalogName }).execute(command);
  const reader = new CellsetReader(context.models);
  return { cellset: reader.read(xml), tabular: reader.readDataset(xml) === null };
}

function queryMismatches(query: QueryCheck, cellset: XmlaCellset, tabular: boolean): string[] {
  const wrong: string[] = [];
  const columns = cellset.axes[0]?.tuples.length ?? 0;
  const rows = cellset.axes[1]?.tuples.length ?? 0;
  if (query.expectedColumnCount !== null && columns !== query.expectedColumnCount) {
    wrong.push(`${columns} column(s), expected ${query.expectedColumnCount}`);
  }
  if (query.expectedRowCount !== null && rows !== query.expectedRowCount) {
    wrong.push(`${rows} row(s), expected ${query.expectedRowCount}`);
  }
  for (const axis of query.axes) {
    const first = cellset.axes[0];
    if (axis.expectedPositionCount !== null && (first?.tuples.length ?? 0) !== axis.expectedPositionCount) {
      wrong.push(`axis 0 has ${first?.tuples.length ?? 0} position(s), expected ${axis.expectedPositionCount}`);
    }
    if (axis.expectedFirstMemberUniqueName !== null) {
      const name = first?.tuples[0]?.[0]?.uniqueName ?? '';
      if (name !== axis.expectedFirstMemberUniqueName) {
        wrong.push(`axis 0 starts with ${JSON.stringify(name)}, expected ${JSON.stringify(axis.expectedFirstMemberUniqueName)}`);
      }
    }
  }
  for (const check of query.cells) {
    const ordinal = cellOrdinal(check.coordinates, cellset, tabular);
    const mismatch = cellMismatch(check, cellset.cells.find((cell) => cell.ordinal === ordinal));
    if (mismatch !== null) {
      wrong.push(mismatch);
    }
  }
  return wrong;
}

export const suiteChecks: readonly Check[] = [
  {
    id: 'K1',
    group: 'suites',
    title: 'the catalogs the check suites describe are listed by DBSCHEMA_CATALOGS',
    level: 'must',
    spec: 'Daanse OLAP check suites (catalog/<name>/check/checkSuite.xmi), catalogChecks/@catalogName; [MS-SSAS] DBSCHEMA_CATALOGS',
    async run(context) {
      const all = await suites(context);
      const { visible, hidden, needRole } = await applicable(context);
      if (visible.length === 0) {
        // Not one of them: these are another server's suites, not a server
        // that lost its catalogs. Said so, rather than failed.
        notHere(
          `none of the ${all.length} suites' catalogs is listed - the suites are not this server's${
            hidden.length === 0 ? '' : ` (${hidden.slice(0, 3).join(', ')}, …)`
          }`,
        );
      }
      return `${visible.length} listed${needRole.length === 0 ? '' : `, ${needRole.length} need a role`}${
        hidden.length === 0 ? '' : `, ${hidden.length} not listed: ${hidden.slice(0, 4).join(', ')}`
      } - of ${all.length} suites`;
    },
  },
  {
    id: 'K2',
    group: 'suites',
    title: 'every cube, dimension, hierarchy, level, measure, KPI and named set a suite names is in the schema rowsets',
    level: 'must',
    spec: 'Daanse OLAP check suites, cubeChecks and below; [MS-SSAS] MDSCHEMA_CUBES, _DIMENSIONS, _HIERARCHIES, _LEVELS, _MEASURES, _KPIS, _SETS',
    async run(context) {
      const { cubes, refused } = await located(context);
      if (cubes.length === 0 && refused.length === 0) {
        notHere('no visible catalog has cube checks');
      }
      const details: Detail[] = [
        ...refused.map((each) => ({ name: each.split(': ')[0]!, status: 'fail' as const, note: `refused: ${each.slice(each.indexOf(': ') + 2)}` })),
        ...cubes.map((cube) => ({
          name: cube.where,
          status: cube.missing.length === 0 ? ('pass' as const) : ('fail' as const),
          note:
            cube.missing.length === 0
              ? `${cube.attributes.length} attribute(s) located${cube.hidden.length === 0 ? '' : '; listed only with ShowHiddenCubes'}`
              : cube.missing.map((each) => each.slice(each.indexOf(': ') + 2)).join('; '),
        })),
      ];
      return verdict(details, `${cubes.length} cube(s) across ${new Set(cubes.map((each) => each.where.split(' / ')[0])).size} catalog(s)`);
    },
  },
  {
    id: 'K3',
    group: 'suites',
    title: 'what a suite says about an object - has-all, visibility, format, aggregator, KPI parts - is what the rowset says',
    level: 'should',
    spec: 'Daanse OLAP check suites, *AttributeChecks, mapped onto the [MS-SSAS] MDSCHEMA_* columns naming the same fact',
    async run(context) {
      const { cubes } = await located(context);
      const details: Detail[] = [];
      for (const cube of cubes) {
        for (const { kind, check, row, at } of cube.attributes) {
          if (row === null) {
            continue;
          }
          const result = attributeMismatch(kind, check, row);
          const name = `${at}: ${check.attributeType ?? 'name'}`;
          if (result === 'unmapped') {
            details.push({ name, status: 'skip', note: 'no rowset column names this fact' });
          } else if (result === null) {
            details.push({ name, status: 'pass', note: check.expectedValue ?? (check.expectedBoolean === null ? check.expectedAggregator : String(check.expectedBoolean)) });
          } else {
            details.push({ name, status: 'fail', note: result });
          }
        }
      }
      if (!details.some((detail) => detail.status !== 'skip')) {
        notHere(`no attribute check maps onto a rowset column (${details.length} unmapped)`);
      }
      return verdict(details);
    },
  },
  {
    id: 'K4',
    group: 'suites',
    title: 'every MDX query a suite gives answers the cells, counts and axes it expects',
    level: 'must',
    spec: 'Daanse OLAP check suites, queryChecks with cellChecks and axisChecks; [MS-SSAS] 2.2.4.2 Execute',
    async run(context) {
      const { visible } = await applicable(context);
      const { client } = await context.connected();
      let cells = 0;
      const details: Detail[] = [];
      for (const { catalog } of visible) {
        for (const query of catalog.queries) {
          const where = `${catalog.catalogName} / ${query.name}`;
          if (query.language === 'SQL') {
            details.push({ name: where, status: 'skip', note: 'SQL, which XMLA has no way to send' });
            continue;
          }
          cells += query.cells.length;
          try {
            const { cellset, tabular } = await executeIn(context, client, catalog.catalogName, query.query);
            const mismatches = queryMismatches(query, cellset, tabular);
            details.push({
              name: where,
              status: mismatches.length === 0 ? 'pass' : 'fail',
              note:
                mismatches.length === 0
                  ? `${query.cells.length} cell(s) as expected${query.expectedColumnCount === null ? '' : `, ${query.expectedColumnCount} column(s)`}`
                  : mismatches.join('; '),
            });
          } catch (error) {
            details.push({ name: where, status: 'fail', note: short(error instanceof Error ? error.message : String(error), 300) });
          }
        }
      }
      if (!details.some((detail) => detail.status !== 'skip')) {
        notHere('no visible catalog has an MDX query check');
      }
      return verdict(details, `${cells} cell(s) compared`);
    },
  },
];
