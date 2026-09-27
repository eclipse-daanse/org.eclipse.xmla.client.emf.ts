/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Credentials } from '@daanse/xmla-client';

/**
 * A server to run against, and what is known about it beforehand.
 *
 * The checks read the server for everything they can. What a profile adds is
 * what cannot be read: the second endpoint that demands a login, the endpoint
 * that answers a rowset no model describes, the file the numbers were computed
 * from. A check for any of those reports "not on this server" when the profile
 * is silent.
 */
export interface Profile {
  readonly name: string;
  readonly url: string;
  readonly credentials?: Credentials;
  /**
   * Which of the rowsets the server declares are asked for, one by one.
   *
   * `all` for a server of one's own. `mandatory` for somebody else's: the ones
   * XMLA 1.1 requires and the ones an OLAP client needs, and no more.
   */
  readonly sweep?: 'all' | 'mandatory';
  /** An endpoint that serves the probe rowsets anonymously and refuses the rest with a 401. */
  readonly guardedUrl?: string;
  /** The credentials the guarded endpoint accepts. */
  readonly guardedCredentials?: { readonly username: string; readonly password: string };
  /** An endpoint answering a rowset present in no `.ecore`, to prove the dynamic path over a wire. */
  readonly foreignUrl?: string;
  /** The request type the foreign endpoint answers. */
  readonly foreignRequestType?: string;
  /** A csv the server's Sales cube was loaded from, so its totals can be recomputed. */
  readonly knownDataCsv?: string;
  /**
   * The Daanse probe's `catalog/` directory: one `<name>/check/checkSuite.xmi`
   * per catalog, saying what it holds and what its queries answer. With it the
   * suite checks run; without it they are not applicable.
   */
  readonly checkSuitesDir?: string;
  /** How long to wait for the server to come up before the first check gives up. */
  readonly waitMs?: number;
  /** How long any one request may take. */
  readonly timeoutMs?: number;
  /** A server nobody here runs: being down is not this project's failure. */
  readonly tolerateUnreachable?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/xmla-tck/dist → the repository root. */
const REPO_ROOT = join(HERE, '..', '..', '..');

/** The servers this project knows, by name. */
export const PROFILES: readonly Profile[] = [
  {
    // scripts/probe.mjs: the csv-backed Daanse server in this repository.
    name: 'csv-probe',
    url: 'http://localhost:8090/xmla',
    sweep: 'all',
    guardedUrl: 'http://localhost:8091/xmla',
    guardedCredentials: { username: 'aladdin', password: 'open sesame' },
    foreignUrl: 'http://localhost:8090/xmla-foreign',
    foreignRequestType: 'DISCOVER_M_EXPRESSIONS',
    knownDataCsv: join(REPO_ROOT, 'probe', 'data', 'sales.csv'),
    waitMs: 60_000,
  },
  {
    // The assembled Daanse probe: application/probe in org.eclipse.daanse.server.
    name: 'daanse',
    url: 'http://localhost:8090/xmla',
    sweep: 'all',
    waitMs: 60_000,
  },
  {
    // The distributable probe with every tutorial catalog (probe-all-tutorials.zip):
    // XMLA on 8080, and the suites beside the catalogs. XMLA_TCK_SUITES names
    // its catalog/ directory, or --suites does.
    name: 'probe-all-tutorials',
    url: 'http://localhost:8080/xmla',
    sweep: 'all',
    waitMs: 120_000,
    ...(process.env['XMLA_TCK_SUITES'] === undefined ? {} : { checkSuitesDir: process.env['XMLA_TCK_SUITES'] }),
  },
  {
    name: 'flexmonster',
    url: 'http://olap.flexmonster.com/olap/msmdpump.dll',
    sweep: 'mandatory',
    tolerateUnreachable: true,
  },
  {
    name: 'syncfusion',
    url: 'https://bi.syncfusion.com/olap/msmdpump.dll',
    sweep: 'mandatory',
    tolerateUnreachable: true,
  },
  {
    // A different implementation altogether, and the one that would say most.
    // Unreachable at the time of writing; kept so that it is tried again.
    name: 'emondrian',
    url: 'https://ssemenkoff.dev/emondrian/xmla',
    sweep: 'mandatory',
    tolerateUnreachable: true,
  },
];

export function profileNamed(name: string): Profile | null {
  return PROFILES.find((profile) => profile.name === name) ?? null;
}

/**
 * A profile for a URL nobody wrote one for.
 *
 * `XMLA_USER` and `XMLA_PASSWORD` supply Basic credentials, as the old probe
 * script took them. Everything else is read from the server.
 */
export function profileFor(url: string, environment: NodeJS.ProcessEnv = process.env): Profile {
  const user = environment['XMLA_USER'];
  const password = environment['XMLA_PASSWORD'] ?? '';
  return {
    name: url,
    url,
    sweep: 'all',
    ...(user === undefined ? {} : { credentials: { kind: 'basic', username: user, password } }),
  };
}

/** What the command line may set on top of any profile. */
export interface ProfileOverrides {
  readonly checkSuitesDir?: string;
}

/** A name from the list, or a URL, with the command line's overrides on top. */
export function resolveProfile(
  nameOrUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: ProfileOverrides = {},
): Profile {
  const base = profileNamed(nameOrUrl) ?? profileFor(nameOrUrl, environment);
  return {
    ...base,
    ...(overrides.checkSuitesDir === undefined ? {} : { checkSuitesDir: overrides.checkSuitesDir }),
  };
}
