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
 * The vendored composer against the snapshot it came from.
 *
 * A vendored copy that quietly diverges is worse than a dependency, because
 * nothing says it has. This compares the two file by file and fails on anything
 * that is not one of the removals or the two edits VENDOR.md sets out.
 *
 *   UIMODEL_SNAPSHOT=/path/to/emf.ts.ui-snapshot node scripts/check-vendor.mjs
 *
 * Skips itself, loudly, when the snapshot is not there: not everyone has it,
 * and a check that passes because it did nothing would be a lie.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot } from './sync-lib.mjs';

const snapshot = process.env['UIMODEL_SNAPSHOT'] ?? join(process.env['HOME'] ?? '', 'Downloads', 'emf.ts.ui-snapshot');
const vendored = join(repoRoot, 'packages', 'vendor-uimodel-composer');

/** What VENDOR.md says was taken out. Anything else missing is a problem. */
const REMOVED = [
  'src/composers/VegaViewComposer.vue',
  'src/composers/MapViewComposer.vue',
  'model/uimodel-vega.ecore',
  'model/uimodel-vega.genconfig.xmi',
  'model/uimodel-maps.ecore',
  'model/uimodel-maps.genconfig.xmi',
];
const REMOVED_TREES = ['src/generated/vega/', 'src/generated/maps/'];

/** What VENDOR.md says was edited, and nothing else may be. */
const EDITED = ['src/index.ts', 'src/composers/UIModelComposer.vue'];

if (!existsSync(snapshot)) {
  console.log(`check:vendor skipped - no snapshot at ${snapshot}`);
  console.log('Set UIMODEL_SNAPSHOT to compare, or take this as unverified.');
  process.exit(0);
}

function filesUnder(root, prefix = '') {
  const found = [];
  const here = join(root, prefix);
  if (!existsSync(here)) {
    return found;
  }
  for (const entry of readdirSync(here, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...filesUnder(root, rel));
    } else if (entry.isFile()) {
      found.push(rel);
    }
  }
  return found;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function wasRemoved(rel) {
  return REMOVED.includes(rel) || REMOVED_TREES.some((tree) => rel.startsWith(tree));
}

const problems = [];
let same = 0;

for (const directory of ['src', 'model']) {
  for (const rel of filesUnder(snapshot, directory)) {
    if (wasRemoved(rel)) {
      if (existsSync(join(vendored, rel))) {
        problems.push(`still here though VENDOR.md says it was removed: ${rel}`);
      }
      continue;
    }
    const mine = join(vendored, rel);
    if (!existsSync(mine)) {
      problems.push(`missing, and VENDOR.md does not say it was removed: ${rel}`);
      continue;
    }
    if (digest(mine) === digest(join(snapshot, rel))) {
      same += 1;
    } else if (EDITED.includes(rel)) {
      same += 1;
    } else {
      problems.push(`differs from the snapshot, and VENDOR.md does not say it was edited: ${rel}`);
    }
  }
}

// Anything here that is not in the snapshot at all - a file added by hand -
// would be the least visible kind of drift.
const OURS = new Set(['package.json', 'VENDOR.md', 'LICENSE']);
for (const rel of filesUnder(vendored)) {
  if (OURS.has(rel) || rel.startsWith('node_modules/') || rel.startsWith('dist/')) {
    continue;
  }
  if (!existsSync(join(snapshot, rel))) {
    problems.push(`not in the snapshot at all: ${rel}`);
  }
}

if (problems.length > 0) {
  console.error(`vendor: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('\nEither re-vendor from the snapshot, or say in VENDOR.md what changed and why.');
  process.exit(1);
}

console.log(`vendor: ${same} file(s) match the snapshot, ${EDITED.length} edited as VENDOR.md sets out`);
console.log(`        ${REMOVED.length + REMOVED_TREES.length} removal(s) confirmed`);
process.exit(0);
