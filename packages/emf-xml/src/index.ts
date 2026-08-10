/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/**
 * Reads and writes XML for any Ecore model, driven by ExtendedMetaData.
 *
 * Knows nothing about XMLA - that is the point. The dynamic path builds EClasses
 * at runtime from a schema the server sent, and this reads them with exactly the
 * same code that reads the static models.
 */
export { EventKind, XmlCursor } from './cursor.js';
export type { XmlAttribute } from './cursor.js';
export {
  DAANSE_XMLA_URI,
  elementNameFrom,
  featureKindOf,
  groupElementNameOf,
  isAttribute,
  isSimpleContent,
  isWildcard,
  rawNamespaceOf,
  wireNameOf,
  wireNameOfType,
  wrapperNameOf,
} from './emd.js';
export { XmlCodecError } from './errors.js';
export type { XmlLocation } from './errors.js';
export { EcoreXmlReader, Unknown } from './reader.js';
export type { ReaderOptions } from './reader.js';
export { formatValue, parseValue } from './values.js';
