/**
 * The XML reader for Word files.
 *
 * A .docx is untrusted input, so as much of this file is about what the reader
 * refuses as about what it reads: a document type declaration, nesting built to
 * exhaust the stack, a bare ampersand, a mismatched tag. Each must end in a
 * readable error that says where, never a hang or a crash.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { allText, elements, first, hasText, parseXml, XmlError, type XmlElement } from "../src/import/docx/xml.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const only = (el: XmlElement, name: string): XmlElement => {
  const found = first(el, name);
  assert.ok(found, `expected a <${name}> inside <${el.name}>`);
  return found;
};

describe("reading", () => {
  test("elements, attributes and text, in order", () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a x="1" y='two'><b>hi</b>tail<c/></a>`);
    assert.equal(root.name, "a");
    assert.deepEqual(root.attrs, { x: "1", y: "two" });
    assert.deepEqual(root.children.map((c) => (typeof c === "string" ? c : c.name)), ["b", "tail", "c"]);
    assert.equal(allText(root), "hitail");
  });

  test("character references, named and numeric", () => {
    const root = parseXml(`<a t="&lt;&amp;&quot;&apos;&gt;">&#65;&#x42;&#x1F600; &amp; done</a>`);
    assert.equal(root.attrs["t"], `<&"'>`);
    assert.equal(allText(root), "AB\u{1F600} & done");
  });

  test("CDATA and comments, and text either side of them is one piece", () => {
    const root = parseXml(`<a>one<!-- skipped -->two<![CDATA[ <three> & ]]>four</a>`);
    assert.deepEqual(root.children, ["onetwo <three> & four"]);
  });

  test("white space inside text is kept exactly", () => {
    const root = parseXml(`<a xml:space="preserve">  two  spaces\ttab\n</a>`);
    assert.equal(allText(root), "  two  spaces\ttab\n");
    assert.equal(root.attrs["xml:space"], "preserve");
  });

  test("a byte order mark at the start is ignored", () => {
    assert.equal(parseXml("﻿<a/>").name, "a");
  });

  test("the helpers find children and text", () => {
    const root = parseXml(`<a><b>x</b><c/><b>y</b></a>`);
    assert.equal(elements(root).length, 3);
    assert.equal(elements(root, "b").length, 2);
    assert.equal(allText(only(root, "c")), "");
    assert.equal(hasText(root), true);
    assert.equal(hasText(parseXml(`<a> <b>  </b> </a>`)), false);
  });
});

describe("names are canonical, however the file spelled them", () => {
  test("the usual prefix is kept", () => {
    const root = parseXml(`<w:document ${W}><w:body><w:p w:rsidR="00AB"/></w:body></w:document>`);
    assert.equal(root.name, "w:document");
    assert.equal(only(only(root, "w:body"), "w:p").attrs["w:rsidR"], "00AB");
  });

  test("a different prefix for the same namespace becomes w:", () => {
    const root = parseXml(`<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:p x:val="1"/></x:document>`);
    assert.equal(root.name, "w:document");
    assert.equal(only(root, "w:p").attrs["w:val"], "1");
  });

  test("the default namespace is resolved too", () => {
    const root = parseXml(`<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><p/></document>`);
    assert.equal(root.name, "w:document");
    assert.equal(elements(root)[0]?.name, "w:p");
  });

  test("the strict flavour of Open XML reads as the same elements", () => {
    const root = parseXml(`<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:p/></w:document>`);
    assert.equal(root.name, "w:document");
    assert.equal(elements(root)[0]?.name, "w:p");
  });

  test("package files have bare names", () => {
    const root = parseXml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="word/document.xml"/></Relationships>`);
    assert.equal(root.name, "Relationships");
    assert.equal(elements(root, "Relationship")[0]?.attrs["Target"], "word/document.xml");
  });

  test("a namespace it does not know is left as written", () => {
    const root = parseXml(`<a:x xmlns:a="urn:other"><a:y/></a:x>`);
    assert.equal(root.name, "a:x");
    assert.equal(elements(root)[0]?.name, "a:y");
  });

  test("a declaration applies to its own element and below, and no further", () => {
    const root = parseXml(`<r><p:a xmlns:p="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/><p:b xmlns:p="urn:other"/></r>`);
    assert.deepEqual(elements(root).map((e) => e.name), ["w:a", "p:b"]);
  });
});

describe("what it refuses, with a message that says where", () => {
  const refuses = (xml: string, message: RegExp, limits?: Parameters<typeof parseXml>[1]) =>
    assert.throws(() => parseXml(xml, limits), (error: unknown) => {
      assert.ok(error instanceof XmlError, "a readable XmlError, not a raw exception");
      assert.match((error as Error).message, message);
      assert.match((error as Error).message, /\(line \d+, column \d+\)|characters long|nested|more than/, "it says where, or what limit");
      return true;
    });

  test("a document type declaration, the door to entity expansion", () => {
    refuses(`<!DOCTYPE lolz [<!ENTITY lol "lol">]><a>&lol;</a>`, /document type/);
    refuses(`<!DOCTYPE html><a/>`, /document type/);
  });

  test("a bare ampersand and unknown or malformed references", () => {
    refuses(`<a>fish & chips</a>`, /does not start a character reference/);
    refuses(`<a>&nbsp;</a>`, /not one this reader knows/);
    refuses(`<a>&#x;</a>`, /does not start a character reference/);
    refuses(`<a>&#0;</a>`, /not a character XML allows/);
    refuses(`<a>&#xD800;</a>`, /not a character XML allows/);
    refuses(`<a b="&oops;"/>`, /not one this reader knows/);
  });

  test("a mismatched, missing or stray end tag", () => {
    refuses(`<a><b></a></b>`, /does not match the start tag <b>/);
    refuses(`<a><b>`, /never closed/);
    refuses(`</a>`, /has nothing to close/);
  });

  test("more than one root, text outside the root, and nothing at all", () => {
    refuses(`<a/><b/>`, /more than one root/);
    refuses(`<a/>stray`, /outside the root/);
    refuses(`stray<a/>`, /outside the root/);
    assert.throws(() => parseXml(""), /no element/);
    assert.throws(() => parseXml("   "), /no element/);
  });

  test("an undeclared prefix, a repeated attribute and a misplaced angle bracket", () => {
    refuses(`<w:p/>`, /prefix "w" in "w:p" is not declared/);
    refuses(`<a x="1" x="2"/>`, /appears twice/);
    refuses(`<a x="<"/>`, /contains a "<"/);
    refuses(`<a x=1/>`, /not well formed/);
    refuses(`<a`, /not well formed/);
    refuses(`<>`, /no name/);
  });

  test("unterminated comments, CDATA and processing instructions", () => {
    refuses(`<a><!-- never ends</a>`, /comment is never closed/);
    refuses(`<a><![CDATA[ never ends</a>`, /CDATA section is never closed/);
    refuses(`<a><? never ends</a>`, /processing instruction is never closed/);
  });

  test("the position in the message is right", () => {
    assert.throws(() => parseXml(`<a>\n  <b>\n</a>`), /line 3, column 1/);
  });
});

describe("limits", () => {
  test("nesting deeper than the limit is refused rather than overflowing the stack", () => {
    const deep = "<a>".repeat(300) + "</a>".repeat(300);
    assert.throws(() => parseXml(deep), /nested more than 256 deep/);
    assert.throws(() => parseXml(deep, { maxDepth: 10 }), /nested more than 10 deep/);
    assert.equal(parseXml("<a>".repeat(256) + "</a>".repeat(256)).name, "a", "exactly the limit is fine");
  });

  test("a million levels does not crash", () => {
    const hostile = "<a>".repeat(1_000_000);
    assert.throws(() => parseXml(hostile), XmlError);
  });

  test("too many parts is refused", () => {
    assert.throws(() => parseXml("<a>" + "<b/>".repeat(1000) + "</a>", { maxNodes: 100 }), /more than 100 parts/);
  });

  test("too long a source is refused before it is read", () => {
    assert.throws(() => parseXml("<a>" + "x".repeat(2000) + "</a>", { maxChars: 1000 }), /more than the 1000 this reader accepts/);
  });

  test("entity expansion has nothing to work with, so a billion laughs is just refused", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
    const started = performance.now();
    assert.throws(() => parseXml(laughs), /document type/);
    assert.ok(performance.now() - started < 200, "refused at once");
  });

  test("a large, ordinary document is read quickly", () => {
    const paragraphs = Array.from({ length: 20000 }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">Question ${i} &amp; its text</w:t></w:r></w:p>`).join("");
    const xml = `<w:document ${W}><w:body>${paragraphs}</w:body></w:document>`;
    const started = performance.now();
    const root = parseXml(xml);
    const took = performance.now() - started;
    assert.equal(elements(only(root, "w:body")).length, 20000);
    assert.ok(took < 1500, `took ${took.toFixed(0)} ms for ${(xml.length / 1e6).toFixed(1)} MB`);
  });
});
