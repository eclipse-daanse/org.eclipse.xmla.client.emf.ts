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
import type { EObject, EStructuralFeature } from '@emfts/core';

/**
 * The shape mdx-workbench consumes today: rows as plain records, columns as a
 * list of names.
 */
export interface ParsedRowset {
  rows: Array<Record<string, unknown>>;
  columns: string[];
}

/**
 * One row as a plain record, keyed by the name the column has **on the wire**.
 *
 * The key is the ExtendedMetaData name and is not transformed in any way. That
 * is worth stating because the obvious guess is wrong: UPPER_SNAKE holds only
 * for the `MDSCHEMA_*` and `DBSCHEMA_*` rowsets. `DISCOVER_DATASOURCES` names
 * its columns `DataSourceName` and `DataSourceInfo`, and that is exactly what
 * mdx-workbench looks for - a client that helpfully normalised everything to
 * `DATA_SOURCE_NAME` would break it.
 */
export function rowToRecord(row: EObject): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const feature of featuresOf(row)) {
    if (!row.eIsSet(feature)) {
      // Unset is NULL, and NULL is absence. Writing an explicit undefined here
      // would make every row carry every column and lose the distinction.
      continue;
    }
    record[wireNameOf(feature)] = valueOf(row, feature);
  }
  return record;
}

/**
 * The rows of a result, with the column list the model declares.
 *
 * The columns come from the class rather than from the rows, so a column that
 * happens to be NULL in every row still appears - which is what a grid needs
 * in order to show it as an empty column rather than not at all.
 */
export function toParsedRowset(rows: readonly EObject[], columns?: readonly string[]): ParsedRowset {
  const names = columns ?? (rows.length === 0 ? [] : featuresOf(rows[0]!).map((feature) => wireNameOf(feature)));
  return {
    rows: rows.map((row) => rowToRecord(row)),
    columns: [...names],
  };
}

function valueOf(row: EObject, feature: EStructuralFeature): unknown {
  const value = row.eGet(feature);
  if (feature.isMany()) {
    return [...(value as Iterable<unknown>)].map((each) => plain(each));
  }
  return plain(value);
}

/**
 * A value as something a plain consumer can hold.
 *
 * A nested rowset becomes a nested record rather than being flattened into a
 * string. That is the gain EObjects have over the hand-written parser this
 * replaces, which turned a nested `<Restrictions>` into `[object Object]`.
 */
function plain(value: unknown): unknown {
  if (typeof (value as { eClass?: unknown })?.eClass === 'function') {
    return rowToRecord(value as EObject);
  }
  if (typeof value === 'bigint') {
    // JSON cannot hold a bigint, and the values that need one - an unsignedLong
    // restrictions mask - are read rather than computed with.
    return value.toString();
  }
  return value;
}

function featuresOf(row: EObject): EStructuralFeature[] {
  return [...(row.eClass().getEAllStructuralFeatures() as unknown as EStructuralFeature[])];
}
