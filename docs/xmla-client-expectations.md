# Was ein XMLA-Server von einem Klienten erwartet

Dieses Dokument sammelt, was dieser Klient über das Gespräch weiß und woher er
es weiß. Es ist das Gegenstück zu `docs/xmla-client-expectations.md` im
Java-Baum, aus der Sicht der fragenden Seite.

Belege stehen dort, wo sie herkommen: das DOCX ist `[MS-SSAS]`, die
Klientenquellen sind der dekompilierte ADOMD-Stapel, und was daraus zitiert
wird, steht **hier** und nicht im Code — der Code sagt, was gilt.

---

## 1. Die Reihenfolge beim Verbinden

`XmlaClient.open()` führt sie. Jeder Schritt existiert, weil etwas seine Antwort
liest.

| # | Anfrage | Wozu |
|---|---|---|
| 1 | `DISCOVER_PROPERTIES`, **ohne Einschränkung** | Die Fähigkeitsprobe. Alles Spätere — welches MDX erzeugt werden darf, ob eine Anmeldung kommt — liest daraus. |
| 2 | `DISCOVER_DATASOURCES`, ohne Einschränkung | Muss **mindestens eine Zeile** liefern. Ist das `DataSourceInfo` darin leer, nennt der Server keins — dann schickt dieser Klient auch keins mit. |
| 3 | — | Der Wert wird festgehalten und **ab hier bei jeder Anfrage mitgeschickt**. |
| 4 | `DISCOVER_PROPERTIES`, eingeschränkt auf `PropertyName=Catalog` | Die Lebendprobe. Die Antwort sagt, welchen Katalog der Server für den aktuellen hält. |

`DISCOVER_SCHEMA_ROWSETS` gehört **nicht** hierher. Es ist die größte Antwort,
die ein Server gibt, und wird beim ersten Schemazugriff geholt.

### Warum `DataSourceInfo` zählt

Ein Server nennt den Wert einmal und erwartet ihn danach auf jeder Anfrage
zurück. Ein Klient, der ihn fallen lässt, ist bei jeder Anfrage ein Fremder.

Der Fall ist belegt: ein Server, der die Spalte im Inline-Schema ankündigte und
in der Zeile leer ließ, wurde von Power BI mit
`AdomdUnknownResponseException("The provider either did not return any data
sources, or it did not return a value for the DataSourceInfo property")` aus
`AdomdConnection.ReadDataSourceInfo()` abgewiesen — vor jeder Sitzung, beim
zweiten Rundgang der Verbindung. ADOMD 19 wirft dort nur bei null Zeilen oder
fehlender Spalte und duldet einen leeren Wert; die ältere Fassung nicht.

**Dieser Klient folgt ADOMD 19 und lässt den Wert leer sein.** Er hat es
nachgerechnet: alle vier Gespräche im Testkit — `ssms-connect`, `ssms-session`,
`powerbi-import`, `powerbi-live` — antworten `<DataSourceInfo/>`, und keiner
dieser Klienten schickt die Eigenschaft danach auf irgendeiner Anfrage mit:
0 von 13 bei SSMS, 0 von 44 bei Power BI live. Wer einen leeren Wert
zurückweist, weist damit jeden Server ab, den dieses Projekt je aufgezeichnet
hat.

Der Unterschied, auf den es ankommt, ist ein anderer: **leer senden** ist nicht
dasselbe wie **nicht senden**. Das erste hat dem echten Klienten oben die
Verbindung gekostet. Dieser Klient lässt die Eigenschaft weg, wenn der Server
keine nennt.

---

## 2. Anmeldung

Zwei Wege, und dieser Klient geht beide:

- **Vorab senden.** Viele Server beantworten eine Herausforderung mit einem Fault
  statt mit einem `401`; wer auf die Herausforderung wartet, wartet ewig.
- **Auf `401` genau einmal wiederholen.** Ein Server, der ordentlich mit
  `WWW-Authenticate` fordert, bekommt dieselbe Anfrage noch einmal mit
  Zugangsdaten. Genau einmal — ein zweites `401` ist die Antwort des Servers und
  kein Grund weiterzufragen.

Zwei Fälle werden gemeldet statt wiederholt: ein Aufrufer **ohne** Zugangsdaten
(es gibt nichts zu wiederholen) und einer, der ein Token hält, während `Basic`
verlangt wird.

`DISCOVER_DATASOURCES` trägt die Spalte, die für genau diese Frage da ist:

> **Unauthenticated** — No user ID or password has to be sent.
> **Authenticated** — User ID and password MUST be included.
> **Integrated** — The data source uses the underlying security to determine authorization.

Sie steht als `info.dataSource.authenticationMode` bereit. Sie wird gelesen und
nicht befolgt: der Klient sendet ohnehin vorab und reagiert ohnehin auf ein
`401`, und ein Server, der hier das Falsche sagt, soll nicht die Verbindung
kosten.

---

## 3. Warum die `SchemaGuid` zählt

Ein Klient kennt **28** Rowsets fest verdrahtet. Jedes andere findet er über die
Spalte `SchemaGuid` aus `DISCOVER_SCHEMA_ROWSETS`. Fehlt sie, ist das Rowset für
die halbe API unerreichbar; ist sie **falsch**, zeigt sie auf ein anderes
Rowset, und nichts an einem laufenden Server verrät es.

`RowsetCatalog.forGuid(guid)` ist diese Richtung — schreibweise- und
klammerunabhängig, weil eine GUID aus einer Registry, einer URL oder von Hand
kommt und die drei sich uneins sind.

Eine Doppelung ist echt und bleibt: `DMSCHEMA_MINING_MODEL_XML` und
`DMSCHEMA_MINING_MODEL_CONTENT_PMML` tragen dieselbe GUID. Sie einem der beiden
zu nehmen macht nicht das andere erreichbar, sondern beide unerreichbar.

Jede GUID im Modell trägt ein `guidSource`. Eine GUID, die niemand zurückverfolgen
kann, ist eine, die niemand prüfen kann.

---

## 4. Die Fallen beim Lesen einer Antwort

Alle vier sind Stellen, an denen eine Zeile **heil aussieht** und falsch ist.
Dieser Klient benennt sie; `packages/emf-xml/test/diagnostics.test.ts` hält jede
einzeln fest.

| Was | Was ohne Diagnose passiert |
|---|---|
| Spalte im richtigen Namen, **falschem Namensraum** | Wird gelesen, als gehöre sie dazu — oder, bei einem strengen Klienten, wortlos übersprungen und die Zelle bleibt leer |
| Leeres `<Col/>` auf Zahl, Datum oder `uuid` | Wird zu `NaN` und wandert durch jede Rechnung, die es anfasst |
| `xsi:nil="true"` | Ohne Behandlung landet leerer Text im Wertleser und wirft — obwohl NULL gemeint war |
| `xsd:dateTime` ohne Sekunden | `2026-08-15T00:00` ist kein gültiger Wert; der Typ verlangt `hh:mm:ss` |

Zwei Feinheiten, die nicht verhandelbar sind:

- `xsi:nil` gilt **nur** beim Literal `true`. XSD kennt `1` für Boolesche, aber
  ein Leser, der es hier auch nähme, läse eine Spalte mit der Zahl Eins als
  abwesend.
- Ein leeres Element auf einer **Text**spalte ist ein Wert — die leere
  Zeichenkette — und auf jeder anderen keiner. Dieselbe Regel steht serverseitig
  in `EcoreXmlWriter.isTextColumn`.

Der Namensraum wird nur dort geprüft, wo das Modell einen nennt: ein Merkmal
ohne Angabe ist absichtlich unqualifiziert, und ein Element ohne Namensraum
passt auf alles.

---

## 5. Die Sitzungsköpfe

Drei getrennte Blöcke, kein Modus:

- `<BeginSession/>` eröffnet, der Server antwortet mit `<Session SessionId="…"/>`
- `<Session SessionId="…"/>` trägt jede weitere Anfrage
- `<EndSession SessionId="…"/>` schließt

Ein Umschlag **ohne** Köpfe trägt gar kein `<soap:Header>`. Ein leeres
`<soap:Header/>` ist ein einziger selbstschließender Knoten, und ein Leser, der
`ReadStartElement` mit `ReadEndElement` paart, ist danach für den Rest des
Dokuments ein Element außer Tritt. Der ereignisbasierte Leser hier ist davon
nicht betroffen — die Regel steht trotzdem hier, weil ein Server sie einhalten
muss.

---

## 6. Die Fähigkeitsmasken

`info.capabilities` liest die `MdpropMdx*`-Werte als benannte Bits, damit ein
Aufrufer fragen kann, statt auszuprobieren:

```ts
if (info.capabilities.has('MDPROPVAL_MF_WITH_CALCMEMBERS')) {
  // WITH MEMBER ist erlaubt
}
```

Die Bits stammen aus `[MS-SSAS]`. Eine Maske, die mehr behauptet, als die
Maschine kann, macht aus einem „nicht unterstützt" einen Übersetzungsfehler am
anderen Ende — wer fragt, ist besser dran als wer es versucht.

---

## Quellen

- `[MS-SSAS]` als DOCX. Die Spaltentabellen, die Bit-Vokabulare, die
  Einschränkungen je Rowset.
- Der dekompilierte ADOMD-Stapel: die Verbindungsfolge, die Prüfungen beim Lesen
  einer Rowset-Antwort und die Ausnahme, die jede von ihnen wirft. **Lokal, nicht
  veröffentlicht** — hier wird umschrieben, nicht zitiert.
- `packages/testkit/fixtures`: 461 aufgezeichnete Nachrichten aus fünf Sitzungen
  mit SSAS 13, mit `_manifest.json` je Gespräch als Grundwahrheit. Sie sind der
  Prüfstand für diesen Port und lassen sich nicht neu aufnehmen.
