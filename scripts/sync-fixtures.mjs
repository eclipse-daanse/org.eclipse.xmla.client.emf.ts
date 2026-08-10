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
 * Copies the recorded XMLA conversations into the testkit.
 *
 * These are captures of real clients talking to SSAS 13, and each conversation
 * carries a _manifest.json holding facts we did not compute ourselves: headers,
 * request types, restrictions, properties, row counts per response. Everything
 * this port claims about the wire is checked against those, which is why they
 * are copied wholesale rather than sampled.
 *
 *   node scripts/sync-fixtures.mjs [--check]
 */
import { join } from 'node:path';

import { filesUnder, readSources, repoRoot, syncFiles } from './sync-lib.mjs';

const check = process.argv.includes('--check');
const sources = readSources();
const sourceDir = join(sources.sourceRoot, sources.fixtures.file);
const targetDir = join(repoRoot, 'packages', 'testkit', 'fixtures');

let entries;
try {
  entries = filesUnder(sourceDir).map((rel) => ({ from: join(sourceDir, rel), to: rel }));
} catch {
  console.error(`fixtures: cannot read ${sourceDir}`);
  console.error('Set XMLA_MODEL_SOURCE to the org.eclipse.daanse.xmla checkout.');
  process.exit(1);
}

let problems = syncFiles({
  label: 'fixtures',
  sourceRoot: sources.sourceRoot,
  targetDir,
  manifestName: '_sync-manifest.json',
  entries,
  check,
});

// Every conversation named in model-sources.json has to have arrived with its
// manifest. A conversation that quietly went missing would just shrink the test
// corpus, and a shrinking corpus still passes.
const arrived = new Set(entries.map((entry) => entry.to.split('/')[1]));
for (const conversation of sources.fixtures.conversations) {
  if (!arrived.has(conversation)) {
    console.error(`  - conversation is missing entirely: ${conversation}`);
    problems += 1;
  } else if (!entries.some((entry) => entry.to === `conversations/${conversation}/_manifest.json`)) {
    console.error(`  - conversation has no _manifest.json: ${conversation}`);
    problems += 1;
  }
}

process.exit(problems === 0 ? 0 : 1);
