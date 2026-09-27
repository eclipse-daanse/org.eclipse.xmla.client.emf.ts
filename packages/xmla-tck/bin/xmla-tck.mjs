#!/usr/bin/env node
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
 * The kit from the command line.
 *
 *   xmla-tck                          the csv probe, or $XMLA_URL when set
 *   xmla-tck csv-probe flexmonster    profiles by name, one run each
 *   xmla-tck http://host/xmla         any URL; XMLA_USER and XMLA_PASSWORD add Basic
 *   xmla-tck --only C5,R7 ...         a subset, by id
 *   xmla-tck --json report.json ...   keep the runs
 *   xmla-tck --html report.html ...   the runs as one page, a matrix of check by server
 *   xmla-tck --suites path/to/catalog  the Daanse check suites, for the suite checks
 *   xmla-tck --list                   what would be asked, and on whose authority
 *
 * Exits non-zero when a `must` check failed on any server that answered, or
 * when a server that is not marked as tolerated did not answer.
 */
import { writeFileSync } from 'node:fs';

import { bootstrapFromDisk } from '@eclipse-daanse/xmla-model/node';

import { ALL_CHECKS, held, htmlReport, jsonReport, line, listing, resolveProfile, runTck, summaryLine } from '../dist/index.js';

const args = process.argv.slice(2);
const only = [];
let json = null;
let html = null;
let suites = process.env['XMLA_TCK_SUITES'] ?? null;
const targets = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--list') {
    console.log(listing(ALL_CHECKS));
    process.exit(0);
  } else if (arg === '--only') {
    only.push(...String(args[++i] ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''));
  } else if (arg === '--json') {
    json = args[++i] ?? null;
  } else if (arg === '--html') {
    html = args[++i] ?? null;
  } else if (arg === '--suites') {
    suites = args[++i] ?? null;
  } else if (arg === '--help' || arg === '-h') {
    console.log('usage: xmla-tck [--list] [--only ID,ID] [--json FILE] [--html FILE] [--suites DIR] [profile-or-url ...]');
    process.exit(0);
  } else {
    targets.push(arg);
  }
}

if (targets.length === 0) {
  targets.push(process.env['XMLA_URL'] ?? 'csv-probe');
}

const models = bootstrapFromDisk();
const runs = [];
let allHeld = true;

for (const target of targets) {
  const profile = resolveProfile(target, process.env, suites === null ? {} : { checkSuitesDir: suites });
  console.log(`\n${profile.name} — ${profile.url}\n`);
  let group = null;
  const run = await runTck(profile, {
    checks: ALL_CHECKS,
    models,
    only,
    onResult(result) {
      if (result.group !== group) {
        group = result.group;
        console.log(group);
      }
      console.log(line(result));
    },
  });
  runs.push(run);
  console.log(`\n${summaryLine(run)}`);
  if (!held(run, profile)) {
    allHeld = false;
  }
}

if (json !== null) {
  writeFileSync(json, jsonReport(runs));
  console.log(`\nwritten to ${json}`);
}
if (html !== null) {
  writeFileSync(html, htmlReport(runs, ALL_CHECKS));
  console.log(`${json === null ? '\n' : ''}written to ${html}`);
}

process.exit(allHeld ? 0 : 1);
