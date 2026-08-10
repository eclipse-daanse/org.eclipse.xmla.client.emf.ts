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
 * The XMLA message layer: the SOAP envelope, the two requests, and faults.
 *
 * Everything below this knows only Ecore and XML; everything above it knows only
 * requests and rows. This is where the two meet.
 */
export { SoapEnvelopeCodec } from './envelope.js';
export type { Envelope, QualifiedName } from './envelope.js';
export { failIfFault, XmlaFaultError } from './fault.js';
export { RequestReader } from './read-requests.js';
export type { ReadDiscover, ReadExecute } from './read-requests.js';
export { writeDiscover, writeExecute } from './requests.js';
export type { DiscoverRequest, ExecuteRequest, RestrictionEntry } from './requests.js';
