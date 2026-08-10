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
 * Talking to an XMLA server.
 *
 * The client is immutable: opening a session gives back a new one rather than
 * changing this one underneath a caller already using it.
 */
export { XmlaClient } from './client.js';
export type { Credentials, DiscoverResult, XmlaClientOptions } from './client.js';
export { SessionHeaders, sessionIdOf } from './session.js';
export { FetchTransport, XmlaHttpError } from './transport.js';
export type { FetchTransportOptions, Transport, XmlaHttpRequest, XmlaHttpResponse } from './transport.js';
