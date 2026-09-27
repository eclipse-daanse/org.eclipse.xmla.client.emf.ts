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
import { XmlaFaultError } from '@daanse/xmla-io';
import type { RestrictionEntry } from '@daanse/xmla-io';
import { RowsetResolver } from '@daanse/xmla-dynamic';
import type { EObject } from '@emfts/core';

import { notHere, short, text, verdict } from '../kit.js';
import type { Check, Context, Detail, Sample } from '../kit.js';

/**
 * The schema rowsets: what a server declares, and whether it answers what it
 * declares.
 *
 * The sweep (R7) is the expensive one and the one everything after it reads
 * from. It asks for every declared rowset once, keeps the raw answers, and the
 * later checks look at those rather than asking again.
 */

/** The Discover types XMLA 1.1 requires of every provider. */
const XMLA_MANDATORY = [
  'DISCOVER_DATASOURCES',
  'DISCOVER_PROPERTIES',
  'DISCOVER_SCHEMA_ROWSETS',
  'DISCOVER_ENUMERATORS',
  'DISCOVER_KEYWORDS',
  'DISCOVER_LITERALS',
];

/** What an OLAP client asks for to show a cube. Not mandatory in XMLA 1.1, indispensable in practice. */
const OLAP_NEEDED = [
  'DBSCHEMA_CATALOGS',
  'MDSCHEMA_CUBES',
  'MDSCHEMA_DIMENSIONS',
  'MDSCHEMA_HIERARCHIES',
  'MDSCHEMA_LEVELS',
  'MDSCHEMA_MEASURES',
  'MDSCHEMA_MEMBERS',
  'MDSCHEMA_PROPERTIES',
];

interface Declared {
  readonly name: string;
  readonly guid: string;
  readonly restrictions: readonly string[];
  readonly mask: bigint | null;
}

interface Answered {
  readonly name: string;
  readonly restrictions: readonly RestrictionEntry[];
  readonly xml: string | null;
  readonly fault: string | null;
  readonly inlineSchema: string | null;
  readonly rows: number | null;
}

async function declared(context: Context): Promise<Declared[]> {
  const result = await context.schemaRowsets();
  return result.rows
    .map((row) => ({
      name: text(row, 'SchemaName'),
      guid: text(row, 'SchemaGuid'),
      restrictions: restrictionsIn(row),
      mask: maskIn(row),
    }))
    .filter((each) => each.name !== '');
}

function restrictionsIn(row: EObject): string[] {
  const feature = row.eClass().getEStructuralFeature('restrictions');
  if (feature === null || feature === undefined || !row.eIsSet(feature)) {
    return [];
  }
  const nested = row.eGet(feature) as Iterable<EObject>;
  return [...nested].map((each) => text(each, 'Name')).filter((name) => name !== '');
}

function maskIn(row: EObject): bigint | null {
  const value = text(row, 'RestrictionsMask');
  if (value === '') {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * The restrictions to ask a rowset with, so that the answer is bounded.
 *
 * A catalog and a cube where the rowset takes them; the measures hierarchy for
 * MDSCHEMA_MEMBERS, which is otherwise every member of a cube. Rowsets whose
 * required restrictions cannot be filled from what is known are left out and
 * reported as such.
 */
async function restrictionsFor(context: Context, rowset: Declared): Promise<RestrictionEntry[] | null> {
  const wanted = new Set(rowset.restrictions);
  const required = context.catalog.requiredRestrictionsOf(rowset.name);
  const entries: RestrictionEntry[] = [];
  const known = await knownTarget(context);
  if (wanted.has('CATALOG_NAME') && known !== null) {
    entries.push({ name: 'CATALOG_NAME', value: known.catalog });
  }
  // The OLE DB relational rowsets call the same thing TABLE_CATALOG.
  if (wanted.has('TABLE_CATALOG') && known !== null) {
    entries.push({ name: 'TABLE_CATALOG', value: known.catalog });
  }
  if (wanted.has('CUBE_NAME') && known !== null) {
    entries.push({ name: 'CUBE_NAME', value: known.cube });
  }
  if (rowset.name === 'MDSCHEMA_MEMBERS') {
    entries.push({ name: 'HIERARCHY_UNIQUE_NAME', value: '[Measures]' });
  }
  const given = new Set(entries.map((entry) => entry.name));
  if (required.some((name) => !given.has(name))) {
    return null;
  }
  return entries;
}

/** Lower case, no braces - the forms a GUID reaches us in, made one. */
function sameGuid(a: string, b: string): boolean {
  const norm = (guid: string): string => guid.trim().replace(/^\{|\}$/g, '').toLowerCase();
  return norm(a) === norm(b);
}

async function knownTarget(context: Context): Promise<{ catalog: string; cube: string } | null> {
  try {
    return await context.target();
  } catch {
    return null;
  }
}

/**
 * A value to try a restriction with: the target's own name where the
 * restriction names something the target has, a plausible literal where the
 * type says what fits, and null where nothing sensible can be said.
 */
function valueFor(context: Context, requestType: string, restriction: string, sample: Sample): string | null {
  const named: Record<string, string | null> = {
    CATALOG_NAME: sample.catalog,
    TABLE_CATALOG: sample.catalog,
    DATABASE_NAME: sample.catalog,
    CUBE_NAME: sample.cube,
    BASE_CUBE_NAME: sample.cube,
    PERSPECTIVE_NAME: sample.cube,
    DIMENSION_UNIQUE_NAME: sample.dimensionUniqueName,
    HIERARCHY_UNIQUE_NAME: sample.hierarchyUniqueName,
    LEVEL_UNIQUE_NAME: sample.levelUniqueName,
    MEMBER_UNIQUE_NAME: sample.memberUniqueName,
    MEASURE_UNIQUE_NAME: sample.measureUniqueName,
    PropertyName: 'Catalog',
    SchemaName: 'MDSCHEMA_CUBES',
    EnumName: 'ProviderType',
    Keyword: 'SELECT',
    LiteralName: 'DBLITERAL_QUOTE_PREFIX',
    TABLE_TYPE: 'TABLE',
    CUBE_SOURCE: '1',
    MEMBER_TYPE: '1',
    TREE_OP: '8',
    LEVEL_NUMBER: '0',
    SCOPE: '1',
    ObjectExpansion: 'ExpandObject',
  };
  if (restriction in named) {
    return named[restriction] ?? null;
  }
  const eClass = context.catalog.restrictionsClassFor(requestType);
  const feature = eClass === null ? null : [...eClass.getEStructuralFeatures()].find((each) => wireNameOf(each) === restriction);
  const type = feature?.getEType()?.getName() ?? '';
  if (/Int|Long|Short/.test(type)) {
    return '1';
  }
  if (/Boolean/.test(type)) {
    return 'true';
  }
  return null;
}

/** Which rowsets the sweep asks for, by the profile's budget. */
function inBudget(context: Context, name: string): boolean {
  if ((context.profile.sweep ?? 'all') === 'all') {
    return true;
  }
  return XMLA_MANDATORY.includes(name) || OLAP_NEEDED.includes(name);
}

/** The sweep: every declared rowset asked for once, answers kept. */
function sweep(context: Context): Promise<Answered[]> {
  return context.memo('sweep', async () => {
    const { client } = await context.connected();
    const answers: Answered[] = [];
    for (const rowset of await declared(context)) {
      if (!inBudget(context, rowset.name)) {
        continue;
      }
      const restrictions = await restrictionsFor(context, rowset);
      if (restrictions === null) {
        answers.push({ name: rowset.name, restrictions: [], xml: null, fault: null, inlineSchema: null, rows: null });
        continue;
      }
      try {
        const xml = await client.discoverRaw(rowset.name, restrictions);
        const inlineSchema = client.schemaOf(xml);
        // Counted through the dynamic path so a rowset the model lacks still counts.
        const resolver = new RowsetResolver(context.catalog, context.profile.url);
        let rows: number | null = null;
        try {
          rows = client.readRows(xml, resolver.resolve(rowset.name, inlineSchema).rowClass).rows.length;
        } catch {
          rows = null;
        }
        answers.push({ name: rowset.name, restrictions, xml, fault: null, inlineSchema, rows });
      } catch (error) {
        const fault = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        answers.push({ name: rowset.name, restrictions, xml: null, fault, inlineSchema: null, rows: null });
      }
    }
    return answers;
  });
}

export const rowsets: readonly Check[] = [
  {
    id: 'R1',
    group: 'rowsets',
    title: 'DISCOVER_SCHEMA_ROWSETS describes the server, one row per rowset with a SchemaName',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.9 DISCOVER_SCHEMA_ROWSETS; XMLA 1.1, "DISCOVER_SCHEMA_ROWSETS"',
    async run(context) {
      const rows = await declared(context);
      if (rows.length === 0) {
        throw new Error('no row carried a SchemaName');
      }
      const unmodelled = rows.filter((each) => context.catalog.forRequestType(each.name) === null);
      return `${rows.length} declared, ${unmodelled.length} the model does not describe${
        unmodelled.length === 0 ? '' : `: ${unmodelled.slice(0, 5).map((each) => each.name).join(', ')}`
      }`;
    },
  },
  {
    id: 'R2',
    group: 'rowsets',
    title: 'the six Discover types XMLA 1.1 requires are declared',
    level: 'should',
    spec: 'XMLA 1.1, "Discover": DISCOVER_DATASOURCES, DISCOVER_PROPERTIES, DISCOVER_SCHEMA_ROWSETS, DISCOVER_ENUMERATORS, DISCOVER_KEYWORDS, DISCOVER_LITERALS',
    async run(context) {
      const names = new Set((await declared(context)).map((each) => each.name));
      const missing = XMLA_MANDATORY.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(`not declared: ${missing.join(', ')}`);
      }
      return 'all six';
    },
  },
  {
    id: 'R3',
    group: 'rowsets',
    title: 'the rowsets an OLAP client needs to show a cube are declared',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3 - DBSCHEMA_CATALOGS and the MDSCHEMA_* family',
    async run(context) {
      const names = new Set((await declared(context)).map((each) => each.name));
      const missing = OLAP_NEEDED.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(`not declared: ${missing.join(', ')}`);
      }
      return `all ${OLAP_NEEDED.length}`;
    },
  },
  {
    id: 'R4',
    group: 'rowsets',
    title: 'the SchemaGuid of every modelled rowset is the one the model states',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.9: SchemaGuid is the OLE DB schema GUID, by which a client may resolve a rowset',
    async run(context) {
      const rows = await declared(context);
      let stated = 0;
      let agreed = 0;
      const wrong: string[] = [];
      for (const each of rows) {
        if (each.guid === '') {
          continue;
        }
        stated += 1;
        const byName = context.catalog.forRequestType(each.name);
        if (byName === null) {
          continue;
        }
        // Compared by value, not by looking the GUID up: two mining rowsets
        // genuinely share one, and a lookup would answer the first of them for
        // both.
        const modelled = context.catalog.guidOf(byName);
        if (modelled !== null && sameGuid(modelled, each.guid)) {
          agreed += 1;
        } else {
          wrong.push(`${each.name}=${each.guid}${modelled === null ? ' (model states none)' : ` (model: ${modelled})`}`);
        }
      }
      if (stated === 0) {
        throw new Error('the server states no SchemaGuid at all, so nothing is reachable by GUID');
      }
      if (wrong.length > 0) {
        throw new Error(`${wrong.length} differ from the model: ${wrong.slice(0, 4).join(', ')}`);
      }
      return `${agreed} of ${stated} stated GUIDs resolve to the rowset of that name`;
    },
  },
  {
    id: 'R5',
    group: 'rowsets',
    title: 'RestrictionsMask has one bit per declared restriction',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.9: RestrictionsMask, a bitmask over the Restrictions column',
    async run(context) {
      const rows = await declared(context);
      let compared = 0;
      const off: string[] = [];
      for (const each of rows) {
        if (each.mask === null || each.restrictions.length === 0) {
          continue;
        }
        compared += 1;
        const expected = (1n << BigInt(each.restrictions.length)) - 1n;
        if (each.mask !== expected) {
          off.push(`${each.name}: ${each.restrictions.length} restrictions, mask ${each.mask}`);
        }
      }
      if (compared === 0) {
        notHere('no row carries both a RestrictionsMask and Restrictions');
      }
      if (off.length > 0) {
        throw new Error(off.slice(0, 4).join('; '));
      }
      return `${compared} rowsets, every mask is 2^n - 1`;
    },
  },
  {
    id: 'R6',
    group: 'rowsets',
    title: 'the restrictions a rowset declares are the ones the model knows, in that order',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.9: the Restrictions column; the order is the order RestrictionsMask counts in',
    async run(context) {
      const rows = await declared(context);
      let compared = 0;
      let fewer = 0;
      const differ: string[] = [];
      for (const each of rows) {
        if (context.catalog.forRequestType(each.name) === null || each.restrictions.length === 0) {
          continue;
        }
        compared += 1;
        const modelled = context.catalog.restrictionsOf(each.name).map((restriction) => restriction.name);
        // A restriction the model lacks is one this client cannot send. One
        // the server lacks is an older server, and the model follows the
        // newest - noted, not held against it.
        const onServer = each.restrictions.filter((name) => !modelled.includes(name));
        if (modelled.some((name) => !each.restrictions.includes(name))) {
          fewer += 1;
        }
        // The shared ones have to come in the model's order, or the mask counts
        // positions the client numbers differently.
        const shared = each.restrictions.filter((name) => modelled.includes(name));
        const inOrder = shared.every(
          (name, index) => index === 0 || modelled.indexOf(shared[index - 1]!) < modelled.indexOf(name),
        );
        if (onServer.length > 0 || !inOrder) {
          differ.push(
            `${each.name}${onServer.length ? ` server-only [${onServer.join(',')}]` : ''}${inOrder ? '' : ' (order)'}`,
          );
        }
      }
      if (compared === 0) {
        notHere('no declared rowset carries restrictions the model could be compared with');
      }
      if (differ.length > 0) {
        throw new Error(`${differ.length} of ${compared} differ: ${differ.slice(0, 5).join('; ')}`);
      }
      return `${compared} rowsets agree with the model${fewer === 0 ? '' : `, ${fewer} declare fewer restrictions than it`}`;
    },
  },
  {
    id: 'R7',
    group: 'rowsets',
    title: 'every rowset the server declares is answered when asked for',
    level: 'must',
    spec: 'XMLA 1.1, "DISCOVER_SCHEMA_ROWSETS": the rowsets listed are the ones Discover supports',
    async run(context) {
      const answers = await sweep(context);
      const asked = answers.filter((each) => each.xml !== null || each.fault !== null);
      const left = answers.filter((each) => each.xml === null && each.fault === null);
      const faulted = answers.filter((each) => each.fault !== null);
      const fatal = faulted.filter((each) => XMLA_MANDATORY.includes(each.name) || OLAP_NEEDED.includes(each.name));
      if (asked.length === 0) {
        throw new Error('nothing was asked for');
      }
      if (fatal.length > 0) {
        throw new Error(
          `${fatal.length} needed rowset(s) refused: ${fatal.map((each) => `${each.name} (${short(each.fault!, 80)})`).join('; ')}`,
        );
      }
      const budget = (context.profile.sweep ?? 'all') === 'all' ? 'all declared' : 'the mandatory ones';
      const details: Detail[] = answers.map((each) => ({
        name: each.name,
        status: each.fault !== null ? 'fail' : each.xml === null ? 'skip' : 'pass',
        note:
          each.fault !== null
            ? short(each.fault.replace(/^\w+: /, '').replace(/^the server answered a SOAP fault: /, ''), 120)
            : each.xml === null
              ? 'not asked: its required restrictions cannot be filled from what is known'
              : `${each.rows ?? '?'} row(s)${each.restrictions.length === 0 ? '' : `, restricted by ${each.restrictions.map((entry) => entry.name).join(', ')}`}`,
      }));
      // A refusal of a rowset nobody needs is noted, not held against the server.
      const noted = details.map((detail) =>
        detail.status === 'fail' && !XMLA_MANDATORY.includes(detail.name) && !OLAP_NEEDED.includes(detail.name)
          ? { ...detail, status: 'skip' as const, note: `refused: ${detail.note}` }
          : detail,
      );
      return verdict(noted, `${asked.length - faulted.length} of ${asked.length} answered (${budget})${left.length === 0 ? '' : `, ${left.length} not asked`}`);
    },
  },
  {
    id: 'R8',
    group: 'rowsets',
    title: 'every rowset answered carries its schema inline',
    level: 'should',
    spec: '[MS-SSAS] 2.2.4.1.1: the return element carries an xsd:schema describing the rows',
    async run(context) {
      const answers = (await sweep(context)).filter((each) => each.xml !== null);
      if (answers.length === 0) {
        notHere('nothing was answered');
      }
      const without = answers.filter((each) => each.inlineSchema === null);
      if (without.length > 0) {
        throw new Error(`${without.length} without: ${without.map((each) => each.name).slice(0, 5).join(', ')}`);
      }
      return `${answers.length} of ${answers.length}`;
    },
  },
  {
    id: 'R9',
    group: 'rowsets',
    title: 'nothing a server sends in a modelled rowset is missing from the model',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3 - the column lists of the schema rowsets; a column the model lacks is one the reader refuses',
    async run(context) {
      const answers = (await sweep(context)).filter((each) => each.xml !== null);
      const resolver = new RowsetResolver(context.catalog, `${context.profile.url}#strict`, { strict: true });
      let compared = 0;
      for (const each of answers) {
        if (context.catalog.forRequestType(each.name) === null || each.inlineSchema === null) {
          continue;
        }
        resolver.resolve(each.name, each.inlineSchema);
        compared += 1;
      }
      if (compared === 0) {
        notHere('no answered rowset is one the model describes');
      }
      const divergences = resolver.divergencesFound;
      const serverOnly = divergences.filter((each) => each.onlyOnServer.length > 0);
      const modelOnly = divergences.filter((each) => each.onlyInModel.length > 0);
      if (serverOnly.length > 0) {
        throw new Error(
          `${serverOnly.length} rowset(s) send columns the model lacks: ${serverOnly
            .slice(0, 4)
            .map((each) => `${each.requestType} [${each.onlyOnServer.join(', ')}]`)
            .join('; ')}`,
        );
      }
      return `${compared} compared; ${modelOnly.length} carry fewer columns than the model${
        modelOnly.length === 0 ? '' : ` (${modelOnly.slice(0, 3).map((each) => each.requestType).join(', ')})`
      }`;
    },
  },
  {
    id: 'R10',
    group: 'rowsets',
    title: 'a restriction on a schema rowset filters its rows',
    level: 'must',
    spec: 'XMLA 1.1, "Discover": a Restrictions entry limits the rowset to rows matching it',
    async run(context) {
      const { client } = await context.connected();
      const { catalog } = await context.target();
      const catalogs = await client.discover('DBSCHEMA_CATALOGS', [{ name: 'CATALOG_NAME', value: catalog }]);
      const wrongCatalogs = catalogs.rows.filter((row) => text(row, 'CATALOG_NAME') !== catalog);
      if (catalogs.rows.length === 0) {
        throw new Error(`DBSCHEMA_CATALOGS restricted to ${JSON.stringify(catalog)} answered nothing, though MDSCHEMA_CUBES names it`);
      }
      if (wrongCatalogs.length > 0) {
        throw new Error(`DBSCHEMA_CATALOGS restricted to ${JSON.stringify(catalog)} also answered ${text(wrongCatalogs[0]!, 'CATALOG_NAME')}`);
      }
      const cubes = await client.discover('MDSCHEMA_CUBES', [{ name: 'CATALOG_NAME', value: catalog }]);
      const wrongCubes = cubes.rows.filter((row) => text(row, 'CATALOG_NAME') !== catalog);
      if (wrongCubes.length > 0) {
        throw new Error(`MDSCHEMA_CUBES restricted to ${JSON.stringify(catalog)} also answered ${text(wrongCubes[0]!, 'CATALOG_NAME')}`);
      }
      return `${catalogs.rows.length} catalog row, ${cubes.rows.length} cube(s) in ${JSON.stringify(catalog)}`;
    },
  },
  {
    id: 'R11',
    group: 'rowsets',
    title: 'a rowset the model does not describe is read from the schema its response carried',
    level: 'must',
    spec: '[MS-SSAS] 2.2.4.1.1: the inline schema is sufficient to read the rows',
    async run(context) {
      const answers = await sweep(context);
      const foreign = answers.find(
        (each) => each.xml !== null && each.inlineSchema !== null && context.catalog.forRequestType(each.name) === null,
      );
      if (foreign === undefined) {
        notHere('every rowset this server answered is one the model describes');
      }
      const { client } = await context.connected();
      const resolver = new RowsetResolver(context.catalog, context.profile.url);
      const resolved = resolver.resolve(foreign.name, foreign.inlineSchema);
      if (resolved.origin !== 'dynamic') {
        throw new Error(`${foreign.name} resolved as ${resolved.origin}, so this proved nothing`);
      }
      const rows = client.readRows(foreign.xml!, resolved.rowClass).rows;
      const columns = [...resolved.rowClass.getEAllStructuralFeatures()].map((feature) => wireNameOf(feature));
      return `${foreign.name}: ${columns.length} columns built from the response, ${rows.length} row(s)`;
    },
  },
  {
    id: 'R12',
    group: 'rowsets',
    title: 'the foreign endpoint answers a rowset present in no .ecore, and it reads',
    level: 'must',
    spec: '[MS-SSAS] 2.2.4.1.1: the inline schema is sufficient to read the rows',
    async run(context) {
      const { foreignUrl, foreignRequestType } = context.profile;
      if (foreignUrl === undefined || foreignRequestType === undefined) {
        notHere('the profile names no foreign endpoint');
      }
      if (context.catalog.forRequestType(foreignRequestType) !== null) {
        throw new Error(`${foreignRequestType} is in the model now, so this check proves nothing - pick another`);
      }
      const foreign = context.client(foreignUrl);
      let xml: string;
      try {
        xml = await foreign.discoverRaw(foreignRequestType);
      } catch (error) {
        if (error instanceof XmlaFaultError) {
          throw error;
        }
        notHere(`nothing answers at ${foreignUrl}: ${short(error instanceof Error ? error.message : String(error), 80)}`);
      }
      const schema = foreign.schemaOf(xml);
      if (schema === null) {
        throw new Error('the response carried no inline schema, so there is nothing to build from');
      }
      const resolved = new RowsetResolver(context.catalog, foreignUrl).resolve(foreignRequestType, schema);
      const rows = foreign.readRows(xml, resolved.rowClass).rows;
      if (rows.length === 0) {
        throw new Error('no rows');
      }
      const columns = [...resolved.rowClass.getEAllStructuralFeatures()].map((feature) => wireNameOf(feature));
      return `${columns.length} columns built from the response, ${rows.length} rows`;
    },
  },
  {
    id: 'R14',
    group: 'rowsets',
    title: 'every restriction a rowset declares is accepted when set on its own',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3.9: the Restrictions column names what a Discover of that rowset may be restricted by',
    async run(context) {
      const { client } = await context.connected();
      const sample = await context.sample();
      const details: Detail[] = [];
      for (const rowset of await declared(context)) {
        if (!inBudget(context, rowset.name) || rowset.restrictions.length === 0) {
          continue;
        }
        const required = context.catalog.requiredRestrictionsOf(rowset.name);
        for (const name of rowset.restrictions) {
          const value = valueFor(context, rowset.name, name, sample);
          const label = `${rowset.name} [${name}]`;
          if (value === null) {
            details.push({ name: label, status: 'skip', note: 'no value to try it with' });
            continue;
          }
          const entries: RestrictionEntry[] = [{ name, value }];
          // The catalog beside it, where the rowset takes one: a server that
          // holds a catalog the client may not see refuses the unrestricted
          // question (R13), and that is not what is asked here.
          for (const scope of ['CATALOG_NAME', 'TABLE_CATALOG']) {
            if (scope !== name && rowset.restrictions.includes(scope)) {
              entries.push({ name: scope, value: sample.catalog });
            }
          }
          // The CSDL rowset is about one perspective and refuses to be asked without one.
          if (rowset.name === 'DISCOVER_CSDL_METADATA' && name !== 'PERSPECTIVE_NAME' && rowset.restrictions.includes('PERSPECTIVE_NAME')) {
            entries.push({ name: 'PERSPECTIVE_NAME', value: sample.cube });
          }
          let filled = true;
          for (const other of required) {
            if (other === name) {
              continue;
            }
            const otherValue = valueFor(context, rowset.name, other, sample);
            if (otherValue === null) {
              filled = false;
              break;
            }
            entries.push({ name: other, value: otherValue });
          }
          if (!filled) {
            details.push({ name: label, status: 'skip', note: `a required restriction beside it cannot be filled` });
            continue;
          }
          if (rowset.name === 'MDSCHEMA_MEMBERS' && !entries.some((entry) => entry.name === 'HIERARCHY_UNIQUE_NAME' || entry.name === 'MEMBER_UNIQUE_NAME' || entry.name === 'LEVEL_UNIQUE_NAME')) {
            // Bounded, as in the sweep: every member of every cube is not a question to ask.
            entries.push({ name: 'CUBE_NAME', value: sample.cube }, { name: 'HIERARCHY_UNIQUE_NAME', value: '[Measures]' });
          }
          try {
            const answer = await client.discoverRaw(rowset.name, entries);
            const resolved = new RowsetResolver(context.catalog, context.profile.url).resolve(rowset.name, client.schemaOf(answer));
            const rows = client.readRows(answer, resolved.rowClass).rows.length;
            details.push({ name: label, status: 'pass', note: `${name}=${JSON.stringify(value)}: ${rows} row(s)` });
          } catch (error) {
            details.push({
              name: label,
              status: 'fail',
              note: `${name}=${JSON.stringify(value)}: ${short((error instanceof Error ? error.message : String(error)).replace(/^the server answered a SOAP fault: /, ''), 120)}`,
            });
          }
        }
      }
      if (details.length === 0) {
        notHere('no declared rowset carries a restriction to try');
      }
      return verdict(details);
    },
  },
  {
    id: 'R15',
    group: 'rowsets',
    title: 'MDSCHEMA_MEMBERS restricted to a member unique name answers that member and no other',
    level: 'must',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3 MDSCHEMA_MEMBERS: the MEMBER_UNIQUE_NAME restriction',
    async run(context) {
      const { client } = await context.connected();
      const sample = await context.sample();
      if (sample.memberUniqueName === null) {
        notHere('the target cube has no member to ask for');
      }
      const rows = (
        await client.discover('MDSCHEMA_MEMBERS', [
          { name: 'CATALOG_NAME', value: sample.catalog },
          { name: 'CUBE_NAME', value: sample.cube },
          { name: 'MEMBER_UNIQUE_NAME', value: sample.memberUniqueName },
        ])
      ).rows;
      const names = rows.map((row) => text(row, 'MEMBER_UNIQUE_NAME'));
      if (rows.length === 0) {
        throw new Error(`${sample.memberUniqueName}, which MDSCHEMA_HIERARCHIES or MDSCHEMA_MEMBERS itself named, answers no row`);
      }
      if (names.some((name) => name !== sample.memberUniqueName)) {
        throw new Error(`asked for ${sample.memberUniqueName}, answered ${names.slice(0, 3).join(', ')}`);
      }
      return `${rows.length} row: ${sample.memberUniqueName}, caption ${JSON.stringify(text(rows[0]!, 'MEMBER_CAPTION'))}`;
    },
  },
  {
    id: 'R16',
    group: 'rowsets',
    title: 'TREE_OP=Children on a member answers members whose parent it is',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3 MDSCHEMA_MEMBERS: TREE_OP, MDTREEOP_CHILDREN = 1',
    async run(context) {
      const { client } = await context.connected();
      const sample = await context.sample();
      if (sample.memberUniqueName === null) {
        notHere('the target cube has no member to ask for the children of');
      }
      const rows = (
        await client.discover('MDSCHEMA_MEMBERS', [
          { name: 'CATALOG_NAME', value: sample.catalog },
          { name: 'CUBE_NAME', value: sample.cube },
          { name: 'MEMBER_UNIQUE_NAME', value: sample.memberUniqueName },
          { name: 'TREE_OP', value: '1' },
        ])
      ).rows;
      const strangers = rows.filter((row) => text(row, 'PARENT_UNIQUE_NAME') !== sample.memberUniqueName);
      if (strangers.length > 0) {
        throw new Error(
          `${strangers.length} of ${rows.length} answered members have another parent: ${strangers
            .slice(0, 2)
            .map((row) => `${text(row, 'MEMBER_UNIQUE_NAME')} under ${JSON.stringify(text(row, 'PARENT_UNIQUE_NAME'))}`)
            .join(', ')}`,
        );
      }
      return `${rows.length} child(ren) of ${sample.memberUniqueName}`;
    },
  },
  {
    id: 'R17',
    group: 'rowsets',
    title: 'DISCOVER_ENUMERATORS names the enumerations XMLA 1.1 defines',
    level: 'should',
    spec: 'XMLA 1.1, "DISCOVER_ENUMERATORS": ProviderType and AuthenticationMode among the enumerators',
    async run(context) {
      const { client } = await context.connected();
      const rows = (await client.discover('DISCOVER_ENUMERATORS')).rows;
      const names = new Set(rows.map((row) => text(row, 'EnumName')));
      const wanted = ['ProviderType', 'AuthenticationMode'];
      const missing = wanted.filter((name) => !names.has(name));
      if (rows.length === 0) {
        throw new Error('no rows');
      }
      if (missing.length > 0) {
        throw new Error(`${names.size} enumeration(s), but not ${missing.join(', ')}`);
      }
      return `${names.size} enumeration(s), ${rows.length} element(s)`;
    },
  },
  {
    id: 'R18',
    group: 'rowsets',
    title: 'DISCOVER_KEYWORDS carries the MDX keywords a statement is built from',
    level: 'should',
    spec: 'XMLA 1.1, "DISCOVER_KEYWORDS": the reserved words of the provider',
    async run(context) {
      const { client } = await context.connected();
      const rows = (await client.discover('DISCOVER_KEYWORDS')).rows;
      const keywords = new Set(rows.map((row) => text(row, 'Keyword').toUpperCase()));
      const missing = ['SELECT', 'FROM', 'WHERE', 'ON', 'COLUMNS', 'ROWS'].filter((word) => !keywords.has(word));
      if (rows.length === 0) {
        throw new Error('no rows');
      }
      if (missing.length > 0) {
        throw new Error(`${keywords.size} keyword(s), but not ${missing.join(', ')}`);
      }
      return `${keywords.size} keyword(s)`;
    },
  },
  {
    id: 'R19',
    group: 'rowsets',
    title: 'DISCOVER_LITERALS says how an identifier is quoted',
    level: 'should',
    spec: 'XMLA 1.1, "DISCOVER_LITERALS": DBLITERAL_QUOTE_PREFIX and DBLITERAL_QUOTE_SUFFIX',
    async run(context) {
      const { client } = await context.connected();
      const rows = (await client.discover('DISCOVER_LITERALS')).rows;
      const byName = new Map(rows.map((row) => [text(row, 'LiteralName'), text(row, 'LiteralValue')]));
      if (rows.length === 0) {
        throw new Error('no rows');
      }
      const prefix = byName.get('DBLITERAL_QUOTE_PREFIX');
      const suffix = byName.get('DBLITERAL_QUOTE_SUFFIX');
      if (prefix === undefined || suffix === undefined) {
        throw new Error(`${rows.length} literal(s), but no DBLITERAL_QUOTE_PREFIX or _SUFFIX`);
      }
      return `${rows.length} literal(s); identifiers are quoted ${prefix}…${suffix}`;
    },
  },
  {
    id: 'R20',
    group: 'rowsets',
    title: 'the levels of a hierarchy are numbered 0 to n-1 without a gap',
    level: 'should',
    spec: '[MS-SSAS] 3.1.4.2.2.1.3 MDSCHEMA_LEVELS: LEVEL_NUMBER, from 0 at the top',
    async run(context) {
      const { client } = await context.connected();
      const sample = await context.sample();
      if (sample.hierarchyUniqueName === null) {
        notHere('the target cube has no hierarchy beside the measures');
      }
      const rows = (
        await client.discover('MDSCHEMA_LEVELS', [
          { name: 'CATALOG_NAME', value: sample.catalog },
          { name: 'CUBE_NAME', value: sample.cube },
          { name: 'HIERARCHY_UNIQUE_NAME', value: sample.hierarchyUniqueName },
        ])
      ).rows;
      const numbers = rows.map((row) => Number(text(row, 'LEVEL_NUMBER'))).sort((a, b) => a - b);
      if (numbers.length === 0) {
        throw new Error(`${sample.hierarchyUniqueName} has no levels`);
      }
      const gaps = numbers.filter((number, index) => number !== index);
      if (gaps.length > 0) {
        throw new Error(`${sample.hierarchyUniqueName}: LEVEL_NUMBERs ${numbers.join(', ')}`);
      }
      return `${sample.hierarchyUniqueName}: ${numbers.length} level(s), 0..${numbers.length - 1}`;
    },
  },
  {
    id: 'R13',
    group: 'rowsets',
    title: 'an unrestricted MDSCHEMA_CUBES lists the cubes of every catalog the client may see',
    level: 'should',
    spec: '[MS-SSAS] MDSCHEMA_CUBES without a CATALOG_NAME restriction: the cubes of all catalogs, not a refusal because of one the caller may not read',
    async run(context) {
      const { client } = await context.connected();
      const { catalog } = await context.target();
      let rows;
      try {
        rows = await client.discover('MDSCHEMA_CUBES');
      } catch (error) {
        throw new Error(
          `refused outright, though ${JSON.stringify(catalog)} answers when asked for by name: ${short(
            error instanceof Error ? error.message : String(error),
            120,
          )}`,
        );
      }
      const catalogs = new Set(rows.rows.map((row) => text(row, 'CATALOG_NAME')));
      if (!catalogs.has(catalog)) {
        throw new Error(`${rows.rows.length} cube(s) in ${catalogs.size} catalog(s), but none of ${JSON.stringify(catalog)}`);
      }
      return `${rows.rows.length} cube(s) across ${catalogs.size} catalog(s)`;
    },
  },
];
