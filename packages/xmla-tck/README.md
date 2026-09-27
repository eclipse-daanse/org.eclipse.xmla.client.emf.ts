# @eclipse-daanse/xmla-tck

The client against a live XMLA server, check by check, with the specification
each check rests on written beside it.

Part of an XMLA client in TypeScript, built on
[`@emfts/core`](https://www.npmjs.com/package/@emfts/core). Everything else in
the repository is checked against recordings of one server family. This is what
says a byte left the process, that a server nobody recorded answers what the
client expects, and which claim of the specification it was that did not hold
when one does not.

## Why it exists

Microsoft publishes the protocol - [MS-SSAS] and the XMLA 1.1 specification -
but no compatibility kit for a client. The olap4j TCK tests a Java API, the
Mondrian XMLA tests test Mondrian, and the Daanse ADOMD tester drives
Microsoft's client against a Daanse server, which is the other direction. So the
claims are written down here, one per check, with the section they come from.

## Running it

```bash
npm run tck                              # the csv probe on localhost:8090, or $XMLA_URL
npm run tck -- http://host/xmla          # any URL; XMLA_USER and XMLA_PASSWORD add Basic
npm run tck -- csv-probe flexmonster     # profiles by name, one run each
npm run tck -- --only C5,R7 ...          # a subset, by id
npm run tck -- --json run.json ...       # keep the runs
npm run tck -- --html run.html ...       # the runs as one page: a matrix of check by server
npm run tck -- --list                    # what would be asked, and on whose authority
```

Under vitest, one test per check, against whatever `XMLA_TCK_TARGET` names.
Without it the suite skips itself, so `npm test` passes on a machine with no
server and says so:

```bash
XMLA_TCK_TARGET=csv-probe npx vitest run packages/xmla-tck
```

## What a check answers

Three things, not two. It **holds**, with a note saying what was seen. It
**fails**, with the reason and the section of the specification. Or it is **not
applicable** to the server it found - a check for a feature a server never
claimed to have has to say so rather than fail, because a red run for the wrong
server teaches nothing.

Two weights. A `must` is what the client cannot work without; one failing fails
the run and the exit code says so. A `should` is what the specification asks for
and the client tolerates being without; a failure is a warning.

The first check is the reachability probe. When it fails the rest are not
attempted: nothing after it could hold, and thirty timeouts say less than one.
A profile may mark a server as tolerated when unreachable - the public demo
servers are, because their being down is not this project's failure.

## The groups

| | |
|---|---|
| transport | anything answers; a Discover answers a rowset with its schema inline; an unknown request type answers a SOAP Fault the client reports as one |
| connection | DISCOVER_PROPERTIES and DISCOVER_DATASOURCES carry what a client reads first; `open()` runs the order a server expects and the DataSourceInfo it names is accepted back; a restriction narrows the answer |
| rowsets | what DISCOVER_SCHEMA_ROWSETS declares, and whether it is answered when asked for: GUIDs, restriction lists, `RestrictionsMask`, the inline schema, the strict comparison against the model, a restriction that filters, and the dynamic path for a rowset the model never described |
| sessions | BeginSession, a request inside it, EndSession |
| execute | an MDX statement answers a dataset with axes, slicer and well-formed cell ordinals; a non-statement answers a fault; a DMV answers a rowset; and, where the data is known, the numbers equal the ones computed from the file the server was loaded from |
| suites | the Daanse check suites beside the probe's catalogs, run over XMLA: the catalogs are listed, every object a suite names is in the `MDSCHEMA_*` rowsets, what a suite says about an object is what the rowset says, and every MDX query answers the cells, counts and axes it expects |
| recorded | the 352 requests Excel, Power BI and SQL Server Management Studio were recorded sending to SSAS, one check per distinct shape - request type, restrictions set, properties carried - replayed through this client with the names rewritten to what the target has and the properties narrowed to what it lists |
| authentication | against a guarded endpoint: the probe rowsets are served anonymously, the rest refused with a 401 carrying its challenge, Basic gets through, the wrong password does not, a session survives it |

`--list` prints every check with its authority.

Checks in the rowsets, execute and suites groups stand for many assertions at
once - one per rowset, per restriction, per catalog, per query - and hand them
back one by one. A check fails when any of its assertions fails, the report
counts them, and the HTML lists each with its own badge.

The recorded group is built from the conversations in `packages/testkit`: a
check per distinct request shape and conversation, 105 in all. The bodies are
read back into their parts, restrictions naming Adventure Works are rewritten
to the target's own catalog, cube, hierarchy, level and member, a property the
server does not list in `DISCOVER_PROPERTIES` is left out - which is what the
recorded clients do themselves, and why a 2016 client works against a 2012
server - and the client writes the request again. Statements against the
recorded server's own cubes cannot be transferred and are reported as not
applicable; the DMV statements can, with Power BI's `@CubeName` parameters put
into the text.

Three forms of report say the same things: the text a run prints as it goes,
`--json` for a build that keeps the run and diffs it against the last one, and
`--html` for someone to read - one self-contained page, no script and nothing
loaded from anywhere, with one column per server and each check's authority
beside it.

## Profiles

A profile is a server and what cannot be read from it: the second endpoint that
demands a login, the endpoint that answers a rowset present in no `.ecore`, the
csv the numbers were computed from, the directory of check suites, and how much
of the server may be swept.
`sweep: 'all'` asks for every declared rowset once; `sweep: 'mandatory'` - for
somebody else's server - asks for the ones XMLA 1.1 requires and the ones an
OLAP client needs, and no more.

The profiles in `src/profile.ts`: `csv-probe`, `daanse` and
`probe-all-tutorials` on localhost, and `flexmonster`, `syncfusion` and
`emondrian` as the public servers this project knows. A URL that matches none
is run as an ad-hoc profile with the `all` sweep.

## The check suites

The Daanse probe ships a `check/checkSuite.xmi` beside every catalog. It is
written against the OLAP API and says what the catalog holds - cubes,
dimensions, hierarchies, levels, measures, KPIs, named sets, and facts about
them such as has-all or a format string - and what its MDX queries answer, cell
by cell. `--suites <dir>` (or `XMLA_TCK_SUITES`) points the kit at the
`catalog/` directory, and the `suites` group asks the server the same things
over XMLA through this client. The suites pass on the server's own API, so a
difference here is in the XMLA layer or in this client.

Two conventions are this project's reading of the suites, and are stated in
`src/suites.ts` rather than assumed: a cell's coordinates are one per axis for a
dataset and row-then-column for a tabular answer such as a DRILLTHROUGH; and the
suite's attribute vocabulary is mapped onto the `MDSCHEMA_*` columns naming the
same fact, with anything that has no such column reported as unmapped rather
than guessed.

## What it has found so far

Against SSAS 13 (Flexmonster) every check holds, 134 of 134. Against SSAS 11
(Syncfusion) everything a `must` asks holds, and two things do not:

- It states a GUID for `DISCOVER_XEVENT_TRACE_DEFINITION` that the model does
  not carry.
- **`MDSCHEMA_MEMBERS` carries a column per member property** - `Account Type`
  arrives as `<Account_x0020_Type>` - and the static row class refuses it. This
  is the client's: the inline schema describes the extra columns, the dynamic
  path could read them, and the resolver prefers the static class regardless.
  Found by R16, which asks for the children of the all member.

And one thing about replaying real clients: SSAS 11 refuses any request that
carries `DbpropMsmdCurrentActivityID`, a property every 2016 client sends. The
clients work against it anyway because they send only what
`DISCOVER_PROPERTIES` lists, so the recorded checks do the same.

Against the Daanse probe with all 97 tutorial catalogs, 30 of 34 applicable
checks hold, and the four that do not are the server's - each was checked
against the server's own `output/check-results`, which fail on the same
things:

- **`DISCOVER_DATASOURCES` answers no rows until the catalogs are built.**
  Right after start-up `DISCOVER_PROPERTIES` answers and `DISCOVER_DATASOURCES`
  is empty, so a client connecting in that window is refused by its own
  connect logic. A minute later there are 93 rows.
- **An unrestricted `MDSCHEMA_CUBES` is refused outright** with *User doesn't
  have any roles assigned and no default role is configured*, because one
  catalog it would list is role-protected. Asked for by catalog name, every
  visible catalog answers. R13 reports this; the kit itself aims its queries by
  catalog because of it. The same refusal hits `DISCOVER_XML_METADATA`.
- **Two catalogs refuse every `MDSCHEMA_*` rowset**: `Bevölkerung` with an
  internal error populating the member cache of `[Jahr].[Jahr]`, and `Daanse
  Tutorial - Formatter Cell` because `mondrian.rolap.format.CellFormatterImpl`
  is not in the assembled build. The server's own check runs fail on both with
  *Failed to create connection*.
- **Two hidden cubes are not listed even with `ShowHiddenCubes=true`.** The
  client sends the property; the server neither lists it in
  `DISCOVER_PROPERTIES` nor honours it, so `Cube1` and `Cube2` of the
  invisible-reference-cubes tutorial cannot be reached over XMLA at all.
- **Four of a hundred MDX queries answer other cells than their suite expects**:
  a `TEXTAGG` measure concatenates every fact row rather than the distinct
  values, two format strings render with the JVM's German decimal comma
  (`63,00` for `63.00`), and the Formatter Cell query faults as above. The
  server's own runs report the first two identically.
- **No `SlicerAxis`** in a dataset for a query without WHERE, where SSAS
  always sends one. Reported as a warning; the client reads both.
- **Execute properties are not honoured**: `Content=Schema` still answers
  data, `BeginRange`/`EndRange` still answer every cell. `Format=Tabular` and
  the three `AxisFormat`s are.
- **`TREE_OP` is not honoured**: asked for the children of the all member,
  `MDSCHEMA_MEMBERS` answers the all member itself.
- **`DISCOVER_LITERALS` names no `DBLITERAL_QUOTE_PREFIX` or `_SUFFIX`**, so a
  client cannot learn from it how to quote an identifier.
- **`DISCOVER_XML_METADATA` and every DMV over `$SYSTEM`** are refused with
  the roles fault above, because they run over all catalogs. Excel and SSMS
  ask `DISCOVER_XML_METADATA` on every connection.

Everything else the suites say - 94 cubes, their dimensions, hierarchies,
levels, measures and KPIs, 100 attribute facts and 96 queries - is what the
server answers over XMLA through this client.

## What it is not

Not a test of the server's correctness beyond what the client relies on, and
not the request-side golden files from [MS-SSAS] section 4 - those are what the
recorded conversations in `packages/testkit` cover. Not published: it needs the
whole workspace, and a kit that ships without its models would prove nothing.

## License

EPL-2.0
