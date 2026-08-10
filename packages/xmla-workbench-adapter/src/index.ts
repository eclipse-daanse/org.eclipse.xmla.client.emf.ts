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
 * Plain records and cellsets over the EObject client.
 *
 * Everything else in this project hands back EObjects, because that is what
 * makes a nested rowset render as a table rather than as a JSON blob. This is
 * the one place that flattens them, so mdx-workbench can change one import
 * instead of being rewritten.
 */
export { CellsetReader, toCellset, UnsupportedResponseShapeError } from './cellset.js';
export type { XmlaCell, XmlaCellset, XmlaCellsetAxis, XmlaCellsetMember } from './cellset.js';
export { rowToRecord, toParsedRowset } from './records.js';
export type { ParsedRowset } from './records.js';
