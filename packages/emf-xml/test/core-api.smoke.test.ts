/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  BasicEAnnotation,
  BasicEAttribute,
  BasicEClass,
  BasicEPackage,
  BasicEReference,
  BasicResourceSet,
  EcoreDataTypes,
  EcoreUtil,
  EPackageRegistry,
  EMD_ANNOTATION_URI,
  ExtendedMetaData,
  getEcorePackage,
  getXMLTypePackage,
  URI,
  XMIResource,
  type EClass,
  type EDataType,
  type EPackage,
  type EStructuralFeature,
} from '@emfts/core';

/**
 * Every API of `@emfts/core` this project builds on, exercised once.
 *
 * It exists because the design was read against snapshot 0.1.1-next.3 while the
 * dependency is 0.1.1-next.16. Anything that drifted has to fail here, before
 * something is built on top of it and fails somewhere less obvious.
 */
const EMD_URI = 'http:///org/eclipse/emf/ecore/util/ExtendedMetaData';

function annotate(
  target: { getEAnnotations(): { push(a: unknown): unknown } },
  source: string,
  details: Record<string, string>,
): void {
  const annotation = new BasicEAnnotation();
  annotation.setSource(source);
  for (const [key, value] of Object.entries(details)) {
    annotation.getDetails().putByKey(key, value);
  }
  target.getEAnnotations().push(annotation);
}

/** A package built entirely at runtime - the dynamic path in miniature. */
function buildDynamicPackage(): { pkg: EPackage; row: EClass; name: EStructuralFeature } {
  const row = new BasicEClass();
  row.setName('Row');
  annotate(row, EMD_URI, { name: 'row', kind: 'elementOnly' });

  const catalogName = new BasicEAttribute();
  catalogName.setName('catalogName');
  catalogName.setEType(EcoreDataTypes.EString);
  catalogName.setLowerBound(0);
  catalogName.setUpperBound(1);
  annotate(catalogName, EMD_URI, {
    kind: 'element',
    name: 'CATALOG_NAME',
    namespace: 'urn:schemas-microsoft-com:xml-analysis:rowset',
  });
  row.addFeature(catalogName);

  const nested = new BasicEClass();
  nested.setName('Restriction');
  const restrictions = new BasicEReference();
  restrictions.setName('restrictions');
  restrictions.setEType(nested);
  restrictions.setContainment(true);
  restrictions.setUpperBound(-1);
  row.addFeature(restrictions);

  const pkg = new BasicEPackage();
  pkg.setName('dyn');
  pkg.setNsPrefix('dyn');
  pkg.setNsURI('https://www.daanse.org/spec/xmla/rowset/dynamic/smoke/TEST');
  pkg.getEClassifiers().push(row, nested);

  return { pkg, row, name: catalogName };
}

describe('the core APIs this project depends on', () => {
  it('bootstraps Ecore and XMLType', () => {
    expect(getEcorePackage().getNsURI()).toBe('http://www.eclipse.org/emf/2002/Ecore');
    expect(getXMLTypePackage().getNsURI()).toBe('http://www.eclipse.org/emf/2003/XMLType');
  });

  it('builds a package, class, attribute and containment reference at runtime', () => {
    const { pkg, row } = buildDynamicPackage();

    expect(pkg.getEClassifier('Row')).toBe(row);
    expect(row.getEStructuralFeature('catalogName')).toBeTruthy();

    const restrictions = row.getEStructuralFeature('restrictions');
    expect(restrictions).toBeTruthy();
    expect(restrictions!.isMany()).toBe(true);
  });

  it('instantiates a runtime class and reflects over it', () => {
    const { pkg, row, name } = buildDynamicPackage();

    const instance = pkg.getEFactoryInstance().create(row);
    expect(instance.eClass()).toBe(row);
    expect(instance.eIsSet(name)).toBe(false);

    instance.eSet(name, 'Adventure Works');
    expect(instance.eGet(name)).toBe('Adventure Works');
    expect(instance.eIsSet(name)).toBe(true);

    // EcoreUtil.create is the other route to the same thing.
    expect(EcoreUtil.create(row).eClass()).toBe(row);
  });

  it('reads ExtendedMetaData off a runtime-built feature', () => {
    const { row } = buildDynamicPackage();
    const feature = row.getEStructuralFeature('catalogName')!;

    // Instantiated, not a singleton: this version exposes no INSTANCE.
    const emd = new ExtendedMetaData();
    expect(emd.getName(feature)).toBe('CATALOG_NAME');
    expect(emd.getFeatureKind(feature)).toBeTruthy();
    expect(EMD_ANNOTATION_URI).toBe(EMD_URI);
  });

  it('registers a package and finds it again by nsURI', () => {
    const { pkg } = buildDynamicPackage();
    const nsURI = pkg.getNsURI()!;

    EPackageRegistry.INSTANCE.set(nsURI, pkg);
    try {
      expect(EPackageRegistry.INSTANCE.getEPackage(nsURI)).toBe(pkg);
    } finally {
      EPackageRegistry.INSTANCE.delete(nsURI);
    }
  });

  it('loads an .ecore from a string into a live EPackage', async () => {
    const ecore = `<?xml version="1.0" encoding="UTF-8"?>
<ecore:EPackage xmlns:xmi="http://www.omg.org/XMI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmi:version="2.0"
    name="smoke" nsURI="https://www.daanse.org/smoke" nsPrefix="smoke">
  <eClassifiers xsi:type="ecore:EClass" name="Thing">
    <eStructuralFeatures xsi:type="ecore:EAttribute" name="label"
        eType="ecore:EDataType http://www.eclipse.org/emf/2002/Ecore#//EString"/>
  </eClassifiers>
</ecore:EPackage>`;

    const resourceSet = new BasicResourceSet();
    resourceSet.getPackageRegistry().set(getEcorePackage().getNsURI()!, getEcorePackage());
    const resource = new XMIResource(URI.createURI('smoke.ecore'));
    resource.setResourceSet(resourceSet);
    resource.loadFromString(ecore);

    const loaded = resource.getContents().get(0) as unknown as EPackage;
    expect(loaded.getNsURI()).toBe('https://www.daanse.org/smoke');

    const thing = loaded.getEClassifier('Thing') as EClass;
    expect(thing).toBeTruthy();
    // The one thing that makes runtime .ecore usable: it is a real BasicEClass,
    // so it can be instantiated rather than only inspected.
    const instance = loaded.getEFactoryInstance().create(thing);
    const label = thing.getEStructuralFeature('label')!;
    instance.eSet(label, 'hello');
    expect(instance.eGet(label)).toBe('hello');
  });

  it('carries the XMLType data types a rowset column needs', () => {
    const xmlType = getXMLTypePackage();
    for (const name of ['String', 'BooleanObject', 'IntObject', 'LongObject', 'DateTime', 'UnsignedLong']) {
      expect(xmlType.getEClassifier(name), `XMLType is missing ${name}`).toBeTruthy();
    }
  });

  /**
   * The reason this project ships its own value coder.
   *
   * XSD says `1` and `0` are boolean literals as much as `true` and `false`, and
   * XMLA uses them: `mustUnderstand="1"` decides whether a message may be
   * ignored at all. This library reads `'1'` as **false** - the converter is
   * resolved by instanceClassName and the `'1'`-aware one never runs.
   *
   * Asserted, not merely observed: if a later version fixes this, the failure
   * here is the signal that our own ValueCoder can be reconsidered.
   */
  it('reads the boolean literal 1 as false, which is why we ship a ValueCoder', () => {
    const xmlType = getXMLTypePackage();
    const factory = xmlType.getEFactoryInstance();

    for (const name of ['Boolean', 'BooleanObject']) {
      const type = xmlType.getEClassifier(name) as EDataType;

      expect(factory.createFromString(type, 'true'), name).toBe(true);
      expect(factory.createFromString(type, 'false'), name).toBe(false);
      // Both wrong per XSD 3.2.2 - '1' is true.
      expect(factory.createFromString(type, '1'), `${name} still misreads '1'`).toBe(false);
      expect(factory.createFromString(type, '0'), name).toBe(false);
    }
  });

  /**
   * A trap specific to this port: reading a many feature materialises its list,
   * and from that moment the feature counts as set - even though nothing was
   * added. The writer must therefore ask eIsSet *before* it ever touches eGet,
   * or a freshly created row emits every collection wrapper it has.
   */
  it('makes a many feature count as set merely by reading it', () => {
    const { pkg, row } = buildDynamicPackage();
    const restrictions = row.getEStructuralFeature('restrictions')!;
    const instance = pkg.getEFactoryInstance().create(row);

    expect(instance.eIsSet(restrictions), 'untouched').toBe(false);

    instance.eGet(restrictions);

    expect(instance.eIsSet(restrictions), 'eGet materialised the empty list').toBe(true);
  });
});
