/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { componentRegistry } from '@emfts/vue-registry';

import XmlaWidget from './XmlaWidget.vue';

/**
 * Teaching the widget registry about the types XMLA actually uses.
 *
 * `@emfts/vue-registry` ships editors keyed on Ecore's own data types -
 * `EString`, `EInt`, `EBoolean`. The XMLA models are built on **XMLType**, so a
 * restriction typed `UnsignedShortObject` or `IntObject` matches nothing and
 * gets no editor at all. That is not a corner: 75 of the 435 restriction
 * features across the catalogue are not `String`, so one restriction in six
 * would have been unfillable, and silently - `WidgetComposer` renders nothing
 * when it finds no component.
 *
 * Nothing is written here. The registry's own editors are simply pointed at the
 * type names the models use.
 */
const NUMERIC = [
  'IntObject',
  'Int',
  'ShortObject',
  'Short',
  'LongObject',
  'Long',
  'UnsignedByteObject',
  'UnsignedByte',
  'UnsignedShortObject',
  'UnsignedShort',
  'UnsignedIntObject',
  'UnsignedInt',
  'UnsignedLong',
  'FloatObject',
  'Float',
  'DoubleObject',
  'Double',
  'Decimal',
];

const TEXTUAL = ['String', 'AnySimpleType', 'Base64Binary', 'XmlDocument', 'Uuid'];

const BOOLEAN = ['BooleanObject', 'Boolean'];

const TEMPORAL = ['DateTime', 'Date', 'Time'];

/**
 * Registers the widget for every XMLType name the models use.
 *
 * One component rather than four, because what differs between a string and a
 * number here is the input's `type` attribute and nothing else - and what they
 * share is the part the registry's own editors get wrong: the label, and the
 * difference between clearing a box and asking for the empty string.
 *
 * Idempotent, so mounting twice in a test does not double-register.
 */
export function registerXmlaWidgets(): void {
  for (const name of REGISTERED_TYPE_NAMES) {
    componentRegistry.registerForDataType(name, XmlaWidget, { replace: true });
  }
}

/** The type names this registers for, so a test can check none was forgotten. */
export const REGISTERED_TYPE_NAMES: readonly string[] = [...TEXTUAL, ...NUMERIC, ...BOOLEAN, ...TEMPORAL];
