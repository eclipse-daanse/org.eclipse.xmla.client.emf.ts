/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { Check } from '../kit.js';

import { authentication } from './authentication.js';
import { connection } from './connection.js';
import { execute } from './execute.js';
import { recorded } from './recorded.js';
import { rowsets } from './rowsets.js';
import { sessions } from './sessions.js';
import { suiteChecks } from './suites.js';
import { transport } from './transport.js';

/**
 * Every check, in the order they run.
 *
 * The order is the order a client meets a server: whether it answers, what it
 * says about itself, what it declares, a session, a query, what the check
 * suites beside the catalogs expect, what the recorded clients asked, and
 * finally the endpoint that demands a login.
 */
export const ALL_CHECKS: readonly Check[] = [
  ...transport,
  ...connection,
  ...rowsets,
  ...sessions,
  ...execute,
  ...suiteChecks,
  ...recorded,
  ...authentication,
];

export { authentication, connection, execute, recorded, rowsets, sessions, suiteChecks, transport };
