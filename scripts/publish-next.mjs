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
 * Publishes every public workspace package whose version is not on npm yet.
 *
 * What `lerna publish from-package` does for the other Daanse repositories,
 * for a plain npm workspace: the version in each package.json is the truth,
 * a version the registry already has is skipped, and the tag comes from the
 * package's own publishConfig - `next` for the prereleases these are.
 *
 *   node scripts/publish-next.mjs                publish what is missing
 *   node scripts/publish-next.mjs --dry-run      say what would be published
 *   node scripts/publish-next.mjs --otp 123456   by hand, with the authenticator's code
 *
 * In order of the build, so a package never lands before what it depends on.
 * Provenance is on when NPM_CONFIG_PROVENANCE says so, which the workflow
 * sets; locally it is off, because there is no OIDC token to sign with.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './sync-lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const otpAt = process.argv.indexOf('--otp');
/** The one-time password an account with 2FA has to give; the workflow's token needs none. */
const otp = otpAt < 0 ? null : (process.argv[otpAt + 1] ?? null);

/** The build order, which is the dependency order. */
const order = JSON.parse(readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8')).references.map((ref) => ref.path);

const candidates = [];
for (const path of order) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8'));
  } catch {
    continue; // not a package (the readme examples)
  }
  if (manifest.private === true || typeof manifest.name !== 'string') {
    continue;
  }
  candidates.push({ path, name: manifest.name, version: manifest.version, tag: manifest.publishConfig?.tag ?? 'next' });
}

function onRegistry(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return false; // E404: not there, or the package does not exist at all
  }
  return result.stdout.trim() !== '' && result.stdout.trim() !== '[]';
}

let published = 0;
let skipped = 0;
for (const { name, version, tag } of candidates) {
  if (onRegistry(name, version)) {
    console.log(`  --   ${name}@${version} is on the registry`);
    skipped += 1;
    continue;
  }
  if (dryRun) {
    console.log(`  will ${name}@${version} --tag ${tag}`);
    published += 1;
    continue;
  }
  console.log(`  pub  ${name}@${version} --tag ${tag}`);
  execFileSync('npm', ['publish', '--workspace', name, '--tag', tag, '--access', 'public', ...(otp === null ? [] : [`--otp=${otp}`])], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  published += 1;
}

console.log(`\n${published} ${dryRun ? 'to publish' : 'published'}, ${skipped} already there`);
