/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { BasicEAttribute, BasicEClass, getXMLTypePackage } from '@emfts/core';
import type { EClassifier, EStructuralFeature } from '@emfts/core';
import { describe, expect, it } from 'vitest';

import { XmlCodecError } from '../src/errors.js';
import { formatValue, parseValue } from '../src/values.js';

function featureOf(typeName: string, name = 'column'): EStructuralFeature {
  const type = getXMLTypePackage().getEClassifier(typeName);
  expect(type, `XMLType has ${typeName}`).toBeTruthy();
  const feature = new BasicEAttribute();
  feature.setName(name);
  feature.setEType(type as EClassifier);
  const owner = new BasicEClass();
  owner.setName('Row');
  owner.addFeature(feature);
  return feature;
}

describe('reading a value', () => {
  it('reads all four boolean literals, which the library does not', () => {
    // XSD 3.2.2: 1 and 0 are boolean literals as much as true and false. XMLA
    // uses them - mustUnderstand="1" decides whether a message may be ignored.
    const feature = featureOf('Boolean');

    expect(parseValue(feature, 'true')).toBe(true);
    expect(parseValue(feature, '1')).toBe(true);
    expect(parseValue(feature, 'false')).toBe(false);
    expect(parseValue(feature, '0')).toBe(false);
  });

  it('refuses text that is not a boolean rather than guessing', () => {
    expect(() => parseValue(featureOf('Boolean'), 'yes')).toThrow(XmlCodecError);
  });

  it('refuses a number that will not parse, where the library answers NaN', () => {
    // NaN spreads through any arithmetic that touches it, so a typo in one
    // column would quietly poison whatever is computed from it.
    expect(() => parseValue(featureOf('IntObject'), 'abc')).toThrow(/cannot read 'abc'/);
    expect(() => parseValue(featureOf('IntObject'), '')).toThrow(XmlCodecError);
  });

  it('reads a long as a bigint, because the wire type is not bounded by a double', () => {
    expect(parseValue(featureOf('LongObject'), '9007199254740993')).toBe(9007199254740993n);
  });

  it('refuses a timestamp that will not parse, where the library passes it through', () => {
    const feature = featureOf('DateTime');

    expect(parseValue(feature, '2023-04-05T06:07:08')).toBe('2023-04-05T06:07:08');
    expect(parseValue(feature, '2023-04-05T06:07:08.123Z')).toBe('2023-04-05T06:07:08.123Z');
    expect(() => parseValue(feature, 'nonsense')).toThrow(XmlCodecError);
    expect(() => parseValue(feature, '2023-04-05')).toThrow(XmlCodecError);
  });

  it('keeps a timestamp lexical rather than binding it to a zone', () => {
    // XMLA timestamps carry no zone. Turning one into a Date would bind it to
    // whichever zone the browser is in, and two clients reading the same
    // response would disagree about what it says.
    expect(typeof parseValue(featureOf('DateTime'), '2023-04-05T06:07:08')).toBe('string');
  });

  it('names the column and the position when it refuses', () => {
    try {
      parseValue(featureOf('Boolean', 'isDefault'), 'maybe', { line: 42, column: 7 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Row.isDefault');
      expect((error as Error).message).toContain('line 42');
    }
  });

  it('leaves a string exactly as it arrived, whitespace included', () => {
    expect(parseValue(featureOf('String'), '  padded  ')).toBe('  padded  ');
    expect(parseValue(featureOf('String'), '')).toBe('');
  });
});

describe('writing a value', () => {
  it('writes booleans as words, which is what every recorded server does', () => {
    const feature = featureOf('Boolean');

    expect(formatValue(feature, true)).toBe('true');
    expect(formatValue(feature, false)).toBe('false');
  });

  it('writes nothing for a value that is not there', () => {
    expect(formatValue(featureOf('String'), null)).toBeNull();
    expect(formatValue(featureOf('String'), undefined)).toBeNull();
  });

  it('distinguishes an empty string from an absent value', () => {
    // Unset means no element at all; set to '' means <X/>. The two say
    // different things and the writer has to keep them apart.
    expect(formatValue(featureOf('String'), '')).toBe('');
  });

  it('writes a bigint in full', () => {
    expect(formatValue(featureOf('LongObject'), 9007199254740993n)).toBe('9007199254740993');
  });

  it('refuses to write NaN rather than emitting the word', () => {
    expect(() => formatValue(featureOf('IntObject'), Number.NaN)).toThrow(XmlCodecError);
  });
});
