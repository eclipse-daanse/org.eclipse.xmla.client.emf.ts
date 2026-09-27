# @eclipse-daanse/xmla-workbench-adapter

Plain records and cellsets over the EObject client, so mdx-workbench can swap its SOAP client for one line.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF. The Ecore models are the only description of the
protocol: reading and writing run over `ExtendedMetaData` and reflection rather
than hand-written XML per rowset.

## Install

```bash
npm install @eclipse-daanse/xmla-workbench-adapter@next
```

## What it does

Plain records and cellsets over the EObject client.

Everything else in this project hands back `EObject`s, because that is what makes
a nested rowset render as a table rather than as a JSON blob. This is the one
place that flattens them, so a consumer can change one import instead of being
rewritten.

```ts
import { WorkbenchXmlaClient, toCellset, toParsedRowset } from '@eclipse-daanse/xmla-workbench-adapter';

const workbench = new WorkbenchXmlaClient({ url, transport, models });
const { catalogs } = await workbench.connect();

const cubes = await workbench.discover('MDSCHEMA_CUBES');   // plain records
const cellset = await workbench.execute(mdx);               // XmlaCellset
```

`toParsedRowset(rows)` and `toCellset(dataset)` do the same conversion on results
obtained elsewhere. `UnsupportedResponseShapeError` is thrown rather than guessed
at, so a response shape nobody anticipated fails where it happens.

## Status

Prerelease, published under the `next` tag. The API is not settled.

## License

EPL-2.0
