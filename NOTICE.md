# Notices for Eclipse Daanse

This content is produced and maintained by the Eclipse Daanse project.

* Project home: https://projects.eclipse.org/projects/technology.daanse

## Declared Project Licenses

This program and the accompanying materials are made available under the terms
of the Eclipse Public License v. 2.0, which is available at
https://www.eclipse.org/legal/epl-2.0.

SPDX-License-Identifier: EPL-2.0

## Third-party Content

### Runtime dependencies

* `@emfts/core` — the TypeScript implementation of Eclipse EMF, from the Eclipse
  Fennec project. EPL-2.0.
* `sax` — a streaming XML parser, used by `@emfts/core` and by this project's own
  reader. ISC.

### Content copied into this repository

The Ecore models under `packages/xmla-model/model/` are copied from the
`org.eclipse.daanse.xmla` repository, which is EPL-2.0 as well. They are not
edited here; `npm run check:sync` fails if they drift from the source. Where they
came from and at which commit is recorded in `model-sources.json` and in the
generated `_manifest.json` beside them.

The models themselves describe the wire format of XML for Analysis, specified by
Microsoft in [MS-SSAS] and the XML for Analysis 1.1 specification. Element and
attribute names, and the documentation strings carried in the models'
annotations, originate from those specifications.

The recorded conversations under `packages/testkit/fixtures/` are captures of
Excel, Power BI and SQL Server Management Studio talking to a SQL Server
Analysis Services instance. They contain metadata of the sample databases used
for the recording, and no personal data.
