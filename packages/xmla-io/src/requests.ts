/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlWriter, wireNameOfType, XmlWriter } from '@eclipse-daanse/emf-xml';
import { XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import type { EObject } from '@emfts/core';

/**
 * Writing the two requests XMLA has.
 *
 * There is nothing here per command or per rowset. A command is an EObject and
 * `EcoreXmlWriter` writes any of them from the model - which is the whole
 * difference between this and a client that needs a generated serializer for
 * each one.
 */

/** One entry of a `<RestrictionList>`: a wire name and its value. */
export interface RestrictionEntry {
  readonly name: string;
  readonly value: string | null;
}

export interface DiscoverRequest {
  readonly requestType: string;
  readonly restrictions?: readonly RestrictionEntry[];
  /** A `PropertyList` EObject, or null for the mandatory empty one. */
  readonly properties?: EObject | null;
}

export function writeDiscover(out: XmlWriter, request: DiscoverRequest): void {
  // setDefaultNamespace has to precede writeStartElement: the prefix for the
  // element is resolved when the element is written, not when the declaration
  // that follows it is.
  out.setDefaultNamespace(XMLA_NAMESPACES.XMLA);
  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'Discover');
  out.writeDefaultNamespace(XMLA_NAMESPACES.XMLA);

  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'RequestType');
  out.writeCharacters(request.requestType);
  out.writeEndElement();

  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'Restrictions');
  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'RestrictionList');
  for (const entry of request.restrictions ?? []) {
    out.writeStartElement(XMLA_NAMESPACES.XMLA, entry.name);
    if (entry.value !== null && entry.value !== undefined) {
      out.writeCharacters(entry.value);
    }
    out.writeEndElement();
  }
  out.writeEndElement();
  out.writeEndElement();

  writeProperties(out, request.properties ?? null);
  out.writeEndElement();
}

export interface ExecuteRequest {
  /** The command as an EObject - a `Statement`, an `Alter`, whatever the model has. */
  readonly command: EObject | null;
  readonly properties?: EObject | null;
}

export function writeExecute(out: XmlWriter, request: ExecuteRequest): void {
  out.setDefaultNamespace(XMLA_NAMESPACES.XMLA);
  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'Execute');
  out.writeDefaultNamespace(XMLA_NAMESPACES.XMLA);

  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'Command');
  if (request.command !== null && request.command !== undefined) {
    // The element is the command's own name - <Statement>, <Alter> - not the
    // feature's, because that is what a server dispatches on.
    new EcoreXmlWriter(XMLA_NAMESPACES.XMLA).write(
      out,
      request.command,
      wireNameOfType(request.command.eClass()),
    );
  }
  out.writeEndElement();

  writeProperties(out, request.properties ?? null);
  out.writeEndElement();
}

/**
 * `<Properties>` with its `<PropertyList>`, which is mandatory even when empty.
 *
 * Leaving the empty one out does not make msmdsrv fall back to its defaults; it
 * makes it reject the request.
 */
function writeProperties(out: XmlWriter, properties: EObject | null): void {
  out.writeStartElement(XMLA_NAMESPACES.XMLA, 'Properties');
  if (properties === null) {
    out.writeEmptyElement(XMLA_NAMESPACES.XMLA, 'PropertyList');
  } else {
    new EcoreXmlWriter(XMLA_NAMESPACES.XMLA).write(out, properties, 'PropertyList');
  }
  out.writeEndElement();
}
