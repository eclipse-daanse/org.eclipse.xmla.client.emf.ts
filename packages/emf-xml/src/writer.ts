/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EventKind, XmlCursor } from './cursor.js';
import { XmlCodecError } from './errors.js';

/**
 * A namespace-aware XML writer, shaped like StAX.
 *
 * The Java side writes through `XMLStreamWriter`, and the rules being ported
 * are expressed in its terms - `writeEmptyElement` for a NULL column,
 * `setDefaultNamespace` for the outermost element, an attribute qualified only
 * where the model says so. Having the same shape here keeps the port readable
 * against its original instead of being a translation of a translation.
 *
 * A start tag stays open until something else is written, so attributes and
 * namespace declarations can still be added to it - the same contract StAX has,
 * and the reason `<DESCRIPTION/>` can be emitted rather than
 * `<DESCRIPTION></DESCRIPTION>`.
 */
interface Scope {
  readonly prefixes: Map<string, string>;
  readonly element: string;
}

export class XmlWriter {
  private readonly parts: string[] = [];
  private readonly scopes: Scope[] = [];
  private open = false;
  /** Whether the open tag is an empty element and closes itself. */
  private openIsEmpty = false;
  private pendingDefault: string | null = null;
  private generated = 0;

  /** The document written so far. */
  toString(): string {
    if (this.scopes.length > 0) {
      throw new XmlCodecError(`${this.scopes.length} element(s) were never closed`);
    }
    this.closeStartTag();
    return this.parts.join('');
  }

  writeDeclaration(encoding = 'UTF-8'): void {
    this.parts.push(`<?xml version="1.0" encoding="${encoding}"?>`);
  }

  /**
   * The namespace to become the default on the next element written.
   *
   * Separate from `writeDefaultNamespace` for the same reason StAX separates
   * them: the binding has to be known while the element name is chosen, but the
   * declaration is only emitted where the caller wants it.
   */
  setDefaultNamespace(namespace: string): void {
    this.pendingDefault = namespace;
  }

  /** The prefix bound to `namespace`, `''` for the default, or null if unbound. */
  getPrefix(namespace: string): string | null {
    if (namespace === '') {
      return '';
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      for (const [prefix, bound] of this.scopes[i]!.prefixes) {
        if (bound === namespace) {
          return prefix;
        }
      }
    }
    return this.pendingDefault === namespace ? '' : null;
  }

  writeStartElement(namespace: string, localName: string, preferredPrefix?: string): void {
    this.closeStartTag();
    this.openTag(namespace, localName, preferredPrefix);
  }

  /**
   * An element with no content at all: `<DESCRIPTION/>`.
   *
   * Not the same as a start immediately followed by an end, and the difference
   * is deliberate. `writeStartElement` + `writeEndElement` always produces
   * `<X></X>`, exactly as `XMLStreamWriter` does, so the short form is only ever
   * written where the caller asked for it. A parser reads the two identically,
   * but a stored document that comes back reshaped is a changed value, and the
   * NULL-versus-empty distinction in a rowset rests on this.
   *
   * The tag stays open, so attributes can still be written to it.
   */
  writeEmptyElement(namespace: string, localName: string, preferredPrefix?: string): void {
    this.closeStartTag();
    this.openTag(namespace, localName, preferredPrefix);
    this.openIsEmpty = true;
  }

  /**
   * Opens a tag, binding a prefix for its namespace if nothing has yet.
   *
   * The order matters and was wrong once: the scope has to exist before the
   * prefix is bound into it, and the declaration can only be emitted while the
   * tag is still open. Getting it the other way round bound the prefix on the
   * parent and never wrote the xmlns, so the document referred to a prefix it
   * had not declared.
   */
  private openTag(namespace: string, localName: string, preferredPrefix?: string): void {
    let prefix = namespace === '' ? '' : this.getPrefix(namespace);
    let declare = false;
    if (prefix === null) {
      // A caller copying a fragment says which prefix the source used, so the
      // output reads like what it came from rather than like ns0, ns1, ns2.
      prefix = preferredPrefix ?? `ns${this.generated++}`;
      declare = true;
    }

    const qName = prefix === '' ? localName : `${prefix}:${localName}`;
    this.parts.push(`<${qName}`);
    this.scopes.push({ prefixes: new Map(), element: qName });
    this.open = true;

    if (declare) {
      this.bind(prefix, namespace);
      this.parts.push(
        prefix === ''
          ? ` xmlns="${escapeAttribute(namespace)}"`
          : ` xmlns:${prefix}="${escapeAttribute(namespace)}"`,
      );
    }
  }

  writeEndElement(): void {
    this.closeStartTag();
    const scope = this.scopes.pop();
    if (scope === undefined) {
      throw new XmlCodecError('there is no open element to end');
    }
    this.parts.push(`</${scope.element}>`);
  }

  writeAttribute(localName: string, value: string): void {
    this.requireOpen('an attribute');
    this.parts.push(` ${localName}="${escapeAttribute(value)}"`);
  }

  writeQualifiedAttribute(namespace: string, localName: string, value: string, preferredPrefix?: string): void {
    this.requireOpen('an attribute');
    let prefix = this.getPrefix(namespace);
    if (prefix === null || prefix === '') {
      // A default-namespace declaration never applies to attributes, so an
      // attribute in a namespace always needs a real prefix of its own.
      prefix = this.declareGenerated(namespace, preferredPrefix);
    }
    this.parts.push(` ${prefix}:${localName}="${escapeAttribute(value)}"`);
  }

  writeNamespace(prefix: string, namespace: string): void {
    this.requireOpen('a namespace declaration');
    this.bind(prefix, namespace);
    this.parts.push(` xmlns:${prefix}="${escapeAttribute(namespace)}"`);
  }

  writeDefaultNamespace(namespace: string): void {
    this.requireOpen('a namespace declaration');
    this.bind('', namespace);
    this.pendingDefault = null;
    this.parts.push(` xmlns="${escapeAttribute(namespace)}"`);
  }

  writeCharacters(text: string): void {
    this.closeStartTag();
    this.parts.push(escapeText(text));
  }

  /**
   * Writes stored XML as XML rather than as text.
   *
   * A column of type `xmlDocument` holds a document: DISCOVER_XML_METADATA
   * answers with an entire `<Server>` definition inside one column. Escaping it
   * would turn that into the literal `&lt;Server&gt;`; concatenating it raw
   * would let a value decide the structure of the message. So it goes back
   * through the parser, and only what parses is written.
   */
  writeFragment(xml: string): void {
    this.closeStartTag();
    if (xml === '') {
      return;
    }
    const cursor = XmlCursor.parse(`<fragment>${xml}</fragment>`);
    const selfClosing: boolean[] = [];
    let depth = 0;
    let kind = cursor.next();
    while (kind !== null) {
      if (kind === EventKind.START) {
        if (depth > 0) {
          // Reproduced as it was written: the forms are the same XML, but a
          // stored document that comes back reshaped is a changed value.
          selfClosing.push(cursor.selfClosing);
          this.writeCopiedStart(cursor, cursor.selfClosing);
        }
        depth += 1;
      } else if (kind === EventKind.END) {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        if (selfClosing.pop() === true) {
          // Already closed by its own tag; only its scope has to go.
          this.closeStartTag();
        } else {
          this.writeEndElement();
        }
      } else if (depth > 0) {
        this.writeCharacters(cursor.text);
      }
      kind = cursor.next();
    }
  }

  private writeCopiedStart(cursor: XmlCursor, empty: boolean): void {
    // The element declares its own namespace when nothing has bound it, so a
    // fragment carrying a prefix its surroundings never declared still comes out
    // parseable on its own.
    if (empty) {
      this.writeEmptyElement(cursor.namespaceURI, cursor.localName, cursor.prefix);
    } else {
      this.writeStartElement(cursor.namespaceURI, cursor.localName, cursor.prefix);
    }
    for (const attribute of cursor.attributes) {
      if (attribute.namespaceURI === '') {
        this.writeAttribute(attribute.localName, attribute.value);
      } else {
        this.writeQualifiedAttribute(
          attribute.namespaceURI,
          attribute.localName,
          attribute.value,
          attribute.prefix,
        );
      }
    }
  }

  /**
   * Binds a prefix nobody asked for, on the tag currently open.
   *
   * Reached when an attribute carries a namespace nothing has bound - a
   * fragment's `sql:field`, for instance. Named `ns0`, `ns1` and so on because
   * the prefix itself carries no meaning; what matters is that it is bound.
   */
  private declareGenerated(namespace: string, preferredPrefix?: string): string {
    const prefix =
      preferredPrefix !== undefined && preferredPrefix !== '' && this.boundTo(preferredPrefix) === undefined
        ? preferredPrefix
        : `ns${this.generated++}`;
    this.bind(prefix, namespace);
    this.parts.push(` xmlns:${prefix}="${escapeAttribute(namespace)}"`);
    return prefix;
  }

  /** What `prefix` is currently bound to, or undefined if nothing binds it. */
  private boundTo(prefix: string): string | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const bound = this.scopes[i]!.prefixes.get(prefix);
      if (bound !== undefined) {
        return bound;
      }
    }
    return undefined;
  }

  private bind(prefix: string, namespace: string): void {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope !== undefined) {
      scope.prefixes.set(prefix, namespace);
    }
  }

  private requireOpen(what: string): void {
    if (!this.open) {
      throw new XmlCodecError(`${what} can only be written while a start tag is open`);
    }
  }

  private closeStartTag(): void {
    if (!this.open) {
      return;
    }
    this.parts.push(this.openIsEmpty ? '/>' : '>');
    this.open = false;
    if (this.openIsEmpty) {
      this.openIsEmpty = false;
      this.scopes.pop();
    }
  }
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;');
}
