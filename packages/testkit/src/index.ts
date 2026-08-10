/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Transport, XmlaHttpRequest, XmlaHttpResponse } from '@daanse/xmla-client';

/**
 * The recorded conversations, and a transport that answers from them.
 *
 * Five captures of Excel, Power BI and SQL Server Management Studio talking to
 * SSAS 13. Each carries a manifest of facts nobody here computed - the request
 * type, the headers, the restrictions and properties, the row count per
 * response - which is what makes them a gate rather than a convenience.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conversations');

export interface RecordedMessage {
  readonly position: number;
  readonly file: string;
  readonly direction: 'request' | 'response';
  readonly bytes: number;
  readonly headers: readonly string[];
  readonly headerNamespaces: readonly string[];
  readonly requestType?: string;
  readonly restrictions?: Readonly<Record<string, string>>;
  readonly properties?: Readonly<Record<string, string>>;
  readonly bodyElement?: string;
  readonly rows?: number;
}

export interface Conversation {
  readonly name: string;
  readonly directory: string;
  readonly recording: string;
  readonly messages: readonly RecordedMessage[];
  text(file: string): string;
}

let cached: Conversation[] | null = null;

export function conversations(): Conversation[] {
  if (cached !== null) {
    return cached;
  }
  cached = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(FIXTURES, entry.name);
      const manifest = JSON.parse(readFileSync(join(directory, '_manifest.json'), 'utf8')) as {
        recording: string;
        messages: RecordedMessage[];
      };
      return {
        name: entry.name,
        directory,
        recording: manifest.recording,
        messages: manifest.messages,
        text: (file: string) => readFileSync(join(directory, file), 'utf8'),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return cached;
}

export function conversation(name: string): Conversation {
  const found = conversations().find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`no recorded conversation called ${name}`);
  }
  return found;
}

/** What the transport was asked to send, for a test to look at afterwards. */
export interface SentRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Answers from a recorded conversation, in order.
 *
 * Deliberately in order rather than by matching the request. Matching would let
 * a client that sends the wrong thing still get a plausible answer, which is
 * the opposite of what a replay is for. What the client sent is kept so a test
 * can compare it against what the real client sent at the same position.
 */
export class FixtureTransport implements Transport {
  readonly sent: SentRequest[] = [];
  private readonly responses: string[];
  private index = 0;

  constructor(responses: readonly string[]) {
    this.responses = [...responses];
  }

  /** Every response of a conversation, in recorded order. */
  static replaying(name: string): FixtureTransport {
    const each = conversation(name);
    return new FixtureTransport(
      each.messages.filter((message) => message.direction === 'response').map((message) => each.text(message.file)),
    );
  }

  /** One fixed response, for a test about a single exchange. */
  static answering(...responses: string[]): FixtureTransport {
    return new FixtureTransport(responses);
  }

  get remaining(): number {
    return this.responses.length - this.index;
  }

  send(request: XmlaHttpRequest): Promise<XmlaHttpResponse> {
    this.sent.push({ url: request.url, body: request.body, headers: { ...request.headers } });
    const body = this.responses[this.index];
    if (body === undefined) {
      return Promise.reject(
        new Error(`the recording has ${this.responses.length} responses and this is request ${this.index + 1}`),
      );
    }
    this.index += 1;
    return Promise.resolve({ status: 200, body, headers: { 'content-type': 'text/xml' } });
  }
}
