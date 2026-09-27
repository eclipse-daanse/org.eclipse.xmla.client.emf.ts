/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { DAANSE_XMLA_URI, EventKind, XmlCodecError, XmlCursor } from '@eclipse-daanse/emf-xml';
import { XMLA_NAMESPACES } from '@eclipse-daanse/xmla-model';
import {
  BasicEAnnotation,
  BasicEAttribute,
  BasicEClass,
  BasicEDataType,
  BasicEPackage,
  BasicEReference,
  EMD_ANNOTATION_URI,
  getXMLTypePackage,
} from '@emfts/core';
import type { EClass, EClassifier, EPackage, EStructuralFeature } from '@emfts/core';

/**
 * Turns the inline `<xsd:schema>` of a response into an EClass for its rows.
 *
 * The whole point of the dynamic path: a server that answers a rowset this
 * project never modelled still describes it, in every single response, and that
 * description is enough to read the rows and to render them.
 *
 * The vocabulary is small and was measured rather than assumed. Across the 83
 * inline schemas in the recorded corpus there are exactly eight element names,
 * `minOccurs` is always `0`, `maxOccurs` is always `unbounded`, and thirteen
 * distinct types occur. So the importer recognises those eight and **throws** on
 * anything else, rather than quietly dropping a column - the same stance the
 * writer takes.
 */
const XSD = XMLA_NAMESPACES.XSD;

const KNOWN_ELEMENTS = new Set([
  'schema',
  'element',
  'complexType',
  'sequence',
  'simpleType',
  'restriction',
  'pattern',
  'any',
  // Not seen in the corpus but harmless and cheap to allow, because it carries
  // no column: an import only names another namespace.
  'import',
  'annotation',
  'documentation',
  'appinfo',
]);

/**
 * The exact inverse of what the schema writer emits, onto XMLType.
 *
 * Object variants throughout, because a column that is absent **is** NULL and a
 * primitive cannot say so. `uuid` and `xmlDocument` are the two types a rowset
 * schema declares locally rather than taking from XSD.
 */
const TYPE_MAP: Readonly<Record<string, string>> = {
  'xsd:string': 'String',
  'xsd:boolean': 'BooleanObject',
  'xsd:int': 'IntObject',
  'xsd:short': 'ShortObject',
  'xsd:long': 'LongObject',
  'xsd:float': 'FloatObject',
  'xsd:double': 'DoubleObject',
  'xsd:decimal': 'Decimal',
  'xsd:dateTime': 'DateTime',
  'xsd:date': 'Date',
  'xsd:time': 'Time',
  'xsd:unsignedByte': 'UnsignedByteObject',
  'xsd:unsignedShort': 'UnsignedShortObject',
  'xsd:unsignedInt': 'UnsignedIntObject',
  'xsd:unsignedLong': 'UnsignedLong',
  'xsd:base64Binary': 'Base64Binary',
  'xsd:anyType': 'AnySimpleType',
  // Declared locally by the rowset schema itself.
  uuid: 'String',
};

/**
 * The two types a rowset schema declares for itself rather than taking from XSD.
 *
 * `xmlDocument` has to keep that exact name. The reader decides whether a column
 * holds a document or a string by the name of its type, so a column mapped to
 * plain String would be read with element text and throw on the <Server>
 * definition DISCOVER_XML_METADATA answers with.
 */
const LOCAL_TYPES: Readonly<Record<string, string>> = {
  xmlDocument: 'XmlDocument',
};

/** One column, as the schema declared it. */
export interface ImportedColumn {
  readonly name: string;
  readonly type: string | null;
  readonly many: boolean;
  /** A nested rowset's own columns, when the column declared a complexType. */
  readonly nested: readonly ImportedColumn[] | null;
}

export interface ImportedSchema {
  readonly targetNamespace: string;
  readonly columns: readonly ImportedColumn[];
}

/**
 * Reads the schema into a plain description, before any Ecore is built.
 *
 * Kept separate so the parse can be tested, and shown, without a model in the
 * way - the explorer puts this beside the EClass built from it.
 */
export function parseInlineSchema(xml: string): ImportedSchema {
  const cursor = XmlCursor.parse(xml);
  if (!cursor.moveToFirstElement()) {
    throw new XmlCodecError('the inline schema is empty');
  }
  if (cursor.namespaceURI !== XSD || cursor.localName !== 'schema') {
    throw new XmlCodecError(`expected an <xsd:schema>, found <${cursor.localName}>`, cursor.location);
  }
  const targetNamespace = attribute(cursor, 'targetNamespace') ?? '';

  // Element declarations by name, so a <element name="row"> that references a
  // named complexType can be resolved.
  const complexTypes = new Map<string, ImportedColumn[]>();
  let rowColumns: ImportedColumn[] | null = null;

  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.END) {
      break;
    }
    if (kind !== EventKind.START) {
      kind = cursor.next();
      continue;
    }
    reject(cursor);
    // Read into a local: the getter is re-evaluated after every next(), which
    // the narrowing from the check above would otherwise hide.
    const local: string = cursor.localName;
    if (local === 'complexType') {
      const name = attribute(cursor, 'name');
      const columns = readComplexType(cursor);
      if (name !== null) {
        complexTypes.set(name, columns);
      }
    } else if (local === 'element' && attribute(cursor, 'name') === 'row') {
      const type = attribute(cursor, 'type');
      if (type === null) {
        rowColumns = readElementBody(cursor);
      } else {
        rowColumns = complexTypes.get(type) ?? [];
      }
    } else {
      cursor.skipSubtree();
    }
    kind = cursor.next();
  }

  if (rowColumns === null) {
    // Both shapes occur: <element name="row" type="row"/> after a named
    // complexType, and an inline one. Neither found means the schema does not
    // describe rows, which is not something to guess about.
    const named = complexTypes.get('row');
    if (named === undefined) {
      throw new XmlCodecError('the inline schema declares no row element');
    }
    rowColumns = named;
  }
  return { targetNamespace, columns: rowColumns };
}

/** The columns of a `<complexType>`, with the cursor on its start. */
function readComplexType(cursor: XmlCursor): ImportedColumn[] {
  const columns: ImportedColumn[] = [];
  let depth = 0;

  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.END) {
      if (depth === 0) {
        return columns;
      }
      depth -= 1;
      kind = cursor.next();
      continue;
    }
    if (kind === EventKind.START) {
      reject(cursor);
      const local: string = cursor.localName;
      if (local === 'element') {
        columns.push(readColumn(cursor));
      } else if (local === 'sequence') {
        depth += 1;
      } else {
        // <any>, <annotation> and friends declare no column.
        cursor.skipSubtree();
      }
    }
    kind = cursor.next();
  }
  return columns;
}

function readColumn(cursor: XmlCursor): ImportedColumn {
  const name = attribute(cursor, 'name');
  if (name === null) {
    throw new XmlCodecError('an <xsd:element> in the inline schema has no name', cursor.location);
  }
  const type = attribute(cursor, 'type');
  const many = attribute(cursor, 'maxOccurs') === 'unbounded';

  if (type !== null) {
    cursor.skipSubtree();
    return { name, type, many, nested: null };
  }
  // No type attribute means the column declares its own, inline. Whether that
  // is a nested rowset or a restricted simple type is decided structurally: a
  // complexType inside makes it nested, a simpleType does not.
  const inline = readElementBodyDetailed(cursor);
  return { name, type: inline.simpleType, many, nested: inline.nested };
}

function readElementBody(cursor: XmlCursor): ImportedColumn[] {
  return readElementBodyDetailed(cursor).nested ?? [];
}

function readElementBodyDetailed(cursor: XmlCursor): {
  nested: ImportedColumn[] | null;
  simpleType: string | null;
} {
  let nested: ImportedColumn[] | null = null;
  let simpleType: string | null = null;
  let depth = 0;

  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.END) {
      if (depth === 0) {
        return { nested, simpleType };
      }
      depth -= 1;
      kind = cursor.next();
      continue;
    }
    if (kind === EventKind.START) {
      reject(cursor);
      const local: string = cursor.localName;
      if (local === 'complexType') {
        nested = readComplexType(cursor);
      } else if (local === 'simpleType') {
        simpleType = readSimpleType(cursor);
      } else {
        cursor.skipSubtree();
      }
    }
    kind = cursor.next();
  }
  return { nested, simpleType };
}

/** The base type a `<simpleType><restriction base="..."/>` narrows. */
function readSimpleType(cursor: XmlCursor): string | null {
  let base: string | null = null;
  let depth = 0;

  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.END) {
      if (depth === 0) {
        return base;
      }
      depth -= 1;
      kind = cursor.next();
      continue;
    }
    if (kind === EventKind.START) {
      reject(cursor);
      const local: string = cursor.localName;
      if (local === 'restriction') {
        base = attribute(cursor, 'base') ?? base;
        depth += 1;
      } else {
        // <pattern> narrows the lexical space; the type it narrows is what a
        // reader needs, and the pattern itself is not enforced here.
        cursor.skipSubtree();
      }
    }
    kind = cursor.next();
  }
  return base;
}

/**
 * Refuses an element the importer does not know.
 *
 * The measured vocabulary is eight names across 83 real schemas. Silently
 * ignoring a ninth would mean losing a column and never being told, so an
 * unexpected one stops the import instead.
 */
function reject(cursor: XmlCursor): void {
  if (cursor.namespaceURI !== XSD) {
    throw new XmlCodecError(
      `<${cursor.localName}> in ${cursor.namespaceURI} has no place in an inline schema`,
      cursor.location,
    );
  }
  if (!KNOWN_ELEMENTS.has(cursor.localName)) {
    throw new XmlCodecError(
      `the inline schema uses <xsd:${cursor.localName}>, which this importer does not know`,
      cursor.location,
    );
  }
}

function attribute(cursor: XmlCursor, name: string): string | null {
  for (const each of cursor.attributes) {
    if (each.localName === name) {
      return each.value;
    }
  }
  return null;
}

export interface RowClassOptions {
  /**
   * The nsURI the built package is registered under.
   *
   * **Never the schema's own `targetNamespace`.** That is byte-identical to the
   * static rowset package's nsURI, so registering a dynamic package under it
   * would replace the real model for the whole process. The wire identity
   * travels on the feature annotations instead.
   */
  readonly nsURI: string;
  readonly className?: string;
}

/** What a built package looks like, so a caller need not dig for the row class. */
export interface DynamicRowset {
  readonly ePackage: EPackage;
  readonly rowClass: EClass;
  readonly schema: ImportedSchema;
}

/**
 * Builds an EPackage whose row EClass reads the rows this schema describes.
 *
 * The wire namespace is written **literally** onto every feature, not as
 * `##targetNamespace`. The convenient form resolves against the owning
 * package's nsURI - which here is the private one - and reading would then look
 * for elements in a namespace no server ever writes, finding nothing and saying
 * nothing.
 */
export function buildRowClass(schema: ImportedSchema, options: RowClassOptions): DynamicRowset {
  const ePackage = new BasicEPackage();
  ePackage.setName('dynamic');
  ePackage.setNsPrefix('dyn');
  ePackage.setNsURI(options.nsURI);

  const wireNamespace = schema.targetNamespace;
  const locals = new Map<string, EClassifier>();
  const rowClass = buildClass(options.className ?? 'Row', 'row', schema.columns, ePackage, wireNamespace, locals);

  return { ePackage, rowClass, schema };
}

function buildClass(
  className: string,
  wireName: string,
  columns: readonly ImportedColumn[],
  ePackage: BasicEPackage,
  wireNamespace: string,
  locals: Map<string, EClassifier>,
): EClass {
  const eClass = new BasicEClass();
  eClass.setName(className);
  annotate(eClass, EMD_ANNOTATION_URI, { name: wireName, kind: 'elementOnly' });
  ePackage.getEClassifiers().push(eClass);

  for (const column of columns) {
    if (column.nested !== null) {
      // A nested rowset: the column declared a complexType of its own.
      const nestedClass = buildClass(
        `${className}_${featureNameOf(column.name)}`,
        column.name,
        column.nested,
        ePackage,
        wireNamespace,
        locals,
      );
      const reference = new BasicEReference();
      reference.setName(featureNameOf(column.name));
      reference.setEType(nestedClass);
      reference.setContainment(true);
      reference.setLowerBound(0);
      reference.setUpperBound(column.many ? -1 : 1);
      annotateFeature(reference, column.name, wireNamespace);
      eClass.addFeature(reference);
      continue;
    }

    const attributeFeature = new BasicEAttribute();
    attributeFeature.setName(featureNameOf(column.name));
    attributeFeature.setEType(dataTypeFor(column.type, ePackage, locals));
    attributeFeature.setLowerBound(0);
    attributeFeature.setUpperBound(column.many ? -1 : 1);
    annotateFeature(attributeFeature, column.name, wireNamespace);
    eClass.addFeature(attributeFeature);
  }
  return eClass;
}

function annotateFeature(feature: EStructuralFeature, wireName: string, wireNamespace: string): void {
  const details: Record<string, string> = { kind: 'element', name: wireName };
  if (wireNamespace !== '') {
    // Literal, never ##targetNamespace - see buildRowClass.
    details['namespace'] = wireNamespace;
  }
  annotate(feature as unknown as Annotatable, EMD_ANNOTATION_URI, details);
  annotate(feature as unknown as Annotatable, DAANSE_XMLA_URI, { origin: 'inline-schema' });
}

interface Annotatable {
  getEAnnotations(): { push(annotation: unknown): unknown };
}

function annotate(target: Annotatable, source: string, details: Record<string, string>): void {
  const annotation = new BasicEAnnotation();
  annotation.setSource(source);
  for (const [key, value] of Object.entries(details)) {
    annotation.getDetails().putByKey(key, value);
  }
  target.getEAnnotations().push(annotation);
}

/**
 * A column name as a feature name: CATALOG_NAME becomes catalogName.
 *
 * Only ever the *feature* name. What goes on the wire stays the column's own
 * name, on the annotation, so nothing here has to be reversible.
 */
export function featureNameOf(columnName: string): string {
  if (!columnName.includes('_')) {
    return columnName.charAt(0).toLowerCase() + columnName.slice(1);
  }
  const parts = columnName.toLowerCase().split('_').filter((part) => part !== '');
  if (parts.length === 0) {
    return 'column';
  }
  return parts[0]! + parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function dataTypeFor(
  xsdType: string | null,
  ePackage: BasicEPackage,
  locals: Map<string, EClassifier>,
): EClassifier {
  const localName = xsdType === null ? null : (LOCAL_TYPES[xsdType] ?? null);
  if (localName !== null) {
    let local = locals.get(localName);
    if (local === undefined) {
      const dataType = new BasicEDataType();
      dataType.setName(localName);
      dataType.setInstanceClassName('java.lang.String');
      ePackage.getEClassifiers().push(dataType);
      local = dataType;
      locals.set(localName, dataType);
    }
    return local;
  }

  const xmlType = getXMLTypePackage();
  const name = xsdType === null ? 'String' : (TYPE_MAP[xsdType] ?? null);
  if (name === null) {
    throw new XmlCodecError(`the inline schema uses the type ${xsdType}, which maps to nothing here`);
  }
  const found = xmlType.getEClassifier(name);
  if (found === null || found === undefined) {
    throw new Error(`XMLType has no ${name}, which ${xsdType ?? 'an untyped column'} needs`);
  }
  return found;
}
