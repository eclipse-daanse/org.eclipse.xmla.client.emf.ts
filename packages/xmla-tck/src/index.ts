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
 * The technology compatibility kit: this client against a live XMLA server.
 *
 * Everything else in this repository is checked against recordings of one
 * server family. This is what says a byte left the process, that a server
 * nobody recorded answers what the client expects, and which claim of the
 * specification it was that did not hold when one does not.
 */
export { ALL_CHECKS, authentication, connection, execute, recorded, rowsets, sessions, suiteChecks, transport } from './checks/index.js';
export { executeRaw, propertyList, statementCommand } from './mdx.js';
export type { Executed, ExecuteOptions, PropertyValues } from './mdx.js';
export { BlockedBy, createContext, held, NotOnThisServer, notHere, REACHABILITY_CHECK, runCheck, runTck, summarise, verdict } from './kit.js';
export type { Check, Context, ContextOptions, Detail, Level, Outcome, Result, Run, RunOptions, Sample, Summary, Target, Verdict } from './kit.js';
export { PROFILES, profileFor, profileNamed, resolveProfile } from './profile.js';
export type { Profile, ProfileOverrides } from './profile.js';
export { jsonReport, line, listing, summaryLine, textReport } from './report.js';
export { htmlReport } from './html.js';
export { AGGREGATORS, attributeMismatch, cellMismatch, cellOrdinal, loadSuites, readSuite } from './suites.js';
export type {
  AttributeCheck,
  AxisCheck,
  CatalogCheck,
  CellCheck,
  ConnectionCheck,
  CubeCheck,
  DimensionCheck,
  HierarchyCheck,
  LevelCheck,
  NamedObjectCheck,
  QueryCheck,
  Row,
  Suite,
} from './suites.js';
