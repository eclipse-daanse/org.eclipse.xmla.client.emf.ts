/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { wireNameOf } from '@daanse/emf-xml';
import type { EClass, EStructuralFeature } from '@emfts/core';

/**
 * Turning an EClass into a description of the screen for it.
 *
 * This is the seam the EMF-TS UIModel composer is meant to fill: it renders a
 * UI that is itself an Ecore model. That package is not published - it is 404 on
 * npm and would have to be vendored, 239 files of it - so the description is
 * built here for now. What matters is that it *is* a description rather than
 * markup: the widget for a feature is chosen from the model, and nothing in the
 * screens knows a rowset by name.
 *
 * The other thing it must not know is where an EClass came from. A form over a
 * restrictions class from a `.ecore` and one over a class built from a schema
 * the server just sent are the same shape, because a screen that branched on
 * that would render one of the two paths badly.
 */
export type WidgetKind = 'text' | 'number' | 'checkbox' | 'timestamp' | 'table';

export interface FieldModel {
  /** The EStructuralFeature itself, not its name - the caller reads and writes through it. */
  readonly feature: EStructuralFeature;
  /** What the column is called on the wire, which is what a user recognises. */
  readonly label: string;
  readonly widget: WidgetKind;
  readonly many: boolean;
  readonly required: boolean;
  /** For a nested rowset: the columns of the inner table. */
  readonly nested: readonly FieldModel[] | null;
  readonly documentation: string | null;
}

export interface FormModel {
  readonly title: string;
  readonly fields: readonly FieldModel[];
}

export interface TableModel {
  readonly title: string;
  readonly columns: readonly FieldModel[];
}

const GENMODEL = 'http://www.eclipse.org/emf/2002/GenModel';

/** A form over a restrictions class: one widget per feature it declares itself. */
export function formViewForEClass(eClass: EClass, required: readonly string[] = []): FormModel {
  // Its own features, not the inherited ones: for a restrictions class the
  // declaration order is the ordinal order the RestrictionsMask is defined over,
  // and showing them in any other order would misrepresent it.
  const own = list(eClass.getEStructuralFeatures());
  return {
    title: eClass.getName() ?? 'Restrictions',
    fields: own.map((feature) => fieldFor(feature, required)),
  };
}

/** A table over a row class: one column per feature, nested ones included. */
export function tableViewForEClass(eClass: EClass): TableModel {
  return {
    title: eClass.getName() ?? 'Rows',
    columns: allFeatures(eClass).map((feature) => fieldFor(feature, [])),
  };
}

function fieldFor(feature: EStructuralFeature, required: readonly string[]): FieldModel {
  const label = wireNameOf(feature);
  const type = feature.getEType();
  const nestedClass = isClass(type) ? (type as EClass) : null;

  return {
    feature,
    label,
    widget: nestedClass !== null ? 'table' : widgetFor(type),
    many: feature.isMany(),
    required: required.includes(label),
    // A nested rowset folds into an inner table rather than a JSON blob. That is
    // the whole gain of carrying EObjects this far.
    nested: nestedClass === null ? null : allFeatures(nestedClass).map((each) => fieldFor(each, [])),
    documentation: documentationOf(feature),
  };
}

/**
 * The widget a data type asks for.
 *
 * Chosen from the instance class rather than the type's name, because the same
 * XSD type arrives under several names - `IntObject`, `UnsignedIntObject` and
 * `Short` are all a number to a person filling in a form.
 */
function widgetFor(type: unknown): WidgetKind {
  const named = type as { getName?(): string; getInstanceClassName?(): string } | null;
  const instanceClass = named?.getInstanceClassName?.() ?? '';
  const name = named?.getName?.() ?? '';

  if (instanceClass === 'boolean' || instanceClass === 'java.lang.Boolean') {
    return 'checkbox';
  }
  if (name === 'DateTime' || name === 'Date' || name === 'Time') {
    return 'timestamp';
  }
  switch (instanceClass) {
    case 'int':
    case 'java.lang.Integer':
    case 'long':
    case 'java.lang.Long':
    case 'short':
    case 'java.lang.Short':
    case 'byte':
    case 'java.lang.Byte':
    case 'float':
    case 'java.lang.Float':
    case 'double':
    case 'java.lang.Double':
    case 'java.math.BigInteger':
      return 'number';
    default:
      return 'text';
  }
}

/**
 * What the model says this column means.
 *
 * Worth surfacing: the static models carry the [MS-SSAS] prose for most
 * columns, and a dynamically built class carries none - which is a visible,
 * honest difference between the two paths rather than a hidden one.
 */
function documentationOf(feature: EStructuralFeature): string | null {
  const annotation = feature.getEAnnotation(GENMODEL);
  if (annotation === null || annotation === undefined) {
    return null;
  }
  const text = annotation.getDetails().getByKey('documentation');
  return text === undefined || text === null || text === '' ? null : text;
}

function isClass(type: unknown): boolean {
  return typeof (type as { getEStructuralFeatures?: unknown })?.getEStructuralFeatures === 'function';
}

function allFeatures(eClass: EClass): EStructuralFeature[] {
  return [...(eClass.getEAllStructuralFeatures() as unknown as EStructuralFeature[])];
}

function list(eList: { size(): number; get(index: number): EStructuralFeature }): EStructuralFeature[] {
  const items: EStructuralFeature[] = [];
  for (let i = 0; i < eList.size(); i++) {
    items.push(eList.get(i)!);
  }
  return items;
}
