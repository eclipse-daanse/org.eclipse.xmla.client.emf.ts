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

import { RowsetCatalog } from '../src/catalog.js';
import { bootstrapInBrowser, modelSources as browserSources } from '../src/browser.js';
import { modelSources as diskSources } from '../src/node.js';
import { unresolvedFeatures } from '../src/bootstrap.js';

/**
 * The inlined models against the ones on disk.
 *
 * Two ways of loading the same thing is two things that can drift, and the
 * drift would be silent: the browser would bootstrap happily against a stale
 * model and read rows that no longer match what the server sends.
 */
describe('the inlined models', () => {
  it('are byte-identical to the files', () => {
    const inlined = new Map(browserSources(true).map((source) => [source.name, source.ecore]));
    const onDisk = diskSources(true);

    expect(inlined.size, 'model count').toBe(onDisk.length);
    for (const source of onDisk) {
      expect(inlined.get(source.name), `${source.name}.ecore`).toBe(source.ecore);
    }
  });

  it('leave out the same optional models by default', () => {
    expect(browserSources().map((source) => source.name)).toEqual(
      diskSources().map((source) => source.name),
    );
  });

  it('bootstrap into a registry with nothing unresolved but the engine features', () => {
    const models = bootstrapInBrowser();

    for (const name of models.names) {
      if (name === 'xmla') {
        continue;
      }
      expect(unresolvedFeatures(models.named(name)!), name).toEqual([]);
    }
    expect(unresolvedFeatures(models.named('xmla')!)).toHaveLength(18);
  });

  it('carry a working rowset catalogue, which is what the UI asks of them', () => {
    const catalog = new RowsetCatalog(bootstrapInBrowser());

    expect(catalog.requestTypes().length).toBeGreaterThan(50);
    expect(catalog.forRequestType('MDSCHEMA_CUBES')).toBeTruthy();
    expect(catalog.restrictionsOf('MDSCHEMA_CUBES').length).toBeGreaterThan(0);
  });
});
