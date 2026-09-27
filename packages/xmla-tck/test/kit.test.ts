/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { Transport, XmlaHttpRequest, XmlaHttpResponse } from '@eclipse-daanse/xmla-client';
import { bootstrapFromDisk } from '@eclipse-daanse/xmla-model/node';
import type { XmlaModels } from '@eclipse-daanse/xmla-model';
import { beforeAll, describe, expect, it } from 'vitest';

import { ALL_CHECKS } from '../src/checks/index.js';
import { held, notHere, runTck, summarise, verdict } from '../src/kit.js';
import type { Check, Result } from '../src/kit.js';
import { PROFILES, profileFor, resolveProfile } from '../src/profile.js';
import { htmlReport } from '../src/html.js';
import { jsonReport, line, listing, textReport } from '../src/report.js';

/**
 * The kit itself, without a server.
 *
 * What a check answers is decided by the server; what the kit does with the
 * answer is decided here. Three outcomes, two weights, one stop condition -
 * and each of them has to come out as the report says it does.
 */
let models: XmlaModels;

beforeAll(() => {
  models = bootstrapFromDisk();
});

/** A transport nothing should reach. */
class Unreachable implements Transport {
  readonly sent: XmlaHttpRequest[] = [];

  send(request: XmlaHttpRequest): Promise<XmlaHttpResponse> {
    this.sent.push(request);
    return Promise.reject(new Error('the kit was not supposed to send anything'));
  }
}

const profile = { name: 'fake', url: 'http://nowhere.invalid/xmla' };

function check(id: string, level: Check['level'], run: Check['run'], group = 'g'): Check {
  return { id, group, title: `check ${id}`, level, spec: 'made up for the test', run };
}

describe('the checks', () => {
  it('have unique ids, a group, a spec and a level each', () => {
    const ids = ALL_CHECKS.map((each) => each.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const each of ALL_CHECKS) {
      expect(each.group, each.id).not.toBe('');
      expect(each.spec, each.id).not.toBe('');
      expect(['must', 'should'], each.id).toContain(each.level);
    }
  });

  it('start with the reachability probe', () => {
    expect(ALL_CHECKS[0]!.id).toBe('T1');
  });
});

describe('running', () => {
  it('turns a returned note into a pass, a throw into a fail, and notHere into a skip', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'must', async () => 'fine'),
        check('X2', 'must', async () => {
          throw new Error('not fine');
        }),
        check('X3', 'must', async () => notHere('not this one')),
      ],
    });

    expect(run.results.map((each) => each.outcome.status)).toEqual(['pass', 'fail', 'skip']);
    expect(run.results[0]!.outcome).toEqual({ status: 'pass', note: 'fine' });
    expect(run.results[1]!.outcome).toEqual({ status: 'fail', reason: 'not fine' });
    expect(run.results[2]!.outcome).toEqual({ status: 'skip', reason: 'not this one' });
    expect(run.unreachable).toBe(false);
  });

  it('weighs a failed should as a warning, and only a failed must as a failure', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'should', async () => {
          throw new Error('advisory');
        }),
        check('X2', 'must', async () => 'ok'),
      ],
    });

    expect(run.summary).toEqual({ passed: 1, failed: 0, warned: 1, skipped: 0, blocked: 0, assertions: { passed: 0, failed: 0, skipped: 0 } });
    expect(held(run, profile)).toBe(true);
    expect(line(run.results[0]!)).toMatch(/^ {2}warn {2}X1 /);
  });

  it('stops asking after the reachability probe fails', async () => {
    let asked = 0;
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('T1', 'must', async () => {
          throw new Error('nothing there');
        }),
        check('X2', 'must', async () => {
          asked += 1;
          return 'never';
        }),
      ],
    });

    expect(asked).toBe(0);
    expect(run.unreachable).toBe(true);
    expect(run.results[1]!.outcome.status).toBe('skip');
    expect(held(run, profile), 'unreachable is a failure unless tolerated').toBe(false);
    expect(held(run, { ...profile, tolerateUnreachable: true })).toBe(true);
  });

  it('runs only the ids asked for', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      only: ['X2'],
      checks: [check('X1', 'must', async () => 'a'), check('X2', 'must', async () => 'b')],
    });

    expect(run.results.map((each) => each.id)).toEqual(['X2']);
  });

  it('reports each result as it comes', async () => {
    const seen: string[] = [];
    await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [check('X1', 'must', async () => 'a'), check('X2', 'must', async () => 'b')],
      onResult: (result: Result) => {
        seen.push(result.id);
      },
    });

    expect(seen).toEqual(['X1', 'X2']);
  });

  it('fails the first check that needed something, and blocks the ones after it', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'must', async (context) => {
          await context.memo('thing', async () => {
            throw new Error('the thing is broken');
          });
        }),
        check('X2', 'must', async (context) => {
          await context.memo('thing', async () => 'never made again');
        }),
        check('X3', 'must', async () => 'independent'),
      ],
    });

    expect(run.results.map((each) => each.outcome.status)).toEqual(['fail', 'blocked', 'pass']);
    expect(run.results[0]!.outcome).toEqual({ status: 'fail', reason: 'the thing is broken' });
    expect(run.results[1]!.outcome).toMatchObject({ status: 'blocked', by: 'thing' });
    expect((run.results[1]!.outcome as { reason: string }).reason).toContain('the thing is broken');
    expect(run.summary).toEqual({ passed: 1, failed: 1, warned: 0, skipped: 0, blocked: 1, assertions: { passed: 0, failed: 0, skipped: 0 } });
    expect(line(run.results[1]!)).toMatch(/^ {2}!! {4}X2 /);
    expect(textReport(run)).toContain('1 blocked by a failure above');
  });

  it('turns a check with details into one result, failing when any detail fails', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'must', async () =>
          verdict(
            [
              { name: 'a', status: 'pass', note: '1' },
              { name: 'b', status: 'pass', note: null },
              { name: 'c', status: 'skip', note: 'not here' },
            ],
            'three looked at',
          ),
        ),
        check('X2', 'must', async () =>
          verdict([
            { name: 'a', status: 'pass', note: null },
            { name: 'b', status: 'fail', note: 'wrong' },
          ]),
        ),
      ],
    });

    expect(run.results[0]!.outcome).toMatchObject({ status: 'pass', note: 'three looked at (2 of 2 hold, 1 not applicable)' });
    expect(run.results[1]!.outcome).toMatchObject({ status: 'fail', reason: '1 of 2 hold: b - wrong' });
    expect(run.summary.assertions).toEqual({ passed: 3, failed: 1, skipped: 1 });
    expect(line(run.results[1]!)).toContain('· b: wrong');
    expect(textReport(run)).toContain('3/4 assertions inside them');
    const page = htmlReport([run], []);
    expect(page).toContain('<details class="assertions" open>');
    expect(page).toContain('3/4 assertions inside the checks hold');
    expect(page).toContain('<span class="dname">b</span><span class="dnote">wrong</span>');
  });

  it('shares what one check fetched with the next', async () => {
    let made = 0;
    await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'must', async (context) => {
          await context.memo('thing', async () => {
            made += 1;
            return 1;
          });
        }),
        check('X2', 'must', async (context) => {
          await context.memo('thing', async () => {
            made += 1;
            return 2;
          });
        }),
      ],
    });

    expect(made).toBe(1);
  });
});

describe('the report', () => {
  it('groups the text by check group and ends with the summary', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'must', async () => 'a', 'one'),
        check('Y1', 'must', async () => notHere('no'), 'two'),
        check('Y2', 'must', async () => {
          throw new Error('bad');
        }, 'two'),
      ],
    });

    const text = textReport(run);
    expect(text).toContain('\none\n');
    expect(text).toContain('\ntwo\n');
    expect(text).toMatch(/FAIL {2}Y2 +check Y2: bad\n {8}made up for the test/);
    expect(text).toMatch(/fake: 1\/2 held, 1 failed, 1 not applicable to this server/);
  });

  it('is the same run as JSON', async () => {
    const run = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [check('X1', 'must', async () => 'a')],
    });

    const parsed = JSON.parse(jsonReport([run])) as { tck: string; runs: Array<{ summary: unknown; results: unknown[] }> };
    expect(parsed.tck).toBe('@eclipse-daanse/xmla-tck');
    expect(parsed.runs[0]!.summary).toEqual(summarise(run.results));
    expect(parsed.runs[0]!.results).toHaveLength(1);
  });

  it('is one page with a column per server, every check with its authority, and nothing unescaped', async () => {
    const one = await runTck(profile, {
      models,
      transport: new Unreachable(),
      checks: [
        check('X1', 'must', async () => 'a <b>note</b> & more', 'one'),
        check('X2', 'should', async () => {
          throw new Error('x'.repeat(300));
        }, 'one'),
        check('X3', 'must', async () => notHere('no'), 'two'),
      ],
    });
    const other = { ...one, profile: { name: 'other', url: 'http://elsewhere.invalid/xmla' } };

    const page = htmlReport([one, other], [
      { id: 'X1', group: 'one', title: 'first', level: 'must', spec: 'spec one', run: async () => undefined },
      { id: 'X2', group: 'one', title: 'second', level: 'should', spec: 'spec <two>', run: async () => undefined },
      { id: 'X3', group: 'two', title: 'third', level: 'must', spec: 'spec three', run: async () => undefined },
    ]);

    expect(page).toContain('<!DOCTYPE html>');
    expect(page).toContain('fake');
    expect(page).toContain('other');
    expect(page).toContain('spec one');
    expect(page, 'escaped, not rendered').toContain('spec &lt;two&gt;');
    expect(page).toContain('a &lt;b&gt;note&lt;/b&gt; &amp; more');
    expect(page).not.toContain('<b>note</b>');
    expect(page, 'a long reason folds').toContain('<details class="note">');
    expect(page.match(/class="badge pass"/g)?.length, 'one ok per server, plus the legend').toBe(3);
    expect(page.match(/class="badge warn"/g)?.length).toBe(3);
    expect(page.match(/class="badge skip"/g)?.length).toBe(3);
    expect(page, 'no script, no external resource').not.toMatch(/<script|https?:\/\/(?!nowhere|elsewhere)/);
  });

  it('lists every check with its authority', () => {
    const text = listing(ALL_CHECKS);
    for (const each of ALL_CHECKS) {
      expect(text).toContain(each.id);
      expect(text).toContain(each.spec);
    }
  });
});

describe('profiles', () => {
  it('resolve by name, and fall back to a URL', () => {
    expect(resolveProfile('flexmonster').url).toMatch(/flexmonster/);
    expect(resolveProfile('http://host/xmla')).toEqual(profileFor('http://host/xmla', {}));
  });

  it('take Basic credentials from the environment the old probe script read', () => {
    const named = profileFor('http://host/xmla', { XMLA_USER: 'u', XMLA_PASSWORD: 'p' });
    expect(named.credentials).toEqual({ kind: 'basic', username: 'u', password: 'p' });
    expect(profileFor('http://host/xmla', {}).credentials).toBeUndefined();
  });

  it('mark the servers nobody here runs as tolerated when unreachable, and budget them', () => {
    for (const each of PROFILES) {
      if (each.url.startsWith('http://localhost')) {
        expect(each.tolerateUnreachable, each.name).not.toBe(true);
      } else {
        expect(each.tolerateUnreachable, each.name).toBe(true);
        expect(each.sweep, `${each.name}: somebody else's server gets the mandatory sweep`).toBe('mandatory');
      }
    }
  });
});
