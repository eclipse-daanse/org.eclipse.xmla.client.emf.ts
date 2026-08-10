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

*(filled in after the spike)*
