# M1 — which reader, and why

**Written before the spike ran.** The point of writing it first is that the rule
cannot be bent to fit the result afterwards. Whatever the measurements say, the
decision below follows from them mechanically.

## The question

Can this project read XMLA by extending `XMLHandler` from `@emfts/core`, or does
it need a purpose-built SAX reader written clause by clause after the Java
`EcoreXmlReader`?

Reading the `@emfts/core` source suggested the latter, on three main grounds:

1. **No seam for the injected row class.** `<root>` has no `row` feature in any
   model — the row type comes from the request, not from the schema.
2. **No `xsi:type` on the wire.** XMLA resolves group alternatives by element
   name (`<CrossProduct>` is a `SetListType`), which is fundamentally different
   from what `handleDeferredType` does.
3. **No skipping by namespace.** Each response carries an inline `<xsd:schema>`;
   without namespace-based skipping every one of its ~200 elements lands in
   `handleUnknownFeature`.

Reading source is not measuring. This spike measures.

## What gets measured

Against two real recorded responses:

- `excel-pivot/39-response-discover-DISCOVER_SCHEMA_ROWSETS.xml` — inline XSD, a
  nested rowset, and the response the whole dynamic path is built on.
- `excel-pivot/69-response-execute-Statement.xml` — an mddataset, with
  polymorphic group alternatives and no `xsi:type` anywhere.

Plus three numbers the plan wants regardless of the outcome:

- **Boolean converter** — already settled in M0: `'1'` reads as `false`. Recorded
  here for completeness, not re-litigated.
- **The engine proxy** — `xmla.ecore` is the only model referencing
  `engine.ecore`, which is 868 KB of the 2.9 MB total. Does loading `xmla`
  without `engine` leave the *rest* of it usable, or does the unresolved
  `ObjectDefinition` proxy damage more than that one feature?
- **Load time** — how long bootstrapping all 19 models takes, since the browser
  pays it on startup.

## The decision rule

**Extend `XMLHandler`** if all four hold:

1. It can be made to read both responses into correct EObjects.
2. Doing so needs no reach into private state — no monkey-patching, no copying
   a private method's body, no relying on a field not in the public typings.
3. The subclass is smaller than the ~600 lines a purpose-built reader is
   estimated at.
4. The three problems above are addressed by *overriding declared extension
   points*, not by working around the base class.

**Write our own SAX reader** if any of the four fails.

Point 2 is the one that decides it in practice. A subclass that works only by
depending on internals is worse than no subclass: it would break on a patch
release, and `@emfts/core` is at `0.1.1-next.16` — a version range that promises
nothing.

## What is not up for decision

Either way, everything else from EMF-TS stays: the metamodel, `BasicE*`,
`EcoreUtil.create`, `XMIResource.loadFromString` for the `.ecore`,
`EPackageRegistry`, and the `sax` dependency. The reader sits behind an interface
with a factory, so if this call turns out wrong, the implementation is swapped
and nothing above it changes.

The value coder is settled independently and is not part of this decision: `'1'`
reading as `false` is measured, and no choice of reader changes it.

---

## Result

**We write our own SAX reader.** All four criteria fail, and the first one fails
in the worst available way.

### Criterion 1 — does it read both correctly? No.

The subclass was taken as far as it would go: skipping the inline schema by
namespace, resolving the `##any` wildcard on `soap:Body` by element name across
the registry, resolving features by ExtendedMetaData name, and injecting the row
`EClass`. On `DISCOVER_SCHEMA_ROWSETS` that got to **zero reported errors** — and
a wrong result.

```
returned, errors: 0, EMD-resolved: 31, rows built: 1
  first row: 1 features set: restrictions=[9]
```

The row has `restrictions` and nothing else. But `DiscoverSchemaRowsetsRow`
declares `schemaName` (ExtendedMetaData name `SchemaName`), and the response
contains `<SchemaName>MDSCHEMA_HIERARCHIES</SchemaName>`. Both scalar columns
were dropped, silently, while the reader reported success.

That is worse than failing. A reader that errors is a bug you fix; a reader that
returns a plausible row with columns missing is a bug that ships.

`execute Statement` did not read at all: 2606 errors, no rows.

### Criterion 2 — no reach into private state? Violated, and silently.

Getting scalar values into features meant setting `deferredFeature` and
`deferredParent` and calling `processObject(null)`. Those fields are `protected`,
so they are in the public typings — but their contract is not documented
anywhere, the guess was wrong, and being wrong produced no error. That is exactly
the dependency that breaks on a patch release of a `0.1.1-next.16` package, and
breaks without saying so.

### Criterion 3 — smaller than a purpose-built reader? Not meaningfully.

116 lines of subclass, and it reads neither case correctly. The remaining work —
scalar values, the polymorphic groups that make up an mddataset, the 182
`wrapperElementName` annotations, simple content, attributes — is the bulk of it.

### Criterion 4 — declared extension points only? No.

`handleUnknownFeature` is a declared hook, and `XMLResource.createXMLLoad()` →
`XMLLoad.makeDefaultHandler()` → `XMLHandler` is a clean, declared chain. That
part of the library is fine. But making XMLA work needed `startElement`,
`endElement` and `characters` overridden to skip a subtree — there is no hook for
"ignore this subtree" — plus feature dispatch, wildcard resolution and object
creation reimplemented. At that point the base class contributes the SAX plumbing
and nothing else, while still being able to break the parts it does contribute.

**The root cause, in one line:** `XMLHandler` does not key feature lookup on
ExtendedMetaData. `Envelope.body` resolved from `<Body>` only because the names
match case-insensitively. `<return>` → `return_` does not, and neither does
`<CATALOG_NAME>` → `catalogName` — which is every column of every rowset.

---

## What else the spike measured

### The Ecore package is missing three data types — and this was a real blocker

`@emfts/core` ships 35 Ecore classifiers. EMF proper has the boxed wrappers too,
and the models use them: **106 features in `xmla.ecore`** point at
`EIntegerObject` (86), `EBooleanObject` (19) or `EDoubleObject` (1). All 106
resolved to unresolved proxies, and among them is all of `PropertyList` —
`timeout`, `localeIdentifier`, `maximumRows` — which every single request writes.

Registering the three as `BasicEDataType` on the Ecore package at bootstrap fixes
it completely: **0 unresolved features across all 19 models**. This is restoring
a gap in the library, not inventing a type, so it belongs in `xmla-model`'s
bootstrap with a test that fails if a later version supplies them itself.

Nothing is missing from XMLType — all 2576 built-in type references outside those
106 resolve.

### The engine model: optional, and the cost is exactly known

`xmla.ecore` is the only model referencing `engine.ecore`. Omitting it leaves
**exactly 18 unresolved features**, all in `xmla` and all on DDL commands:
`Alter.objectDefinition`, `Create.objectDefinition`, `Batch.dataSource`,
`Batch.dataSourceView`, `Batch.errorConfiguration`, `Process.*`,
`NotifyTableChange.tableNotifications`, `OutOfLineBinding.*`. **Zero** unresolved
in the other 17 models.

None of those is on the read path of an OLAP client — they are for a tool that
deploys database objects, which this is not. The damage is contained: `Alter` is
still instantiable, its sibling features still resolve, and `eGet` on a damaged
feature returns rather than throwing. That last part is why it stays a deliberate,
documented choice: an unresolved eType is silent, so it must never be an accident.

So `engine` becomes **opt-in**, off by default, with the 18 features named.

### Load times

| | |
|---|---|
| all 19 models | **622 ms** |
| without `engine` | **382 ms** (saves 240 ms) |
| `engine` alone | 173 ms |
| `rowset` alone | 141 ms |

The browser pays this on startup, and 622 ms is too much to pay for the DDL
commands a client never sends. Off by default is the right default.

### The boolean converter

Settled in M0 and unchanged: `createFromString(XMLType.Boolean, '1')` returns
`false`, for `BooleanObject` as well. Asserted in the smoke test. No choice of
reader affects it, and the value coder stands.
