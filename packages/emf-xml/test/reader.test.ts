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
  BasicEReference,
  EcoreDataTypes,
  EMD_ANNOTATION_URI,
  EPackageRegistry,
  getXMLTypePackage,
} from '@emfts/core';
import type { EClass, EObject, EPackage, EStructuralFeature } from '@emfts/core';
import { afterEach, describe, expect, it } from 'vitest';

import { DAANSE_XMLA_URI } from '../src/emd.js';
import { XmlCodecError } from '../src/errors.js';
import { EcoreXmlReader, Unknown } from '../src/reader.js';
import { XmlCursor } from '../src/cursor.js';

/**
 * The reader against models built here, on purpose.
 *
 * `emf-xml` knows nothing about XMLA - that is what makes the dynamic path
 * possible, where EClasses come from a schema the server sent and are read by
 * exactly this code. Testing it against models this file builds is the way to
 * keep that true: nothing here could pass by knowing a rowset.
 */
const NS = 'https://example.test/reader';
const registered: string[] = [];

afterEach(() => {
  for (const nsURI of registered.splice(0)) {
    EPackageRegistry.INSTANCE.delete(nsURI);
  }
});

function annotate(target: { getEAnnotations(): { push(a: unknown): unknown } }, source: string, details: Record<string, string>): void {
  const annotation = new BasicEAnnotation();
  annotation.setSource(source);
  for (const [key, value] of Object.entries(details)) {
    annotation.getDetails().putByKey(key, value);
  }
  target.getEAnnotations().push(annotation);
}

function attribute(name: string, wireName: string, type = EcoreDataTypes.EString, kind = 'element'): EStructuralFeature {
  const feature = new BasicEAttribute();
  feature.setName(name);
  feature.setEType(type);
  feature.setUpperBound(1);
  annotate(feature, EMD_ANNOTATION_URI, { kind, name: wireName });
  return feature;
}

function reference(name: string, type: EClass, wireName: string, many = false): BasicEReference {
  const feature = new BasicEReference();
  feature.setName(name);
  feature.setEType(type);
  feature.setContainment(true);
  feature.setUpperBound(many ? -1 : 1);
  annotate(feature, EMD_ANNOTATION_URI, { kind: 'element', name: wireName });
  return feature;
}

function eClass(name: string, wireName = name): BasicEClass {
  const created = new BasicEClass();
  created.setName(name);
  annotate(created, EMD_ANNOTATION_URI, { name: wireName, kind: 'elementOnly' });
  return created;
}

function ePackage(nsURI: string, ...classes: BasicEClass[]): EPackage {
  const created = new BasicEPackage();
  created.setName('t');
  created.setNsPrefix('t');
  created.setNsURI(nsURI);
  created.getEClassifiers().push(...classes);
  return created;
}

function readOne(xml: string, target: EClass, unknown: Unknown = Unknown.FAIL): EObject {
  const cursor = XmlCursor.parse(xml);
  expect(cursor.moveToFirstElement()).toBe(true);
  return new EcoreXmlReader({ unknown }).read(cursor, target);
}

function value(object: EObject, featureName: string): unknown {
  return object.eGet(object.eClass().getEStructuralFeature(featureName)!);
}

describe('reading an element into an EObject', () => {
  it('maps element names through ExtendedMetaData, not through feature names', () => {
    // The single reason this reader exists. The library's handler matches
    // feature names case-insensitively, so CATALOG_NAME never finds catalogName
    // and the column is dropped without a word.
    const row = eClass('Row', 'row');
    row.addFeature(attribute('catalogName', 'CATALOG_NAME'));
    row.addFeature(attribute('cubeName', 'CUBE_NAME'));
    ePackage(`${NS}/emd`, row);

    const read = readOne('<row><CATALOG_NAME>Adventure Works</CATALOG_NAME><CUBE_NAME>Sales</CUBE_NAME></row>', row);

    expect(value(read, 'catalogName')).toBe('Adventure Works');
    expect(value(read, 'cubeName')).toBe('Sales');
  });

  it('reads attributes by their wire name and leaves unknown ones alone', () => {
    const item = eClass('Item');
    item.addFeature(attribute('mustUnderstand', 'mustUnderstand', getXMLTypePackage().getEClassifier('Boolean')!, 'attribute'));
    ePackage(`${NS}/attrs`, item);

    const read = readOne('<Item mustUnderstand="1" somethingElse="x"/>', item);

    // '1' is true per XSD; the library's own converter answers false here.
    expect(value(read, 'mustUnderstand')).toBe(true);
  });

  it('keeps the element text of a type with simple content', () => {
    const cell = eClass('Cell');
    const text = attribute('value', ':0', EcoreDataTypes.EString, 'simple');
    cell.addFeature(text);
    cell.addFeature(attribute('ordinal', 'ordinal', EcoreDataTypes.EString, 'attribute'));
    ePackage(`${NS}/simple`, cell);

    const read = readOne('<Cell ordinal="7">$1,234.00</Cell>', cell);

    expect(value(read, 'value')).toBe('$1,234.00');
    expect(value(read, 'ordinal')).toBe('7');
  });

  it('steps through a wrapper element the model declares', () => {
    // ASSL puts its <Annotation>s inside an <Annotations>; a rowset repeats
    // <ProviderType> bare. The model says which, and both have to work.
    const note = eClass('Note');
    note.addFeature(attribute('text', 'Text'));
    const owner = eClass('Owner');
    const notes = reference('notes', note, 'Annotation', true);
    annotate(notes, DAANSE_XMLA_URI, { wrapperElementName: 'Annotations' });
    owner.addFeature(notes);
    ePackage(`${NS}/wrapped`, owner, note);

    const read = readOne(
      '<Owner><Annotations><Annotation><Text>a</Text></Annotation><Annotation><Text>b</Text></Annotation></Annotations></Owner>',
      owner,
    );

    const collected = value(read, 'notes') as { size(): number; get(i: number): EObject };
    expect(collected.size()).toBe(2);
    expect(value(collected.get(0)!, 'text')).toBe('a');
    expect(value(collected.get(1)!, 'text')).toBe('b');
  });

  it('resolves a group alternative by element name, with no xsi:type on the wire', () => {
    // An Axis holds a SetType; what arrives is <Members> or <CrossProduct>. The
    // element name is the only thing that says which.
    const setType = eClass('SetType');
    setType.setAbstract(true);
    const members = eClass('MembersType', 'Members');
    members.getESuperTypes().push(setType);
    members.addFeature(attribute('member', 'Member'));
    const crossProduct = eClass('SetListType', 'CrossProduct');
    crossProduct.getESuperTypes().push(setType);
    crossProduct.addFeature(attribute('size', 'Size'));

    const axis = eClass('Axis');
    axis.addFeature(reference('set', setType, 'set'));
    ePackage(`${NS}/groups`, axis, setType, members, crossProduct);

    expect(value(readOne('<Axis><Members><Member>m</Member></Members></Axis>', axis), 'set')!.constructor).toBeTruthy();
    const cross = value(readOne('<Axis><CrossProduct><Size>3</Size></CrossProduct></Axis>', axis), 'set') as EObject;
    expect(cross.eClass().getName()).toBe('SetListType');
    expect(value(cross, 'size')).toBe('3');
  });

  it('finds a group alternative contributed by another package', () => {
    // NormTupleSet is in msxmla while its group SetType is in mddataset. This
    // is what SSAS answers when a client asks for an optimised response, as
    // Excel does, so the fallback across the registry is not a nicety.
    const setType = eClass('SetType');
    setType.setAbstract(true);
    const axis = eClass('Axis');
    axis.addFeature(reference('set', setType, 'set'));
    ePackage(`${NS}/home`, axis, setType);

    const foreign = eClass('NormTupleSet', 'NormTupleSet');
    foreign.getESuperTypes().push(setType);
    foreign.addFeature(attribute('tuples', 'Tuples'));
    const otherPackage = ePackage(`${NS}/foreign`, foreign);
    EPackageRegistry.INSTANCE.set(`${NS}/foreign`, otherPackage);
    registered.push(`${NS}/foreign`);

    const read = readOne('<Axis><NormTupleSet><Tuples>t</Tuples></NormTupleSet></Axis>', axis);

    expect((value(read, 'set') as EObject).eClass().getName()).toBe('NormTupleSet');
  });

  it('lets a child take its element name from its own data', () => {
    // A CellInfoItem is <FORMATTED_VALUE> because that is the property asked
    // for. The name is data, not schema.
    const property = eClass('CellInfoItem');
    property.addFeature(attribute('tagName', 'tagName', EcoreDataTypes.EString, 'attribute'));
    annotate(property, DAANSE_XMLA_URI, { elementNameFrom: 'tagName' });
    const info = eClass('CellInfo');
    info.addFeature(reference('items', property, 'items', true));
    ePackage(`${NS}/named`, info, property);

    const read = readOne('<CellInfo><FORMATTED_VALUE/><FONT_FLAGS/></CellInfo>', info);

    const items = value(read, 'items') as { size(): number; get(i: number): EObject };
    expect(items.size()).toBe(2);
    expect(value(items.get(0)!, 'tagName')).toBe('FORMATTED_VALUE');
    expect(value(items.get(1)!, 'tagName')).toBe('FONT_FLAGS');
  });

  it('skips an inline schema by namespace, whatever the unknown policy says', () => {
    // Skipping by namespace rather than by policy is what keeps FAIL meaning
    // what it says for everything else.
    const row = eClass('Row', 'row');
    row.addFeature(attribute('name', 'NAME'));
    ePackage(`${NS}/xsd`, row);

    const xml = `<row xmlns:xsd="http://www.w3.org/2001/XMLSchema">`
      + `<xsd:schema><xsd:element name="NAME" type="xsd:string"/></xsd:schema>`
      + `<NAME>kept</NAME></row>`;

    expect(value(readOne(xml, row, Unknown.FAIL), 'name')).toBe('kept');
  });

  it('fails on an element the model does not know, and says which', () => {
    const row = eClass('Row', 'row');
    row.addFeature(attribute('name', 'NAME'));
    ePackage(`${NS}/strict`, row);

    expect(() => readOne('<row><TYPO>x</TYPO></row>', row)).toThrow(XmlCodecError);
    expect(() => readOne('<row><TYPO>x</TYPO></row>', row)).toThrow(/TYPO/);
  });

  it('skips an unknown element when asked to, and keeps reading after it', () => {
    const row = eClass('Row', 'row');
    row.addFeature(attribute('name', 'NAME'));
    ePackage(`${NS}/lenient`, row);

    const read = readOne('<row><EXTRA><deep/></EXTRA><NAME>still here</NAME></row>', row, Unknown.SKIP);

    expect(value(read, 'name')).toBe('still here');
  });

  it('leaves a feature unset when its element is absent', () => {
    const row = eClass('Row', 'row');
    row.addFeature(attribute('name', 'NAME'));
    row.addFeature(attribute('description', 'DESCRIPTION'));
    ePackage(`${NS}/sparse`, row);

    const read = readOne('<row><NAME>x</NAME></row>', row);

    expect(read.eIsSet(read.eClass().getEStructuralFeature('name')!)).toBe(true);
    expect(read.eIsSet(read.eClass().getEStructuralFeature('description')!)).toBe(false);
  });

  it('reads an empty element as an empty string, which is not the same as absent', () => {
    const row = eClass('Row', 'row');
    row.addFeature(attribute('description', 'DESCRIPTION'));
    ePackage(`${NS}/empty`, row);

    const read = readOne('<row><DESCRIPTION/></row>', row);

    expect(value(read, 'description')).toBe('');
    expect(read.eIsSet(read.eClass().getEStructuralFeature('description')!)).toBe(true);
  });
});
