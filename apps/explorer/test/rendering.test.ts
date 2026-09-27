/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
// @vitest-environment happy-dom
import { EcoreXmlReader, EventKind, Unknown, XmlCursor } from '@eclipse-daanse/emf-xml';
import { UIModelComposer } from '@eclipse-daanse/vendor-uimodel-composer';
import { RowsetCatalog, XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import { bootstrapFromDisk } from '@eclipse-daanse/xmla-model/node';
import { conversation } from '@eclipse-daanse/xmla-testkit';
import type { XmlaModels } from '@eclipse-daanse/xmla-model';
import type { EClass, EObject } from '@emfts/core';
import { EmftsRendererPlugin } from '@emfts/vue-registry';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { h } from 'vue';

import RowsetTable from '../src/RowsetTable.vue';
import TableViewRenderer from '../src/TableViewRenderer.vue';
import { composerRegistry, formViewForEClass, ROWS_KEY, tableViewForEClass } from '../src/ui-model.js';
import { registerXmlaWidgets, REGISTERED_TYPE_NAMES } from '../src/widgets.js';

/**
 * The composer actually rendering, in a DOM.
 *
 * Everything else about the UI is checked by looking at the model it builds,
 * which says the model is well formed and nothing about whether anything
 * appears on a screen. `TableViewComposer` in particular renders a **silent
 * empty placeholder** when no `TableViewRenderer` is registered, so a grid that
 * shows nothing is exactly what a passing model test would have hidden.
 */
let models: XmlaModels;
let catalog: RowsetCatalog;

beforeAll(() => {
  models = bootstrapFromDisk();
  catalog = new RowsetCatalog(models);
  registerXmlaWidgets();
});

/** The registry the explorer uses, built where the explorer builds it. */
function registryWithGrid() {
  return composerRegistry(TableViewRenderer);
}

function readRows(xml: string, rowClass: EClass): EObject[] {
  const cursor = XmlCursor.parse(xml);
  let kind = cursor.next();
  while (kind !== null && cursor.localName !== 'root') {
    kind = cursor.next();
  }
  const reader = new EcoreXmlReader({ unknown: Unknown.FAIL });
  const rows: EObject[] = [];
  let depth = 0;
  kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START) {
      if (depth === 0 && cursor.localName === 'row') {
        rows.push(reader.read(cursor, rowClass));
      } else if (depth === 0 && cursor.namespaceURI === XMLA_NAMESPACES.XSD) {
        cursor.skipSubtree();
      } else {
        depth += 1;
      }
    } else if (kind === EventKind.END) {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    }
    kind = cursor.next();
  }
  return rows;
}

function responseFor(requestType: string): string {
  for (const name of ['ssms-connect', 'excel-pivot', 'powerbi-live']) {
    const each = conversation(name);
    let pending: string | undefined;
    for (const message of each.messages) {
      if (message.direction === 'request') {
        pending = message.requestType;
        continue;
      }
      if (pending === requestType && message.rows !== undefined) {
        return each.text(message.file);
      }
      pending = undefined;
    }
  }
  throw new Error(`no recorded ${requestType}`);
}

describe('a restrictions form, rendered', () => {
  it('puts a real input on the page for every restriction', async () => {
    const requestType = 'MDSCHEMA_CUBES';
    const eClass = catalog.restrictionsClassFor(requestType)!;
    const built = formViewForEClass(eClass, catalog.requiredRestrictionsOf(requestType));

    const wrapper = mount(UIModelComposer, {
      props: {
        uiModel: built.uiModel as never,
        model: built.instance as never,
        composerRegistry: registryWithGrid() as never,
      },
      global: { plugins: [EmftsRendererPlugin], provide: { [ROWS_KEY as symbol]: () => [] } },
    });

    const inputs = wrapper.findAll('input, select, textarea');
    expect(inputs.length, 'one control per restriction').toBe(
      catalog.restrictionsOf(requestType).length,
    );
    // The labels a user reads are the wire names. The registry's own editors
    // label with the feature name - catalogName - and what anyone recognises is
    // CATALOG_NAME: it is what [MS-SSAS] calls it and what the server returns.
    for (const restriction of catalog.restrictionsOf(requestType)) {
      expect(wrapper.text(), 'the wire name, not the feature name').toContain(restriction.name);
    }
    expect(wrapper.text(), 'the feature name is not what is shown').not.toContain('catalogName');
  });

  it('writes what is typed back into the EObject, through the feature', async () => {
    // The whole reason a widget holds the EStructuralFeature and not its name.
    const eClass = catalog.restrictionsClassFor('MDSCHEMA_CUBES')!;
    const built = formViewForEClass(eClass);

    const wrapper = mount(UIModelComposer, {
      props: {
        uiModel: built.uiModel as never,
        model: built.instance as never,
        composerRegistry: registryWithGrid() as never,
      },
      global: { plugins: [EmftsRendererPlugin], provide: { [ROWS_KEY as symbol]: () => [] } },
    });

    const first = wrapper.findAll('input')[0]!;
    const feature = eClass.getEStructuralFeatures().get(0)!;

    await first.setValue('Adventure Works');
    expect(built.instance.eGet(feature)).toBe('Adventure Works');

    // Clearing unsets rather than setting the empty string. Those are different
    // restrictions - one asks for everything, the other for rows whose column
    // is empty - and the reader and writer take care to keep them apart.
    await first.setValue('');
    expect(built.instance.eIsSet(feature), 'cleared means unset').toBe(false);
  });
});

describe('every restriction the catalogue has', () => {
  it('has a widget registered for its type', () => {
    // Measured rather than assumed: 75 of the 440 restriction features are not
    // String, over nine data types, and the registry's own editors are keyed on
    // Ecore's data types rather than on the XMLType ones the models use. One
    // restriction in six would otherwise be unfillable, silently.
    //
    // 440 since DBSCHEMA_TRUSTEE joined the model with its four. The tabular
    // package adds none: its restrictions live in a model of their own, which
    // the catalogue does not scan.
    const missing = new Set<string>();
    let total = 0;
    for (const requestType of catalog.requestTypes()) {
      const eClass = catalog.restrictionsClassFor(requestType);
      if (eClass === null) {
        continue;
      }
      const features = eClass.getEStructuralFeatures();
      for (let i = 0; i < features.size(); i++) {
        total += 1;
        const name = features.get(i)!.getEType()?.getName() ?? '?';
        if (!REGISTERED_TYPE_NAMES.includes(name)) {
          missing.add(name);
        }
      }
    }
    expect(total).toBe(440);
    expect([...missing], 'types with no editor').toEqual([]);
  });

  // Mounting every form in the catalogue is a sweep, and a sweep takes longer
  // than a default timeout allows. It is worth the seconds: it is the only
  // thing that says no rowset renders blank.
  it('renders every restriction of every rowset, with nothing left blank', { timeout: 60_000 }, () => {
    let forms = 0;
    for (const requestType of catalog.requestTypes()) {
      const eClass = catalog.restrictionsClassFor(requestType);
      if (eClass === null) {
        continue;
      }
      const built = formViewForEClass(eClass);
      const wrapper = mount(UIModelComposer, {
        props: {
          uiModel: built.uiModel as never,
          model: built.instance as never,
          composerRegistry: registryWithGrid() as never,
        },
        global: { plugins: [EmftsRendererPlugin], provide: { [ROWS_KEY as symbol]: () => [] } },
      });
      expect(wrapper.findAll('input, select, textarea').length, requestType).toBe(
        eClass.getEStructuralFeatures().size(),
      );
      forms += 1;
    }
    expect(forms, 'rowsets with restrictions').toBeGreaterThan(60);
  });
});

describe('a rowset, rendered', () => {
  it('renders through the composer, not beside it', async () => {
    // TableViewComposer delegates to the registry key TableViewRenderer and
    // renders an empty placeholder when nothing is registered. This is the test
    // that tells those two apart.
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const rows = readRows(responseFor('DBSCHEMA_CATALOGS'), rowClass);
    const built = tableViewForEClass(rowClass);

    const wrapper = mount(UIModelComposer, {
      props: {
        uiModel: built.uiModel as never,
        model: rows[0] as never,
        composerRegistry: registryWithGrid() as never,
      },
      global: { plugins: [EmftsRendererPlugin], provide: { [ROWS_KEY as symbol]: () => rows } },
    });

    expect(wrapper.findAll('table').length, 'a grid appeared').toBeGreaterThan(0);
    expect(wrapper.findAll('tbody tr').length, 'a row per row').toBe(rows.length);
    expect(wrapper.text()).toContain('CATALOG_NAME');
  });

  it('renders nothing but a placeholder when no grid is registered', async () => {
    // Recorded rather than asserted away: this is the failure mode the test
    // above exists to catch, and it is silent.
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const rows = readRows(responseFor('DBSCHEMA_CATALOGS'), rowClass);
    const built = tableViewForEClass(rowClass);

    const wrapper = mount(UIModelComposer, {
      props: { uiModel: built.uiModel as never, model: rows[0] as never },
      global: { plugins: [EmftsRendererPlugin], provide: { [ROWS_KEY as symbol]: () => rows } },
    });

    expect(wrapper.findAll('table').length, 'nothing rendered').toBe(0);
  });

  it('shows an unset column as NULL and an empty one as empty', async () => {
    // Two different things, and a grid that showed both as blank would lose the
    // distinction the reader and writer take such care over.
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const factory = rowClass.getEPackage()!.getEFactoryInstance();

    const withEmpty = factory.create(rowClass);
    withEmpty.eSet(rowClass.getEStructuralFeature('catalogName')!, 'Named');
    withEmpty.eSet(rowClass.getEStructuralFeature('description')!, '');

    const wrapper = mount(RowsetTable, {
      props: { columns: tableViewForEClass(rowClass).columns, rows: [withEmpty] },
    });

    const text = wrapper.text();
    expect(text).toContain('Named');
    expect(text, 'the columns never set').toContain('NULL');
    // The empty one is present but blank: it is not reported as NULL.
    const cells = wrapper.findAll('tbody td');
    const description = tableViewForEClass(rowClass).columns.findIndex((c) => c.label === 'DESCRIPTION');
    expect(cells[description]!.text(), 'set to the empty string').toBe('');
  });

  it('folds a nested rowset into an inner table', async () => {
    // What a Record<string, unknown> renderer cannot do, and the reason
    // EObjects are carried as far as the UI.
    const rowClass = catalog.forRequestType('DISCOVER_SCHEMA_ROWSETS')!;
    const rows = readRows(responseFor('DISCOVER_SCHEMA_ROWSETS'), rowClass);

    const wrapper = mount(RowsetTable, {
      props: { columns: tableViewForEClass(rowClass).columns, rows },
    });

    expect(wrapper.findAll('table table').length, 'a table inside a table').toBeGreaterThan(0);
    expect(wrapper.text()).toContain('Restrictions');
  });

  it('renders a class the server described just as readily as one from a model', async () => {
    // The claim the whole second path rests on, now on a page rather than in an
    // object graph.
    const { DynamicModelRegistry } = await import('@eclipse-daanse/xmla-dynamic');
    const xml = responseFor('DBSCHEMA_CATALOGS');
    const cursor = XmlCursor.parse(xml);
    let kind = cursor.next();
    while (kind !== null && !(kind === EventKind.START && cursor.namespaceURI === XMLA_NAMESPACES.XSD)) {
      kind = cursor.next();
    }
    const schema = cursor.rawElement();

    const dynamic = new DynamicModelRegistry('http://server/xmla').learn('ANYTHING', schema);
    const rows = readRows(xml, dynamic.rowClass);

    const wrapper = mount(RowsetTable, {
      props: { columns: tableViewForEClass(dynamic.rowClass).columns, rows },
    });

    expect(wrapper.findAll('tbody tr').length).toBe(rows.length);
    expect(wrapper.text()).toContain('CATALOG_NAME');
  });
});

describe('the whole screen', () => {
  it('mounts with a form and a grid together', async () => {
    const rowClass = catalog.forRequestType('DBSCHEMA_CATALOGS')!;
    const rows = readRows(responseFor('DBSCHEMA_CATALOGS'), rowClass);
    const form = formViewForEClass(catalog.restrictionsClassFor('DBSCHEMA_CATALOGS')!);
    const table = tableViewForEClass(rowClass);

    const wrapper = mount(
      {
        setup() {
          const registry = registryWithGrid();
          return () => [
            h(UIModelComposer, { uiModel: form.uiModel, model: form.instance }),
            h(UIModelComposer, {
              uiModel: table.uiModel,
              model: rows[0],
              composerRegistry: registry,
            }),
          ];
        },
      },
      { global: { plugins: [EmftsRendererPlugin], provide: { [ROWS_KEY as symbol]: () => rows } } },
    );

    expect(wrapper.findAll('input').length, 'the restrictions form').toBeGreaterThan(0);
    expect(wrapper.findAll('tbody tr').length, 'the rows').toBe(rows.length);
  });
});
