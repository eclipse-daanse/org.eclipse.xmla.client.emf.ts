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
import { wireNameOf } from '../packages/emf-xml/dist/emd.js';
import { WorkbenchXmlaClient } from '../packages/xmla-workbench-adapter/dist/workbench-client.js';

const url = process.argv[2] ?? process.env['XMLA_URL'] ?? 'http://localhost:8090/xmla';
const user = process.env['XMLA_USER'];
const password = process.env['XMLA_PASSWORD'];

const checks = [];
let failures = 0;

function check(name, run) {
  checks.push([name, run]);
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
  const requestType = 'DISCOVER_RESOURCE_POOLS';

  const xml = await foreign.discoverRaw(requestType);
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

check('a rowset a client probes with is served without credentials', async () => {
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

check('an MDX statement answers a cellset with values in it', async () => {
  // Nothing had run a statement live: the probe used to answer Execute with
  // nothing, so the whole cellset path was checked only against recordings.
  const workbench = new WorkbenchXmlaClient({ url, transport: new FetchTransport(), models, credentials });
  const cellset = await workbench.execute('SELECT [Measures].MEMBERS ON 0, [Time].MEMBERS ON 1 FROM [Probe]');

  if (cellset.axes.length !== 2) {
    throw new Error(`${cellset.axes.length} axes, expected 2 with the slicer kept apart`);
  }
  if ((cellset.slicer ?? []).length === 0) {
    throw new Error('the WHERE clause did not come back');
  }
  const captions = cellset.axes.map((axis) => axis.tuples.map((tuple) => tuple[0].caption).join('/'));
  const values = cellset.cells.map((cell) => `${cell.ordinal}:${cell.value}`).join(' ');

  // Sparse on purpose: three cells for four positions, so a reader that counts
  // instead of reading the ordinal would put a value in the wrong square.
  if (cellset.cells.length !== 3) {
    throw new Error(`${cellset.cells.length} cells, expected 3 - the fourth is absent on purpose`);
  }
  if (cellset.cells.some((cell) => cell.ordinal === 3)) {
    throw new Error('a cell arrived that the server never sent');
  }
  if (cellset.cells[0].formattedValue !== '$1,234.50') {
    throw new Error(`the formatted value is ${JSON.stringify(cellset.cells[0].formattedValue)}`);
  }
  if (typeof cellset.cells[0].value !== 'number') {
    throw new Error('the raw value did not come back as a number');
  }
  return `axes [${captions.join('] [')}], cells ${values}, slicer ${cellset.slicer[0].caption}`;
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
    failures += 1;
    console.log(`  FAIL  ${name}: ${error.message}`);
  }
}
console.log(`\n${checks.length - failures}/${checks.length} held`);
process.exit(failures === 0 ? 0 : 1);
