# @daanse/xmla-dynamic

Builds Ecore models at runtime from what a server says about itself, so an unknown rowset is still queryable.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF. The Ecore models are the only description of the
protocol: reading and writing run over `ExtendedMetaData` and reflection rather
than hand-written XML per rowset.

## Install

```bash
npm install @daanse/xmla-dynamic@next
```

## What it does

Builds Ecore models at runtime from what a server says about itself, so a rowset
this client has never seen is still queryable and renderable.

```ts
import { RowsetResolver, parseInlineSchema, buildRowClass } from '@daanse/xmla-dynamic';

const resolver = new RowsetResolver(catalog, serverKey);

// discoverRaw hands back the response body unread, because the schema needed
// to build a class for these rows travels inside it.
const body = await client.discoverRaw('SOME_VENDOR_ROWSET');
const resolved = resolver.resolve('SOME_VENDOR_ROWSET', client.schemaOf(body));
const { rows } = client.readRows(body, resolved.rowClass);
```

Two sources feed it: `DISCOVER_SCHEMA_ROWSETS` yields the restrictions metamodel,
and the inline XSD of each response yields the row class. Where a known rowset and
the server's own description disagree, the resolver reports the `Divergence`
rather than silently preferring one, and `Origin` says which side a column came
from.

## Status

Prerelease, published under the `next` tag. The API is not settled.

## License

EPL-2.0
