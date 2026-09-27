/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { columnOf as columnOfRow, FetchTransport, XmlaClient } from '@daanse/xmla-client';
import type { ConnectionInfo, DiscoverResult, Transport } from '@daanse/xmla-client';
import { RowsetCatalog } from '@daanse/xmla-model';
import type { XmlaModels } from '@daanse/xmla-model';
import type { EObject } from '@emfts/core';

import type { Profile } from './profile.js';

/**
 * The kit itself: what a check is, what it runs against, and what it answers.
 *
 * A check is one claim about a server, with the specification it rests on
 * written next to it. It either holds, does not hold, or is not applicable to
 * the server it found - three answers, not two, because a red run for a feature
 * a server never claimed to have teaches nothing.
 */

/**
 * How much a failure weighs.
 *
 * `must` is what the client cannot work without - a server that fails one is a
 * server this client cannot talk to. `should` is what the specification asks
 * for and the client tolerates being without; a failure is reported as a
 * warning and does not fail the run.
 */
export type Level = 'must' | 'should';

export interface Check {
  /** Short and stable: `C4`, `R9`. What a report refers to and `--only` filters by. */
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly level: Level;
  /** Where the claim comes from: the section of [MS-SSAS] or of XMLA 1.1 that states it. */
  readonly spec: string;
  /**
   * Holds, with a note; or throws. {@link notHere} for a server that lacks
   * the thing. A check that stands for many assertions - one per catalog, per
   * query, per rowset - hands them back as {@link Detail}s, and fails when any
   * of them fails.
   */
  run(context: Context): Promise<string | void | Verdict>;
}

/** One assertion inside a check that makes many: a query, a catalog, a rowset. */
export interface Detail {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly note: string | null;
}

/** What a check with details answers: the details, and a note summing them up. */
export interface Verdict {
  readonly note?: string;
  readonly details: readonly Detail[];
}

/** The verdict for a list of details: fails when any of them fails. */
export function verdict(details: readonly Detail[], note?: string): Verdict {
  return note === undefined ? { details } : { note, details };
}

/**
 * What a check says when the server it found does not have the thing it tests.
 *
 * The kit runs against more than one server - the csv probe with its guarded
 * endpoint, the assembled Daanse one, SSAS behind msmdpump - so a check for a
 * feature one of them lacks has to say so rather than fail.
 */
export class NotOnThisServer extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'NotOnThisServer';
  }
}

export function notHere(why: string): never {
  throw new NotOnThisServer(why);
}

/**
 * What a check says when something it needs was already asked for by an
 * earlier check, and could not be had.
 *
 * The connection, the schema rowsets, the target cube, the sweep: each is
 * fetched once and shared. When the fetch fails, the check that asked first
 * fails with the reason, and every later one that needs the same thing is
 * blocked by it rather than failing again with the same words. One cause, one
 * failure, and a report that says which one.
 */
export class BlockedBy extends Error {
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super(`blocked: ${key} could not be had - ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'BlockedBy';
    this.key = key;
  }
}

/** The first catalog and cube a server offers - what the queries are aimed at. */
export interface Target {
  readonly catalog: string;
  readonly cube: string;
}

/**
 * One of everything the target cube has, by unique name.
 *
 * What a recorded restriction naming an Adventure Works hierarchy is rewritten
 * to, and what a query on a second axis is built from. Null where the cube has
 * no such thing - a cube of measures only has no hierarchy to speak of.
 */
export interface Sample extends Target {
  readonly dimensionUniqueName: string | null;
  readonly hierarchyUniqueName: string | null;
  readonly levelUniqueName: string | null;
  readonly memberUniqueName: string | null;
  readonly measureUniqueName: string | null;
}

/**
 * What the checks share: the server, the models, and the answers already
 * fetched. A check that needs DISCOVER_SCHEMA_ROWSETS asks here rather than the
 * server, so the largest answer a server gives is fetched once per run.
 */
export interface Context {
  readonly profile: Profile;
  readonly models: XmlaModels;
  readonly catalog: RowsetCatalog;
  /** The transport every client here sends through, for a check that wants to see the bytes. */
  readonly transport: Transport;
  /** A client on the profile's endpoint, carrying its credentials and nothing else. */
  client(url?: string): XmlaClient;
  /** The connection as `open()` leaves it, made once. */
  connected(): Promise<{ client: XmlaClient; info: ConnectionInfo }>;
  /** DISCOVER_SCHEMA_ROWSETS, fetched once. */
  schemaRowsets(): Promise<DiscoverResult>;
  /** The first catalog and cube, or {@link notHere} when the server offers none. */
  target(): Promise<Target>;
  /** The target, with one dimension, hierarchy, level, member and measure of it by unique name. */
  sample(): Promise<Sample>;
  /** Anything else a check wants to leave for a later one, by key. */
  memo<T>(key: string, make: () => Promise<T>): Promise<T>;
}

export interface ContextOptions {
  readonly models: XmlaModels;
  readonly transport?: Transport;
}

export function createContext(profile: Profile, options: ContextOptions): Context {
  const models = options.models;
  const catalog = new RowsetCatalog(models);
  const transport = options.transport ?? new FetchTransport({ fetch: fetchWithDeadline(profile.timeoutMs ?? 30_000) });
  const memos = new Map<string, Promise<unknown>>();

  const context: Context = {
    profile,
    models,
    catalog,
    transport,
    client(url = profile.url) {
      return new XmlaClient({
        url,
        transport,
        models,
        ...(profile.credentials === undefined ? {} : { credentials: profile.credentials }),
      });
    },
    connected() {
      return context.memo('connected', () => context.client().open());
    },
    schemaRowsets() {
      return context.memo('DISCOVER_SCHEMA_ROWSETS', async () => {
        const { client } = await context.connected();
        return client.discover('DISCOVER_SCHEMA_ROWSETS');
      });
    },
    target() {
      return context.memo('target', async () => {
        const { client, info } = await context.connected();
        // Catalog by catalog, not one unrestricted MDSCHEMA_CUBES: a server that
        // holds a catalog this client may not see can refuse the unrestricted
        // rowset outright - the Daanse probe does, for FoodMart - and a cube in
        // a refused catalog is no target. The current catalog first, then the
        // ones that name no roles, then the rest.
        const catalogs = await client.discover('DBSCHEMA_CATALOGS');
        const named = catalogs.rows.map((row) => ({
          name: columnOf(row, 'CATALOG_NAME') ?? '',
          roles: (columnOf(row, 'ROLES') ?? '').trim(),
        }));
        const ordered = [
          ...named.filter((each) => each.name === info.currentCatalog),
          ...named.filter((each) => each.name !== info.currentCatalog && each.roles === ''),
          ...named.filter((each) => each.name !== info.currentCatalog && each.roles !== ''),
        ].filter((each) => each.name !== '');
        let refused = 0;
        for (const each of ordered) {
          let cubes: DiscoverResult;
          try {
            cubes = await client.discover('MDSCHEMA_CUBES', [{ name: 'CATALOG_NAME', value: each.name }]);
          } catch {
            refused += 1;
            continue;
          }
          const first = cubes.rows.find((row) => (columnOf(row, 'CUBE_NAME') ?? '') !== '');
          if (first !== undefined) {
            return { catalog: each.name, cube: columnOf(first, 'CUBE_NAME')! };
          }
        }
        notHere(
          ordered.length === 0
            ? 'this server lists no catalog'
            : `no catalog of ${ordered.length} answers a cube${refused === 0 ? '' : ` (${refused} refused the question)`}`,
        );
      });
    },
    sample() {
      return context.memo('sample', async () => {
        const { client } = await context.connected();
        const target = await context.target();
        const scope = [
          { name: 'CATALOG_NAME', value: target.catalog },
          { name: 'CUBE_NAME', value: target.cube },
        ];
        const hierarchies = (await client.discover('MDSCHEMA_HIERARCHIES', scope)).rows.filter(
          (row) => (columnOf(row, 'DIMENSION_UNIQUE_NAME') ?? '') !== '[Measures]',
        );
        const hierarchy = hierarchies[0];
        const hierarchyUniqueName = hierarchy === undefined ? null : columnOf(hierarchy, 'HIERARCHY_UNIQUE_NAME');
        let levelUniqueName: string | null = null;
        let memberUniqueName: string | null = hierarchy === undefined ? null : blank(columnOf(hierarchy, 'ALL_MEMBER'));
        if (hierarchyUniqueName !== null) {
          const levels = (
            await client.discover('MDSCHEMA_LEVELS', [...scope, { name: 'HIERARCHY_UNIQUE_NAME', value: hierarchyUniqueName }])
          ).rows;
          // The lowest-numbered level that is not the all level, so a member of it is a real one.
          const sorted = [...levels].sort((a, b) => Number(columnOf(a, 'LEVEL_NUMBER') ?? 0) - Number(columnOf(b, 'LEVEL_NUMBER') ?? 0));
          levelUniqueName = blank(columnOf(sorted.find((row) => Number(columnOf(row, 'LEVEL_NUMBER') ?? 0) > 0) ?? sorted[0] ?? null, 'LEVEL_UNIQUE_NAME'));
          if (memberUniqueName === null && levelUniqueName !== null) {
            try {
              const members = await client.discover('MDSCHEMA_MEMBERS', [
                ...scope,
                { name: 'LEVEL_UNIQUE_NAME', value: levelUniqueName },
              ]);
              memberUniqueName = blank(columnOf(members.rows[0] ?? null, 'MEMBER_UNIQUE_NAME'));
            } catch {
              memberUniqueName = null;
            }
          }
        }
        const measures = (await client.discover('MDSCHEMA_MEASURES', scope)).rows;
        return {
          ...target,
          dimensionUniqueName: hierarchy === undefined ? null : blank(columnOf(hierarchy, 'DIMENSION_UNIQUE_NAME')),
          hierarchyUniqueName,
          levelUniqueName,
          memberUniqueName,
          measureUniqueName: blank(columnOf(measures[0] ?? null, 'MEASURE_UNIQUE_NAME')),
        };
      });
    },
    memo<T>(key: string, make: () => Promise<T>): Promise<T> {
      const held = memos.get(key);
      if (held !== undefined) {
        return held as Promise<T>;
      }
      const made = make();
      // The first to ask gets the error; everyone after is blocked by it.
      const shared = made.catch((cause: unknown) => {
        // "Not on this server" is an answer, and the same answer for everyone
        // who asks; only a failure blocks the ones who ask later.
        const blocked = Promise.reject(cause instanceof NotOnThisServer ? cause : new BlockedBy(key, cause));
        // Nobody may ever ask for it again; that must not count as unhandled.
        blocked.catch(() => undefined);
        memos.set(key, blocked);
        throw cause;
      });
      memos.set(key, shared);
      return shared;
    },
  };
  return context;
}

/** `fetch` with a deadline, because a server may simply not answer. */
export function fetchWithDeadline(timeoutMs: number): typeof globalThis.fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return globalThis.fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

/** `columnOf`, tolerant of no row at all. */
function columnOf(row: EObject | null, wireName: string): string | null {
  return row === null ? null : columnOfRow(row, wireName);
}

/** The value of a column, by its name on the wire, as text; empty when unset. */
export function text(row: EObject, wireName: string): string {
  return columnOf(row, wireName) ?? '';
}

/** Null for an empty or missing value. */
function blank(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value;
}

/** Cut to fit a report line. */
export function short(message: string, length = 200): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

export type Outcome =
  | { readonly status: 'pass'; readonly note: string | null; readonly details?: readonly Detail[] }
  | { readonly status: 'fail'; readonly reason: string; readonly details?: readonly Detail[] }
  | { readonly status: 'skip'; readonly reason: string }
  /** Could not be asked, because something an earlier check needed - and failed to get - is needed here too. */
  | { readonly status: 'blocked'; readonly reason: string; readonly by: string };

export interface Result {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly level: Level;
  readonly spec: string;
  readonly outcome: Outcome;
  readonly millis: number;
}

export interface Summary {
  readonly passed: number;
  /** `must` checks that did not hold. What decides the exit code. */
  readonly failed: number;
  /** `should` checks that did not hold. Reported, never fatal. */
  readonly warned: number;
  readonly skipped: number;
  /** Not asked, because what they needed had already failed to arrive for an earlier check. */
  readonly blocked: number;
  /** The assertions inside the checks that make many - one per query, catalog, rowset. */
  readonly assertions: { readonly passed: number; readonly failed: number; readonly skipped: number };
}

export interface Run {
  readonly profile: { readonly name: string; readonly url: string };
  readonly startedAt: string;
  readonly millis: number;
  /** True when the endpoint never answered and the rest was not attempted. */
  readonly unreachable: boolean;
  readonly results: readonly Result[];
  readonly summary: Summary;
}

/** Runs one check and turns what happened into an outcome. Never throws. */
export async function runCheck(check: Check, context: Context): Promise<Result> {
  const started = Date.now();
  let outcome: Outcome;
  try {
    const answer = await check.run(context);
    if (answer !== undefined && typeof answer === 'object') {
      const failed = answer.details.filter((detail) => detail.status === 'fail');
      const passed = answer.details.filter((detail) => detail.status === 'pass').length;
      const skipped = answer.details.length - failed.length - passed;
      const counted = `${passed} of ${passed + failed.length} hold${skipped === 0 ? '' : `, ${skipped} not applicable`}`;
      const note = answer.note === undefined ? counted : `${answer.note} (${counted})`;
      outcome =
        failed.length === 0
          ? { status: 'pass', note, details: answer.details }
          : {
              status: 'fail',
              reason: `${note}: ${failed
                .slice(0, 5)
                .map((detail) => `${detail.name}${detail.note === null ? '' : ` - ${detail.note}`}`)
                .join('; ')}${failed.length > 5 ? '; …' : ''}`,
              details: answer.details,
            };
    } else {
      outcome = { status: 'pass', note: answer === undefined ? null : answer };
    }
  } catch (error) {
    if (error instanceof NotOnThisServer) {
      outcome = { status: 'skip', reason: error.message };
    } else if (error instanceof BlockedBy) {
      outcome = { status: 'blocked', reason: short(error.message, 400), by: error.key };
    } else {
      // Generous: the JSON keeps the whole reason, and the text line cuts it.
      outcome = { status: 'fail', reason: short(messageOf(error), 4000) };
    }
  }
  return {
    id: check.id,
    group: check.group,
    title: check.title,
    level: check.level,
    spec: check.spec,
    outcome,
    millis: Date.now() - started,
  };
}

export interface RunOptions {
  readonly checks: readonly Check[];
  readonly models: XmlaModels;
  readonly transport?: Transport;
  /** Run only these ids. */
  readonly only?: readonly string[];
  /** Called after each check, for a report that grows while the run does. */
  readonly onResult?: (result: Result) => void;
}

/**
 * Runs the checks against one server, in order.
 *
 * In order and one at a time, deliberately: a session check that overlapped
 * with another's request would be testing the kit's own concurrency rather than
 * the server's protocol, and some of these servers are somebody else's.
 *
 * The first check of the first group is the reachability probe. When it fails
 * the rest are not attempted: nothing after it could hold, and thirty
 * timeouts say less than one.
 */
export async function runTck(profile: Profile, options: RunOptions): Promise<Run> {
  const context = createContext(profile, {
    models: options.models,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
  const selected =
    options.only === undefined || options.only.length === 0
      ? options.checks
      : options.checks.filter((check) => options.only!.includes(check.id));

  const startedAt = new Date();
  const results: Result[] = [];
  let unreachable = false;

  for (const check of selected) {
    const result = unreachable
      ? {
          id: check.id,
          group: check.group,
          title: check.title,
          level: check.level,
          spec: check.spec,
          outcome: { status: 'skip', reason: 'not attempted: the endpoint did not answer' } as const,
          millis: 0,
        }
      : await runCheck(check, context);
    results.push(result);
    options.onResult?.(result);
    if (check.id === REACHABILITY_CHECK && result.outcome.status === 'fail') {
      unreachable = true;
    }
  }

  return {
    profile: { name: profile.name, url: profile.url },
    startedAt: startedAt.toISOString(),
    millis: Date.now() - startedAt.getTime(),
    unreachable,
    results,
    summary: summarise(results),
  };
}

/** The id of the check whose failure means nothing else can be asked. */
export const REACHABILITY_CHECK = 'T1';

export function summarise(results: readonly Result[]): Summary {
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let skipped = 0;
  let blocked = 0;
  const assertions = { passed: 0, failed: 0, skipped: 0 };
  for (const result of results) {
    if ((result.outcome.status === 'pass' || result.outcome.status === 'fail') && result.outcome.details !== undefined) {
      for (const detail of result.outcome.details) {
        if (detail.status === 'pass') {
          assertions.passed += 1;
        } else if (detail.status === 'fail') {
          assertions.failed += 1;
        } else {
          assertions.skipped += 1;
        }
      }
    }
    switch (result.outcome.status) {
      case 'pass':
        passed += 1;
        break;
      case 'skip':
        skipped += 1;
        break;
      case 'blocked':
        blocked += 1;
        break;
      case 'fail':
        if (result.level === 'must') {
          failed += 1;
        } else {
          warned += 1;
        }
        break;
    }
  }
  return { passed, failed, warned, skipped, blocked, assertions };
}

/** Whether a run is one to gate a build on. Unreachable counts as failed unless the profile tolerates it. */
export function held(run: Run, profile: Profile): boolean {
  if (run.unreachable) {
    return profile.tolerateUnreachable === true;
  }
  return run.summary.failed === 0;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // An HTTP error carries the status and, often, the server's own text.
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? `HTTP ${status}: ${error.message}` : error.message;
  }
  return String(error);
}
