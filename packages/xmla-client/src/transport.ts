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
 * How a message gets to a server and back.
 *
 * An interface rather than a fetch call inline, for three reasons that all
 * turned up before this was written: the tests replay recorded conversations
 * through it, the browser and Node differ in what headers they will let a
 * caller set, and a proxy in front of the server is a deployment detail rather
 * than a protocol one.
 */
export interface XmlaHttpRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface XmlaHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Transport {
  send(request: XmlaHttpRequest): Promise<XmlaHttpResponse>;
}

/** A server that answered, but not with success. */
export class XmlaHttpError extends Error {
  readonly status: number;
  readonly body: string;
  /**
   * The response headers.
   *
   * Carried because a 401 is not only a refusal: `WWW-Authenticate` says which
   * mechanisms the server will accept, and a caller that has to log in cannot
   * do it without that. Dropping them turns "you may authenticate with Basic"
   * into "no".
   */
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, body: string, headers: Readonly<Record<string, string>> = {}) {
    super(`the server answered HTTP ${status}`);
    this.name = 'XmlaHttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  /** What the server said it would accept, or null when it said nothing. */
  get challenge(): string | null {
    for (const [name, value] of Object.entries(this.headers)) {
      if (name.toLowerCase() === 'www-authenticate') {
        return value;
      }
    }
    return null;
  }
}

export interface FetchTransportOptions {
  /**
   * Whether to send credentials the browser already holds - cookies, or a
   * negotiated session. Off by default, because turning it on without the
   * server also naming an origin makes every request fail CORS rather than
   * silently succeed, and that is not a default to choose for someone.
   */
  readonly withCredentials?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The ordinary transport, over `fetch`.
 *
 * **A note for the browser.** `User-Agent` is a forbidden header name there, and
 * a `fetch` that sets one has the value dropped rather than honoured. Some
 * servers log it and a few key off it. That is not worked around here - it is
 * stated, because a client that appeared to set it and did not would be worse
 * than one that never claimed to. In Node the header is settable and is sent.
 */
export class FetchTransport implements Transport {
  private readonly withCredentials: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FetchTransportOptions = {}) {
    this.withCredentials = options.withCredentials ?? false;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(request: XmlaHttpRequest): Promise<XmlaHttpResponse> {
    const response = await this.fetchImpl(request.url, {
      method: 'POST',
      body: request.body,
      headers: { ...request.headers },
      credentials: this.withCredentials ? 'include' : 'same-origin',
    });

    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    return { status: response.status, body, headers };
  }
}
