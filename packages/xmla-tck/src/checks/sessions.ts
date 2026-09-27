/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { XmlaClient } from '@eclipse-daanse/xmla-client';
import { XmlaFaultError } from '@eclipse-daanse/xmla-io';

import { short } from '../kit.js';
import type { Check, Context } from '../kit.js';
import { executeRaw } from '../mdx.js';

/**
 * Sessions: the optional part of XMLA 1.1 that every Analysis Services client
 * uses, so a server this client talks to has to have it.
 */
function opened(context: Context): Promise<XmlaClient> {
  return context.memo('session', async () => {
    const { client } = await context.connected();
    return client.beginSession();
  });
}

export const sessions: readonly Check[] = [
  {
    id: 'S1',
    group: 'sessions',
    title: 'BeginSession answers a Session header carrying an id',
    level: 'must',
    spec: 'XMLA 1.1, "Support for Statefulness in XML for Analysis"; [MS-SSAS] 2.2.3.1 BeginSession, 2.2.3.3 Session',
    async run(context) {
      const inSession = await opened(context);
      if (inSession.sessionId === null) {
        throw new Error('no session id came back');
      }
      return `session ${inSession.sessionId}`;
    },
  },
  {
    id: 'S2',
    group: 'sessions',
    title: 'a Discover inside the session is answered',
    level: 'must',
    spec: '[MS-SSAS] 2.2.3.3: the Session header names the session a request belongs to',
    async run(context) {
      const inSession = await opened(context);
      const result = await inSession.discover('DISCOVER_DATASOURCES');
      if (result.rows.length === 0) {
        throw new Error('the request inside the session answered nothing');
      }
      return `${result.rows.length} row(s)`;
    },
  },
  {
    id: 'S4',
    group: 'sessions',
    title: 'a request carrying a session id the server never issued is refused with a fault',
    level: 'should',
    spec: '[MS-SSAS] 2.2.3.3 Session: the SessionId names an existing session; an unknown one is an error',
    async run(context) {
      const { client } = await context.connected();
      const stranger = client.withSession('00000000-0000-4000-8000-00000000c0de');
      try {
        await stranger.discover('DISCOVER_DATASOURCES');
      } catch (error) {
        if (error instanceof XmlaFaultError) {
          return `fault: ${short(error.message.replace(/^the server answered a SOAP fault: /, ''), 100)}`;
        }
        throw new Error(`refused, but not with a fault: ${short(error instanceof Error ? error.message : String(error), 100)}`);
      }
      throw new Error('answered as if the session existed');
    },
  },
  {
    id: 'S5',
    group: 'sessions',
    title: 'a session that was ended is gone: its id is refused afterwards',
    level: 'should',
    spec: '[MS-SSAS] 2.2.3.2 EndSession: the session and its state are released',
    async run(context) {
      const { client } = await context.connected();
      const opened = await client.beginSession();
      const id = opened.sessionId!;
      await opened.endSession();
      try {
        await client.withSession(id).discover('DISCOVER_DATASOURCES');
      } catch (error) {
        if (error instanceof XmlaFaultError) {
          return `${id} refused after EndSession: ${short(error.message.replace(/^the server answered a SOAP fault: /, ''), 80)}`;
        }
        throw new Error(`refused, but not with a fault: ${short(error instanceof Error ? error.message : String(error), 100)}`);
      }
      throw new Error(`${id} still answers after EndSession`);
    },
  },
  {
    id: 'S6',
    group: 'sessions',
    title: 'a statement inside a session, with the Catalog property, answers a dataset',
    level: 'must',
    spec: '[MS-SSAS] 2.2.3.3 Session with 2.2.4.2 Execute: the shape every Analysis Services client uses for a query',
    async run(context) {
      const { catalog, cube } = await context.target();
      const inSession = await opened(context);
      const answer = await executeRaw(context, catalog, `SELECT [Measures].Members ON COLUMNS FROM [${cube}]`, {
        client: inSession,
      });
      if (answer.readError !== null || (answer.cellset?.cells.length ?? 0) === 0) {
        throw new Error(answer.readError ?? 'no cells');
      }
      return `session ${inSession.sessionId}: ${answer.cellset!.cells.length} cell(s)`;
    },
  },
  {
    id: 'S3',
    group: 'sessions',
    title: 'EndSession is accepted, and the client lets the id go',
    level: 'must',
    spec: '[MS-SSAS] 2.2.3.2 EndSession',
    async run(context) {
      const inSession = await opened(context);
      const closed = await inSession.endSession();
      if (closed.sessionId !== null) {
        throw new Error('the session was not let go of');
      }
      return `closed ${inSession.sessionId}`;
    },
  },
];
