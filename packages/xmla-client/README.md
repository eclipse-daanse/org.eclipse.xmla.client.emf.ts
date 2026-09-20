# @daanse/xmla-client

Talks to an XMLA server: transport, authentication, sessions, discover and execute.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF. The Ecore models are the only description of the
protocol: reading and writing run over `ExtendedMetaData` and reflection rather
than hand-written XML per rowset.

## Install

```bash
npm install @daanse/xmla-client@next
```

## What it does

Talks to an XMLA endpoint: transport, authentication, sessions, Discover and
Execute.

```ts
import { XmlaClient, FetchTransport } from '@daanse/xmla-client';
import { bootstrapInBrowser } from '@daanse/xmla-model/browser';

const { client, info } = await new XmlaClient({
  url: 'https://server/xmla',
  transport: new FetchTransport(),
  models: bootstrapInBrowser(),
}).open();

const { rows } = await client.discover('MDSCHEMA_CUBES', [
  { name: 'CATALOG_NAME', value: 'Foodmart' },
]);
```

Rows come back as `EObject`s of the class the model names for that rowset.

The client is immutable. `withSession`, `withCredentials` and
`withConnectionProperties` hand back a new client rather than changing one a
caller is already using.

`open()` runs the sequence a server expects — the capability probe, the data
source whose `DataSourceInfo` every later request has to carry, then a liveness
probe. `discoverRaw` exists for a rowset the model does not describe: the schema
travels in the response, so the body comes back unread and `readRows` is called
once there is a class for it. One round trip, not two.

## Status

Prerelease, published under the `next` tag. The API is not settled.

## License

EPL-2.0
