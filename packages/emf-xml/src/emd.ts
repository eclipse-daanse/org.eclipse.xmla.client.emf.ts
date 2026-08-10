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
  ATTRIBUTE_FEATURE,
  EMD_ANNOTATION_URI,
  ExtendedMetaData,
  SIMPLE_FEATURE,
} from '@emfts/core';
import type { EClass, EClassifier, EModelElement, EStructuralFeature } from '@emfts/core';

/**
 * What the model says about how a feature appears on the wire.
 *
 * A thin facade over `ExtendedMetaData`, for two reasons. It is instantiated
 * rather than a singleton in this version of the library, so one instance lives
 * here instead of at every call site. And one of its methods must not be used
 * at all - see `rawNamespaceOf`.
 */
const emd = new ExtendedMetaData();

/** Where this project states what XSD and ExtendedMetaData cannot. */
export const DAANSE_XMLA_URI = 'https://www.daanse.org/spec/xmla/1.0';

/** The element or attribute name this feature takes on the wire. */
export function wireNameOf(feature: EStructuralFeature): string {
  const name = emd.getName(feature);
  return name === null || name === undefined || name === '' ? feature.getName()! : name;
}

/**
 * The element name a classifier takes on the wire.
 *
 * Read from the annotation directly: `getName` is declared for features only,
 * and a classifier carries the same detail under the same source.
 */
export function wireNameOfType(classifier: EClassifier): string {
  const name = annotationDetail(classifier, EMD_ANNOTATION_URI, 'name');
  return name === null || name === '' ? classifier.getName()! : name;
}

export function featureKindOf(feature: EStructuralFeature): number {
  return emd.getFeatureKind(feature);
}

export function isAttribute(feature: EStructuralFeature): boolean {
  return featureKindOf(feature) === ATTRIBUTE_FEATURE;
}

/**
 * Whether this feature holds the element's own text.
 *
 * Keyed on the declared kind rather than on the feature being called `:0`,
 * because the name is a convention of one generator and the kind is what the
 * model actually states.
 */
export function isSimpleContent(feature: EStructuralFeature): boolean {
  return featureKindOf(feature) === SIMPLE_FEATURE;
}

/**
 * The namespace the model gives a feature explicitly, or null when it gives
 * none and for `##targetNamespace`.
 *
 * Read off the annotation rather than through `getNamespace`, which falls back
 * to the owning EPackage's nsURI when the model states nothing - and "states
 * nothing" is precisely the case that has to stay unqualified. Going through the
 * convenient method would put `<Session>` into the SOAP namespace and put every
 * attribute into the namespace of the element around it.
 */
export function rawNamespaceOf(feature: EStructuralFeature): string | null {
  const declared = annotationDetail(feature, EMD_ANNOTATION_URI, 'namespace');
  if (declared === null || declared === '' || declared === '##targetNamespace') {
    return null;
  }
  return declared;
}

/** Whether the model lets any element fill this feature. */
export function isWildcard(feature: EStructuralFeature): boolean {
  return annotationDetail(feature, EMD_ANNOTATION_URI, 'namespace') === '##any';
}

/**
 * The element this feature's values are wrapped in, or null when they are
 * written bare.
 *
 * Both forms are real: a rowset repeats `<ProviderType>` with nothing around
 * it, while ASSL puts its `<Annotation>`s inside an `<Annotations>`. The model
 * says which, in 182 places.
 */
export function wrapperNameOf(feature: EStructuralFeature): string | null {
  return annotationDetail(feature, DAANSE_XMLA_URI, 'wrapperElementName');
}

/**
 * The name an alternative takes inside its group, which is not its type's name.
 */
export function groupElementNameOf(eClass: EClass): string {
  const group = annotationDetail(eClass, DAANSE_XMLA_URI, 'groupElementName');
  return group !== null && group !== '' ? group : wireNameOfType(eClass);
}

/**
 * The feature whose value *is* the element's name, or null.
 *
 * A CellInfoItem is written as `<FORMATTED_VALUE>` because that is the property
 * the client asked for - the name is data, not schema.
 */
export function elementNameFrom(eClass: EClass): string | null {
  return annotationDetail(eClass, DAANSE_XMLA_URI, 'elementNameFrom');
}

function annotationDetail(element: EModelElement, source: string, key: string): string | null {
  const annotation = element.getEAnnotation(source);
  if (annotation === null || annotation === undefined) {
    return null;
  }
  const value = annotation.getDetails().getByKey(key);
  return value === undefined || value === null ? null : value;
}
