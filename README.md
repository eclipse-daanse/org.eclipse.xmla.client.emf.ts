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
  xmla-tck                 the client against a live server, check by check, with the spec beside it
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

There are two servers to run against, and the checks adapt to whichever they
find: what a server does not have is reported as not applicable rather than
failed.

**The assembled Daanse probe** is the real deployment - the OSGi application in
`org.eclipse.daanse.server/application/probe`, with three tutorial catalogs
loaded from CSV by the project's own importer. Build it once with
`mvn -pl application/probe install`, then `./start` in that directory. It serves
XMLA on **8090** (8080 is the Jetty side, not XMLA).

**The csv probe here** needs no other repository checked out and holds one small
dataset:

```bash
npm run probe        # XMLA on 8090, and a guarded endpoint on 8091
npm run probe:live   # the TCK against it, over HTTP
```

The checks are the **technology compatibility kit** in `packages/xmla-tck`:
62 claims about a server, each with the section of [MS-SSAS] or of XMLA 1.1
it rests on, in seven groups - transport, connection, rowsets, sessions,
execute, suites, authentication - plus one check per distinct request the
recorded clients sent, 105 of them, replayed against the server: 167 checks in
all, and several hundred assertions inside them. Each holds, fails, or is not
applicable to the server it found; a `must` that fails fails the run, a
`should` is a warning. Point it anywhere:

```bash
npm run tck -- http://host/xmla        # any URL; XMLA_USER and XMLA_PASSWORD add Basic
npm run tck -- csv-probe flexmonster   # profiles by name
npm run tck -- --list                  # what is asked, and on whose authority
npm run tck -- --json run.json ...     # keep the run
npm run tck -- --html run.html ...     # the run as one page, check by server
XMLA_TCK_TARGET=csv-probe npx vitest run packages/xmla-tck   # the same, as one test per check
```

Among them: rows, a real session, the dynamic path, an MDX query computed from
the database, and authentication - that the two rowsets a client probes with
are served anonymously, that anything else is refused with a 401 **carrying its
challenge**, that Basic gets through and the wrong password does not, and that a
session survives all of it.

**The Daanse check suites as an oracle.** The distributable probe with every
tutorial catalog (`probe-all-tutorials.zip`, XMLA on **8080**) ships a
`check/checkSuite.xmi` beside each of its 97 catalogs: what the catalog holds
and what its MDX queries must answer, written by whoever wrote the catalog and
run by the server against itself at start-up. Pointed at that directory, the
TCK asks the same things over XMLA and compares - every cube, dimension,
hierarchy, level, measure and KPI against the `MDSCHEMA_*` rowsets, and every
query's cells, counts and axes against an `Execute`:

```bash
npm run tck -- probe-all-tutorials --suites /path/to/probe-all-tutorials/catalog
```

Connections the suites mark as needing a role are left out; this client speaks
anonymously, and those catalogs are hidden from it by design. The eight SQL
queries are left out too, since XMLA has no way to send one.

One thing neither probe answers: **`MDSCHEMA_MEMBERS` comes back empty**, while
`MDSCHEMA_LEVELS` and `MDSCHEMA_HIERARCHIES` answer from the same catalogue over
the same client path, and MDX resolves the members perfectly well. It is empty
on the csv probe and on the assembled one with its tutorial catalogs, so it is
reproducible and it is the server's, not this client's. Written down rather than
worked around.

## And against servers nobody here built

```bash
npm run probe:public   # the TCK against flexmonster, syncfusion and emondrian
```

The probe is driven by the same models the client uses, so agreement between
them proves they agree - not that either is right. These are public demo
endpoints run by other people, and the TCK runs its `mandatory` sweep against
them: the rowsets XMLA 1.1 requires and the ones an OLAP client needs, in
sequence, and no more. They are somebody else's servers, and one being down
does not fail the run.

| | |
|---|---|
| Flexmonster (SSAS 13) | 134 of 134 held |
| Syncfusion (SSAS 11) | two warnings: a GUID for `DISCOVER_XEVENT_TRACE_DEFINITION` the model does not carry, and member-property columns in `MDSCHEMA_MEMBERS` the static row class cannot read |
| eMondrian | unreachable at the time of writing - the host itself does not answer |
| Daanse probe, all tutorials | 118 of 139 held with the check suites, 456 of 469 assertions inside them; what did not hold is the server's, and listed in the package README |

Two things came out of it earlier and still hold. Flexmonster once declared
**DISCOVER_RESOURCE_POOLS**, which no model then described, and the dynamic path
read it into 15 columns built from the response - the necessity of that path, on
a server nobody recorded. And across both, every divergence strict mode finds
runs one way: the models carry columns and restrictions an older server does not
send, and nothing a server sends is missing from the models.

The csv probe is the project's own Java server, backed by the real ROLAP engine:
an H2 database this process fills from `probe/data/sales.csv`, described by a
mapping built from that csv's own columns. A text column becomes a dimension, a
numeric one becomes a measure, and editing the file changes what the cubes
answer. An MDX query against it is parsed, compiled, turned into SQL, run and
aggregated - so what comes back was computed, not written down. The live check
sums the csv itself and compares, which means a wrong total cannot agree with a
wrong expectation.

It needs the Java repositories built once:

```bash
# in org.eclipse.daanse.xmla
mvn -pl server/jdk.httpserver -am -DskipTests -Deditorconfig.skip=true install
```

The Daanse jars are built with Java 25, and an older `javac` refuses them with
*wrong version 69.0, should be 65.0* - a message that names no JDK. The launcher
therefore picks a Java 25 itself rather than trusting `JAVA_HOME`;
`PROBE_JAVA_HOME` overrides it.

It has already earned its keep. `beginSession` was sending an `<Execute>` with
an empty `<Command>`, and a server that checks refuses that: *the Execute
request carries no command*. Every recorded client sends
`<Command><Statement/></Command>`, but a recording of what a client sends never
says what a server would have refused. There is now a test against the
recording so it cannot come back.

The probe also answers, on `/xmla-foreign`, a rowset **no model describes**. It
cannot go through the adapter - that looks the row class up in the catalogue and
refuses what it does not find, correctly - so the response is written by the
same `XmlaMessageCodec` the adapter uses, over an EClass built at runtime on the
server and present in no `.ecore` anywhere. The client reads it into three
columns and two rows, with the numeric and boolean columns arriving as a number
and a boolean. That is the dynamic path over a wire, and nothing the client
already knew could have told it the shape.

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

Two things the composer leaves to the application, and both are silent when
left undone - which is why the tests mount a DOM rather than inspecting the
model:

- `TableViewComposer` renders **nothing** of its own. It looks up
  `TableViewRenderer` in the registry and delegates, and an unregistered key
  gives an empty placeholder. `RowsetTable` is registered under it, so the grid
  goes through the composer rather than beside it.
- `WidgetComposer` finds its inputs in `@emfts/vue-registry`, whose editors are
  keyed on **Ecore's** data types. The XMLA models are built on XMLType, so 75
  of the 435 restriction features in the catalogue - one in six - matched
  nothing and rendered blank. `src/widgets.ts` registers for the names the
  models actually use, and a test mounts every form in the catalogue to check
  none is blank.

## Swapping mdx-workbench's client

`@daanse/xmla-workbench-adapter` exposes `WorkbenchXmlaClient`, which mirrors
`XmlaSoapClient` method for method - `connect`, `discover`, `execute`,
`endSession`, `setCatalog`, `currentSessionId` - and answers the same plain
shapes. The tests assert that surface rather than assume it lines up.

What changes underneath: rows are read against the models instead of out of a
DOM, a rowset the models never described is read from the schema its own
response carried, a nested rowset arrives as a nested record rather than as
`[object Object]`, and a DMV answer becomes a cellset by reading the namespace
of `<root>` rather than by guessing from the statement text.

## What is not done yet

## Publishing

The six public packages (`@daanse/emf-xml`, `xmla-model`, `xmla-io`,
`xmla-dynamic`, `xmla-client`, `xmla-workbench-adapter`) are prereleases under
the `next` tag. As in the other Daanse repositories, they are published by a
workflow that runs after CI on `main`: `scripts/publish-next.mjs` publishes
every public workspace whose version the registry does not have yet, in build
order, with provenance. Bump the version in a package.json and the next push to
`main` publishes it; nothing else does. `npm run publish:next -- --dry-run`
says what would go.

## Publishing

The six public packages (`@daanse/emf-xml`, `xmla-model`, `xmla-io`,
`xmla-dynamic`, `xmla-client`, `xmla-workbench-adapter`) are prereleases under
the `next` tag. As in the other Daanse repositories, they are published by a
workflow that runs after CI on `main`: `scripts/publish-next.mjs` publishes
every public workspace whose version the registry does not have yet, in build
order, with provenance. Bump the version in a package.json and the next push to
`main` publishes it; nothing else does. `npm run publish:next -- --dry-run`
says what would go.

## License

EPL-2.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
