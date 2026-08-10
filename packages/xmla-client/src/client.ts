/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlReader, EventKind, Unknown } from '@daanse/emf-xml';
import { failIfFault, SoapEnvelopeCodec, writeDiscover, writeExecute } from '@daanse/xmla-io';
import type { RestrictionEntry } from '@daanse/xmla-io';
import { RowsetCatalog, XMLA_NAMESPACES } from '@daanse/xmla-model';
import type { XmlaModels } from '@daanse/xmla-model';
import type { EClass, EObject } from '@emfts/core';

import { SessionHeaders, sessionIdOf } from './session.js';
import { XmlaHttpError } from './transport.js';
import type { Transport, XmlaHttpResponse } from './transport.js';

/** How to prove who is calling. */
export type Credentials =
  | { readonly kind: 'none' }
  | { readonly kind: 'basic'; readonly username: string; readonly password: string }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'header'; readonly headers: Readonly<Record<string, string>> };

export interface XmlaClientOptions {
  readonly url: string;
  readonly transport: Transport;
  readonly models: XmlaModels;
  readonly credentials?: Credentials;
  /** Extra headers on every request - a proxy token, a correlation id. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly sessionId?: string | null;
  /** Header blocks to send on every request besides the session ones. */
  readonly extraSoapHeaders?: readonly EObject[];
}

export interface DiscoverResult<T = EObject> {
  readonly requestType: string;
  readonly rows: readonly T[];
  /** The inline schema the response carried, unparsed. The dynamic path uses it. */
  readonly inlineSchema: string | null;
}

/**
 * Talks to one XMLA endpoint.
 *
 * Immutable. `withSession` and the rest return a new client rather than
 * mutating this one, so a session cannot be opened underneath a caller that is
 * midway through using the sessionless one.
 */
export class XmlaClient {
  private readonly options: XmlaClientOptions;
  private readonly codec: SoapEnvelopeCodec;
  private readonly catalog: RowsetCatalog;
  private readonly sessions: SessionHeaders;
  private readonly reader = new EcoreXmlReader({ unknown: Unknown.FAIL });

  constructor(options: XmlaClientOptions) {
    this.options = options;
    this.codec = new SoapEnvelopeCodec(options.models);
    this.catalog = new RowsetCatalog(options.models);
    this.sessions = new SessionHeaders(options.models);
  }

  get sessionId(): string | null {
    return this.options.sessionId ?? null;
  }

  get rowsets(): RowsetCatalog {
    return this.catalog;
  }

  withSession(sessionId: string | null): XmlaClient {
    return new XmlaClient({ ...this.options, sessionId });
  }

  withCredentials(credentials: Credentials): XmlaClient {
    return new XmlaClient({ ...this.options, credentials });
  }

  /** Opens a session and returns a client that carries it. */
  async beginSession(): Promise<XmlaClient> {
    const body = this.codec.write([this.sessions.beginSession()], (out) => {
      writeExecute(out, { command: null });
    });
    const response = await this.post(body, XMLA_NAMESPACES.SOAP_ACTION_EXECUTE);

    const sessionId = sessionIdOf(response.body);
    if (sessionId === null) {
      throw new Error('the server opened no session: its response carried no <Session SessionId>');
    }
    return this.withSession(sessionId);
  }

  /** Closes the session this client carries, and returns one without it. */
  async endSession(): Promise<XmlaClient> {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return this;
    }
    const body = this.codec.write([this.sessions.endSession(sessionId)], (out) => {
      writeExecute(out, { command: null });
    });
    await this.post(body, XMLA_NAMESPACES.SOAP_ACTION_EXECUTE);
    return this.withSession(null);
  }

  /**
   * A Discover, with the rows read into the EClass the model names for it.
   *
   * `rowClass` overrides that lookup, which is how the dynamic path reads a
   * rowset this model never described.
   */
  async discover(
    requestType: string,
    restrictions: readonly RestrictionEntry[] = [],
    properties: EObject | null = null,
    rowClass?: EClass,
  ): Promise<DiscoverResult> {
    const body = this.codec.write(this.soapHeaders(), (out) => {
      writeDiscover(out, { requestType, restrictions, properties });
    });
    const response = await this.post(body, XMLA_NAMESPACES.SOAP_ACTION_DISCOVER);

    const target = rowClass ?? this.catalog.forRequestType(requestType);
    if (target === null || target === undefined) {
      throw new Error(
        `no row class for ${requestType}. Pass one, or build it from the response's inline schema.`,
      );
    }
    return { requestType, ...this.readRoot(response.body, target) };
  }

  /**
   * A Discover whose response comes back unread.
   *
   * For a rowset the model does not describe: the schema needed to build a
   * class for it travels in the response, so the body is handed over whole and
   * `readRows` is called again once there is something to read it with. One
   * round trip, not two.
   */
  async discoverRaw(
    requestType: string,
    restrictions: readonly RestrictionEntry[] = [],
    properties: EObject | null = null,
  ): Promise<string> {
    const body = this.codec.write(this.soapHeaders(), (out) => {
      writeDiscover(out, { requestType, restrictions, properties });
    });
    return (await this.post(body, XMLA_NAMESPACES.SOAP_ACTION_DISCOVER)).body;
  }

  /** The rows and the inline schema of a response already fetched. */
  readRows(xml: string, rowClass: EClass): { rows: EObject[]; inlineSchema: string | null } {
    return this.readRoot(xml, rowClass);
  }

  /** The inline schema of a response, without reading a single row. */
  schemaOf(xml: string): string | null {
    return this.readRoot(xml, null).inlineSchema;
  }

  /** An Execute, with the response body handed back unparsed. */
  async execute(command: EObject | null, properties: EObject | null = null): Promise<string> {
    const body = this.codec.write(this.soapHeaders(), (out) => {
      writeExecute(out, { command, properties });
    });
    const response = await this.post(body, XMLA_NAMESPACES.SOAP_ACTION_EXECUTE);
    return response.body;
  }

  /**
   * The header blocks every request carries.
   *
   * Setting one does not displace the others. The Java client replaces the
   * header list wholesale when it sets a session, which drops a
   * ProtocolCapabilities block a caller had asked for; that is not carried over.
   */
  private soapHeaders(): EObject[] {
    const headers = [...(this.options.extraSoapHeaders ?? [])];
    const sessionId = this.sessionId;
    if (sessionId !== null) {
      headers.push(this.sessions.session(sessionId));
    }
    return headers;
  }

  private async post(body: string, soapAction: string): Promise<XmlaHttpResponse> {
    const response = await this.options.transport.send({
      url: this.options.url,
      body,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        // Quoted. Every recorded ADOMD.NET request quotes it, and RFC 2616's
        // SOAPAction is a quoted-string; a bare value is refused by some
        // gateways and silently ignored by others.
        SOAPAction: `"${soapAction}"`,
        ...authHeaders(this.options.credentials ?? { kind: 'none' }),
        ...(this.options.headers ?? {}),
      },
    });

    if (response.status >= 400) {
      // A fault often arrives with a 500, and its text says far more than the
      // status does - so it is preferred where there is one.
      failIfFault(response.body);
      throw new XmlaHttpError(response.status, response.body);
    }
    // Before parsing, not after: a fault has no <root> and the parse error it
    // would cause would replace the server's own explanation with ours.
    failIfFault(response.body);
    return response;
  }

  /**
   * Reads `<root>`: its rows, and the inline schema it carried.
   *
   * A null `rowClass` means the caller wants the schema and nothing else, which
   * is the first half of reading a rowset the model has never seen.
   */
  private readRoot(xml: string, rowClass: EClass | null): { rows: EObject[]; inlineSchema: string | null } {
    const envelope = this.codec.read(xml);
    const cursor = envelope.cursor;
    const rows: EObject[] = [];
    let inlineSchema: string | null = null;

    // Descend to <root>, which sits inside <DiscoverResponse><return>.
    let kind: number | null = cursor.kind;
    while (kind !== null && cursor.localName !== 'root') {
      kind = cursor.next();
    }
    if (kind === null) {
      return { rows, inlineSchema };
    }

    let depth = 0;
    kind = cursor.next();
    while (kind !== null) {
      if (kind === EventKind.START) {
        if (depth === 0 && cursor.localName === 'row') {
          if (rowClass === null) {
            cursor.skipSubtree();
          } else {
            rows.push(this.reader.read(cursor, rowClass));
          }
        } else if (depth === 0 && cursor.namespaceURI === XMLA_NAMESPACES.XSD) {
          // Kept rather than skipped: it is what the dynamic path builds an
          // EClass from, and asking for it twice would mean a second request.
          // The element itself, not just its children: a rebuilt start tag
          // would drop the targetNamespace and the sql prefix the schema
          // declares on itself, and a schema without those describes something
          // else.
          inlineSchema = cursor.rawElement();
        } else {
          depth += 1;
        }
      } else if (kind === EventKind.END) {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      kind = cursor.next();
    }
    return { rows, inlineSchema };
  }
}

function authHeaders(credentials: Credentials): Record<string, string> {
  switch (credentials.kind) {
    case 'basic':
      // Sent up front rather than after a 401. XMLA servers commonly answer the
      // challenge with a fault instead of a WWW-Authenticate, so waiting to be
      // asked means never being asked.
      return { Authorization: `Basic ${base64(`${credentials.username}:${credentials.password}`)}` };
    case 'bearer':
      return { Authorization: `Bearer ${credentials.token}` };
    case 'header':
      return { ...credentials.headers };
    case 'none':
      return {};
  }
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}
