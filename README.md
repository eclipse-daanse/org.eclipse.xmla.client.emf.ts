# An XMLA client in TypeScript, on EMF-TS

Talks XML for Analysis, and does it entirely model-driven: the Ecore models are the
only description of the protocol, and both reading and writing run over
`ExtendedMetaData` and reflection rather than hand-written XML per rowset.

Two ways in:

- **Classic** — the known `.ecore`. Every request type is callable with typed
  restrictions, and rows come back as `EObject`s of a known `EClass`.
- **Dynamic** — the server describes itself. `DISCOVER_SCHEMA_ROWSETS` yields a
  restrictions metamodel, and the inline XSD of each response yields a row
  `EClass`. That makes a rowset queryable and renderable which this client has
  never seen.

Built on [`@emfts/core`](https://www.npmjs.com/package/@emfts/core), the TypeScript
implementation of Eclipse EMF.

## Layout

```
packages/
  emf-xml                  Ecore in, XML out. Knows nothing about XMLA.
  xmla-model               the .ecore, bootstrapped, plus the rowset catalogue
  xmla-io                  envelope, requests, faults, codec
  xmla-client              fetch, auth, sessions, discover/execute
  xmla-dynamic             XSD to Ecore, the restrictions metamodel
  xmla-workbench-adapter   plain records and cellsets, for mdx-workbench
  testkit                  recorded conversations and a transport that replays them
apps/
  explorer                 Vue 3, the test UI
```

## Getting started

```bash
npm install
npm test
```

## The models and fixtures are copies

`packages/xmla-model/model/` and `packages/testkit/fixtures/` are copied from the
`org.eclipse.daanse.xmla` repository so this one builds without a Java toolchain.
They are guarded by sha256 manifests:

```bash
npm run check:sync      # fails if the copies drifted from the source
npm run sync:ecore      # bring them back in step
npm run sync:fixtures
```

Point `XMLA_MODEL_SOURCE` at your checkout if it is not where `model-sources.json`
says. The sync also checks that every model still declares the nsURI it is
registered under, and that the load order is topological — a mismatch there turns
cross-model type references into unresolved proxies, and a proxy reads as an
empty value rather than as an error.

## Two things about `@emfts/core` worth knowing

Both are asserted in `packages/emf-xml/test/core-api.smoke.test.ts`, so a future
version that changes them shows up as a failure rather than as a silent wrong
result.

**`createFromString(XMLType.Boolean, '1')` returns `false`.** Per XSD it is
`true`, and XMLA does use `1` and `0` — `mustUnderstand="1"` decides whether a
message may be ignored at all. That is why this project ships its own value
coder rather than using the library's converters.

**Reading a many-valued feature makes it count as set.** `eGet` materialises the
empty list, and `eIsSet` is true from then on. So the writer asks `eIsSet` before
it ever touches `eGet`, or a freshly created row emits every collection wrapper
it has.

## What is not done yet

**The UI does not use `@emfts/uimodel-composer`.** That package is what should
generate the forms and grids - a UI that is itself an Ecore model - but it is
not published: `npm view` answers 404, and the snapshot is 239 files that would
have to be vendored and trimmed. So `apps/explorer/src/ui-model.ts` builds the
same *description* by hand, behind the seam the composer would fill. It is still
model-driven - the widget for a feature is chosen from the model and nothing in
the screens knows a rowset by name - but it is not the composer.

**`NormTupleSet` raises rather than being read.** It is the optimised response
shape SSAS sends when a client asks for it, which Excel does on every connect.
One of the two recorded statement responses uses it. Raising is deliberate:
walking the axis finds nothing there, so the alternative is a grid that looks
like a query returning no data.

**The models are read from disk.** `@daanse/xmla-model/node` uses `fs`, so the
browser build needs them inlined first. Until then the explorer runs against the
recorded conversations.

**The cursor parses eagerly.** The largest recorded response, 4.3 MB, becomes
49k events in 364 ms and about 24 MB of heap. That is affordable and measured,
but a streaming cursor belongs behind the same interface eventually.

## License

EPL-2.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
