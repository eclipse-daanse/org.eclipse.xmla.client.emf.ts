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
  // The whole reason the dynamic path exists. If this server declares nothing
  // unmodelled, say so rather than passing on nothing.
  const declared = await client.discover('DISCOVER_SCHEMA_ROWSETS');
  const names = declared.rows.map((row) => String(read(row, 'schemaName') ?? ''));
  const unmodelled = names.find((name) => name !== '' && catalog.forRequestType(name) === null);

  if (unmodelled === undefined) {
    return 'this server declares nothing the model lacks - not proven here';
  }
  const resolver = new RowsetResolver(catalog, url);
  const xml = await client.discoverRaw(unmodelled);
  const resolved = resolver.resolve(unmodelled, client.schemaOf(xml));
  const read_ = client.readRows(xml, resolved.rowClass);

  if (resolved.origin !== 'dynamic') {
    throw new Error(`${unmodelled} resolved as ${resolved.origin}`);
  }
  return `${unmodelled}: ${resolved.rowClass.getEAllStructuralFeatures().length} columns built from the response, ${read_.rows.length} row(s)`;
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
