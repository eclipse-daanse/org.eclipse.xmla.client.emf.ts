/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EPackageRegistry } from '@emfts/core';
import type { EClass, EObject, EPackage, EReference, EStructuralFeature } from '@emfts/core';

import { EventKind, XmlCursor } from './cursor.js';
import {
  elementNameFrom,
  groupElementNameOf,
  isAttribute,
  isSimpleContent,
  isWildcard,
  rawNamespaceOf,
  wireNameOf,
  wrapperNameOf,
} from './emd.js';
import { XmlCodecError } from './errors.js';
import { parseValue } from './values.js';

/** The XSD namespace, which is never a feature of anything. */
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/** What to do with an element the target EClass has no feature for. */
export const Unknown = {
  /** Fail. The right default for a request: a typo must not be ignored. */
  FAIL: 'fail',
  /** Skip the subtree. */
  SKIP: 'skip',
} as const;

export type Unknown = (typeof Unknown)[keyof typeof Unknown];

export interface ReaderOptions {
  readonly unknown?: Unknown;
  /**
   * Where to look for group alternatives declared outside their own package.
   * Defaults to the global registry.
   */
  readonly registry?: Pick<EPackageRegistry, 'values'>;
}

/**
 * Reads one element subtree into an EObject, driven by ExtendedMetaData.
 *
 * A port of the Java `EcoreXmlReader`, clause for clause. Written rather than
 * derived from the library's `XMLHandler` because that one does not key feature
 * lookup on ExtendedMetaData - measured in M1, where it produced a row with its
 * scalar columns missing and reported no error at all.
 *
 * An element the model does not know is handled by an explicit policy, and a
 * value that will not parse throws with the element name and the position.
 */
export class EcoreXmlReader {
  private readonly unknown: Unknown;
  private readonly registry: Pick<EPackageRegistry, 'values'>;

  /** Feature lookup per EClass, built once per class and kept. */
  private readonly elements = new Map<EClass, Map<string, EStructuralFeature>>();
  private readonly attributes = new Map<EClass, Map<string, EStructuralFeature>>();
  private readonly simpleContent = new Map<EClass, EStructuralFeature | null>();

  constructor(options: ReaderOptions = {}) {
    this.unknown = options.unknown ?? Unknown.FAIL;
    this.registry = options.registry ?? EPackageRegistry.INSTANCE;
  }

  /**
   * Reads the element the cursor is positioned on into a new instance of
   * `target`. On return the cursor sits on the matching END.
   */
  read(cursor: XmlCursor, target: EClass): EObject {
    const object = target.getEPackage()!.getEFactoryInstance().create(target);
    this.readAttributes(cursor, target, object);

    // A type with simple content keeps the element's own text, as
    // <FmtValue>$1,234.00</FmtValue> and <Value xsi:type="xsd:int">42</Value>
    // both do.
    const simple = this.simpleContentOf(target);
    let text = simple === null ? null : '';

    let depth = 0;
    let kind = cursor.next();
    while (kind !== null) {
      if (kind === EventKind.START) {
        if (depth === 0) {
          this.readChild(cursor, target, object);
        } else {
          depth += 1;
        }
      } else if (kind === EventKind.END) {
        if (depth === 0) {
          if (simple !== null && text !== null && text !== '') {
            this.set(object, simple, text, cursor);
          }
          return object;
        }
        depth -= 1;
      } else if (text !== null && depth === 0) {
        text += cursor.text;
      }
      kind = cursor.next();
    }
    return object;
  }

  private readChild(cursor: XmlCursor, target: EClass, object: EObject): void {
    const name = cursor.localName;

    if (cursor.namespaceURI === XSD_NS) {
      // The inline <xsd:schema> describes the payload and is never a feature of
      // anything. Skipping it by namespace rather than by policy keeps FAIL
      // meaning what it says for everything else.
      cursor.skipSubtree();
      return;
    }

    if (isNil(cursor)) {
      // xsi:nil is NULL, not an empty value. Left unset, so that eIsSet keeps
      // saying what it says everywhere else - and so that a numeric column
      // arriving as <Col xsi:nil="true"/> is not read as unparseable text.
      cursor.skipSubtree();
      return;
    }

    const feature = this.elementsOf(target).get(name);
    if (feature === undefined) {
      // ASSL wraps its collections - <Annotations> around the <Annotation>s. The
      // wrapper holds no value of its own and the model flattens it to a list,
      // so it is stepped through rather than treated as unknown.
      if (this.wrappedBy(target, name) !== null) {
        this.readWrapped(cursor, target, object);
        return;
      }

      // Two shapes where the element name is not a feature name, both real
      // content: a polymorphic containment, where the name is the concrete
      // subtype's, and a data-named one, where the name is a value.
      const polymorphic = this.polymorphicFor(target, name);
      if (polymorphic !== null) {
        add(object, polymorphic, this.read(cursor, this.subtypeFor(polymorphic, name)!));
        return;
      }

      const named = this.dataNamedFor(target);
      if (named !== null) {
        const childType = named.getEType() as EClass;
        const child = this.read(cursor, childType);
        const naming = child.eClass().getEStructuralFeature(elementNameFrom(childType)!);
        if (naming === null || naming === undefined) {
          throw new XmlCodecError(
            `${childType.getName()} names itself from '${elementNameFrom(childType)}', which it does not have`,
            cursor.location,
          );
        }
        child.eSet(naming, name);
        add(object, named, child);
        return;
      }

      if (this.unknown === Unknown.FAIL) {
        throw new XmlCodecError(`element <${name}> is not a feature of ${target.getName()}`, cursor.location);
      }
      cursor.skipSubtree();
      return;
    }

    this.checkNamespace(cursor, feature, target);

    if (isReference(feature)) {
      const declared = feature.getEType() as EClass;
      // Even a known feature can arrive under a subtype's name when its declared
      // type is a group.
      const as = declared.isAbstract?.() === true ? (this.subtypeFor(feature, name) ?? declared) : declared;
      add(object, feature, this.read(cursor, as));
    } else if (isXmlDocument(feature)) {
      // An xmlDocument column carries a document, not text, so the subtree is
      // captured as XML and kept as the column's value.
      this.set(object, feature, cursor.rawSubtree(), cursor);
    } else {
      this.set(object, feature, cursor.elementText(), cursor);
    }
  }

  /** Reads the children of a wrapper as though it had not been written. */
  private readWrapped(cursor: XmlCursor, target: EClass, object: EObject): void {
    let depth = 1;
    while (depth > 0) {
      const kind = cursor.next();
      if (kind === null) {
        return;
      }
      if (kind === EventKind.START) {
        this.readChild(cursor, target, object);
      } else if (kind === EventKind.END) {
        depth -= 1;
      }
    }
  }

  /**
   * That the element sits in the namespace the model puts the feature in.
   *
   * Features are matched on the local name, which is what makes a model read a
   * response at all - but it also means an element with the right name and the
   * wrong namespace is read as though it belonged. The other direction is worse
   * and is what a strict client does: it skips such an element without a word,
   * and the column arrives empty with nothing to say why.
   *
   * So the mismatch is named. Only where the model states a namespace: a
   * feature that states none is unqualified on purpose, and an element that
   * carries none matches anything.
   */
  private checkNamespace(cursor: XmlCursor, feature: EStructuralFeature, target: EClass): void {
    const declared = rawNamespaceOf(feature);
    if (declared === null || cursor.namespaceURI === '' || cursor.namespaceURI === declared) {
      return;
    }
    throw new XmlCodecError(
      `<${cursor.localName}> is in ${cursor.namespaceURI}, but ${target.getName()} puts ` +
        `${wireNameOf(feature)} in ${declared}`,
      cursor.location,
    );
  }

  private readAttributes(cursor: XmlCursor, target: EClass, object: EObject): void {
    const byName = this.attributesOf(target);
    for (const attribute of cursor.attributes) {
      const feature = byName.get(attribute.localName);
      if (feature !== undefined) {
        this.set(object, feature, attribute.value, cursor);
      }
    }
  }

  private set(object: EObject, feature: EStructuralFeature, text: string, cursor: XmlCursor): void {
    const value = parseValue(feature, text, cursor.location);
    if (feature.isMany()) {
      (object.eGet(feature) as { add(value: unknown): void }).add(value);
    } else {
      object.eSet(feature, value);
    }
  }

  /**
   * The many-valued feature this element wraps, or null when it wraps nothing.
   */
  private wrappedBy(target: EClass, name: string): EStructuralFeature | null {
    for (const feature of allFeatures(target)) {
      if (feature.isMany() && wrapperNameOf(feature) === name) {
        return feature;
      }
    }
    return null;
  }

  /**
   * A containment whose declared type is abstract and has an alternative called
   * `name`.
   *
   * An Axis holds a SetType; what arrives is `<Members>`, `<Tuples>`,
   * `<CrossProduct>` or `<Union>`. The element name is the only thing that says
   * which - there is no xsi:type on the wire - so it is what the lookup uses.
   */
  private polymorphicFor(target: EClass, name: string): EReference | null {
    for (const feature of allFeatures(target)) {
      if (isReference(feature)) {
        const type = feature.getEType() as EClass | null;
        if (type?.isAbstract?.() === true && this.subtypeFor(feature, name) !== null) {
          return feature;
        }
      }
    }
    return null;
  }

  /**
   * The alternative of a group named `name`, from any package contributing one.
   *
   * A group is not confined to the package that declares it. `SetType` lives in
   * mddataset with four of its five alternatives, but `NormTupleSet` - what SSAS
   * answers when a client asks for an optimised response, as Excel does - is in
   * the msxmla package. The declared package is searched first because that is
   * where an alternative usually is; the registry is the fallback.
   */
  private subtypeFor(reference: EReference, name: string): EClass | null {
    const declared = reference.getEType() as EClass | null;
    if (declared === null) {
      return null;
    }
    const own = declared.getEPackage();
    const found = own === null || own === undefined ? null : subtypeIn(own, declared, name);
    if (found !== null) {
      return found;
    }
    for (const registered of this.registry.values()) {
      const candidate = registered as EPackage;
      if (candidate !== own && typeof candidate?.getEClassifiers === 'function') {
        const hit = subtypeIn(candidate, declared, name);
        if (hit !== null) {
          return hit;
        }
      }
    }
    return null;
  }

  /**
   * A containment whose target names itself from its own data - a CellInfoItem
   * is `<FORMATTED_VALUE>` because that is the property the client asked for.
   */
  private dataNamedFor(target: EClass): EReference | null {
    for (const feature of allFeatures(target)) {
      if (isReference(feature)) {
        const type = feature.getEType() as EClass | null;
        if (type !== null && elementNameFrom(type) !== null) {
          return feature;
        }
      }
    }
    return null;
  }

  private simpleContentOf(target: EClass): EStructuralFeature | null {
    let found = this.simpleContent.get(target);
    if (found === undefined) {
      found = null;
      for (const feature of allFeatures(target)) {
        if (isSimpleContent(feature)) {
          found = feature;
          break;
        }
      }
      this.simpleContent.set(target, found);
    }
    return found;
  }

  private elementsOf(target: EClass): Map<string, EStructuralFeature> {
    return cached(this.elements, target, false);
  }

  private attributesOf(target: EClass): Map<string, EStructuralFeature> {
    return cached(this.attributes, target, true);
  }
}

function cached(
  store: Map<EClass, Map<string, EStructuralFeature>>,
  target: EClass,
  attributes: boolean,
): Map<string, EStructuralFeature> {
  let index = store.get(target);
  if (index === undefined) {
    index = new Map();
    for (const feature of allFeatures(target)) {
      if (isAttribute(feature) === attributes && !isWildcard(feature)) {
        index.set(wireNameOf(feature), feature);
      }
    }
    store.set(target, index);
  }
  return index;
}

function subtypeIn(ePackage: EPackage, declared: EClass, name: string): EClass | null {
  for (const candidate of iterate(ePackage.getEClassifiers())) {
    const eClass = candidate as EClass;
    if (
      typeof eClass.getEStructuralFeatures === 'function'
      && eClass.isAbstract?.() !== true
      && declared.isSuperTypeOf?.(eClass) === true
      && groupElementNameOf(eClass) === name
    ) {
      return eClass;
    }
  }
  return null;
}

/**
 * Whether the feature's type is the model's `xmlDocument`, whatever it is named
 * here.
 */
function isXmlDocument(feature: EStructuralFeature): boolean {
  return feature.getEType()?.getName() === 'XmlDocument';
}

function isReference(feature: EStructuralFeature): feature is EReference {
  return typeof (feature.getEType() as { getEStructuralFeatures?: unknown })?.getEStructuralFeatures === 'function';
}

function add(object: EObject, feature: EStructuralFeature, child: EObject): void {
  if (feature.isMany()) {
    (object.eGet(feature) as { add(value: EObject): void }).add(child);
  } else {
    object.eSet(feature, child);
  }
}

/**
 * Whether this element says it is NULL.
 *
 * Only the literal `true`. XSD allows `1` for a boolean, but `xsi:nil` is
 * defined over the words, and a client that also honoured `1` would read a
 * column holding the number one as absent.
 */
function isNil(cursor: XmlCursor): boolean {
  for (const attribute of cursor.attributes) {
    if (attribute.localName === 'nil' && attribute.namespaceURI === XSI_NS) {
      return attribute.value.trim() === 'true';
    }
  }
  return false;
}

function allFeatures(eClass: EClass): EStructuralFeature[] {
  return [...iterate(eClass.getEAllStructuralFeatures())] as EStructuralFeature[];
}

/** EList in this library is index-based; this makes it iterable either way. */
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
