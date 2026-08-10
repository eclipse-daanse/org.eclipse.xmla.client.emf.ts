# The rowsets we do not have

> **Status, after this was acted on.** 34 of the 67 are now modelled: the 32
> `TMSCHEMA_*` that [MS-SSAS-T] specifies, and 2 of the 6 operational
> `DISCOVER_*`. The models here describe **137** request types, not 103. Two
> claims in the original text were wrong and are corrected in place, marked where
> they occur. The analysis of how the rowsets should now be divided between
> packages is in the Java repository's `docs/rowsets-tabular-vs-multidimensional.md`
> — and has since been carried out: the rowsets are split into one package per
> kind (relational, multidimensional, mining, server, tabular).

Three tools that talk to Analysis Services were read to find out what a real
client asks for that this project's models do not describe. They were chosen
because none of them is documentation: each is a working tool's own list, so a
rowset in it is one somebody actually queries.

| source | what it is | what it contributes |
|---|---|---|
| [`pbix_doc/conf/pbix_doc.yaml`](https://github.com/ZdenekMerka/pbix_doc) | a Power BI documentation generator | the full list it can dump, including every `TMSCHEMA_*` |
| [`DaxStudio/DaxStudioTraceEventSubclass.cs`](https://github.com/DaxStudio/DaxStudio) | DAX Studio's trace event subclasses | which Discover requests a server reports executing |
| SSMS `Microsoft Analysis Services TraceDefinition 17.0.0.xml` | the Profiler's own event definitions | the same, with each one's numeric subclass id |

## The count

The models here describe **103** request types. The three sources between them
name **130**, of which **63** we have. So **67 are missing** — and 40 of ours
appear in none of them, which is not a gap but a difference of purpose: they are
the OLE DB relational rowsets (`DBSCHEMA_ASSERTIONS`, `DBSCHEMA_PRIMARY_KEYS`
and the rest) and the whole data-mining family (`DMSCHEMA_*`), none of which a
Power BI tool has any use for.

## What is missing, and what it is for

### The Tabular Object Model — 60 named by the tools, 32 specified

**Correction.** The 60 below is what the three tool inventories name between them.
[MS-SSAS-T] v20210406 specifies **32**, and those 32 are what could be modelled
from a source; they are now `model/rowset.tabular` in the Java repository. The
difference is almost exactly the storage group described further down - the
VertiPaq `_STORAGES`, `_SEGMENT_*` and `_DICTIONARY_*` diagnostics appear in no
specification, only in tools that read them.

`TMSCHEMA_MODEL`, `TMSCHEMA_TABLES`, `TMSCHEMA_COLUMNS`, `TMSCHEMA_MEASURES`,
`TMSCHEMA_RELATIONSHIPS`, `TMSCHEMA_PARTITIONS`, `TMSCHEMA_ROLES`,
`TMSCHEMA_CALCULATION_GROUPS`, `TMSCHEMA_PERSPECTIVES`, `TMSCHEMA_CULTURES`,
`TMSCHEMA_EXPRESSIONS` … and fifty more.

This is not an extension of what we have; it is a **parallel metadata world**.
`MDSCHEMA_*` describes a multidimensional model — cubes, dimensions,
hierarchies, levels. `TMSCHEMA_*` describes a **tabular** one — tables, columns,
relationships, DAX measures, partitions. Power BI and every Analysis Services
instance in tabular mode expose the second; a Mondrian-style ROLAP server
exposes neither, because it has no tabular model to describe.

Within the family, three groups do different work:

- **the model itself** — `TMSCHEMA_MODEL`, `_TABLES`, `_COLUMNS`, `_MEASURES`,
  `_HIERARCHIES`, `_LEVELS`, `_RELATIONSHIPS`, `_PARTITIONS`, `_KPIS`, `_SETS`,
  `_EXPRESSIONS`, `_ROLES`, `_CULTURES`, `_PERSPECTIVES` and their `_PERSPECTIVE_*`
  members. This is what a documentation tool reads, and what an editor needs.
- **storage** — everything ending in `_STORAGES` plus `_SEGMENT_*`, `_DICTIONARY_*`,
  `_PARQUET_FILE_STORAGES`, `_DELTA_TABLE_METADATA_STORAGES`. These describe how
  the VertiPaq engine has laid the data out: segments, dictionaries, compression.
  They are diagnostics for one specific engine.
- **security and governance** — `_ROLE_MEMBERSHIPS`, `_TABLE_PERMISSIONS`,
  `_COLUMN_PERMISSIONS`, `_OBJECT_TRANSLATIONS`, `_ANNOTATIONS`,
  `_EXTENDED_PROPERTIES`.

### Six `DISCOVER_*`, all operational

A server reports what it was asked as a trace event subclass, and **the two
sources number those subclasses differently**. The SSMS trace definition and the
AMO `TraceEventSubclass` enumeration disagree on every one of the six, so both are
given rather than one being presented as the id:

| rowset | SSMS | AMO | what it answers |
|---|---|---|---|
| `DISCOVER_RESOURCE_POOLS` | 56 | 239 | the memory and CPU pools the instance divides work between |
| `DISCOVER_JOB_PROGRESS` | 15 | 72 | how far a running process or refresh has got |
| `DISCOVER_M_EXPRESSIONS` | 110 | 312 | the Power Query (M) expressions behind a tabular model's tables |
| `DISCOVER_MODEL_SECURITY` | 116 | 322 | the row-level security a model applies |
| `DISCOVER_POWERBI_DATASOURCES` | 107 | 310 | the data sources a Power BI dataset was built from |
| `DISCOVER_POWERBI_ROLES` | — | 313 | the roles a Power BI dataset defines; absent from the SSMS definition, so newer than it |

The AMO column is from `spec/sources/.amo-cache/…traceeventsubclass.html`, which
lists 342 subclasses. Neither number is a rowset identifier - a subclass id says
what a *trace* calls the request, not what the protocol calls it - so nothing in
the models depends on either.

`DISCOVER_RESOURCE_POOLS` is the one already met: the public Flexmonster server
declares it, and it is what the dynamic path read live in
`scripts/probe-public.mjs` before the model described it.

### One `MDSCHEMA`

`MDSCHEMA_COMMANDS` — the commands a client may send. Named in the sources and
absent from the models.

## The other thing these sources showed

`pbix_doc` reaches all of this through **DMV syntax**, not through Discover:

```yaml
pbix_table_prefix: '$SYSTEM'
all_pbix_tables: [ {table: "DBSCHEMA_CATALOGS", idx: "CATALOG_NAME"}, … ]
```

That is `SELECT * FROM $SYSTEM.DBSCHEMA_CATALOGS` sent as an **Execute**, and the
server answers a rowset rather than an mddataset. So every one of these rowsets
has two doors, and a client that can only knock on one reaches half of them.

This project already goes through both: `WorkbenchXmlaClient.execute` decides
which shape came back by reading the namespace of `<root>` rather than by
guessing from the statement text, so a `$SYSTEM` query lands in the same grid as
an MDX one. That was built for DAX Studio-style DMV queries and turns out to be
exactly what this needs.

## The plan

**Nothing here is urgent, and one part of it should probably never be done.**

**1. Nothing, for now — and that is the point of the dynamic path.**

Every one of these 67 is already reachable. A server that offers
`TMSCHEMA_MEASURES` describes it in the inline schema of its own response, and
`xmla-dynamic` builds an EClass from that and reads the rows. It is proven live:
`DISCOVER_RESOURCE_POOLS` against the Flexmonster server, 15 columns built from
the response, on a rowset no model here describes. The gap costs typed access
and documentation, not access.

**2. Two of the six `DISCOVER_*` have been modelled. Four cannot be. — done**

This section previously claimed the six each have "a fixed column list [MS-SSAS]
specifies". **That was wrong.** None of the six appears in [MS-SSAS], and none
appears in [MS-SSAS-T] either; five do not occur in the specification text at all.
There was no column list to transcribe.

What there is instead is what a server answers, and asking settled it. All four
public servers were asked for all six (`spec/capture_ssas_fixtures.py`):

| rowset | outcome |
|---|---|
| `DISCOVER_RESOURCE_POOLS` | Flexmonster answered, 15 columns, 2 rows — modelled |
| `DISCOVER_MODEL_SECURITY` | Telerik answered, 3 columns, 0 rows; the inline schema is the column list — modelled |
| the other four | refused by all four, "an error occurred while parsing the RequestType element" — **not** modelled |

Both modelled ones carry `source="OBSERVED"` and an `observedFrom` naming the
recording, because an observation is weaker than a specification and the model
should say so. The four refusals are kept as `.fault.xml` so the absence is a
recorded fact. They went into the multidimensional package, not the tabular one:
both servers that answered are multidimensional, and what these rowsets describe
is the server rather than a model.

`MDSCHEMA_COMMANDS` is still unmodelled and still worth it.

**3. `TMSCHEMA_*` has been modelled — 32 of them, not 60. — done**

The count here was taken from tool inventories. [MS-SSAS-T] v20210406 specifies
**32**, each with a column table, an embedded XSD giving the types, and an
Additional Restrictions section. They are now in the Java repository as
`model/rowset.tabular` (305 columns, 372 restrictions), generated by
`spec/bootstrap_tabular_rowset_ecore.py` rather than typed.

The reservation above still stands and is worth keeping: a Daanse server has cubes
and dimensions, not tables and DAX measures, and would answer every one of them
empty. What modelling them buys is the *client* side — this project talks to
Power BI and to tabular SSAS, and now reads their metadata with named, typed
columns instead of through the dynamic path. Note also that no server advertises
them: all three recorded sessions list 70 rowsets and not one `TMSCHEMA_`, so a
client cannot discover them and has to know them. That is precisely what a model
is for.

How the rowsets should be divided between packages from here is analysed in the
Java repository's `docs/rowsets-tabular-vs-multidimensional.md`.

They matter in one case only: **reading somebody else's tabular server** - a
Power BI dataset, an Analysis Services instance in tabular mode. If that is a
goal, the storage group should still be left out. `TMSCHEMA_SEGMENT_STORAGES`
and its neighbours describe how VertiPaq compressed something, and nothing this
project could do with that answer would be meaningful.

So: **the model group first if ever** — `TMSCHEMA_MODEL`, `_TABLES`, `_COLUMNS`,
`_MEASURES`, `_RELATIONSHIPS`, `_PARTITIONS` - about fifteen rowsets, and enough
to read a tabular model's shape.

**4. What this project should do regardless.**

Make the dynamic path the *documented* answer for all of it. A user who asks for
`TMSCHEMA_MEASURES` in the explorer should get rows and a badge saying the
description came from the server, which already works - rather than an error
saying the rowset is unknown, which is what a reader would expect from a list of
103.
