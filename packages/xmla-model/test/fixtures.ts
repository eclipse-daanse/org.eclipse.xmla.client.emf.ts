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

/**
 * The recorded conversations, read straight from the testkit.
 *
 * Each manifest carries facts nobody here computed - the request type, the
 * headers, the restrictions and properties, and a row count per response. Those
 * are what the tests check against, which is why the fixtures are the gate for
 * this port rather than a convenience.
 */
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'testkit',
  'fixtures',
  'conversations',
);

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
      return { name: entry.name, directory, recording: manifest.recording, messages: withRequestTypes(manifest.messages) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return cached;
}

/**
 * Carries each request's type forward onto its response.
 *
 * A response says nothing about what was asked - it is a `<root>` full of rows -
 * so the only way to know which rowset it holds is the request before it. That
 * is also exactly how a client knows, which makes it fair rather than a
 * shortcut.
 */
function withRequestTypes(messages: readonly RecordedMessage[]): RecordedMessage[] {
  const carried: RecordedMessage[] = [];
  let pending: string | undefined;
  for (const message of messages) {
    if (message.direction === 'request') {
      pending = message.requestType;
      carried.push(message);
    } else {
      carried.push(pending === undefined ? message : { ...message, requestType: pending });
      pending = undefined;
    }
  }
  return carried;
}
