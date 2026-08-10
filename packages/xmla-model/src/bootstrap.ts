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
  BasicEDataType,
  BasicResourceSet,
  EPackageRegistry,
  getEcorePackage,
  getXMLTypePackage,
  URI,
  XMIResource,
} from '@emfts/core';
import type { EPackage } from '@emfts/core';

/** One `.ecore`, as text, with the nsURI it has to be registered under. */
export interface ModelSource {
  readonly name: string;
  readonly nsURI: string;
  readonly ecore: string;
}

export interface BootstrapOptions {
  /**
   * Also register every package in the global `EPackageRegistry`.
   *
   * On by default, and needed by the reader: a group alternative may live in
   * another package - `NormTupleSet` is in msxmla while its group `SetType` is
   * in mddataset - and the fallback search goes through the registry.
   */
  readonly registerGlobally?: boolean;
}

export interface XmlaModels {
  readonly resourceSet: BasicResourceSet;
  packageFor(nsURI: string): EPackage | null;
  named(name: string): EPackage | null;
  readonly names: readonly string[];
}

/**
 * The boxed wrapper data types EMF proper has and `@emfts/core` does not.
 *
 * Measured in M1: 106 features in `xmla.ecore` point at these, among them all of
 * `PropertyList` - `Timeout`, `LocaleIdentifier`, `MaximumRows` - which every
 * single request writes. Without them each of those features gets an unresolved
 * proxy for a type, and an unresolved type reads as an empty value rather than
 * raising anything.
 *
 * Restoring them is closing a gap in the library, not inventing a type. The
 * smoke test in `emf-xml` asserts the gap is still there, so when a later
 * version supplies them itself this goes away rather than shadowing theirs.
 */
const ECORE_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['EIntegerObject', 'java.lang.Integer'],
  ['EBooleanObject', 'java.lang.Boolean'],
  ['EDoubleObject', 'java.lang.Double'],
];

export function restoreEcoreWrappers(): string[] {
  const ecore = getEcorePackage();
  const added: string[] = [];
  for (const [name, instanceClassName] of ECORE_WRAPPERS) {
    if (ecore.getEClassifier(name) !== null && ecore.getEClassifier(name) !== undefined) {
      continue;
    }
    const dataType = new BasicEDataType();
    dataType.setName(name);
    dataType.setInstanceClassName(instanceClassName);
    ecore.getEClassifiers().push(dataType);
    added.push(name);
  }
  return added;
}

/**
 * Loads the models into a live registry.
 *
 * `sources` must be in topological order - cross-model types resolve through the
 * registry by nsURI, so a dependency has to be registered before the model using
 * it is read. `scripts/sync-ecore.mjs --check` enforces that order, and
 * `modelOrder` here is generated from the same file.
 */
export function bootstrap(sources: readonly ModelSource[], options: BootstrapOptions = {}): XmlaModels {
  restoreEcoreWrappers();

  const registerGlobally = options.registerGlobally ?? true;
  const resourceSet = new BasicResourceSet();
  const registry = resourceSet.getPackageRegistry();

  for (const builtin of [getEcorePackage(), getXMLTypePackage()]) {
    registry.set(builtin.getNsURI()!, builtin);
    if (registerGlobally) {
      EPackageRegistry.INSTANCE.set(builtin.getNsURI()!, builtin);
    }
  }

  const byNsURI = new Map<string, EPackage>();
  const byName = new Map<string, EPackage>();

  for (const source of sources) {
    const resource = new XMIResource(URI.createURI(`${source.name}.ecore`));
    resource.setResourceSet(resourceSet);
    resource.loadFromString(source.ecore);

    const ePackage = resource.getContents().get(0) as unknown as EPackage;
    const declared = ePackage.getNsURI();
    if (declared !== source.nsURI) {
      throw new Error(
        `${source.name}.ecore declares nsURI ${declared}, but it is registered as ${source.nsURI}`,
      );
    }

    registry.set(source.nsURI, ePackage);
    if (registerGlobally) {
      EPackageRegistry.INSTANCE.set(source.nsURI, ePackage);
    }
    byNsURI.set(source.nsURI, ePackage);
    byName.set(source.name, ePackage);
  }

  return {
    resourceSet,
    packageFor: (nsURI) => byNsURI.get(nsURI) ?? null,
    named: (name) => byName.get(name) ?? null,
    names: [...byName.keys()],
  };
}

/**
 * Every feature whose type did not resolve, as `Class.feature` paths.
 *
 * Worth asking after a bootstrap because the failure is otherwise silent: `eGet`
 * on a feature with an unresolved type returns rather than throwing, so a whole
 * missing model shows up as empty values much later.
 */
export function unresolvedFeatures(ePackage: EPackage): string[] {
  const damaged: string[] = [];
  const classifiers = ePackage.getEClassifiers();
  for (let i = 0; i < classifiers.size(); i++) {
    const classifier = classifiers.get(i)!;
    const asClass = classifier as unknown as {
      getName(): string;
      getEStructuralFeatures?: () => { size(): number; get(i: number): { getName(): string; getEType(): unknown } };
    };
    if (typeof asClass.getEStructuralFeatures !== 'function') {
      continue;
    }
    const features = asClass.getEStructuralFeatures();
    for (let j = 0; j < features.size(); j++) {
      const feature = features.get(j)!;
      const type = feature.getEType() as { eIsProxy?: () => boolean } | null | undefined;
      if (type === null || type === undefined || type.eIsProxy?.() === true) {
        damaged.push(`${asClass.getName()}.${feature.getName()}`);
      }
    }
  }
  return damaged;
}
