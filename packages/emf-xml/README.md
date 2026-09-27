# @eclipse-daanse/emf-xml

Reads and writes XML for any Ecore model, driven by ExtendedMetaData. Knows nothing about XMLA.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF. The Ecore models are the only description of the
protocol: reading and writing run over `ExtendedMetaData` and reflection rather
than hand-written XML per rowset.

## Install

```bash
npm install @eclipse-daanse/emf-xml@next
```

## What it does

Reads and writes XML for any Ecore model. The mapping comes from
`ExtendedMetaData` on the model, so there is no generated or hand-written reader
per type — a model that carries the annotations can be read and written as it is.

```ts
import { EcoreXmlReader, EcoreXmlWriter, XmlCursor, XmlWriter } from '@eclipse-daanse/emf-xml';

const root = new EcoreXmlReader().read(XmlCursor.parse(xml), someEClass);

const out = new XmlWriter();
new EcoreXmlWriter(namespaceUri).write(out, root, 'root');
```

`XmlCursor` is the pull parser underneath, usable on its own when a document
should be walked rather than materialised. `Unknown` marks what the model did not
describe, so an unexpected element is visible instead of dropped.

This package knows nothing about XMLA.

## Status

Prerelease, published under the `next` tag. The API is not settled.

## License

EPL-2.0
