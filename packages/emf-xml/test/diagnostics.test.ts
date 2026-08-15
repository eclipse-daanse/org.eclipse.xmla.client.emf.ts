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
  BasicEAnnotation,
  BasicEAttribute,
  BasicEClass,
  BasicEPackage,
  EcoreDataTypes,
  EMD_ANNOTATION_URI,
  getXMLTypePackage,
} from '@emfts/core';
import type { EClass, EClassifier, EObject, EStructuralFeature } from '@emfts/core';
import { describe, expect, it } from 'vitest';

import { XmlCursor } from '../src/cursor.js';
import { XmlCodecError } from '../src/errors.js';
import { EcoreXmlReader } from '../src/reader.js';

/**
 * The four ways a rowset row reads wrong without saying so.
 *
 * Each is a real shape a server sends, and each used to end as a column that
 * looks empty or a number that is not one. A client that reports nothing about
 * them is worse than one that fails: the row arrives looking whole.
 *
 * Built against models this file makes, like the rest of `emf-xml` - nothing
 * here may pass by knowing what a rowset is.
 */
const ROWSET_NS = 'urn:schemas-microsoft-com:xml-analysis:rowset';

function annotate(
  target: { getEAnnotations(): { push(a: unknown): unknown } },
  details: Record<string, string>,
): void {
  const annotation = new BasicEAnnotation();
  annotation.setSource(EMD_ANNOTATION_URI);
  for (const [key, value] of Object.entries(details)) {
    annotation.getDetails().putByKey(key, value);
  }
  target.getEAnnotations().push(annotation);
}

function column(name: string, wireName: string, type: EClassifier, namespace?: string): EStructuralFeature {
  const feature = new BasicEAttribute();
  feature.setName(name);
  feature.setEType(type);
  feature.setUpperBound(1);
  annotate(feature, {
    kind: 'element',
    name: wireName,
    ...(namespace === undefined ? {} : { namespace }),
  });
  return feature;
}

function rowClass(...columns: EStructuralFeature[]): EClass {
  const row = new BasicEClass();
  row.setName('Row');
  annotate(row, { name: 'row', kind: 'elementOnly' });
  for (const each of columns) {
    row.addFeature(each);
  }
  const pack = new BasicEPackage();
  pack.setName('t');
  pack.setNsPrefix('t');
  pack.setNsURI(`${ROWSET_NS}/test/${Math.random()}`);
  pack.getEClassifiers().push(row);
  return row;
}

function read(xml: string, target: EClass): EObject {
  const cursor = XmlCursor.parse(xml);
  expect(cursor.moveToFirstElement()).toBe(true);
  return new EcoreXmlReader().read(cursor, target);
}

function xmlType(name: string): EClassifier {
  const type = getXMLTypePackage().getEClassifier(name);
  expect(type, `XMLType has ${name}`).toBeTruthy();
  return type as EClassifier;
}

describe('a column that is NULL rather than empty', () => {
  it('leaves the feature unset instead of reading the empty string', () => {
    const value = column('unitSales', 'UNIT_SALES', xmlType('Int'));
    const row = rowClass(value);

    const read1 = read(
      '<row xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<UNIT_SALES xsi:nil="true"/></row>',
      row,
    );

    expect(read1.eIsSet(value), 'nil is absence, not a value').toBe(false);
  });

  it('does not take 1 for nil, because a column may hold the number one', () => {
    // xsi:nil is defined over the words. A reader that also honoured 1 would
    // read <UNIT_SALES xsi:nil="1">1</UNIT_SALES> as absent.
    const value = column('unitSales', 'UNIT_SALES', xmlType('Int'));
    const row = rowClass(value);

    const read1 = read(
      '<row xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<UNIT_SALES xsi:nil="1">1</UNIT_SALES></row>',
      row,
    );

    expect(read1.eGet(value)).toBe(1);
  });
});

describe('a column in the wrong namespace', () => {
  it('is named rather than read as though it belonged', () => {
    const value = column('catalogName', 'CATALOG_NAME', EcoreDataTypes.EString, ROWSET_NS);
    const row = rowClass(value);

    expect(() =>
      read(`<row xmlns="${ROWSET_NS}"><CATALOG_NAME xmlns="urn:someone:else">FoodMart</CATALOG_NAME></row>`, row),
    ).toThrow(XmlCodecError);
  });

  it('is read where the element carries no namespace at all', () => {
    // An unqualified element matches whatever the model says: that is what a
    // response without a default namespace looks like, and refusing it would
    // reject a legal document.
    const value = column('catalogName', 'CATALOG_NAME', EcoreDataTypes.EString, ROWSET_NS);
    const row = rowClass(value);

    const read1 = read('<row><CATALOG_NAME>FoodMart</CATALOG_NAME></row>', row);

    expect(read1.eGet(value)).toBe('FoodMart');
  });
});

describe('a timestamp without its seconds', () => {
  it('is refused, because xsd:dateTime has none without them', () => {
    // What a server writing LocalDateTime.toString() produces once a minute.
    // A client that accepted it would carry a value the type does not have.
    const value = column('lastDataUpdate', 'LAST_DATA_UPDATE', xmlType('DateTime'));
    const row = rowClass(value);

    expect(() => read('<row><LAST_DATA_UPDATE>2026-08-15T00:00</LAST_DATA_UPDATE></row>', row)).toThrow(
      XmlCodecError,
    );
    expect(() => read('<row><LAST_DATA_UPDATE>2026-08-15T00:00:00</LAST_DATA_UPDATE></row>', row)).not.toThrow();
  });
});

describe('an empty element on a column that is not text', () => {
  it('is refused rather than read as a number that is not one', () => {
    // <COMPATIBILITY_LEVEL/> is unparseable input, not an empty value. Read
    // loosely it becomes NaN and spreads through any arithmetic that touches it.
    const value = column('compatibilityLevel', 'COMPATIBILITY_LEVEL', xmlType('Int'));
    const row = rowClass(value);

    expect(() => read('<row><COMPATIBILITY_LEVEL/></row>', row)).toThrow(XmlCodecError);
  });

  it('is a value on a text column, where the empty string is one', () => {
    const value = column('description', 'DESCRIPTION', EcoreDataTypes.EString);
    const row = rowClass(value);

    const read1 = read('<row><DESCRIPTION/></row>', row);

    expect(read1.eGet(value)).toBe('');
  });
});
