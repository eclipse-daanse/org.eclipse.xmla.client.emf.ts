/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EcoreXmlReader, EventKind, Unknown, XmlCodecError, XmlCursor } from '@daanse/emf-xml';
import type { XmlaModels } from '@daanse/xmla-model';
import type { EClass, EObject } from '@emfts/core';

import type { RestrictionEntry } from './requests.js';

/**
 * Reading the two requests back.
 *
 * Needed for the client only to check itself - the round trip over every
 * recorded request is what says the writer produces what a real client sends.
 * A server implementation would use the same code.
 */
export interface ReadDiscover {
  readonly requestType: string;
  readonly restrictions: readonly RestrictionEntry[];
  /** The `PropertyList` as read, or null when the request carried an empty one. */
  readonly properties: EObject | null;
}

export interface ReadExecute {
  /** The command element's name, which is what a server dispatches on. */
  readonly commandName: string | null;
  readonly command: EObject | null;
  readonly properties: EObject | null;
}

export class RequestReader {
  private readonly propertyListClass: EClass;
  private readonly reader = new EcoreXmlReader({ unknown: Unknown.SKIP });
  private readonly commandClasses = new Map<string, EClass>();

  constructor(models: XmlaModels) {
    const xmla = models.named('xmla');
    if (xmla === null) {
      throw new Error('the xmla model is not loaded');
    }
    const propertyList = xmla.getEClassifier('PropertyList') as EClass | null;
    if (propertyList === null || propertyList === undefined) {
      throw new Error('the xmla model has no PropertyList');
    }
    this.propertyListClass = propertyList;

    // Commands resolve by element name, exactly as a server dispatches them.
    const classifiers = xmla.getEClassifiers();
    for (let i = 0; i < classifiers.size(); i++) {
      const classifier = classifiers.get(i)!;
      const eClass = classifier as unknown as EClass;
      if (typeof eClass.getEStructuralFeatures !== 'function' || eClass.isAbstract?.() === true) {
        continue;
      }
      this.commandClasses.set(eClass.getName()!, eClass);
    }
  }

  /**
   * Reads a `<Discover>`, with the cursor on its start element.
   */
  readDiscover(cursor: XmlCursor): ReadDiscover {
    let requestType: string | null = null;
    const restrictions: RestrictionEntry[] = [];
    let properties: EObject | null = null;

    let depth = 0;
    let kind = cursor.next();
    while (kind !== null) {
      if (kind === EventKind.END) {
        if (depth === 0) {
          break; // </Discover>
        }
        depth -= 1;
        kind = cursor.next();
        continue;
      }
      if (kind !== EventKind.START) {
        kind = cursor.next();
        continue;
      }
      switch (cursor.localName) {
        case 'RequestType':
          requestType = cursor.elementText().trim();
          break;
        case 'RestrictionList':
          readRestrictions(cursor, restrictions);
          break;
        case 'PropertyList':
          properties = this.reader.read(cursor, this.propertyListClass);
          break;
        default:
          // <Restrictions> and <Properties> only wrap the two lists above, and an
          // unrecognised child is not this reader's to refuse.
          depth += 1;
      }
      kind = cursor.next();
    }

    if (requestType === null) {
      throw new XmlCodecError('the Discover request carries no <RequestType>', cursor.location);
    }
    if (requestType === '') {
      throw new XmlCodecError('the Discover request carries an empty <RequestType>', cursor.location);
    }
    return { requestType, restrictions, properties };
  }

  /** Reads an `<Execute>`, with the cursor on its start element. */
  readExecute(cursor: XmlCursor): ReadExecute {
    let commandName: string | null = null;
    let command: EObject | null = null;
    let properties: EObject | null = null;

    let depth = 0;
    let kind = cursor.next();
    while (kind !== null) {
      if (kind === EventKind.END) {
        if (depth === 0) {
          break; // </Execute>
        }
        depth -= 1;
        kind = cursor.next();
        continue;
      }
      if (kind !== EventKind.START) {
        kind = cursor.next();
        continue;
      }
      const name = cursor.localName;
      if (name === 'PropertyList') {
        properties = this.reader.read(cursor, this.propertyListClass);
      } else if (name === 'Command' || name === 'Properties') {
        depth += 1;
      } else if (commandName === null) {
        // The first element inside <Command> is the command, and its name is what
        // a server dispatches on - <Statement>, <Alter>, <BeginSession>.
        commandName = name;
        const eClass = this.commandClasses.get(name);
        if (eClass === undefined) {
          cursor.skipSubtree();
        } else {
          command = this.reader.read(cursor, eClass);
        }
      } else {
        depth += 1;
      }
      kind = cursor.next();
    }
    return { commandName, command, properties };
  }
}

function readRestrictions(cursor: XmlCursor, into: RestrictionEntry[]): void {
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.END) {
      return; // </RestrictionList>
    }
    if (kind === EventKind.START) {
      readRestrictionValues(cursor, cursor.localName, into);
    }
    kind = cursor.next();
  }
}

/**
 * One restriction, in either of the two forms a client sends.
 *
 * SQL Server Management Studio writes several values by repeating the element:
 * `<PropertyName>a</PropertyName><PropertyName>b</PropertyName>`. Excel writes
 * them as a set inside one:
 * `<PropertyName><Value>a</Value><Value>b</Value></PropertyName>`.
 *
 * Both mean the same and both become one entry per value, so a caller cannot
 * tell which client it is talking to - which is the point. Reading this with
 * plain element text throws on the second form, and that is not hypothetical: it
 * refused a real Excel connect with a parse error before its first
 * DISCOVER_PROPERTIES was answered.
 */
function readRestrictionValues(cursor: XmlCursor, name: string, into: RestrictionEntry[]): void {
  let text = '';
  let depth = 0;

  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.TEXT) {
      text += cursor.text;
    } else if (kind === EventKind.START) {
      // A wrapped value. Whatever text accumulated so far is whitespace between
      // the wrapper and its children.
      text = '';
      depth += 1;
    } else {
      const value = text.trim();
      text = '';
      if (depth === 0) {
        // </PropertyName>: the unwrapped form, unless children already supplied it.
        if (value !== '') {
          into.push({ name, value });
        }
        return;
      }
      depth -= 1;
      into.push({ name, value });
    }
    kind = cursor.next();
  }
}
