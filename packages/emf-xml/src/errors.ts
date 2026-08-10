/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/** Where in the document something went wrong. */
export interface XmlLocation {
  readonly line: number;
  readonly column: number;
}

/**
 * A message that could not be read or written.
 *
 * Always carries the position, because the alternative - "cannot read '' as a
 * boolean" against a 4 MB response - is not something anyone can act on.
 */
export class XmlCodecError extends Error {
  readonly location: XmlLocation | undefined;

  constructor(message: string, location?: XmlLocation, options?: { cause?: unknown }) {
    super(location ? `${message} (line ${location.line}, column ${location.column})` : message, options);
    this.name = 'XmlCodecError';
    this.location = location;
  }
}
