/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { FetchTransport, XmlaClient } from '@eclipse-daanse/xmla-client';
import type { Credentials } from '@eclipse-daanse/xmla-client';

import { fetchWithDeadline, notHere, short } from '../kit.js';
import type { Check, Context } from '../kit.js';

/**
 * Authentication, against the guarded endpoint a profile names.
 *
 * Every check here is about the same two facts: Excel and SSMS ask
 * DISCOVER_PROPERTIES and DISCOVER_DATASOURCES before they authenticate, so
 * those have to be served anonymously; and everything else has to be refused
 * with a 401 that says how to ask, because a client cannot log in from a fault.
 */
async function guarded(context: Context): Promise<{ url: string; username: string; password: string }> {
  const { guardedUrl, guardedCredentials } = context.profile;
  if (guardedUrl === undefined || guardedCredentials === undefined) {
    notHere('the profile names no guarded endpoint');
  }
  const up = await context.memo('guarded:up', async () => {
    try {
      await fetchWithDeadline(context.profile.timeoutMs ?? 30_000)(guardedUrl, {
        method: 'POST',
        body: '',
        headers: { 'Content-Type': 'text/xml' },
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!up) {
    notHere(`nothing answers at ${guardedUrl}`);
  }
  return { url: guardedUrl, ...guardedCredentials };
}

function clientFor(context: Context, url: string, credentials: Credentials): XmlaClient {
  return new XmlaClient({
    url,
    transport: new FetchTransport({ fetch: fetchWithDeadline(context.profile.timeoutMs ?? 30_000) }),
    models: context.models,
    credentials,
  });
}

export const authentication: readonly Check[] = [
  {
    id: 'A1',
    group: 'authentication',
    title: 'the rowsets a client probes with are served without credentials',
    level: 'must',
    spec: 'Observed: Excel and SSMS ask DISCOVER_PROPERTIES and DISCOVER_DATASOURCES before they authenticate',
    async run(context) {
      const { url } = await guarded(context);
      const anonymous = clientFor(context, url, { kind: 'none' });
      const result = await anonymous.discover('DISCOVER_DATASOURCES');
      return `${result.rows.length} row(s) without so much as a header`;
    },
  },
  {
    id: 'A2',
    group: 'authentication',
    title: 'a guarded rowset is refused without credentials, with a 401 that says how to ask',
    level: 'must',
    spec: 'RFC 9110 §11.6.1: a 401 carries WWW-Authenticate',
    async run(context) {
      const { url } = await guarded(context);
      const anonymous = clientFor(context, url, { kind: 'none' });
      try {
        await anonymous.discover('DBSCHEMA_CATALOGS');
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status !== 401) {
          // A fault would also be a refusal, but a client cannot log in from one.
          throw new Error(`refused with ${typeof status === 'number' ? status : (error as Error).name}, not 401`);
        }
        const challenge = (error as { challenge?: string | null }).challenge;
        if (challenge === null || challenge === undefined) {
          throw new Error('a 401 that carries no WWW-Authenticate');
        }
        return `HTTP 401, ${challenge}`;
      }
      throw new Error('the guarded endpoint served an anonymous request');
    },
  },
  {
    id: 'A3',
    group: 'authentication',
    title: 'Basic credentials get through',
    level: 'must',
    spec: 'RFC 7617: the Basic scheme',
    async run(context) {
      const { url, username, password } = await guarded(context);
      const authenticated = clientFor(context, url, { kind: 'basic', username, password });
      const result = await authenticated.discover('DBSCHEMA_CATALOGS');
      if (result.rows.length === 0) {
        throw new Error('authenticated but no rows');
      }
      return `${result.rows.length} row(s) as ${username}`;
    },
  },
  {
    id: 'A4',
    group: 'authentication',
    title: 'the wrong password does not',
    level: 'must',
    spec: 'RFC 7617: the Basic scheme',
    async run(context) {
      const { url, username } = await guarded(context);
      const wrong = clientFor(context, url, { kind: 'basic', username, password: 'not it' });
      try {
        await wrong.discover('DBSCHEMA_CATALOGS');
      } catch (error) {
        return `refused: ${short(error instanceof Error ? error.message : String(error), 80)}`;
      }
      throw new Error('the wrong password was accepted');
    },
  },
  {
    id: 'A5',
    group: 'authentication',
    title: 'a session survives authentication',
    level: 'must',
    spec: 'XMLA 1.1, "Support for Statefulness in XML for Analysis", over an authenticated connection',
    async run(context) {
      const { url, username, password } = await guarded(context);
      const authenticated = clientFor(context, url, { kind: 'basic', username, password });
      const opened = await authenticated.beginSession();
      if (opened.sessionId === null) {
        throw new Error('no session opened on the guarded endpoint');
      }
      const rows = await opened.discover('DBSCHEMA_CATALOGS');
      await opened.endSession();
      return `session ${opened.sessionId}, ${rows.rows.length} row(s) inside it`;
    },
  },
];
