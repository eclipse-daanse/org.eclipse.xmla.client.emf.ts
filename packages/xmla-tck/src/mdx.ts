/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { XmlaClient } from '@eclipse-daanse/xmla-client';
import { CellsetReader } from '@eclipse-daanse/xmla-workbench-adapter';
import type { XmlaCellset } from '@eclipse-daanse/xmla-workbench-adapter';
import type { EClass, EObject, EStructuralFeature } from '@emfts/core';

import type { Context } from './kit.js';

/**
 * Execute, with the response kept: the bytes, and what they read as.
 *
 * The workbench adapter hands back a cellset and nothing else, which is right
 * for a consumer and too little for a check that asks whether the answer
 * carried a schema, or came as a rowset, or had a slicer. So this goes through
 * the bare client and reads the answer twice: once as the consumer would, and
 * once to say what shape it was.
 */
export interface Executed {
  readonly xml: string;
  /** The cellset, or null with `readError` set when the reader could not make one. */
  readonly cellset: XmlaCellset | null;
  readonly readError: string | null;
  /** True when the server answered a rowset rather than a dataset. */
  readonly tabular: boolean;
  readonly hasInlineSchema: boolean;
}

export type PropertyValues = Readonly<Record<string, string | number | boolean | undefined>>;

/** A `<Statement>` command carrying the text. */
export function statementCommand(context: Context, statement: string): EObject {
  const xmla = context.models.named('xmla');
  if (xmla === null) {
    throw new Error('the xmla model is not loaded');
  }
  const eClass = xmla.getEClassifier('Statement') as EClass | null;
  if (eClass === null || eClass === undefined) {
    throw new Error('the xmla model has no Statement');
  }
  const command = xmla.getEFactoryInstance().create(eClass);
  const feature = eClass.getEStructuralFeature('statement');
  if (feature !== null && feature !== undefined) {
    command.eSet(feature, statement);
  }
  return command;
}

/**
 * A `PropertyList` with these properties set, by their names on the wire.
 *
 * Typed as the model types them: `LocaleIdentifier` is an integer and
 * `ShowHiddenCubes` a boolean, and a string in their place would be written
 * as one and refused. Null when nothing is set, which the writer turns into
 * the mandatory empty `<PropertyList/>`.
 */
export function propertyList(context: Context, values: PropertyValues): EObject | null {
  const xmla = context.models.named('xmla');
  if (xmla === null) {
    throw new Error('the xmla model is not loaded');
  }
  const eClass = xmla.getEClassifier('PropertyList') as EClass | null;
  if (eClass === null || eClass === undefined) {
    throw new Error('the xmla model has no PropertyList');
  }
  const list = xmla.getEFactoryInstance().create(eClass);
  let any = false;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    const feature = featureByWireName(eClass, name);
    if (feature === null) {
      throw new Error(`the PropertyList has no property called ${name}`);
    }
    list.eSet(feature, coerce(feature, value));
    any = true;
  }
  return any ? list : null;
}

function coerce(feature: EStructuralFeature, value: string | number | boolean): unknown {
  const type = feature.getEType()?.getName() ?? '';
  if (/Int|Long|Short/.test(type)) {
    return typeof value === 'number' ? value : Number(value);
  }
  if (/Boolean/.test(type)) {
    return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
  }
  return String(value);
}

export function featureByWireName(eClass: EClass, wireName: string): EStructuralFeature | null {
  for (const feature of eClass.getEAllStructuralFeatures()) {
    const annotation = feature.getEAnnotation('http:///org/eclipse/emf/ecore/util/ExtendedMetaData');
    const name = annotation?.getDetails().getByKey('name') ?? feature.getName();
    if (name === wireName) {
      return feature;
    }
  }
  return null;
}

export interface ExecuteOptions {
  readonly properties?: PropertyValues;
  /** Header blocks beside the session ones. */
  readonly headers?: readonly EObject[];
  /** The client to send through; the profile's own by default. */
  readonly client?: XmlaClient;
}

/** One statement against one catalog, and what came back. */
export async function executeRaw(
  context: Context,
  catalog: string | null,
  statement: string,
  options: ExecuteOptions = {},
): Promise<Executed> {
  const base = options.client ?? (await context.connected()).client;
  const client =
    options.headers === undefined
      ? base
      : new XmlaClient({
          url: context.profile.url,
          transport: context.transport,
          models: context.models,
          ...(context.profile.credentials === undefined ? {} : { credentials: context.profile.credentials }),
          connectionProperties: base.connectionProperties,
          sessionId: base.sessionId,
          extraSoapHeaders: options.headers,
        });
  const properties = propertyList(context, { ...(catalog === null ? {} : { Catalog: catalog }), ...options.properties });
  const xml = await client.execute(statementCommand(context, statement), properties);
  return read(context, xml);
}

/** What an Execute answer reads as, without sending anything. */
export function read(context: Context, xml: string): Executed {
  const reader = new CellsetReader(context.models);
  let cellset: XmlaCellset | null = null;
  let readError: string | null = null;
  let tabular = false;
  try {
    tabular = reader.readDataset(xml) === null;
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }
  if (readError === null) {
    try {
      cellset = reader.read(xml);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }
  return { xml, cellset, readError, tabular, hasInlineSchema: /<(\w+:)?schema[\s>]/.test(xml) };
}
