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

## Talking to a real server

Everything else here is checked against recordings of one server family. This is
the only thing that says a byte ever left the process.

```bash
npm run probe        # builds and starts a real Daanse XMLA server on 8090
npm run probe:live   # the client against it, over HTTP
```

The probe is the project's own Java server - its envelope, its sessions, its
inline schema, its rowset serialisation - with only the backend stood in for,
because standing up ROLAP with a catalog and a data source is a different stack
in a different repository. It needs the Java repository built once:

```bash
mvn -pl server/jdk.httpserver -am -DskipTests -Deditorconfig.skip=true install
```

It has already earned its keep. `beginSession` was sending an `<Execute>` with
an empty `<Command>`, and a server that checks refuses that: *the Execute
request carries no command*. Every recorded client sends
`<Command><Statement/></Command>`, but a recording of what a client sends never
says what a server would have refused. There is now a test against the
recording so it cannot come back.

One thing the probe does **not** prove: the dynamic path. It declares exactly
the 103 rowsets the model describes, because it is driven by that same model.
Proving the dynamic path live needs a server built from a different model.

## Reading a large response

The cursor feeds the parser a piece at a time and hands out only what a piece
produced, so memory is bounded by the chunk rather than by the document. On the
largest recorded response - 4.3 MB, 49 198 events:

| chunk | time | heap |
|---|---|---|
| 16 KB | 262 ms | 1.6 MB |
| **64 KB (default)** | **262 ms** | **3.9 MB** |
| whole document at once | 305 ms | 17.2 MB |

The trade it makes: nothing is parsed until something is asked for, so a
document that is not well formed reports itself while being read rather than
when it is handed over. It still reports itself, which is what matters.

## The UI is a model

The forms come from `@emfts/uimodel-composer`, which renders a UI that is itself
an Ecore instance: a `FormView` with one widget per restriction, and the
`EStructuralFeature` **itself** behind each one rather than its name. That last
part is what makes a class the server described a moment ago editable at all -
nobody could have written its column names down in advance.

The package is not published, so it is vendored in
`packages/vendor-uimodel-composer` with `vega` and OpenLayers trimmed out. See
its `VENDOR.md`; `npm run check:vendor` compares the tree against the snapshot
and fails on anything VENDOR.md does not account for.

## What is not done yet

**The grid is this project's, not the composer's.** `TableViewComposer` renders
rows as flat values, and a nested rowset has to fold into an inner table rather
than a JSON blob - which is the reason EObjects are carried as far as the UI.
The form is the composer's.

## License

EPL-2.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
