/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { bootstrapFromDisk } from '@eclipse-daanse/xmla-model/node';
import { conversation, FixtureTransport } from '@eclipse-daanse/xmla-testkit';
import type { XmlaModels } from '@eclipse-daanse/xmla-model';
import type { EObject, EStructuralFeature } from '@emfts/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { ExplorerSession, toEntries } from '../src/session.js';
import { formViewForEClass, tableViewForEClass } from '../src/ui-model.js';
import { RowsetCatalog } from '@eclipse-daanse/xmla-model';

/**
 * The acceptance the plan asks of the UI: a recorded transport, a session, rows
 * back, and a table description a grid can render - without the screens ever
 * knowing a rowset by name.
 */
let models: XmlaModels;
let catalog: RowsetCatalog;

beforeAll(() => {
  models = bootstrapFromDisk();
  catalog = new RowsetCatalog(models);
});

function responseFor(requestType: string): string {
  for (const name of ['ssms-connect', 'excel-pivot', 'powerbi-live', 'powerbi-import', 'ssms-session']) {
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

function sessionAnswering(...responses: string[]): { session: ExplorerSession; transport: FixtureTransport } {
  const transport = FixtureTransport.answering(...responses);
  return {
    session: new ExplorerSession({ url: 'http://server/xmla', transport, models }),
    transport,
  };
}

/**
 * The composer's generated model holds its children in plain arrays and reads
 * them as properties, so the tests walk it the same way the composer does.
 */
function componentsOf(uiModel: EObject): Array<EObject & Record<string, unknown>> {
  return (uiModel as unknown as { components: Array<EObject & Record<string, unknown>> }).components;
}

function widgetsOf(uiModel: EObject): Array<EObject & Record<string, unknown>> {
  const form = componentsOf(uiModel)[0]!;
  return (form as unknown as { fields: Array<EObject & Record<string, unknown>> }).fields;
}

function featureOf(widget: EObject): EStructuralFeature {
  return (widget as unknown as { feature: EStructuralFeature }).feature;
}

function labelOf(widget: EObject): string {
  return String((widget as unknown as { label: string }).label);
}

describe('the UIModel a restrictions class produces', () => {
  it('is an EObject tree the composer can render, not a description of our own', () => {
    // The whole reason for vendoring the composer: the UI is itself a model.
    const eClass = catalog.restrictionsClassFor('MDSCHEMA_CUBES')!;
    const built = formViewForEClass(eClass, catalog.requiredRestrictionsOf('MDSCHEMA_CUBES'));

    expect(built.uiModel.eClass().getName()).toBe('UIModel');
    const components = componentsOf(built.uiModel);
    expect(components).toHaveLength(1);
    // FormView is one of the keys UIModelComposer dispatches on.
    expect(components[0]!.eClass().getName()).toBe('FormView');
  });

  it('gives every widget the EStructuralFeature itself, not its name', () => {
    // What makes this work for a class the server described a moment ago and
    // that nobody could have written a name for.
    const eClass = catalog.restrictionsClassFor('MDSCHEMA_CUBES')!;
    const widgets = widgetsOf(formViewForEClass(eClass).uiModel);

    expect(widgets.length).toBeGreaterThan(0);
    for (const widget of widgets) {
      const feature = featureOf(widget);
      expect(typeof feature.getName).toBe('function');
      expect(feature.getEContainingClass?.()).toBe(eClass);
      expect(labelOf(widget), 'the wire name, which is what a user recognises').not.toBe('');
    }
  });

  it('chooses the widget class from the data type', () => {
    const eClass = catalog.restrictionsClassFor('MDSCHEMA_CUBES')!;
    const kinds = new Set(widgetsOf(formViewForEClass(eClass).uiModel).map((w) => w.eClass().getName()));

    for (const kind of kinds) {
      expect(['InputWidget', 'NumberWidget', 'CheckboxWidget', 'DateWidget']).toContain(kind);
    }
  });

  it('keeps the restrictions in the order the mask is defined over', () => {
    const requestType = 'MDSCHEMA_CUBES';
    const widgets = widgetsOf(formViewForEClass(catalog.restrictionsClassFor(requestType)!).uiModel);

    expect(widgets.map((widget) => labelOf(widget))).toEqual(
      catalog.restrictionsOf(requestType).map((restriction) => restriction.name),
    );
  });

  it('turns a filled-in form into wire entries, and leaves the blanks out', () => {
    const eClass = catalog.restrictionsClassFor('MDSCHEMA_CUBES')!;
    const instance = eClass.getEPackage()!.getEFactoryInstance().create(eClass);
    const first = eClass.getEStructuralFeatures().get(0)!;
    instance.eSet(first, 'Adventure Works');

    const entries = toEntries(instance);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.value).toBe('Adventure Works');
  });
});

describe('the table a row class produces', () => {
  it('is a TableView the composer knows, with columns this project renders', () => {
    const built = tableViewForEClass(catalog.forRequestType('MDSCHEMA_CUBES')!);

    expect(componentsOf(built.uiModel)[0]!.eClass().getName()).toBe('TableView');
    expect(built.columns.length).toBeGreaterThan(0);
  });

  it('describes a nested rowset as an inner table, not as a blob', () => {
    const built = tableViewForEClass(catalog.forRequestType('DISCOVER_SCHEMA_ROWSETS')!);
    const nested = built.columns.find((column) => column.widget === 'table');

    expect(nested, 'Restrictions is a nested rowset').toBeTruthy();
    expect(nested!.nested!.map((column) => column.label)).toContain('Name');
  });

  it('carries the documentation the static models hold', () => {
    const built = tableViewForEClass(catalog.forRequestType('MDSCHEMA_CUBES')!);

    expect(built.columns.some((column) => column.documentation !== null)).toBe(true);
  });
});

describe('running a rowset the model knows', () => {
  it('answers rows and a table to render them with', async () => {
    const { session } = sessionAnswering(responseFor('DBSCHEMA_CATALOGS'));

    const result = await session.run('DBSCHEMA_CATALOGS', null);

    expect(result.origin).toBe('static');
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.table.columns.map((column) => column.label)).toContain('CATALOG_NAME');
    expect(result.inlineSchema).toBeTruthy();
  });

  it('asks the server once, not twice', async () => {
    // The class to read with and the schema to build one from arrive in the
    // same response, so a second request would be asking for what is in hand.
    const { session, transport } = sessionAnswering(responseFor('DBSCHEMA_CATALOGS'));

    await session.run('DBSCHEMA_CATALOGS', null);

    expect(transport.sent).toHaveLength(1);
  });
});

describe('running a rowset the model has never seen', () => {
  it('builds a class from the response and renders it the same way', async () => {
    // The whole reason for the second path. Nothing in the screens branches on
    // where the class came from; origin is a badge, not a switch.
    const { session } = sessionAnswering(responseFor('DBSCHEMA_CATALOGS'));

    const result = await session.run('DISCOVER_M_EXPRESSIONS', null);

    expect(result.origin).toBe('dynamic');
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.table.columns.length).toBeGreaterThan(0);
    expect(result.table.columns.every((column) => column.label !== '')).toBe(true);
  });

  it('describes its columns in the same shape as a modelled one', async () => {
    const known = sessionAnswering(responseFor('DISCOVER_SCHEMA_ROWSETS'));
    const unknown = sessionAnswering(responseFor('DISCOVER_SCHEMA_ROWSETS'));

    const fromModel = await known.session.run('DISCOVER_SCHEMA_ROWSETS', null);
    const fromServer = await unknown.session.run('DISCOVER_M_EXPRESSIONS', null);

    expect(fromModel.origin).toBe('static');
    expect(fromServer.origin).toBe('dynamic');
    // Same shape, same keys, same nesting - which is what lets one grid render
    // both.
    expect(Object.keys(fromModel.table)).toEqual(Object.keys(fromServer.table));
    expect(fromServer.table.uiModel.eClass().getName()).toBe('UIModel');
    expect(fromServer.table.columns.some((column) => column.widget === 'table')).toBe(true);
  });
});

describe('the rowset list', () => {
  it('offers what the model knows plus what the server declares', async () => {
    const { session } = sessionAnswering(responseFor('DISCOVER_SCHEMA_ROWSETS'));

    const offered = await session.rowsets();
    const names = offered.map((entry) => entry.requestType);

    expect(names).toContain('MDSCHEMA_CUBES');
    expect(names.length).toBeGreaterThanOrEqual(catalog.requestTypes().length);
    expect(offered.every((entry) => entry.requestType !== '')).toBe(true);
  });

  it('still lists the modelled rowsets when the server will not describe itself', async () => {
    const transport = FixtureTransport.answering();
    const session = new ExplorerSession({ url: 'http://server/xmla', transport, models });

    const offered = await session.rowsets();

    expect(offered.length).toBe(catalog.requestTypes().length);
  });
});

describe('a session', () => {
  it('opens, carries its id, and closes', async () => {
    const each = conversation('ssms-session');
    const begin = each.messages.find(
      (message) => message.direction === 'response' && message.file.includes('BeginSession'),
    )!;
    const end = each.messages.find(
      (message) => message.direction === 'response' && message.file.includes('EndSession'),
    );

    const transport = FixtureTransport.answering(
      each.text(begin.file),
      responseFor('DBSCHEMA_CATALOGS'),
      end === undefined ? each.text(begin.file) : each.text(end.file),
    );
    const session = new ExplorerSession({ url: 'http://server/xmla', transport, models });

    await session.openSession();
    expect(session.sessionId).toBeTruthy();

    await session.run('DBSCHEMA_CATALOGS', null);
    expect(transport.sent[1]!.body).toContain(`SessionId="${session.sessionId}"`);

    await session.closeSession();
    expect(session.sessionId).toBeNull();
  });
});
