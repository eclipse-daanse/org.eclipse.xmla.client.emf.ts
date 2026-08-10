/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import {
  EcoreXmlReader,
  EcoreXmlWriter,
  EventKind,
  Unknown,
  wireNameOfType,
  XmlCodecError,
  XmlCursor,
  XmlWriter,
} from '@daanse/emf-xml';
import { XMLA_NAMESPACES } from '@daanse/xmla-model';
import type { XmlaModels } from '@daanse/xmla-model';
import { EMD_ANNOTATION_URI } from '@emfts/core';
import type { EClass, EObject, EPackage } from '@emfts/core';

/**
 * The header blocks a real client sends, by local name.
 *
 * By local name rather than qualified name on purpose: these seven sit in five
 * different namespaces and no two share a local name, so the namespace adds
 * nothing to the lookup while making it fail on a client that binds a different
 * one for the same block. The recorded conversations show exactly that -
 * `Version` appears in two namespaces and `BeginGetSessionToken` in none.
 */
const HEADER_CLASSES: Readonly<Record<string, string>> = {
  Session: 'SessionHeader',
  BeginSession: 'BeginSessionHeader',
  EndSession: 'EndSessionHeader',
  ProtocolCapabilities: 'ProtocolCapabilitiesHeader',
  /** Sent by SQL Server Management Studio. */
  Version: 'VersionHeader',
  NamespaceCompatibility: 'NamespaceCompatibilityHeader',
  /** Sent by Excel's MSOLAP provider, and by no other known client. */
  BeginGetSessionToken: 'BeginGetSessionTokenHeader',
};

export interface QualifiedName {
  readonly namespaceURI: string;
  readonly localName: string;
}

/**
 * What was read, plus the live cursor.
 *
 * The body is deliberately not materialised. The cursor is handed back still
 * positioned on the body's first element so a caller can dispatch on its name
 * and keep reading - a response carrying a million rows is never held as a
 * document.
 */
export interface Envelope {
  readonly headers: readonly EObject[];
  readonly bodyElement: QualifiedName | null;
  readonly cursor: XmlCursor;
}

export class SoapEnvelopeCodec {
  private readonly soap: EPackage;
  private readonly headerTypes: Map<string, EClass>;
  private readonly reader: EcoreXmlReader;

  constructor(models: XmlaModels) {
    const soap = models.named('soap');
    if (soap === null) {
      throw new Error('the soap model is not loaded');
    }
    this.soap = soap;
    this.headerTypes = new Map();
    for (const [wireName, className] of Object.entries(HEADER_CLASSES)) {
      const eClass = soap.getEClassifier(className) as EClass | null;
      if (eClass === null || eClass === undefined) {
        throw new Error(`the soap model has no ${className} for header <${wireName}>`);
      }
      this.headerTypes.set(wireName, eClass);
    }
    // A header block may carry a namespace this implementation does not model,
    // so an unrecognised child of one is skipped rather than refused.
    this.reader = new EcoreXmlReader({ unknown: Unknown.SKIP });
  }

  /** Reads an envelope up to the first child of the body, and no further. */
  read(xml: string): Envelope {
    const cursor = XmlCursor.parse(xml);
    const headers: EObject[] = [];

    let kind = cursor.next();
    while (kind !== null) {
      if (kind !== EventKind.START) {
        kind = cursor.next();
        continue;
      }
      const name = cursor.localName;
      const namespace = cursor.namespaceURI;

      if (namespace === XMLA_NAMESPACES.SOAP_ENV) {
        if (name === 'Envelope' || name === 'Header') {
          kind = cursor.next();
          continue; // descend
        }
        if (name === 'Body') {
          return { headers, bodyElement: firstBodyElement(cursor), cursor };
        }
        kind = cursor.next();
        continue;
      }

      const headerType = this.headerTypes.get(name);
      if (headerType !== undefined) {
        headers.push(this.reader.read(cursor, headerType));
      } else {
        // A header this implementation has no model for is still read, not
        // skipped. SOAP 1.1 requires a receiver that does not understand a block
        // carrying mustUnderstand="1" to answer a MustUnderstand fault, which it
        // cannot do about a block it threw away.
        headers.push(this.readUnknownHeader(cursor, namespace, name));
      }
      kind = cursor.next();
    }
    throw new XmlCodecError('no <soap:Body> in the message');
  }

  private readUnknownHeader(cursor: XmlCursor, namespace: string, localName: string): EObject {
    const eClass = this.soap.getEClassifier('UnknownHeader') as EClass | null;
    if (eClass === null || eClass === undefined) {
      throw new Error('the soap model has no UnknownHeader');
    }
    const header = this.soap.getEFactoryInstance().create(eClass);
    header.eSet(eClass.getEStructuralFeature('namespaceUri')!, namespace);
    header.eSet(eClass.getEStructuralFeature('localName')!, localName);
    header.eSet(eClass.getEStructuralFeature('mustUnderstand')!, mustUnderstand(cursor));
    header.eSet(eClass.getEStructuralFeature('raw')!, cursor.rawSubtree());
    return header;
  }

  /**
   * Writes an envelope whose body is produced by a callback.
   *
   * A callback rather than an object so a response can be streamed: a Discover
   * over MDSCHEMA_MEMBERS may run to hundreds of thousands of rows.
   */
  write(headers: readonly EObject[], body: (out: XmlWriter) => void): string {
    const out = new XmlWriter();
    out.writeDeclaration();
    out.writeStartElement(XMLA_NAMESPACES.SOAP_ENV, 'Envelope', XMLA_NAMESPACES.SOAP_ENV_PREFIX);

    out.writeStartElement(XMLA_NAMESPACES.SOAP_ENV, 'Header');
    for (const header of headers) {
      // Not every header is in the XMLA namespace: ProtocolCapabilities belongs
      // to the engine namespace, and a client looks for it there.
      new EcoreXmlWriter(namespaceOf(header)).write(out, header, wireNameOfType(header.eClass()));
    }
    out.writeEndElement();

    out.writeStartElement(XMLA_NAMESPACES.SOAP_ENV, 'Body');
    body(out);
    out.writeEndElement();

    out.writeEndElement();
    return out.toString();
  }
}

/**
 * The namespace a header block belongs to: what the model states, or the XMLA
 * namespace when it states nothing.
 *
 * Read off the annotation rather than through `getNamespace`, which falls back
 * to the EPackage's own nsURI. That fallback is wrong here - the soap package's
 * nsURI is the SOAP envelope namespace, so `<Session>`, which belongs to the
 * XMLA namespace, would go out as `<soap:Session>`.
 */
function namespaceOf(header: EObject): string {
  const annotation = header.eClass().getEAnnotation(EMD_ANNOTATION_URI);
  const namespace = annotation === null || annotation === undefined
    ? null
    : (annotation.getDetails().getByKey('namespace') ?? null);
  if (namespace === null || namespace === '' || namespace === '##targetNamespace') {
    return XMLA_NAMESPACES.XMLA;
  }
  return namespace;
}

/** `soap:mustUnderstand`, in any of xsd:boolean's four lexical forms. */
function mustUnderstand(cursor: XmlCursor): boolean {
  for (const attribute of cursor.attributes) {
    if (attribute.localName === 'mustUnderstand' && attribute.namespaceURI === XMLA_NAMESPACES.SOAP_ENV) {
      const value = attribute.value.trim();
      return value === '1' || value === 'true';
    }
  }
  return false;
}

function firstBodyElement(cursor: XmlCursor): QualifiedName | null {
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START) {
      return { namespaceURI: cursor.namespaceURI, localName: cursor.localName };
    }
    if (kind === EventKind.END) {
      return null; // an empty body is legal, if useless
    }
    kind = cursor.next();
  }
  return null;
}
