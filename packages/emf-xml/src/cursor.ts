/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import sax from 'sax';

import { XmlCodecError } from './errors.js';

/**
 * A pull cursor over XML, shaped like StAX.
 *
 * The reader is a port of a Java one written against `XMLStreamReader`, and it
 * reads a subtree by recursing while pulling events. `sax` pushes, so this
 * turns the push into a pull.
 *
 * It does that by parsing eagerly into an event list. That is the honest thing
 * to start with - it is simple enough to be obviously correct, and the shape of
 * this interface is what a genuinely streaming implementation would have to
 * offer anyway. What it costs on a large response is measured rather than
 * guessed, and replacing the internals is a change behind this interface.
 */
export const EventKind = {
  START: 1,
  END: 2,
  TEXT: 3,
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface XmlAttribute {
  readonly localName: string;
  readonly prefix: string;
  readonly namespaceURI: string;
  readonly value: string;
}

interface XmlEvent {
  readonly kind: EventKind;
  readonly localName: string;
  readonly prefix: string;
  readonly namespaceURI: string;
  readonly text: string;
  readonly attributes: readonly XmlAttribute[];
  /** Prefixes this element declares itself, needed when cutting out a fragment. */
  readonly declaredNamespaces: Readonly<Record<string, string>> | null;
  /**
   * Whether the document wrote this as `<X/>` rather than `<X></X>`.
   *
   * The two are the same to a parser, but a stored document has to come back out
   * the way it went in, and SSAS uses both forms in the same response.
   */
  readonly selfClosing: boolean;
  readonly line: number;
  readonly column: number;
}

const NO_ATTRIBUTES: readonly XmlAttribute[] = [];

export class XmlCursor {
  private readonly events: readonly XmlEvent[];
  private index = -1;

  private constructor(events: readonly XmlEvent[]) {
    this.events = events;
  }

  static parse(xml: string): XmlCursor {
    return new XmlCursor(collect(xml));
  }

  /** How many events the document produced. Reported by the streaming tests. */
  get eventCount(): number {
    return this.events.length;
  }

  /** Advances one event, or returns null at the end of the document. */
  next(): EventKind | null {
    if (this.index + 1 >= this.events.length) {
      this.index = this.events.length;
      return null;
    }
    this.index += 1;
    return this.events[this.index]!.kind;
  }

  private get current(): XmlEvent {
    const event = this.events[this.index];
    if (event === undefined) {
      throw new XmlCodecError('the cursor is not positioned on an event');
    }
    return event;
  }

  get kind(): EventKind {
    return this.current.kind;
  }

  get localName(): string {
    return this.current.localName;
  }

  get namespaceURI(): string {
    return this.current.namespaceURI;
  }

  /**
   * The prefix the document itself used, `''` for the default namespace.
   *
   * Carried because copying a fragment has to reproduce it. A prefix means
   * nothing to a parser, but a recorded response is compared against what the
   * server wrote, and minting fresh prefixes would differ from it everywhere.
   */
  get prefix(): string {
    return this.current.prefix;
  }

  /** Whether the source wrote this element as `<X/>`. */
  get selfClosing(): boolean {
    return this.current.selfClosing;
  }

  get text(): string {
    return this.current.text;
  }

  get attributes(): readonly XmlAttribute[] {
    return this.current.attributes;
  }

  get location(): { line: number; column: number } {
    const event = this.events[Math.min(this.index, this.events.length - 1)];
    return event ? { line: event.line, column: event.column } : { line: 0, column: 0 };
  }

  /**
   * Positions on the first START_ELEMENT, so a caller can start reading without
   * knowing whether the document began with a declaration or whitespace.
   */
  moveToFirstElement(): boolean {
    let kind = this.next();
    while (kind !== null && kind !== EventKind.START) {
      kind = this.next();
    }
    return kind === EventKind.START;
  }

  /**
   * The text of the element the cursor is on, leaving it on the matching END.
   *
   * Throws when the element has element content, exactly as `getElementText`
   * does: a caller asking for text from something structured has the wrong
   * model, and silently returning the concatenated leaves would hide it.
   */
  elementText(): string {
    let text = '';
    let kind = this.next();
    while (kind !== null) {
      if (kind === EventKind.TEXT) {
        text += this.text;
      } else if (kind === EventKind.END) {
        return text;
      } else {
        throw new XmlCodecError(
          `element <${this.localName}> has element content where text was expected`,
          this.location,
        );
      }
      kind = this.next();
    }
    return text;
  }

  /** Steps over the subtree of the element the cursor is on, END included. */
  skipSubtree(): void {
    let depth = 1;
    while (depth > 0) {
      const kind = this.next();
      if (kind === null) {
        return;
      }
      if (kind === EventKind.START) {
        depth += 1;
      } else if (kind === EventKind.END) {
        depth -= 1;
      }
    }
  }

  /**
   * Everything inside the element the cursor is on, as XML text.
   *
   * A column of type `xmlDocument` holds a document, not a string:
   * DISCOVER_XML_METADATA answers with an entire `<Server>` definition inside
   * one column. Both directions go through the parser rather than through string
   * handling, so a value can never decide the structure of the message.
   *
   * The result has to stand on its own. A fragment is cut out of a larger
   * document and may use a prefix declared on an ancestor that is not coming
   * with it - SSAS declares a dozen `ddl*` prefixes on the response root. Any
   * prefix used but not declared inside the fragment is therefore declared where
   * it is first used.
   */
  rawSubtree(): string {
    return this.raw(false);
  }

  /**
   * The element the cursor is on, its own start tag included.
   *
   * The difference from `rawSubtree` matters more than it looks. Rebuilding a
   * start tag by hand loses whatever the element itself declared - an inline
   * `<xsd:schema>` carries its `targetNamespace` and its `xmlns:sql` there, and
   * a schema that arrives without them describes a different thing.
   */
  rawElement(): string {
    return this.raw(true);
  }

  private raw(includeSelf: boolean): string {
    const parts: string[] = [];
    const scopes: Array<Map<string, string>> = [];
    let depth = 0;
    // A self-closing tag is left unterminated until we know nothing follows it
    // inside, so `<X/>` can be written as `<X/>` rather than `<X></X>`.
    let selfClosed = false;

    const covers = (prefix: string, namespace: string): boolean => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const bound = scopes[i]!.get(prefix);
        if (bound !== undefined) {
          return bound === namespace;
        }
      }
      return false;
    };

    let ownTag = '';
    if (includeSelf) {
      const scope = new Map<string, string>();
      scopes.push(scope);
      ownTag = qualify(this.current.prefix, this.localName);
      parts.push(this.startTag(scope, covers, true));
      if (this.current.selfClosing) {
        // Nothing inside it, so the cursor's own END is all that is left.
        this.next();
        return `${parts.join('')}/>`;
      }
      parts.push('>');
    }

    let kind = this.next();
    while (kind !== null) {
      if (kind === EventKind.END) {
        if (depth === 0) {
          return includeSelf ? `${parts.join('')}</${ownTag}>` : parts.join('');
        }
        depth -= 1;
        scopes.pop();
        if (selfClosed) {
          selfClosed = false;
          parts.push('/>');
        } else {
          parts.push(`</${qualify(this.current.prefix, this.localName)}>`);
        }
      } else if (kind === EventKind.START) {
        if (selfClosed) {
          // The previous tag was self-closing, so its END is still to come.
          selfClosed = false;
          parts.push('>');
        }
        depth += 1;
        const scope = new Map<string, string>();
        scopes.push(scope);
        parts.push(this.startTag(scope, covers, true));
        selfClosed = this.current.selfClosing;
      } else {
        if (selfClosed) {
          selfClosed = false;
          parts.push('>');
        }
        parts.push(escapeText(this.text));
      }
      kind = this.next();
    }
    return parts.join('');
  }

  private startTag(
    scope: Map<string, string>,
    covers: (prefix: string, ns: string) => boolean,
    leaveOpen = false,
  ): string {
    const event = this.current;
    const declare = (prefix: string, namespace: string): string => {
      if (namespace === '' || covers(prefix, namespace) || scope.get(prefix) === namespace) {
        return '';
      }
      scope.set(prefix, namespace);
      return prefix === '' ? ` xmlns="${escapeAttribute(namespace)}"` : ` xmlns:${prefix}="${escapeAttribute(namespace)}"`;
    };

    let tag = `<${qualify(event.prefix, event.localName)}`;
    tag += declare(event.prefix, event.namespaceURI);
    for (const attribute of event.attributes) {
      // An attribute in no namespace needs no declaration; one in a namespace
      // may be the only user of its prefix in the fragment.
      if (attribute.namespaceURI !== '') {
        tag += declare(attribute.prefix, attribute.namespaceURI);
      }
      tag += ` ${qualify(attribute.prefix, attribute.localName)}="${escapeAttribute(attribute.value)}"`;
    }
    return leaveOpen && this.current.selfClosing ? tag : `${tag}>`;
  }
}

function qualify(prefix: string, localName: string): string {
  return prefix === '' ? localName : `${prefix}:${localName}`;
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;');
}

/**
 * Runs the parser once and keeps what it produced.
 *
 * Whitespace-only text is kept. A type with simple content owns the element's
 * own text, and `<FmtValue> </FmtValue>` means a single space - discarding it
 * because it looks like formatting would change the value.
 */
function collect(xml: string): XmlEvent[] {
  const events: XmlEvent[] = [];
  // The elements currently open, so an END knows its own name in constant time.
  const open: XmlEvent[] = [];
  const parser = sax.parser(true, { xmlns: true, position: true });

  parser.onerror = (error: Error) => {
    throw new XmlCodecError(`the document is not well formed: ${error.message}`, {
      line: parser.line + 1,
      column: parser.column,
    });
  };

  parser.onopentag = (node) => {
    const tag = node as sax.QualifiedTag;
    const attributes: XmlAttribute[] = [];
    for (const attribute of Object.values(tag.attributes)) {
      // sax reports the namespace declarations themselves as attributes. They
      // are structure, not data, and are rebuilt from scratch when a fragment is
      // cut out, so they must not travel as attributes too.
      if (attribute.prefix === 'xmlns' || attribute.name === 'xmlns') {
        continue;
      }
      attributes.push({
        localName: attribute.local,
        prefix: attribute.prefix,
        namespaceURI: attribute.uri,
        value: attribute.value,
      });
    }
    const start: XmlEvent = {
      kind: EventKind.START,
      localName: tag.local,
      prefix: tag.prefix,
      namespaceURI: tag.uri,
      text: '',
      attributes: attributes.length === 0 ? NO_ATTRIBUTES : attributes,
      declaredNamespaces: tag.ns ?? null,
      selfClosing: (node as { isSelfClosing?: boolean }).isSelfClosing === true,
      line: parser.line + 1,
      column: parser.column,
    };
    events.push(start);
    open.push(start);
  };

  parser.onclosetag = () => {
    const start = open.pop();
    events.push({
      kind: EventKind.END,
      localName: start?.localName ?? '',
      prefix: start?.prefix ?? '',
      namespaceURI: start?.namespaceURI ?? '',
      text: '',
      attributes: NO_ATTRIBUTES,
      declaredNamespaces: null,
      selfClosing: start?.selfClosing ?? false,
      line: parser.line + 1,
      column: parser.column,
    });
  };

  const onText = (text: string): void => {
    events.push({
      kind: EventKind.TEXT,
      localName: '',
      prefix: '',
      namespaceURI: '',
      text,
      attributes: NO_ATTRIBUTES,
      declaredNamespaces: null,
      selfClosing: false,
      line: parser.line + 1,
      column: parser.column,
    });
  };
  parser.ontext = onText;
  parser.oncdata = onText;

  parser.write(xml).close();
  return events;
}
