/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { RowsetCatalog } from '../src/catalog.js';
import { bootstrapFromDisk } from '../src/node.js';

/**
 * The GUIDs a rowset is reachable by, and the tabular family that joined them.
 *
 * A client hard-wires twenty-eight request types by name. Every other rowset it
 * finds through the `SchemaGuid` column of DISCOVER_SCHEMA_ROWSETS, so a GUID
 * the model does not carry is a rowset half the API cannot reach - and a wrong
 * one points a client at some other rowset entirely, with nothing in a running
 * server to reveal it.
 */
let catalog: RowsetCatalog;

beforeAll(() => {
  catalog = new RowsetCatalog(bootstrapFromDisk());
});

/** Canonical 8-4-4-4-12. Case is free: clients parse case-insensitively. */
const SHAPE = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/**
 * The one duplicate that is not ours to fix: a real Analysis Services
 * advertises the same GUID on both of these, and dropping it from one would
 * make both unreachable rather than one.
 */
const SHARE_ONE_GUID = ['DMSCHEMA_MINING_MODEL_XML', 'DMSCHEMA_MINING_MODEL_CONTENT_PMML'];

describe('the GUIDs the model states', () => {
  it('are all shaped like GUIDs', () => {
    const malformed = [...catalog.guids()].filter(([, guid]) => !SHAPE.test(guid));

    expect(malformed).toEqual([]);
  });

  it('carry enough of them to matter', () => {
    // Not an exact count - the model gains rowsets. A floor, because the point
    // of the exercise was that 55 rowsets had none at all.
    expect(catalog.guids().size).toBeGreaterThan(60);
  });

  it('are unique, apart from the one pair that genuinely is not', () => {
    const seen = new Map<string, string[]>();
    for (const [requestType, guid] of catalog.guids()) {
      const key = guid.toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), requestType]);
    }
    const shared = [...seen.values()].filter((types) => types.length > 1);

    expect(shared).toHaveLength(1);
    expect([...shared[0]!].sort()).toEqual([...SHARE_ONE_GUID].sort());
  });
});

describe('finding a rowset by its GUID', () => {
  it('finds every rowset that states one', () => {
    for (const [requestType, guid] of catalog.guids()) {
      const found = catalog.forGuid(guid);

      expect(found, `${requestType} by ${guid}`).not.toBeNull();
      // The shared pair resolves to one of its two, which is all a client can
      // do with a GUID two rowsets answer to.
      const name = catalog.requestTypeOf(found!);
      if (!SHARE_ONE_GUID.includes(requestType)) {
        expect(name).toBe(requestType);
      }
    }
  });

  it('does not mind the case or the braces a client wraps it in', () => {
    const [requestType, guid] = [...catalog.guids()][0]!;

    expect(catalog.requestTypeOf(catalog.forGuid(guid.toUpperCase())!)).toBe(requestType);
    expect(catalog.requestTypeOf(catalog.forGuid(guid.toLowerCase())!)).toBe(requestType);
    expect(catalog.requestTypeOf(catalog.forGuid(`{${guid}}`)!)).toBe(requestType);
    expect(catalog.requestTypeOf(catalog.forGuid(` ${guid} `)!)).toBe(requestType);
  });

  it('answers nothing for a GUID no rowset carries', () => {
    expect(catalog.forGuid('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(catalog.forGuid('')).toBeNull();
    expect(catalog.forGuid('not a guid')).toBeNull();
  });

  it('says where a GUID came from, which is how a wrong one is noticed', () => {
    let attributed = 0;
    for (const requestType of catalog.requestTypes()) {
      const eClass = catalog.forRequestType(requestType)!;
      if (catalog.guidOf(eClass) !== null && catalog.guidSourceOf(eClass) !== null) {
        attributed += 1;
      }
    }

    expect(attributed, 'a GUID nobody can trace is a GUID nobody can check').toBeGreaterThan(60);
  });
});

describe('the tabular family', () => {
  it('is in the model, all forty-eight of it', () => {
    const tabular = catalog.requestTypes().filter((name) => name.startsWith('TMSCHEMA_'));

    expect(tabular).toHaveLength(48);
  });

  it('gives every one of them a name to be correlated by', () => {
    // AMO matches the 48 answers of one batch by position, but looks two of them
    // up by the `name` attribute of the rowset root - the singular ObjectType
    // name, Model and Partition. Without it the lookup returns nothing and the
    // whole batch is reported as a broken database.
    const names = new Set<string>();
    for (const requestType of catalog.requestTypes()) {
      if (!requestType.startsWith('TMSCHEMA_')) {
        continue;
      }
      const eClass = catalog.forRequestType(requestType)!;
      const annotation = eClass.getEAnnotation('https://www.daanse.org/spec/xmla/rowset/1.0');
      const rowsetName = annotation?.getDetails().getByKey('rowsetName');

      expect(rowsetName, `${requestType} states a rowsetName`).toBeTruthy();
      names.add(rowsetName!);
    }

    expect(names.size, 'and no two of them share it').toBe(48);
  });
});
