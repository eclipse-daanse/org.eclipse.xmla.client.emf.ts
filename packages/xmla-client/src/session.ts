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
import { XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import type { XmlaModels } from '@eclipse-daanse/xmla-model';
import type { EClass, EObject } from '@emfts/core';

/**
 * Building the header blocks that open, carry and close a session.
 *
 * The three are separate blocks, not one with a mode. A request that opens a
 * session carries `<BeginSession/>`; every later one carries
 * `<Session SessionId="..."/>`; the last carries `<EndSession SessionId="..."/>`.
 * The server answers the first with a `<Session>` header holding the id.
 */
export class SessionHeaders {
  private readonly soap: EPackageLike;

  constructor(models: XmlaModels) {
    const soap = models.named('soap');
    if (soap === null) {
      throw new Error('the soap model is not loaded');
    }
    this.soap = soap as unknown as EPackageLike;
  }

  beginSession(): EObject {
    return this.create('BeginSessionHeader');
  }

  session(sessionId: string): EObject {
    const header = this.create('SessionHeader');
    header.eSet(header.eClass().getEStructuralFeature('sessionId')!, sessionId);
    return header;
  }

  endSession(sessionId: string): EObject {
    const header = this.create('EndSessionHeader');
    header.eSet(header.eClass().getEStructuralFeature('sessionId')!, sessionId);
    return header;
  }

  private create(className: string): EObject {
    const eClass = this.soap.getEClassifier(className) as EClass | null;
    if (eClass === null || eClass === undefined) {
      throw new Error(`the soap model has no ${className}`);
    }
    return this.soap.getEFactoryInstance().create(eClass);
  }
}

interface EPackageLike {
  getEClassifier(name: string): unknown;
  getEFactoryInstance(): { create(eClass: EClass): EObject };
}

/**
 * The session id a response carries, or null.
 *
 * Read off the wire rather than from a parsed envelope because it has to work
 * on a response whose body is a fault, and on one whose body has not been
 * looked at yet.
 */
export function sessionIdOf(xml: string): string | null {
  const cursor = XmlCursor.parse(xml);
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START && cursor.localName === 'Session') {
      for (const attribute of cursor.attributes) {
        if (attribute.localName === 'SessionId') {
          return attribute.value;
        }
      }
      // Some servers put the id in the element's text rather than an attribute.
      const text = cursor.elementText().trim();
      return text === '' ? null : text;
    }
    if (kind === EventKind.START && cursor.namespaceURI === XMLA_NAMESPACES.SOAP_ENV && cursor.localName === 'Body') {
      // Headers come before the body; past it there is nothing to find.
      return null;
    }
    kind = cursor.next();
  }
  return null;
}
