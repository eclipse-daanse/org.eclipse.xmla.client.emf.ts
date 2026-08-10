/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { describe, expect, it } from 'vitest';

import { EventKind, XmlCursor } from '../src/cursor.js';
import { XmlCodecError } from '../src/errors.js';

function at(xml: string, localName: string): XmlCursor {
  const cursor = XmlCursor.parse(xml);
  let kind = cursor.next();
  while (kind !== null && !(kind === EventKind.START && cursor.localName === localName)) {
    kind = cursor.next();
  }
  expect(kind, `found <${localName}>`).toBe(EventKind.START);
  return cursor;
}

describe('the cursor', () => {
  it('reports namespaces and local names apart from prefixes', () => {
    const cursor = at('<a:root xmlns:a="urn:one"><b:child xmlns:b="urn:two"/></a:root>', 'child');

    expect(cursor.localName).toBe('child');
    expect(cursor.namespaceURI).toBe('urn:two');
  });

  it('does not report namespace declarations as attributes', () => {
    // They are structure, not data. A model has no feature for xmlns, and
    // letting them travel as attributes would make every element look like it
    // carried unknown ones.
    const cursor = at('<root xmlns="urn:d" xmlns:x="urn:x" real="yes"/>', 'root');

    expect(cursor.attributes.map((a) => a.localName)).toEqual(['real']);
  });

  it('keeps whitespace-only text', () => {
    // A type with simple content owns the element's own text, so
    // <FmtValue> </FmtValue> means a single space. Dropping it because it looks
    // like formatting would change the value.
    const cursor = at('<v> </v>', 'v');

    expect(cursor.elementText()).toBe(' ');
  });

  it('refuses to read element content as text', () => {
    // Returning the concatenated leaves would hide a model that is simply wrong
    // about the shape of what it is reading.
    const cursor = at('<v><nested/></v>', 'v');

    expect(() => cursor.elementText()).toThrow(XmlCodecError);
  });

  it('leaves the cursor on the matching end after skipping a subtree', () => {
    const cursor = at('<root><skip><deep><deeper/></deep></skip><after/></root>', 'skip');
    cursor.skipSubtree();

    expect(cursor.kind).toBe(EventKind.END);
    expect(cursor.next()).toBe(EventKind.START);
    expect(cursor.localName).toBe('after');
  });

  it('says where it is, so a bad value can be found in a large document', () => {
    const cursor = at('<root>\n  <v>x</v>\n</root>', 'v');

    expect(cursor.location.line).toBe(2);
  });

  it('reports a document that is not well formed, while reading it', () => {
    // The trade streaming makes: nothing is parsed until something is asked
    // for, so malformedness surfaces on the read rather than on the call that
    // hands over the text. It still surfaces, which is what matters - a
    // half-read document must never look like a complete one.
    const cursor = XmlCursor.parse('<root><unclosed></root>');

    expect(() => {
      while (cursor.next() !== null) {
        // drain
      }
    }).toThrow(XmlCodecError);
  });

  it('reads only as far as it is asked to', () => {
    // The point of the whole change: a document is not turned into an object
    // graph before the first question is answered.
    const many = `<root>${'<row><A>x</A></row>'.repeat(20_000)}</root>`;
    const cursor = XmlCursor.parse(many);

    cursor.next();
    cursor.next();

    expect(cursor.eventCount, 'events gone past').toBe(2);
  });
});

describe('cutting out a fragment', () => {
  it('returns the children as XML, not as escaped text', () => {
    const cursor = at('<column><Server><Name>s</Name></Server></column>', 'column');

    expect(cursor.rawSubtree()).toBe('<Server><Name>s</Name></Server>');
  });

  it('escapes text so a value cannot decide the structure of the message', () => {
    const cursor = at('<column>a &lt; b &amp; c</column>', 'column');

    expect(cursor.rawSubtree()).toBe('a &lt; b &amp; c');
  });

  it('declares a prefix the fragment uses but does not carry', () => {
    // SSAS writes <xars:METADATA> with xars and a dozen ddl* prefixes declared
    // on the response root. Without redeclaring, the captured text cannot be
    // parsed again.
    const cursor = at(
      '<root xmlns:xars="urn:xars"><column><xars:METADATA><xars:Item/></xars:METADATA></column></root>',
      'column',
    );
    const fragment = cursor.rawSubtree();

    expect(fragment).toContain('xmlns:xars="urn:xars"');
    // And it parses on its own, which is the whole point.
    expect(() => XmlCursor.parse(fragment)).not.toThrow();
  });

  it('does not redeclare a prefix the fragment already declares', () => {
    const cursor = at('<column><a:x xmlns:a="urn:a"><a:y/></a:x></column>', 'column');
    const fragment = cursor.rawSubtree();

    expect(fragment.match(/xmlns:a=/g)?.length).toBe(1);
  });

  it('keeps attributes, including one in a namespace of its own', () => {
    const cursor = at(
      '<root xmlns:sql="urn:sql"><column><e sql:field="F" plain="p"/></column></root>',
      'column',
    );
    const fragment = cursor.rawSubtree();

    expect(fragment).toContain('plain="p"');
    expect(fragment).toContain('sql:field="F"');
    expect(fragment).toContain('xmlns:sql="urn:sql"');
  });
});
