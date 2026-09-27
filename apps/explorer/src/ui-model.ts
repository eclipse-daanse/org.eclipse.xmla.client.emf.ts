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
  createComposerRegistry,
  FormViewComposer,
  MasterDetailComposer,
  SectionViewComposer,
  SummaryViewComposer,
  TabViewComposer,
  TableViewComposer,
  UimodelFactory,
  UimodelPackage,
} from '@eclipse-daanse/vendor-uimodel-composer';
import { wireNameOf } from '@eclipse-daanse/emf-xml';
import type { WidgetComponent } from '@eclipse-daanse/vendor-uimodel-composer';
import type { EClass, EObject, EStructuralFeature } from '@emfts/core';
import type { InjectionKey } from 'vue';

/**
 * Building a UI that is itself an Ecore model.
 *
 * The composer renders a `UIModel` instance, so what this produces is EObjects
 * and not a description of its own: a `FormView` holding one widget per
 * restriction, a `TableView` for the rows. Which widget a feature gets is read
 * off its data type, so nothing here knows a rowset by name - and a class the
 * server described a moment ago goes through exactly the same code as one from
 * a `.ecore`.
 *
 * `widget.feature` holds the **EStructuralFeature itself**, not its name. That
 * is what the composer reads and writes through, and it is what makes the whole
 * thing work for a class that has no name anyone could have written down.
 *
 * These UIModels stay in memory. They point at features in a package that has
 * no Resource, so saving one would write `href`s that resolve to nothing.
 */
const GENMODEL = 'http://www.eclipse.org/emf/2002/GenModel';

/**
 * The rows a TableView is rendering, handed down rather than passed through.
 *
 * The composer gives a renderer one `model` EObject, and a rowset is a list of
 * them - so the list travels beside the model rather than being squeezed into
 * it.
 */
export const ROWS_KEY: InjectionKey<() => readonly EObject[]> = Symbol('xmla-rows');

/** The widget kinds this generator chooses between. */
export type WidgetKind = 'input' | 'number' | 'checkbox' | 'date' | 'textArea';

export interface BuiltForm {
  /** The UIModel to hand the composer. */
  readonly uiModel: EObject;
  /** The instance it edits. */
  readonly instance: EObject;
  readonly fields: readonly EStructuralFeature[];
}

export interface BuiltTable {
  readonly uiModel: EObject;
  readonly columns: readonly ColumnModel[];
}

/**
 * A column, described the same way whichever path produced the class.
 *
 * The grid is rendered by this project rather than by the composer's
 * `TableViewComposer`, because a nested rowset has to fold into an inner table
 * and a `Record<string, unknown>` renderer cannot do that. The description is
 * still taken from the model.
 */
export interface ColumnModel {
  readonly feature: EStructuralFeature;
  readonly label: string;
  readonly widget: WidgetKind | 'table';
  readonly many: boolean;
  readonly nested: readonly ColumnModel[] | null;
  readonly documentation: string | null;
}

/**
 * A `FormView` over a restrictions class, and the instance it edits.
 *
 * The class's **own** features, in declaration order: for a restrictions class
 * that order is the ordinal order the RestrictionsMask is defined over, and any
 * other would misrepresent it.
 */
export function formViewForEClass(eClass: EClass, required: readonly string[] = []): BuiltForm {
  const factory = UimodelFactory.eINSTANCE;
  const form = factory.createFormView();
  form.name = eClass.getName() ?? 'Restrictions';

  const own = list(eClass.getEStructuralFeatures());
  for (const feature of own) {
    const widget = widgetFor(feature, factory);
    widget.name = feature.getName() ?? '';
    widget.feature = feature;
    widget.label = wireNameOf(feature);
    widget.required = required.includes(wireNameOf(feature));
    form.fields.push(widget);
  }

  const uiModel = factory.createUIModel();
  uiModel.name = `${eClass.getName()} restrictions`;
  uiModel.targetClasses.push(eClass);
  uiModel.components.push(form);

  return {
    uiModel: uiModel as unknown as EObject,
    instance: eClass.getEPackage()!.getEFactoryInstance().create(eClass),
    fields: own,
  };
}

/** A `TableView` over a row class, plus the columns this project renders with. */
export function tableViewForEClass(eClass: EClass): BuiltTable {
  const factory = UimodelFactory.eINSTANCE;
  const table = factory.createTableView();
  table.name = eClass.getName() ?? 'Rows';
  table.tableStyle = factory.createTableStyle();
  // On the TableView itself, not only on the UIModel: the renderer the composer
  // delegates to is handed the component, and that is where it has to find out
  // what it is rendering.
  table.targetClasses.push(eClass);

  const uiModel = factory.createUIModel();
  uiModel.name = `${eClass.getName()} rows`;
  uiModel.targetClasses.push(eClass);
  uiModel.components.push(table);

  return {
    uiModel: uiModel as unknown as EObject,
    columns: columnsForEClass(eClass),
  };
}

/** The columns of a row class, without building a UIModel to get at them. */
export function columnsForEClass(eClass: EClass): ColumnModel[] {
  return allFeatures(eClass).map((feature) => columnFor(feature));
}

function columnFor(feature: EStructuralFeature): ColumnModel {
  const type = feature.getEType();
  const nested = isClass(type) ? (type as EClass) : null;

  return {
    feature,
    label: wireNameOf(feature),
    widget: nested !== null ? 'table' : widgetKindFor(type),
    many: feature.isMany(),
    // A nested rowset folds into an inner table rather than a JSON blob. That is
    // the gain of carrying EObjects this far.
    nested: nested === null ? null : allFeatures(nested).map((each) => columnFor(each)),
    documentation: documentationOf(feature),
  };
}

function widgetFor(feature: EStructuralFeature, factory: typeof UimodelFactory.eINSTANCE): WidgetComponent {
  switch (widgetKindFor(feature.getEType())) {
    case 'checkbox':
      return factory.createCheckboxWidget();
    case 'number':
      return factory.createNumberWidget();
    case 'date':
      return factory.createDateWidget();
    default:
      return factory.createInputWidget();
  }
}

/**
 * The widget a data type asks for.
 *
 * Read off the instance class rather than the type's name, because the same
 * thing arrives under several names - `IntObject`, `UnsignedIntObject` and
 * `Short` are all a number to someone filling in a form.
 */
export function widgetKindFor(type: unknown): WidgetKind {
  const named = type as { getName?(): string; getInstanceClassName?(): string } | null;
  const instanceClass = named?.getInstanceClassName?.() ?? '';
  const name = named?.getName?.() ?? '';

  if (instanceClass === 'boolean' || instanceClass === 'java.lang.Boolean') {
    return 'checkbox';
  }
  if (name === 'DateTime' || name === 'Date' || name === 'Time') {
    return 'date';
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
      return 'input';
  }
}

/**
 * What the model says a column means.
 *
 * Worth surfacing, and worth noticing when it is absent: the static models
 * carry the [MS-SSAS] prose for most columns and a dynamically built class
 * carries none, which is a visible difference between the two paths rather than
 * a hidden one.
 */
function documentationOf(feature: EStructuralFeature): string | null {
  const annotation = feature.getEAnnotation(GENMODEL);
  if (annotation === null || annotation === undefined) {
    return null;
  }
  const text = annotation.getDetails().getByKey('documentation');
  return text === undefined || text === null || text === '' ? null : text;
}

/**
 * The registry the composer is given: its own composers, plus our grid.
 *
 * Passing a registry replaces the composer's defaults wholesale rather than
 * adding to them, so every key it dispatches on has to be listed here. Leaving
 * one out is silent - `ComponentDispatcher` renders nothing and warns to the
 * console - which is why this is in one place with a test that mounts it.
 *
 * `TableViewRenderer` is the seam `TableViewComposer` delegates to. Without it
 * a TableView renders an empty placeholder.
 */
export function composerRegistry(tableRenderer: unknown) {
  return createComposerRegistry({
    FormView: FormViewComposer,
    SectionView: SectionViewComposer,
    TabView: TabViewComposer,
    SummaryView: SummaryViewComposer,
    TableView: TableViewComposer,
    MasterDetail: MasterDetailComposer,
    TableViewRenderer: tableRenderer as never,
  });
}

/** The UIModel package, so a caller can register it before rendering. */
export function uiModelPackage(): unknown {
  return UimodelPackage.eINSTANCE;
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
