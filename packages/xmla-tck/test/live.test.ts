/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
import { describe, expect, it } from 'vitest';

import { ALL_CHECKS } from '../src/checks/index.js';
import { createContext, REACHABILITY_CHECK, runCheck } from '../src/kit.js';
import type { Context, Result } from '../src/kit.js';
import { resolveProfile } from '../src/profile.js';

/**
 * The kit under vitest, against whatever `XMLA_TCK_TARGET` names.
 *
 * A profile name or a URL, as the command line takes it. Absent, this file
 * does nothing: `npm test` has to pass on a machine with no server, and a
 * skipped suite says so where a green one would lie.
 *
 *   XMLA_TCK_TARGET=csv-probe npx vitest run packages/xmla-tck
 *
 * One `it` per check, so a failure is one line in the output and one node in
 * a test tree. A check that does not apply to this server skips its `it`. A
 * `should` that fails is reported through the note rather than as a failed
 * test - it is a warning there too.
 */
const target = process.env['XMLA_TCK_TARGET'];

describe.skipIf(target === undefined)(`the client against ${target ?? 'no server'}`, () => {
  const profile = resolveProfile(target ?? '');
  let context: Context | null = null;
  let unreachable = false;

  function contextOnce(): Context {
    if (context === null) {
      context = createContext(profile, { models: bootstrapFromDisk() });
    }
    return context;
  }

  for (const check of ALL_CHECKS) {
    it(`${check.id} ${check.title}`, { timeout: 120_000 }, async (test) => {
      if (unreachable) {
        test.skip();
      }
      const result: Result = await runCheck(check, contextOnce());
      if (check.id === REACHABILITY_CHECK && result.outcome.status === 'fail') {
        unreachable = true;
      }
      switch (result.outcome.status) {
        case 'skip':
          test.skip();
          break;
        case 'blocked':
          // The cause already failed its own test; this one has nothing to add.
          console.warn(`${check.id} ${result.outcome.reason}`);
          test.skip();
          break;
        case 'fail':
          if (check.level === 'must') {
            expect.fail(`${result.outcome.reason}\n${check.spec}`);
          }
          // A should: noted, and not a failed test.
          console.warn(`warn ${check.id} ${check.title}: ${result.outcome.reason}`);
          break;
        case 'pass':
          break;
      }
    });
  }
});
