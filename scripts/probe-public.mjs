/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/**
 * The client against servers nobody here built.
 *
 * Everything else is checked against recordings of one server family and
 * against a probe driven by the very models the client uses - so agreement
 * proves the two agree, not that either is right. These are public demo
 * endpoints run by other people, on other implementations, and they are the
 * only thing that can say the reading is right rather than merely consistent.
 *
 *   node scripts/probe-public.mjs [url...]
 *
 * Read-only and deliberately small: a handful of Discover calls, in sequence,
 * no statements and no load. They are somebody else's servers.
 *
 * A server that does not answer is reported as unreachable and does not fail
 * the run - these are outside anyone's control, and a red build for someone
 * else's downtime teaches nothing.
 */
import { FetchTransport, XmlaClient } from '../packages/xmla-client/dist/index.js';
import { RowsetResolver } from '../packages/xmla-dynamic/dist/resolver.js';
import { RowsetCatalog } from '../packages/xmla-model/dist/catalog.js';
import { bootstrapFromDisk } from '../packages/xmla-model/dist/node.js';
import { wireNameOf } from '../packages/emf-xml/dist/emd.js';

/** The public endpoints this project knows of. */
const KNOWN = [
  {
    name: 'Flexmonster demo (SSAS behind msmdpump)',
    url: 'http://olap.flexmonster.com/olap/msmdpump.dll',
  },
  {
    name: 'Syncfusion demo (SSAS behind msmdpump)',
    url: 'https://bi.syncfusion.com/olap/msmdpump.dll',
  },
  {
    // A different implementation altogether, and the one that would say most.
    // Unreachable at the time of writing - the host itself does not answer, so
    // it is not an XMLA problem - and kept here so that it is tried again.
    name: 'eMondrian demo (Mondrian)',
    url: 'https://ssemenkoff.dev/emondrian/xmla',
  },
];

const targets = process.argv.length > 2
  ? process.argv.slice(2).map((url) => ({ name: url, url }))
  : KNOWN;

const models = bootstrapFromDisk();
const catalog = new RowsetCatalog(models);
const timeout = Number(process.env['XMLA_TIMEOUT_MS'] ?? 20_000);

/** fetch with a deadline, because a demo server may simply not answer. */
function withTimeout(input, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let reachable = 0;
let problems = 0;

for (const target of targets) {
  console.log(`\n${target.name}\n  ${target.url}`);
  const client = new XmlaClient({
    url: target.url,
    transport: new FetchTransport({ fetch: withTimeout }),
    models,
  });

  let datasources;
  try {
    datasources = await client.discover('DISCOVER_DATASOURCES');
  } catch (error) {
    console.log(`  unreachable — ${short(error)}`);
    continue;
  }
  reachable += 1;
  console.log(`  ok    DISCOVER_DATASOURCES — ${datasources.rows.length} row(s)`);
  const first = datasources.rows[0];
  if (first !== undefined) {
    console.log(`        ${describe(first)}`);
  }

  problems += await step('DISCOVER_PROPERTIES', async () => {
    const result = await client.discover('DISCOVER_PROPERTIES');
    return `${result.rows.length} propert${result.rows.length === 1 ? 'y' : 'ies'}`;
  });

  // The one that matters most: a server built by someone else, describing
  // rowsets this project may never have modelled.
  let unmodelled = [];
  problems += await step('DISCOVER_SCHEMA_ROWSETS', async () => {
    const result = await client.discover('DISCOVER_SCHEMA_ROWSETS');
    const declared = result.rows
      .map((row) => String(value(row, 'schemaName') ?? ''))
      .filter((name) => name !== '');
    unmodelled = declared.filter((name) => catalog.forRequestType(name) === null);
    return `${declared.length} declared, ${unmodelled.length} this model does not describe`
      + (unmodelled.length > 0 ? `: ${unmodelled.slice(0, 6).join(', ')}` : '');
  });

  if (unmodelled.length > 0) {
    problems += await step(`the dynamic path on ${unmodelled[0]}`, async () => {
      const resolver = new RowsetResolver(catalog, target.url);
      const xml = await client.discoverRaw(unmodelled[0]);
      const schema = client.schemaOf(xml);
      if (schema === null) {
        throw new Error('no inline schema came with it');
      }
      const resolved = resolver.resolve(unmodelled[0], schema);
      const rows = client.readRows(xml, resolved.rowClass).rows;
      const columns = [...resolved.rowClass.getEAllStructuralFeatures()].map((f) => wireNameOf(f));
      return `${columns.length} columns built from the response, ${rows.length} row(s)`;
    });
  }

  problems += await step('DBSCHEMA_CATALOGS', async () => {
    const result = await client.discover('DBSCHEMA_CATALOGS');
    const names = result.rows.map((row) => String(value(row, 'catalogName') ?? '?'));
    return `${names.length}: ${names.slice(0, 4).join(', ')}`;
  });

  problems += await step('MDSCHEMA_CUBES', async () => {
    const result = await client.discover('MDSCHEMA_CUBES');
    const names = result.rows.map((row) => String(value(row, 'cubeName') ?? '?'));
    return `${names.length}: ${names.slice(0, 4).join(', ')}`;
  });

  // Strict mode as a conformance run: what this server describes against what
  // the models say. Divergence is reported, not failed - a foreign server is
  // allowed to differ, and being told is the point.
  problems += await step('what it describes against what the models say', async () => {
    const resolver = new RowsetResolver(catalog, target.url, { strict: true });
    let looked = 0;
    for (const requestType of ['DISCOVER_DATASOURCES', 'DBSCHEMA_CATALOGS', 'MDSCHEMA_CUBES', 'DISCOVER_PROPERTIES']) {
      const xml = await client.discoverRaw(requestType);
      resolver.resolve(requestType, client.schemaOf(xml));
      looked += 1;
    }
    if (resolver.divergencesFound.length === 0) {
      return `${looked} rowsets compared, no divergence`;
    }
    return resolver.divergencesFound
      .map(
        (each) =>
          `${each.requestType}: only on the server [${each.onlyOnServer.join(', ')}]`
          + ` / only in the model [${each.onlyInModel.slice(0, 8).join(', ')}${each.onlyInModel.length > 8 ? ', …' : ''}]`,
      )
      .join('\n        ');
  });
}

async function step(name, run) {
  try {
    console.log(`  ok    ${name} — ${await run()}`);
    return 0;
  } catch (error) {
    console.log(`  FAIL  ${name}: ${short(error)}`);
    return 1;
  }
}

function value(object, featureName) {
  const feature = object.eClass().getEStructuralFeature(featureName);
  return feature === null || feature === undefined || !object.eIsSet(feature) ? null : object.eGet(feature);
}

function describe(row) {
  const features = [...row.eClass().getEAllStructuralFeatures()].filter((f) => row.eIsSet(f)).slice(0, 4);
  return features.map((f) => `${wireNameOf(f)}=${JSON.stringify(String(row.eGet(f)))}`).join(' ');
}

function short(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

console.log(
  `\n${reachable}/${targets.length} reachable, ${problems} problem(s) on the ones that answered`,
);
// A server being down is not this project's failure; a server answering
// something this client cannot read is.
process.exit(problems === 0 ? 0 : 1);
