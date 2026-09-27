/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EventKind, XmlCursor } from '@eclipse-daanse/emf-xml';

/** A refusal the server sent, raised as one. */
export class XmlaFaultError extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[]) {
    super(message);
    this.name = 'XmlaFaultError';
    this.details = details;
  }
}

/**
 * Throws when the response carries a SOAP fault, and returns silently otherwise.
 *
 * The details are the `faultstring` and any `Description` attributes of the
 * fault's error details, in document order. The children of a SOAP 1.1 fault are
 * unqualified, and what a server actually says lives in the **attributes** of
 * `<EX:Error>` rather than in its text - so both are collected.
 */
export function failIfFault(xml: string): void {
  let details: string[] | null;
  try {
    details = faultDetails(xml);
  } catch {
    // Whether these bytes are a fault is all this decides. A message it cannot
    // parse is the codec's complaint to make when it reads the response, and
    // making it here would replace a precise error with a vague one.
    return;
  }
  if (details === null) {
    return;
  }
  throw new XmlaFaultError(
    details.length === 0
      ? 'the server answered a SOAP fault'
      : `the server answered a SOAP fault: ${details.join(' / ')}`,
    details,
  );
}

/** The fault's details, or null when the response carries no fault. */
function faultDetails(xml: string): string[] | null {
  const cursor = XmlCursor.parse(xml);
  let inFault = false;
  const details: string[] = [];

  let kind = cursor.next();
  while (kind !== null) {
    if (kind !== EventKind.START) {
      kind = cursor.next();
      continue;
    }
    const name = cursor.localName;
    if (name === 'Fault') {
      inFault = true;
    } else if (inFault && name === 'faultstring') {
      const text = cursor.elementText().trim();
      if (text !== '') {
        details.push(text);
      }
    } else if (inFault) {
      for (const attribute of cursor.attributes) {
        if (attribute.localName === 'Description' && attribute.value !== '') {
          details.push(attribute.value);
        }
      }
    }
    kind = cursor.next();
  }
  return inFault ? details : null;
}
