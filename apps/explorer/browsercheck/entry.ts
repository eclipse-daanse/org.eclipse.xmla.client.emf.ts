import { XmlCursor, EventKind } from '@daanse/emf-xml';
import { RowsetCatalog } from '@daanse/xmla-model';
import { bootstrapInBrowser } from '@daanse/xmla-model/browser';

const models = bootstrapInBrowser();
const catalog = new RowsetCatalog(models);
const cursor = XmlCursor.parse('<root xmlns="urn:x"><row><A>1</A></row></root>');
let n = 0;
let k = cursor.next();
while (k !== null) { if (k === EventKind.START) n++; k = cursor.next(); }
(globalThis as Record<string, unknown>)['RESULT'] = {
  models: models.names.length,
  rowsets: catalog.requestTypes().length,
  events: n,
  cubes: catalog.forRequestType('MDSCHEMA_CUBES') !== null,
};
