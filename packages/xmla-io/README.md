# @daanse/xmla-io

The XMLA message layer: SOAP envelope, requests, faults, and the codec that dispatches a response.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF. The Ecore models are the only description of the
protocol: reading and writing run over `ExtendedMetaData` and reflection rather
than hand-written XML per rowset.

## Install

```bash
npm install @daanse/xmla-io@next
```

## What it does

The XMLA message layer: the SOAP envelope, Discover and Execute requests, fault
handling, and the codec that dispatches a response.

```ts
import { SoapEnvelopeCodec, writeDiscover, failIfFault } from '@daanse/xmla-io';

const body = codec.write(headers, (out) => {
  writeDiscover(out, {
    requestType: 'MDSCHEMA_CUBES',
    restrictions: [{ name: 'CATALOG_NAME', value: 'Foodmart' }],
    properties,
  });
});

failIfFault(responseXml);   // throws XmlaFaultError
```

`RequestReader` reads requests as well as writing them, which is what lets a
recorded conversation be replayed against the same code that produced it.

## Status

Prerelease, published under the `next` tag. The API is not settled.

## License

EPL-2.0
