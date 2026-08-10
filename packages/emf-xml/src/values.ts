/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { EClassifier, EDataType, EStructuralFeature } from '@emfts/core';

import { wireNameOf } from './emd.js';
import { XmlCodecError } from './errors.js';
import type { XmlLocation } from './errors.js';

/**
 * Turns the text of an element or attribute into the value its feature holds.
 *
 * This exists because the library's own converters are wrong in ways that do
 * not announce themselves. All three were measured against
 * `@emfts/core@0.1.1-next.16`:
 *
 * - `createFromString(Boolean, '1')` returns **false**. XSD says `1` and `0`
 *   are boolean literals, and XMLA writes them: `mustUnderstand="1"` decides
 *   whether a message may be ignored at all. The conversion does not fail here,
 *   it inverts the meaning.
 * - `createFromString(IntObject, 'abc')` returns **NaN**, and so does `''`.
 * - `createFromString(DateTime, 'nonsense')` returns `'nonsense'` unchanged.
 *
 * Each of those puts a wrong value into a model that then looks fine. So every
 * conversion here either yields a value the text really denotes or throws with
 * the column name and the position in the document.
 */

/** xsd:dateTime, xsd:date and xsd:time, lexically. */
const DATE_TIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE = /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/;
const TIME = /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

const TEMPORAL: Readonly<Record<string, RegExp>> = {
  DateTime: DATE_TIME,
  Date: DATE,
  Time: TIME,
};

export function parseValue(feature: EStructuralFeature, text: string, location?: XmlLocation): unknown {
  const type = feature.getEType();
  if (type === null || type === undefined) {
    // An unresolved eType is the failure mode M1 measured: it reads as empty
    // rather than erroring. Not here.
    throw new XmlCodecError(
      `the type of ${describe(feature)} is unresolved, so '${text}' cannot be read`,
      location,
    );
  }

  if (isBoolean(type)) {
    switch (text.trim()) {
      case 'true':
      case '1':
        return true;
      case 'false':
      case '0':
        return false;
      default:
        throw new XmlCodecError(`cannot read '${text}' as a boolean for ${describe(feature)}`, location);
    }
  }

  const pattern = TEMPORAL[type.getName() ?? ''];
  if (pattern !== undefined) {
    const trimmed = text.trim();
    if (!pattern.test(trimmed)) {
      throw new XmlCodecError(`cannot read '${text}' as ${type.getName()} for ${describe(feature)}`, location);
    }
    // Kept lexical. XMLA timestamps carry no zone, so turning them into a Date
    // would bind them to whichever zone the browser happens to be in, and the
    // value would differ between two clients reading the same response.
    return trimmed;
  }

  if (!isDataType(type)) {
    return text;
  }

  const ePackage = type.getEPackage();
  if (ePackage === null || ePackage === undefined) {
    // A data type need not belong to a package. `EcoreDataTypes.EString` is one
    // such, and the dynamic path builds more of them, so this is a shape to
    // handle rather than an error - there is simply no factory to ask, and the
    // instance class is what says how to read the text.
    return withoutFactory(type, text, feature, location);
  }

  let value: unknown;
  try {
    value = ePackage.getEFactoryInstance().createFromString(type, text);
  } catch (cause) {
    throw new XmlCodecError(`cannot read '${text}' as ${type.getName()} for ${describe(feature)}`, location, {
      cause,
    });
  }
  if (typeof value === 'number' && Number.isNaN(value) && text.trim().toLowerCase() !== 'nan') {
    // The library's numeric converters answer NaN instead of failing, so a typo
    // in a column would arrive as a value that spreads through any arithmetic
    // touching it.
    throw new XmlCodecError(`cannot read '${text}' as ${type.getName()} for ${describe(feature)}`, location);
  }
  return value;
}

/**
 * A value as the text an element or attribute carries, or null when the feature
 * holds nothing to write.
 */
export function formatValue(feature: EStructuralFeature, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    // Always the words. Both forms are legal, `1` and `0` are what a client
    // sends, and every recorded server response writes true and false.
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      throw new XmlCodecError(`refusing to write NaN for ${describe(feature)}`);
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 'INF' : '-INF';
    }
    return String(value);
  }

  const type = feature.getEType();
  if (isDataType(type)) {
    return type.getEPackage()!.getEFactoryInstance().convertToString(type, value);
  }
  return String(value);
}

/**
 * Reading text for a data type that belongs to no package.
 *
 * Keyed on the instance class, which is the only thing such a type states about
 * itself. Anything not named here stays text - that is what an unconstrained
 * `xsd:string` column is, and guessing further would invent a value.
 */
function withoutFactory(
  type: EDataType,
  text: string,
  feature: EStructuralFeature,
  location: XmlLocation | undefined,
): unknown {
  const instanceClass = type.getInstanceClassName();
  switch (instanceClass) {
    case 'int':
    case 'java.lang.Integer':
    case 'short':
    case 'java.lang.Short':
    case 'byte':
    case 'java.lang.Byte': {
      const parsed = Number(text.trim());
      if (!Number.isInteger(parsed)) {
        throw new XmlCodecError(`cannot read '${text}' as ${type.getName()} for ${describe(feature)}`, location);
      }
      return parsed;
    }
    case 'long':
    case 'java.lang.Long':
      try {
        return BigInt(text.trim());
      } catch (cause) {
        throw new XmlCodecError(`cannot read '${text}' as ${type.getName()} for ${describe(feature)}`, location, {
          cause,
        });
      }
    case 'float':
    case 'java.lang.Float':
    case 'double':
    case 'java.lang.Double': {
      const parsed = Number(text.trim());
      if (Number.isNaN(parsed)) {
        throw new XmlCodecError(`cannot read '${text}' as ${type.getName()} for ${describe(feature)}`, location);
      }
      return parsed;
    }
    default:
      return text;
  }
}

function isBoolean(type: EClassifier): boolean {
  const instanceClass = type.getInstanceClassName();
  return instanceClass === 'boolean' || instanceClass === 'java.lang.Boolean';
}

function isDataType(type: EClassifier | null | undefined): type is EDataType {
  return type !== null && type !== undefined && typeof (type as EDataType).getInstanceClassName === 'function'
    && typeof (type as unknown as { getEStructuralFeatures?: unknown }).getEStructuralFeatures !== 'function';
}

function describe(feature: EStructuralFeature): string {
  const owner = feature.getEContainingClass?.()?.getName();
  return owner === undefined || owner === null ? wireNameOf(feature) : `${owner}.${wireNameOf(feature)}`;
}
