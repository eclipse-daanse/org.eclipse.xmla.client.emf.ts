/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/**
 * The snippets from the package READMEs, compiled.
 *
 * Nothing here runs and nothing ships. It exists so that a README which drifts
 * from the API it documents fails the build, rather than being discovered by
 * someone who copied it off npm.
 *
 * Keep each block next to the package it belongs to, and keep it identical to
 * what the README shows.
 */
import { EcoreXmlReader, EcoreXmlWriter, XmlCursor, XmlWriter } from '@eclipse-daanse/emf-xml';
import { RowsetCatalog } from '@eclipse-daanse/xmla-model';
import { bootstrapFromDisk } from '@eclipse-daanse/xmla-model/node';
import { bootstrapInBrowser } from '@eclipse-daanse/xmla-model/browser';
import { failIfFault, SoapEnvelopeCodec, writeDiscover } from '@eclipse-daanse/xmla-io';
import { FetchTransport, XmlaClient } from '@eclipse-daanse/xmla-client';
import { RowsetResolver } from '@eclipse-daanse/xmla-dynamic';
import { toCellset, toParsedRowset, WorkbenchXmlaClient } from '@eclipse-daanse/xmla-workbench-adapter';
import type { EClass, EObject } from '@emfts/core';

declare const xml: string;
declare const someEClass: EClass;
declare const namespaceUri: string;
declare const responseXml: string;
declare const mdx: string;
declare const serverKey: string;
declare const properties: EObject | null;
declare const headers: readonly EObject[];
declare const codec: SoapEnvelopeCodec;

/** packages/emf-xml/README.md */
export function emfXml(): void {
  const root = new EcoreXmlReader().read(XmlCursor.parse(xml), someEClass);

  const out = new XmlWriter();
  new EcoreXmlWriter(namespaceUri).write(out, root, 'root');
}

/** packages/xmla-model/README.md */
export function xmlaModel(): RowsetCatalog[] {
  const fromDisk = bootstrapFromDisk();
  const inBrowser = bootstrapInBrowser();
  return [new RowsetCatalog(fromDisk), new RowsetCatalog(inBrowser)];
}

/** packages/xmla-io/README.md */
export function xmlaIo(): string {
  const body = codec.write(headers, (out) => {
    writeDiscover(out, {
      requestType: 'MDSCHEMA_CUBES',
      restrictions: [{ name: 'CATALOG_NAME', value: 'Foodmart' }],
      properties,
    });
  });

  failIfFault(responseXml);
  return body;
}

/** packages/xmla-client/README.md */
export async function xmlaClient(): Promise<unknown> {
  const { client, info } = await new XmlaClient({
    url: 'https://server/xmla',
    transport: new FetchTransport(),
    models: bootstrapInBrowser(),
  }).open();

  const { rows } = await client.discover('MDSCHEMA_CUBES', [
    { name: 'CATALOG_NAME', value: 'Foodmart' },
  ]);
  return { rows, info };
}

/** packages/xmla-dynamic/README.md */
export async function xmlaDynamic(client: XmlaClient, catalog: RowsetCatalog): Promise<unknown> {
  const resolver = new RowsetResolver(catalog, serverKey);

  const body = await client.discoverRaw('SOME_VENDOR_ROWSET');
  const resolved = resolver.resolve('SOME_VENDOR_ROWSET', client.schemaOf(body));
  const { rows } = client.readRows(body, resolved.rowClass);
  return rows;
}

/** packages/xmla-workbench-adapter/README.md */
export async function workbenchAdapter(url: string, transport: FetchTransport): Promise<unknown> {
  const workbench = new WorkbenchXmlaClient({ url, transport, models: bootstrapInBrowser() });
  const { catalogs } = await workbench.connect();

  const cubes = await workbench.discover('MDSCHEMA_CUBES');
  const cellset = await workbench.execute(mdx);
  return { catalogs, cubes, cellset, toCellset, toParsedRowset };
}
