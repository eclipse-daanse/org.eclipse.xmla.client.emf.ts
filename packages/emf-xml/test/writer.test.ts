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
import { XmlWriter } from '../src/writer.js';

const NS = 'urn:test';

function wrapped(fragment: string): string {
  const out = new XmlWriter();
  out.setDefaultNamespace(NS);
  out.writeStartElement(NS, 'wrap');
  out.writeDefaultNamespace(NS);
  out.writeFragment(fragment);
  out.writeEndElement();
  const xml = out.toString();
  return xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf('</wrap>'));
}

/** Cut a subtree back out, the way an xmlDocument column is read. */
function cutOut(xml: string, elementName: string): string {
  const cursor = XmlCursor.parse(xml);
  let kind = cursor.next();
  while (kind !== null && !(kind === EventKind.START && cursor.localName === elementName)) {
    kind = cursor.next();
  }
  expect(kind).toBe(EventKind.START);
  return cursor.rawSubtree();
}

describe('the writer', () => {
  it('writes an element with no content as <X/>', () => {
    const out = new XmlWriter();
    out.setDefaultNamespace(NS);
    out.writeStartElement(NS, 'root');
    out.writeDefaultNamespace(NS);
    out.writeEmptyElement(NS, 'DESCRIPTION');
    out.writeEndElement();

    expect(out.toString()).toBe(`<root xmlns="${NS}"><DESCRIPTION/></root>`);
  });

  it('declares a namespace once and reuses the binding underneath', () => {
    const out = new XmlWriter();
    out.setDefaultNamespace(NS);
    out.writeStartElement(NS, 'root');
    out.writeDefaultNamespace(NS);
    out.writeStartElement(NS, 'a');
    out.writeStartElement(NS, 'b');
    out.writeEndElement();
    out.writeEndElement();
    out.writeEndElement();

    expect(out.toString().match(/xmlns=/g)?.length).toBe(1);
  });

  it('gives an attribute a real prefix, since a default namespace never covers one', () => {
    const out = new XmlWriter();
    out.setDefaultNamespace(NS);
    out.writeStartElement(NS, 'Header');
    out.writeDefaultNamespace(NS);
    out.writeQualifiedAttribute('http://schemas.xmlsoap.org/soap/envelope/', 'mustUnderstand', '1', 'soap');
    out.writeEndElement();

    const xml = out.toString();
    expect(xml).toContain('soap:mustUnderstand="1"');
    expect(xml).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
  });

  it('escapes text and attribute values', () => {
    const out = new XmlWriter();
    out.writeStartElement('', 'v');
    out.writeAttribute('a', 'quote " and < and &');
    out.writeCharacters('a < b & c');
    out.writeEndElement();

    expect(out.toString()).toBe('<v a="quote &quot; and &lt; and &amp;">a &lt; b &amp; c</v>');
  });

  it('refuses to hand out a document with an element still open', () => {
    const out = new XmlWriter();
    out.writeStartElement('', 'never-closed');

    expect(() => out.toString()).toThrow(XmlCodecError);
  });
});

describe('a stored document', () => {
  it('comes back out the way it went in', () => {
    // An xmlDocument column holds a document. Reshaping it on the way through
    // would change the value, even where the XML means the same.
    const original = '<Server xmlns="urn:e"><Name>host</Name><Description/><Empty></Empty></Server>';

    expect(wrapped(original)).toBe(original);
  });

  it('keeps <X/> and <X></X> apart in both directions', () => {
    const source = '<r><selfClosed/><spelledOut></spelledOut></r>';

    expect(cutOut(`<hold>${source}</hold>`, 'hold')).toBe(source);
    expect(wrapped(source)).toBe(source);
  });

  it('keeps the prefixes the source used rather than minting its own', () => {
    // Semantically a prefix means nothing. But a document that came back as
    // ns0, ns1, ns2 would no longer look like what the server sent, and would be
    // a fifth larger for nothing.
    const original = '<a:Root xmlns:a="urn:a"><a:Child b:flag="1" xmlns:b="urn:b"/></a:Root>';
    const written = wrapped(original);

    expect(written).toContain('<a:Root xmlns:a="urn:a">');
    expect(written).toContain('b:flag="1"');
    expect(written).not.toMatch(/ns\d+:/);
  });

  it('puts namespace declarations before attributes, and keeps doing so', () => {
    // The one thing neither direction preserves is where a declaration sits
    // among the attributes; both put it first. That is a normal form rather
    // than a loss, and what makes it safe is that applying it again changes
    // nothing - so a stored document never drifts on repeated handling.
    const source = '<Child b:flag="1" plain="p" xmlns:b="urn:b"/>';
    const once = wrapped(source);
    const twice = wrapped(once);

    expect(once).toBe('<Child xmlns:b="urn:b" b:flag="1" plain="p"/>');
    expect(twice).toBe(once);
  });

  it('parses on its own after being cut out of a larger document', () => {
    // A fragment may use a prefix declared on an ancestor that is not coming
    // with it. Without redeclaring, the stored text cannot be read again.
    const fragment = cutOut('<root xmlns:x="urn:x"><col><x:Deep><x:Inner/></x:Deep></col></root>', 'col');

    expect(fragment).toContain('xmlns:x="urn:x"');
    expect(() => XmlCursor.parse(fragment)).not.toThrow();
    expect(wrapped(fragment)).toBe(fragment);
  });

  it('writes stored XML as XML, not as escaped text', () => {
    expect(wrapped('<Server><Name>s</Name></Server>')).toBe('<Server><Name>s</Name></Server>');
  });

  it('will not let a value decide the structure of the message', () => {
    // Everything goes back through the parser, so text that looks like markup
    // stays text and text that is not well formed never reaches the output.
    expect(wrapped('a &lt; b')).toBe('a &lt; b');
    expect(() => wrapped('<unclosed>')).toThrow(XmlCodecError);
  });
});
