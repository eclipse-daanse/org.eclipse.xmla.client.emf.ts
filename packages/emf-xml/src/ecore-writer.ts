/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { EObject, EStructuralFeature } from '@emfts/core';

import {
  elementNameFrom,
  groupElementNameOf,
  isAttribute,
  isSimpleContent,
  rawNamespaceOf,
  wireNameOf,
  wrapperNameOf,
} from './emd.js';
import { formatValue } from './values.js';
import { XmlWriter } from './writer.js';

/**
 * Writes an EObject as XML, driven entirely by its ExtendedMetaData.
 *
 * Two behaviours of the wire format fall out of this rather than being special
 * cases:
 *
 * - a feature that is **not set** produces no element at all, which is how a
 *   NULL column is written;
 * - a feature set to the **empty string** produces `<DESCRIPTION/>`, which
 *   clients read as different from NULL.
 *
 * That distinction is why the writer asks `eIsSet` before it ever touches
 * `eGet`. Reading a many-valued feature materialises its list and makes it count
 * as set from then on, so the other order would have a freshly built row emit
 * every collection wrapper it has.
 */
export class EcoreXmlWriter {
  private readonly namespace: string;

  /**
   * @param namespace the namespace this object's elements belong to, used where
   *                  the model says `##targetNamespace`
   */
  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /** Writes `object` as an element named `elementName`. */
  write(out: XmlWriter, object: EObject, elementName: string): void {
    const declare = out.getPrefix(this.namespace) === null;
    if (declare) {
      // Nothing has bound this namespace yet - usually because this is the
      // outermost element the caller writes. Make it the default, as a live
      // server does.
      out.setDefaultNamespace(this.namespace);
    }
    out.writeStartElement(this.namespace, elementName);
    if (declare) {
      out.writeDefaultNamespace(this.namespace);
    }
    this.writeContent(out, object);
    out.writeEndElement();
  }

  /** Writes only the children, for a caller that already opened the element. */
  writeContent(out: XmlWriter, object: EObject): void {
    this.writeAttributes(out, object);
    this.writeSimpleContent(out, object);
    this.writeElements(out, object);
  }

  private writeAttributes(out: XmlWriter, object: EObject): void {
    for (const feature of allFeatures(object)) {
      if (!isAttribute(feature) || !object.eIsSet(feature) || isElementName(feature)) {
        continue;
      }
      const text = formatValue(feature, object.eGet(feature));
      if (text === null) {
        continue;
      }
      // An attribute is unqualified unless the model says otherwise - the XSD
      // default, and right for the rowset columns. The exception is
      // soap:mustUnderstand, which SOAP 1.1 requires qualified; written bare,
      // the receiver does not see it at all.
      const namespace = rawNamespaceOf(feature);
      if (namespace === null) {
        out.writeAttribute(wireNameOf(feature), text);
      } else {
        out.writeQualifiedAttribute(namespace, wireNameOf(feature), text);
      }
    }
  }

  /**
   * The element's own text - `<Value xsi:type="xsd:int">42</Value>`.
   *
   * Written before any child element, so reader and writer agree on the order of
   * mixed content.
   */
  private writeSimpleContent(out: XmlWriter, object: EObject): void {
    for (const feature of allFeatures(object)) {
      if (object.eIsSet(feature) && isSimpleContent(feature)) {
        const text = formatValue(feature, object.eGet(feature));
        if (text !== null) {
          out.writeCharacters(text);
        }
      }
    }
  }

  private writeElements(out: XmlWriter, object: EObject): void {
    for (const feature of allFeatures(object)) {
      if (isAttribute(feature) || !object.eIsSet(feature) || isSimpleContent(feature)) {
        continue;
      }
      const name = wireNameOf(feature);
      const value = object.eGet(feature);

      if (feature.isMany()) {
        const values = [...iterate(value as Iterable<unknown>)];
        // ASSL wraps its collections: <Annotations> holds the <Annotation>s. The
        // wrapper carries nothing itself, which is why the model flattens it to
        // a list, but it is on the wire.
        const wrapper = wrapperNameOf(feature);
        if (wrapper !== null && values.length > 0) {
          out.writeStartElement(this.namespace, wrapper);
        }
        for (const element of values) {
          this.writeOne(out, feature, name, element);
        }
        if (wrapper !== null && values.length > 0) {
          out.writeEndElement();
        }
      } else if (value !== null && value !== undefined) {
        this.writeOne(out, feature, name, value);
      }
    }
  }

  private writeOne(out: XmlWriter, feature: EStructuralFeature, name: string, value: unknown): void {
    const elementNamespace = rawNamespaceOf(feature);

    if (isEObject(value)) {
      const childName = elementNameOf(feature, value, name);
      if (elementNamespace === null) {
        this.write(out, value, childName);
      } else {
        // Reached across a namespace boundary - a WarningColumn stays in the
        // engine namespace wherever it appears.
        new EcoreXmlWriter(elementNamespace).write(out, value, childName);
      }
      return;
    }

    const text = formatValue(feature, value);
    if (text === null || text === '') {
      out.writeEmptyElement(this.namespace, name);
      return;
    }
    out.writeStartElement(this.namespace, name);
    if (isXmlDocument(feature)) {
      // The column holds a document, not a string. Escaping it would turn a
      // <Server> definition into the literal text "&lt;Server&gt;".
      out.writeFragment(text);
    } else {
      out.writeCharacters(text);
    }
    out.writeEndElement();
  }
}

/**
 * The element name a contained object takes.
 *
 * Two cases where the feature's own name is not it: the feature's type is
 * abstract, so the concrete alternative decides - an Axis holds a SetType and
 * what goes on the wire is `<Members>`, `<Tuples>`, `<CrossProduct>` or
 * `<Union>`; or the model says `elementNameFrom`, meaning the name is a value
 * the object carries rather than anything the schema fixes.
 */
function elementNameOf(feature: EStructuralFeature, value: EObject, declared: string): string {
  const eClass = value.eClass();
  const from = elementNameFrom(eClass);
  if (from !== null) {
    const naming = eClass.getEStructuralFeature(from);
    const name = naming === null || naming === undefined ? null : value.eGet(naming);
    if (name !== null && name !== undefined && String(name) !== '') {
      return String(name);
    }
  }
  if (feature.getEType() !== eClass) {
    // Inside a group the alternative's element name is not its type's name: the
    // SetType choice calls a SetListType a <CrossProduct>.
    return groupElementNameOf(eClass);
  }
  return declared;
}

/**
 * Whether this feature *is* the element's name, and so must not also be written
 * as an attribute.
 */
function isElementName(feature: EStructuralFeature): boolean {
  const owner = feature.getEContainingClass();
  if (owner === null || owner === undefined) {
    return false;
  }
  return elementNameFrom(owner) === feature.getName();
}

function isXmlDocument(feature: EStructuralFeature): boolean {
  return feature.getEType()?.getName() === 'XmlDocument';
}

function isEObject(value: unknown): value is EObject {
  return typeof (value as { eClass?: unknown })?.eClass === 'function';
}

function allFeatures(object: EObject): EStructuralFeature[] {
  return [...iterate(object.eClass().getEAllStructuralFeatures() as never)] as EStructuralFeature[];
}

/** EList here is index-based in some places and a plain array in others. */
function* iterate<T>(list: { size?(): number; get?(index: number): T; length?: number } | Iterable<T>): Generator<T> {
  const indexed = list as { size?(): number; get?(index: number): T; length?: number };
  if (typeof indexed.get === 'function') {
    const n = typeof indexed.size === 'function' ? indexed.size() : (indexed.length ?? 0);
    for (let i = 0; i < n; i++) {
      yield indexed.get(i)!;
    }
    return;
  }
  yield* list as Iterable<T>;
}
