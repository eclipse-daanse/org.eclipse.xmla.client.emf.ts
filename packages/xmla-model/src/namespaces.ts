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
 * Every namespace and prefix the XMLA wire format uses, in one place.
 *
 * The prefixes are the ones a real Analysis Services instance emits. They carry
 * no meaning to a conforming parser, but clients exist that key off them, so
 * reproducing them costs nothing and avoids a class of interoperability
 * surprise.
 */
export const XMLA_NAMESPACES = {
  SOAP_ENV: 'http://schemas.xmlsoap.org/soap/envelope/',
  SOAP_ENV_PREFIX: 'soap',

  XMLA: 'urn:schemas-microsoft-com:xml-analysis',
  ROWSET: 'urn:schemas-microsoft-com:xml-analysis:rowset',
  MDDATASET: 'urn:schemas-microsoft-com:xml-analysis:mddataset',
  EMPTY: 'urn:schemas-microsoft-com:xml-analysis:empty',
  MULTIPLE_RESULTS: 'http://schemas.microsoft.com/analysisservices/2003/xmla-multipleresults',
  EXCEPTION: 'urn:schemas-microsoft-com:xml-analysis:exception',
  EXCEPTION_PREFIX: 'EX',

  ENGINE: 'http://schemas.microsoft.com/analysisservices/2003/engine',
  MSXMLA: 'http://schemas.microsoft.com/analysisservices/2003/xmla',
  EXT: 'http://schemas.microsoft.com/analysisservices/2003/ext',

  XSD: 'http://www.w3.org/2001/XMLSchema',
  XSD_PREFIX: 'xsd',
  XSI: 'http://www.w3.org/2001/XMLSchema-instance',
  XSI_PREFIX: 'xsi',

  /**
   * The namespace of the `sql:field` attribute accompanying every column
   * declaration in an inline schema. It carries no element, only that one
   * attribute — counted over both specifications, nothing else in this namespace
   * is ever written.
   *
   * There is a model for it on the Java side, `model/xml.sql`, but it is parked and
   * out of the build. Nothing here would use it anyway: this side only *reads*
   * inline schemas, and reading needs the element names rather than the annotation.
   * This constant is all there is.
   */
  SQL: 'urn:schemas-microsoft-com:xml-sql',
  SQL_PREFIX: 'sql',

  /** The SOAPAction values the specification names for the two verbs. */
  SOAP_ACTION_DISCOVER: 'urn:schemas-microsoft-com:xml-analysis:Discover',
  SOAP_ACTION_EXECUTE: 'urn:schemas-microsoft-com:xml-analysis:Execute',
} as const;
