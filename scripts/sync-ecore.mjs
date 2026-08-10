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
 * Copies the Ecore models listed in model-sources.json into xmla-model.
 *
 * Beyond copying, this checks the two things about the model set that the
 * loader relies on and that nothing else would notice going wrong: that the
 * declared nsURI still matches what the file actually says, and that the
 * declared order really is topological. Both are cheap here and expensive to
 * debug later, when a type silently fails to resolve.
 *
 *   node scripts/sync-ecore.mjs [--check]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSources, repoRoot, syncFiles } from './sync-lib.mjs';

const check = process.argv.includes('--check');
const sources = readSources();
const targetDir = join(repoRoot, 'packages', 'xmla-model', 'model');

const entries = sources.models.map((model) => ({
  from: join(sources.sourceRoot, model.file),
  to: `${model.name}.ecore`,
}));

const problems = syncFiles({
  label: 'ecore',
  sourceRoot: sources.sourceRoot,
  targetDir,
  manifestName: '_manifest.json',
  entries,
  check,
});

// Only worth asking once the copies are known good. Verifying the source after a
// copy already failed would print a reassuring line underneath the failure.
if (problems > 0) {
  process.exit(1);
}

process.exit(verifyDeclarations(sources, targetDir) === 0 ? 0 : 1);

/**
 * The nsURI in model-sources.json is what the loader registers a package under.
 * If the file ever declares something else, every cross-model type reference
 * into it turns into an unresolved proxy - and a proxy reads as an empty value
 * rather than as an error.
 */
function verifyDeclarations(sources, dir) {
  const found = [];
  const seen = new Set();

  for (const model of sources.models) {
    const path = join(dir, `${model.name}.ecore`);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      found.push(`cannot read ${model.name}`);
      continue;
    }

    const declared = /nsURI="([^"]*)"/.exec(text);
    if (declared === null) {
      found.push(`${model.name}: the file declares no nsURI`);
    } else if (declared[1] !== model.nsURI) {
      found.push(`${model.name}: declares ${declared[1]}, model-sources.json says ${model.nsURI}`);
    }

    for (const dependency of model.dependsOn) {
      if (!seen.has(dependency)) {
        found.push(`${model.name} depends on ${dependency}, which is not loaded before it`);
      }
    }
    seen.add(model.nsURI);
  }

  if (found.length > 0) {
    console.error(`ecore: ${found.length} declaration problem(s)`);
    for (const problem of found) {
      console.error(`  - ${problem}`);
    }
    return found.length;
  }
  console.log(`ecore: ${sources.models.length} nsURI(s) declared as expected, order is topological`);
  return 0;
}
