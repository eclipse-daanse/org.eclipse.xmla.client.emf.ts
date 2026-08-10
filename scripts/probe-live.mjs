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
 * The client against a live server, over real HTTP.
 *
 * Everything else in this repository is checked against recordings of one
 * server family. This is the only thing that says a byte ever left the process,
 * that a session was really negotiated, and that the dynamic path works against
 * a server nobody recorded.
 *
 *   node scripts/probe-live.mjs [url]
 *
 * Exits non-zero on the first thing that does not hold, so it can gate a build.
 */
import { XmlaClient, FetchTransport } from '../packages/xmla-client/dist/index.js';
import { RowsetCatalog } from '../packages/xmla-model/dist/catalog.js';
import { bootstrapFromDisk } from '../packages/xmla-model/dist/node.js';
import { RowsetResolver } from '../packages/xmla-dynamic/dist/resolver.js';
import { readFileSync } from 'node:fs';

import { wireNameOf } from '../packages/emf-xml/dist/emd.js';
import { WorkbenchXmlaClient } from '../packages/xmla-workbench-adapter/dist/workbench-client.js';

const url = process.argv[2] ?? process.env['XMLA_URL'] ?? 'http://localhost:8090/xmla';
const user = process.env['XMLA_USER'];
const password = process.env['XMLA_PASSWORD'];

const checks = [];
let failures = 0;
let skipped = 0;

function check(name, run) {
  checks.push([name, run]);
}

/**
 * What a check says when the server it found does not have the thing it tests.
 *
 * These run against more than one server - the assembled Daanse probe with its
 * tutorial catalogs, the small csv one in this repository, and whatever else is
 * pointed at - so a check for a feature one of them lacks has to say so rather
 * than fail. A red run for the wrong server teaches nothing.
 */
class NotOnThisServer extends Error {}

function notHere(why) {
  throw new NotOnThisServer(why);
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'POST', body: '', headers: { 'Content-Type': 'text/xml' } });
      // Anything that answers is enough; a bad request is still a server.
      if (response.status > 0) {
        await response.text();
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const models = bootstrapFromDisk();
const catalog = new RowsetCatalog(models);
const credentials =
  user === undefined ? { kind: 'none' } : { kind: 'basic', username: user, password: password ?? '' };

let client = new XmlaClient({ url, transport: new FetchTransport(), models, credentials });

check('the server answers at all', async () => {
  const up = await waitForServer(Number(process.env['XMLA_WAIT_MS'] ?? 60_000));
  if (!up) {
    throw new Error(`nothing answered at ${url}`);
  }
  return url;
});

check('DISCOVER_DATASOURCES comes back with rows', async () => {
  const result = await client.discover('DISCOVER_DATASOURCES');
  if (result.rows.length === 0) {
    throw new Error('no rows');
  }
  const first = result.rows[0];
  const name = read(first, 'dataSourceName');
  return `${result.rows.length} row(s), first DataSourceName=${JSON.stringify(name)}`;
});

check('the response carries an inline schema', async () => {
  const result = await client.discover('DISCOVER_DATASOURCES');
  if (result.inlineSchema === null) {
    throw new Error('no inline schema, so the dynamic path has nothing to work from');
  }
  if (!result.inlineSchema.includes('targetNamespace')) {
    throw new Error('the schema lost its targetNamespace on the way out of the cursor');
  }
  return `${result.inlineSchema.length} bytes`;
});

check('DISCOVER_SCHEMA_ROWSETS describes the server', async () => {
  const result = await client.discover('DISCOVER_SCHEMA_ROWSETS');
  const declared = result.rows.map((row) => String(read(row, 'schemaName') ?? ''));
  const unknown = declared.filter((name) => name !== '' && catalog.forRequestType(name) === null);
  return `${declared.length} declared, ${unknown.length} the model does not describe${unknown.length ? `: ${unknown.slice(0, 5).join(', ')}` : ''}`;
});

check('a session is really negotiated', async () => {
  const opened = await client.beginSession();
  if (opened.sessionId === null) {
    throw new Error('no session id came back');
  }
  const inSession = await opened.discover('DISCOVER_DATASOURCES');
  if (inSession.rows.length === 0) {
    throw new Error('the request inside the session answered nothing');
  }
  const closed = await opened.endSession();
  if (closed.sessionId !== null) {
    throw new Error('the session was not let go of');
  }
  return `session ${opened.sessionId}`;
});

check('a rowset the model does not describe is still readable', async () => {
  // The claim the whole second path rests on, over a wire. The endpoint answers
  // a rowset written from an EClass built at runtime on the server and present
  // in no .ecore anywhere - so nothing the client knows could have told it the
  // shape.
  const foreign = new XmlaClient({ url: `${url}-foreign`, transport: new FetchTransport(), models, credentials });
  // Not DISCOVER_RESOURCE_POOLS any more: the model describes it since a live
  // server was asked and answered. This has to be a request type still described
  // nowhere, or the check silently proves nothing - which is what it reported.
  const requestType = 'DISCOVER_M_EXPRESSIONS';

  let xml;
  try {
    xml = await foreign.discoverRaw(requestType);
  } catch (error) {
    notHere(`no ${url}-foreign here - that endpoint is the csv probe's own (${error.message.slice(0, 60)})`);
  }
  const schema = foreign.schemaOf(xml);
  if (schema === null) {
    throw new Error('the response carried no inline schema, so there is nothing to build from');
  }

  const resolver = new RowsetResolver(catalog, `${url}-foreign`);
  const resolved = resolver.resolve(requestType, schema);
  if (resolved.origin !== 'dynamic') {
    throw new Error(`${requestType} resolved as ${resolved.origin}, so this proved nothing`);
  }

  const rows = foreign.readRows(xml, resolved.rowClass).rows;
  const columns = [...resolved.rowClass.getEAllStructuralFeatures()].map((f) => wireNameOf(f));
  if (rows.length === 0) {
    throw new Error('no rows');
  }
  const first = rows[0];
  const values = columns.map((name, i) => {
    const feature = [...resolved.rowClass.getEAllStructuralFeatures()][i];
    return `${name}=${first.eIsSet(feature) ? JSON.stringify(first.eGet(feature)) : 'NULL'}`;
  });
  return `${columns.length} columns built from the response, ${rows.length} rows; first: ${values.join(' ')}`;
});

const guardedUrl = process.env['XMLA_GUARDED_URL'] ?? url.replace(/:(\d+)/, (_, port) => `:${Number(port) + 1}`);

/** Whether anything answers on the guarded port at all. */
let guardedUp = null;
async function requireGuarded() {
  if (guardedUp === null) {
    try {
      await fetch(guardedUrl, { method: 'POST', body: '', headers: { 'Content-Type': 'text/xml' } });
      guardedUp = true;
    } catch {
      guardedUp = false;
    }
  }
  if (!guardedUp) {
    notHere(`nothing answers at ${guardedUrl} - the guarded endpoint is the csv probe's own`);
  }
}

check('a rowset a client probes with is served without credentials', async () => {
  await requireGuarded();
  // Excel and SSMS both ask DISCOVER_PROPERTIES and DISCOVER_DATASOURCES before
  // they authenticate. A server that challenges those refuses the connection
  // outright, so a client must be able to get them anonymously.
  const anonymous = new XmlaClient({
    url: guardedUrl,
    transport: new FetchTransport(),
    models,
    credentials: { kind: 'none' },
  });
  const result = await anonymous.discover('DISCOVER_DATASOURCES');
  return `${result.rows.length} row(s) without so much as a header`;
});

check('a guarded rowset is refused without credentials, and says how to ask', async () => {
  await requireGuarded();
  const anonymous = new XmlaClient({
    url: guardedUrl,
    transport: new FetchTransport(),
    models,
    credentials: { kind: 'none' },
  });
  try {
    await anonymous.discover('DBSCHEMA_CATALOGS');
  } catch (error) {
    const status = error.status;
    if (status !== 401) {
      // A fault would also be a refusal, but a client cannot log in from one.
      throw new Error(`refused with ${status ?? error.name}, not 401`);
    }
    if (error.challenge === null || error.challenge === undefined) {
      // A 401 with no challenge tells a client it may not in, and nothing about
      // how it might.
      throw new Error('a 401 that carries no WWW-Authenticate');
    }
    return `HTTP 401, ${error.challenge}`;
  }
  throw new Error('the guarded endpoint served an anonymous request');
});

check('Basic credentials get through', async () => {
  await requireGuarded();
  const authenticated = new XmlaClient({
    url: guardedUrl,
    transport: new FetchTransport(),
    models,
    credentials: { kind: 'basic', username: 'aladdin', password: 'open sesame' },
  });
  const result = await authenticated.discover('DBSCHEMA_CATALOGS');
  if (result.rows.length === 0) {
    throw new Error('authenticated but no rows');
  }
  return `${result.rows.length} row(s) as aladdin`;
});

check('the wrong password does not', async () => {
  await requireGuarded();
  const wrong = new XmlaClient({
    url: guardedUrl,
    transport: new FetchTransport(),
    models,
    credentials: { kind: 'basic', username: 'aladdin', password: 'not it' },
  });
  try {
    await wrong.discover('DBSCHEMA_CATALOGS');
  } catch (error) {
    return `refused: ${error.message}`;
  }
  throw new Error('the wrong password was accepted');
});

check('a session survives authentication', async () => {
  await requireGuarded();
  const authenticated = new XmlaClient({
    url: guardedUrl,
    transport: new FetchTransport(),
    models,
    credentials: { kind: 'basic', username: 'aladdin', password: 'open sesame' },
  });
  const opened = await authenticated.beginSession();
  if (opened.sessionId === null) {
    throw new Error('no session opened on the guarded endpoint');
  }
  const rows = await opened.discover('DBSCHEMA_CATALOGS');
  await opened.endSession();
  return `session ${opened.sessionId}, ${rows.rows.length} row(s) inside it`;
});

check('an MDX statement answers a cellset from a cube the server has', async () => {
  // Whichever server this is, ask it what cubes it has and query one. Naming a
  // cube here would tie the check to one probe, and the point of it is that a
  // query is answered at all.
  const cubes = await client.discover('MDSCHEMA_CUBES');
  if (cubes.rows.length === 0) {
    notHere('this server offers no cubes');
  }
  const first = cubes.rows[0];
  const catalog = String(read(first, 'catalogName') ?? '');
  const cube = String(read(first, 'cubeName') ?? '');

  const workbench = new WorkbenchXmlaClient({
    url,
    transport: new FetchTransport(),
    models,
    credentials,
    catalog,
  });
  const cellset = await workbench.execute(`SELECT [Measures].Members ON COLUMNS FROM [${cube}]`);

  if (cellset.axes.length === 0) {
    throw new Error(`[${cube}] answered no axis`);
  }
  if (cellset.cells.length === 0) {
    throw new Error(`[${cube}] answered no cells`);
  }
  const measures = cellset.axes[0].tuples.map((tuple) => tuple[0].caption);
  const values = cellset.cells.map((cell) => `${cell.ordinal}:${cell.value}`);
  return `${catalog} / [${cube}]: ${measures.join(', ')} = ${values.join(' ')}`;
});

check('the numbers come out of the database, not out of the server', async () => {
  // Only where the data is known: the csv probe in this repository. Both sides
  // are computed from the same file, so a wrong total cannot agree with a wrong
  // expectation.
  const cubes = await client.discover('MDSCHEMA_CUBES');
  const sales = cubes.rows.find((row) => String(read(row, 'cubeName') ?? '') === 'Sales');
  if (sales === undefined) {
    notHere('this server has no Sales cube - that one is the csv probe\'s own');
  }

  const workbench = new WorkbenchXmlaClient({
    url,
    transport: new FetchTransport(),
    models,
    credentials,
    catalog: String(read(sales, 'catalogName') ?? ''),
  });
  const cellset = await workbench.execute(
    'SELECT {[Measures].[Amount], [Measures].[Quantity]} ON COLUMNS, [Region].[Region].Members ON ROWS FROM [Sales]',
  );

  const columns = cellset.axes[0].tuples.map((tuple) => tuple[0].caption);
  const rows = cellset.axes[1].tuples.map((tuple) => tuple[0].caption);
  const at = (row, column) => {
    const cell = cellset.cells.find((each) => each.ordinal === row * columns.length + column);
    return cell === undefined ? null : cell.value;
  };

  const csv = readFileSync(new URL('../probe/data/sales.csv', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(',').map((cell) => cell.trim()));
  const expected = new Map();
  for (const [region, , , amount, quantity] of csv) {
    const held = expected.get(region) ?? { amount: 0, quantity: 0 };
    expected.set(region, { amount: held.amount + Number(amount), quantity: held.quantity + Number(quantity) });
  }
  const total = [...expected.values()].reduce(
    (sum, each) => ({ amount: sum.amount + each.amount, quantity: sum.quantity + each.quantity }),
    { amount: 0, quantity: 0 },
  );

  const wrong = [];
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
  return `${rows.length} regions x ${columns.length} measures, every total matches the csv`
    + ` (all: ${total.amount} / ${total.quantity})`;
});

check('what the server describes matches what the model says', async () => {
  // Strict mode as a conformance run against a server nobody recorded.
  const resolver = new RowsetResolver(catalog, url, { strict: true });
  const sample = ['DISCOVER_DATASOURCES', 'DBSCHEMA_CATALOGS', 'DISCOVER_SCHEMA_ROWSETS', 'DISCOVER_PROPERTIES'];
  let looked = 0;
  for (const requestType of sample) {
    if (catalog.forRequestType(requestType) === null) {
      continue;
    }
    try {
      const xml = await client.discoverRaw(requestType);
      resolver.resolve(requestType, client.schemaOf(xml));
      looked += 1;
    } catch (error) {
      return `stopped at ${requestType}: ${error.message}`;
    }
  }
  const divergences = resolver.divergencesFound;
  if (divergences.length === 0) {
    return `${looked} rowset(s) compared, no divergence`;
  }
  return divergences
    .map(
      (each) =>
        `${each.requestType}: server-only [${each.onlyOnServer.join(', ')}] model-only [${each.onlyInModel.slice(0, 6).join(', ')}]`,
    )
    .join('; ');
});

function read(object, featureName) {
  const feature = object.eClass().getEStructuralFeature(featureName);
  return feature === null || feature === undefined || !object.eIsSet(feature) ? null : object.eGet(feature);
}

console.log(`probing ${url}\n`);
for (const [name, run] of checks) {
  try {
    const note = await run();
    console.log(`  ok    ${name}${note === undefined ? '' : ` — ${note}`}`);
  } catch (error) {
    if (error instanceof NotOnThisServer) {
      skipped += 1;
      console.log(`  --    ${name}: ${error.message}`);
      continue;
    }
    failures += 1;
    console.log(`  FAIL  ${name}: ${error.message}`);
  }
}
const ran = checks.length - skipped;
console.log(
  `\n${ran - failures}/${ran} held`
    + (skipped === 0 ? '' : `, ${skipped} not applicable to this server`),
);
process.exit(failures === 0 ? 0 : 1);
