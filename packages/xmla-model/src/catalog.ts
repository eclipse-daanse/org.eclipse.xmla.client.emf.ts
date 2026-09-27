/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { wireNameOf } from '@eclipse-daanse/emf-xml';
import type { EClass, EClassifier, EPackage, EStructuralFeature } from '@emfts/core';

import type { XmlaModels } from './bootstrap.js';

/** The kinds of rowset, which is one model each - see docs/rowsets-tabular-vs-multidimensional.md. */
const KINDS = ['core', 'relational', 'multidimensional', 'mining', 'server', 'tabular'] as const;

const ROWSET_MODELS = KINDS.map((kind) => `rowset-${kind}`);

/** The annotation carrying the XMLA and OLE DB facts EMF has no idiom for. */
export const ROWSET_ANNOTATION = 'https://www.daanse.org/spec/xmla/rowset/1.0';

/** One restriction of one rowset: where it sits, what it is called, how it is typed. */
export interface Restriction {
  readonly ordinal: number;
  readonly name: string;
  readonly required: boolean;
}

/**
 * Maps a Discover request type to the EClass modelling its row, and back.
 *
 * Built by scanning the rowset package for the `requestType` annotation, so it
 * cannot fall behind the model - a rowset added there is callable here without
 * anything being written twice.
 */
export class RowsetCatalog {
  private readonly byRequestType = new Map<string, EClass>();
  private readonly requestTypeByClass = new Map<EClass, string>();
  private readonly restrictionsByRequestType = new Map<string, EClass>();

  constructor(models: XmlaModels) {
    // One package per kind of rowset - relational, multidimensional, mining, the
    // server's own DISCOVER_*, and the tabular TMSCHEMA_* family. A request type
    // belongs to exactly one of them, and which one it is says what it describes.
    for (const name of ROWSET_MODELS) {
      for (const eClass of classesOf(required(models, name))) {
        const requestType = detail(eClass, 'requestType');
        if (requestType === null) {
          continue;
        }
        // One package per kind holds both: what a rowset is, and what a request for
        // it may be restricted by. The annotation tells them apart, not the package.
        if (detail(eClass, 'role') === 'restrictions') {
          this.restrictionsByRequestType.set(requestType, eClass);
        } else {
          this.byRequestType.set(requestType, eClass);
          this.requestTypeByClass.set(eClass, requestType);
        }
      }
    }


  }

  /** Every request type the model describes, in model order. */
  requestTypes(): string[] {
    return [...this.byRequestType.keys()];
  }

  forRequestType(requestType: string): EClass | null {
    return this.byRequestType.get(requestType) ?? null;
  }

  requestTypeOf(eClass: EClass): string | null {
    return this.requestTypeByClass.get(eClass) ?? null;
  }

  /**
   * What a request of this type may be restricted by, as a class a client can
   * instantiate and fill. Null for the two rowsets no server advertises
   * restrictions for.
   */
  restrictionsClassFor(requestType: string): EClass | null {
    return this.restrictionsByRequestType.get(requestType) ?? null;
  }

  /** The OLE DB schema GUID, absent for rowsets no specification assigns one to. */
  guidOf(eClass: EClass): string | null {
    const guid = detail(eClass, 'guid');
    return guid === null || guid === '' ? null : guid;
  }

  /**
   * The rowset a client knows only by its GUID.
   *
   * A client resolves a rowset by name for the twenty-eight it hard-wires and by
   * `SchemaGuid` for every other - the column DISCOVER_SCHEMA_ROWSETS carries for
   * exactly that. Without this direction the GUIDs in the model are decoration.
   *
   * Case is free and braces are optional, because a GUID reaches this from a
   * client's own registry, a URL or a hand-typed restriction, and the three
   * disagree about both.
   */
  forGuid(guid: string): EClass | null {
    const wanted = normalizeGuid(guid);
    if (wanted === '') {
      return null;
    }
    for (const eClass of this.byRequestType.values()) {
      const own = this.guidOf(eClass);
      if (own !== null && normalizeGuid(own) === wanted) {
        return eClass;
      }
    }
    return null;
  }

  /**
   * Every GUID the model states, by request type.
   *
   * Not one per rowset: DMSCHEMA_MINING_MODEL_XML and
   * DMSCHEMA_MINING_MODEL_CONTENT_PMML genuinely share one, which is why
   * {@link forGuid} answers with the first and this answers with all of them.
   */
  guids(): ReadonlyMap<string, string> {
    const found = new Map<string, string>();
    for (const [requestType, eClass] of this.byRequestType) {
      const guid = this.guidOf(eClass);
      if (guid !== null) {
        found.set(requestType, guid);
      }
    }
    return found;
  }

  /** Where a GUID came from, which is how a wrong one is ever noticed. */
  guidSourceOf(eClass: EClass): string | null {
    return detail(eClass, 'guidSource');
  }

  /**
   * Where this rowset's column list comes from: `MS-SSAS-251031`,
   * `OLEDB-APPENDIX-B`, `INFERRED` or `PROPRIETARY`.
   */
  sourceOf(eClass: EClass): string | null {
    return detail(eClass, 'source');
  }

  /**
   * The restrictions this rowset accepts, in the order their ordinal gives them.
   *
   * The order is not presentation. `RestrictionsMask` in DISCOVER_SCHEMA_ROWSETS
   * is a bitmask over exactly these positions, and it is the order the live
   * servers state rather than the specification's prose table - the two differ
   * for ten rowsets, MDSCHEMA_CUBES and MDSCHEMA_MEMBERS among them.
   */
  restrictionsOf(requestType: string): Restriction[] {
    const eClass = this.restrictionsByRequestType.get(requestType);
    if (eClass === undefined) {
      return [];
    }
    // The class's own features, in declaration order. Inherited ones would shift
    // every ordinal after them and so change the mask.
    const own = list(eClass.getEStructuralFeatures()) as EStructuralFeature[];
    return own.map((feature, ordinal) => ({
      ordinal,
      name: wireNameOf(feature),
      required: featureDetail(feature, 'required') === 'true',
    }));
  }

  /**
   * The restrictions [MS-SSAS] marks `[Required]`, by wire name.
   *
   * Five rowsets carry them and live servers enforce them: MDSCHEMA_ACTIONS
   * without a CUBE_NAME answers a parse fault, not an empty rowset.
   */
  requiredRestrictionsOf(requestType: string): string[] {
    return this.restrictionsOf(requestType)
      .filter((restriction) => restriction.required)
      .map((restriction) => restriction.name);
  }

  /**
   * The `RestrictionsMask` for a rowset: bit *n* set for restriction *n*.
   *
   * A bigint because the wire type is `unsignedLong` and the count of
   * restrictions is not bounded by what a double can index exactly.
   *
   * Note what this mask does *not* say. In all 70 rows of a recorded
   * DISCOVER_SCHEMA_ROWSETS it is 2^n - 1, so it carries the number of
   * restrictions and nothing else - in particular it says nothing about which
   * are required.
   */
  restrictionsMaskOf(requestType: string): bigint {
    let mask = 0n;
    for (const restriction of this.restrictionsOf(requestType)) {
      mask |= 1n << BigInt(restriction.ordinal);
    }
    return mask;
  }
}

function required(models: XmlaModels, name: string): EPackage {
  const ePackage = models.named(name);
  if (ePackage === null) {
    throw new Error(`the ${name} model is not loaded, so the rowset catalogue cannot be built`);
  }
  return ePackage;
}

function classesOf(ePackage: EPackage): EClass[] {
  return (list(ePackage.getEClassifiers()) as EClassifier[]).filter(
    (classifier): classifier is EClass =>
      typeof (classifier as unknown as { getEStructuralFeatures?: unknown }).getEStructuralFeatures === 'function',
  );
}

/** Lower case, no braces - the three forms a GUID reaches us in, made one. */
function normalizeGuid(guid: string): string {
  return guid.trim().replace(/^\{|\}$/g, '').toLowerCase();
}

function detail(eClass: EClass, key: string): string | null {
  const annotation = eClass.getEAnnotation(ROWSET_ANNOTATION);
  if (annotation === null || annotation === undefined) {
    return null;
  }
  return annotation.getDetails().getByKey(key) ?? null;
}

function featureDetail(feature: EStructuralFeature, key: string): string | null {
  const annotation = feature.getEAnnotation(ROWSET_ANNOTATION);
  if (annotation === null || annotation === undefined) {
    return null;
  }
  return annotation.getDetails().getByKey(key) ?? null;
}

function list<T>(eList: { size(): number; get(index: number): T }): T[] {
  const items: T[] = [];
  for (let i = 0; i < eList.size(); i++) {
    items.push(eList.get(i)!);
  }
  return items;
}
