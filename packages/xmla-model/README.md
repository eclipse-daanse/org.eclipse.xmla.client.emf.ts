# @daanse/xmla-model

The XMLA Ecore models, bootstrapped into a live registry, plus the rowset catalogue over them.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF. The Ecore models are the only description of the
protocol: reading and writing run over `ExtendedMetaData` and reflection rather
than hand-written XML per rowset.

## Install

```bash
npm install @daanse/xmla-model@next
```

## What it does

The XMLA Ecore models, bootstrapped into a live `EPackage` registry, plus the
rowset catalogue that describes which restrictions each rowset takes.

```ts
// Node — reads the .ecore files from disk
import { bootstrapFromDisk } from '@daanse/xmla-model/node';
const models = bootstrapFromDisk();

// Browser — the same models inlined as strings, no filesystem, no raw imports
import { bootstrapInBrowser } from '@daanse/xmla-model/browser';
const models = bootstrapInBrowser();

import { RowsetCatalog } from '@daanse/xmla-model';
const catalog = new RowsetCatalog(models);
```

Bootstrapping is synchronous and registers the packages globally by default.

Load order matters. Cross-model types resolve through the registry by nsURI, so a
package has to be registered before anything references it — an unresolved
reference becomes a proxy, and a proxy reads as an empty value rather than as an
error. `unresolvedFeatures()` is there to catch that.

`includeOptional` pulls in the `engine` model as well: 868 KB of DDL types whose
absence costs 18 features, all on commands a client never sends. Off by default,
and worth leaving off in a browser.

The `.ecore` files are copies from `org.eclipse.daanse.xmla`, guarded by a sha256
manifest in the source repository.

## Status

Prerelease, published under the `next` tag. The API is not settled.

## License

EPL-2.0
