/**
 * The clean-up of an equation's MathML (`src/model/mathml.ts`): a bank can come from someone else, so the MathML it holds is kept to
 * the elements and attributes the engine writes and the window draws (the security review of 2026-11-13). That what the engine writes
 * is kept byte for byte, and that the two lists are the window's, is held in `packages/app/test/math-draw.test.ts`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { cleanMathList, cleanMathml, MATHML_NS } from "../src/model/mathml.ts";
import { parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { createQuestion } from "../src/model/create.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import { unzipSync } from "../src/container/zip.ts";
import { mathPlaceholder, rich } from "../src/model/richtext.ts";
import type { MathRef } from "../src/model/question.ts";

const M = (inside: string, attrs = ""): string => `<math xmlns="${MATHML_NS}"${attrs}>${inside}</math>`;

/** Every element name in the MathML, and every attribute name, as the reader gives them. */
function namesIn(mathml: string): { elements: string[]; attributes: string[] } {
  const elements: string[] = [];
  const attributes: string[] = [];
  const walk = (e: XmlElement): void => {
    elements.push(e.name);
    attributes.push(...Object.keys(e.attrs));
    for (const child of e.children) if (typeof child !== "string") walk(child);
  };
  walk(parseXml(mathml));
  return { elements, attributes };
}

describe("an equation's MathML", () => {
  test("that is what the engine writes is kept byte for byte, and said to be unchanged", () => {
    for (const mathml of [
      M("<mi>x</mi>"),
      M('<mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac>'),
      M('<mrow><mo fence="true">(</mo><mi mathvariant="bold">v</mi><mo fence="true">)</mo></mrow>'),
      M('<menclose notation="box"><mi>x</mi></menclose><mtable><mtr><mtd><mn>1</mn></mtd></mtr></mtable>'),
      M("<msubsup><mo largeop=\"true\">∑</mo><mi>i</mi><mi>n</mi></msubsup><mtext>a &lt; b &amp; c</mtext>"),
    ]) {
      assert.deepEqual(cleanMathml(mathml), { mathml, changed: false });
    }
  });

  test("loses a link, an event attribute, a style and any attribute off the list, and keeps the rest", () => {
    const hostile = M(
      '<mi href="javascript:alert(1)" onclick="alert(2)" style="color:red" mathvariant="bold">x</mi><mo xlink:href="https://example.invalid" xmlns:xlink="http://www.w3.org/1999/xlink">=</mo><mn>2</mn>',
    );
    const { mathml, changed } = cleanMathml(hostile);
    assert.equal(changed, true);
    assert.equal(mathml, M('<mi mathvariant="bold">x</mi><mo>=</mo><mn>2</mn>'));
    assert.doesNotMatch(mathml, /href|onclick|style|javascript|example\.invalid/);
  });

  test("keeps an attribute on the list only with a value the engine writes", () => {
    assert.equal(cleanMathml(M('<mi mathvariant="url(x)">x</mi><mfrac linethickness="9px"><mi>a</mi><mi>b</mi></mfrac>')).mathml, M("<mi>x</mi><mfrac><mi>a</mi><mi>b</mi></mfrac>"));
  });

  test("keeps the equation shown in `semantics` and loses the other forms of it, such as XHTML in an annotation", () => {
    const hostile = M(
      '<semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><annotation-xml encoding="application/xhtml+xml"><div xmlns="http://www.w3.org/1999/xhtml"><a href="javascript:alert(1)">click</a><script>alert(1)</script></div></annotation-xml><annotation encoding="TeX">x+1</annotation></semantics>',
    );
    const { mathml, changed } = cleanMathml(hostile);
    assert.equal(changed, true);
    assert.equal(mathml, M("<mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow>"));
  });

  test("loses an element off the list with what is inside it", () => {
    const { mathml } = cleanMathml(M('<mi>a</mi><maction actiontype="statusline"><mi>b</mi><mtext>see https://example.invalid</mtext></maction><mstyle mathcolor="red"><mi>c</mi></mstyle><mi>d</mi>'));
    assert.equal(mathml, M("<mi>a</mi><mi>d</mi>"));
    const { elements, attributes } = namesIn(mathml);
    assert.deepEqual(elements, ["math", "mi", "mi"]);
    assert.deepEqual(attributes, []);
  });

  test("written with a prefix is written again without one, with the namespace on the first element", () => {
    const { mathml, changed } = cleanMathml(`<m:math xmlns:m="${MATHML_NS}"><m:mi>x</m:mi><m:mo onmouseover="alert(1)">=</m:mo><m:mn>1</m:mn></m:math>`);
    assert.equal(changed, true);
    assert.equal(mathml, M("<mi>x</mi><mo>=</mo><mn>1</mn>"));
  });

  test("with text and attribute values that need escaping is written again escaped", () => {
    const { mathml } = cleanMathml(M('<mtext title="x">a &lt;b&gt; &amp; "c"</mtext>'));
    assert.equal(mathml, M("<mtext>a &lt;b&gt; &amp; \"c\"</mtext>"));
    assert.doesNotThrow(() => parseXml(mathml));
  });

  test("that cannot be read, or does not declare the MathML namespace, is left as it is: nothing draws it or writes it as MathML", () => {
    for (const source of ["", "   ", "<math/>", "<math><mi>x</mi></math>", "<math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mi>x</math>", "not xml at all <", '<span xmlns="http://www.w3.org/1998/Math/MathML">x</span>']) {
      assert.deepEqual(cleanMathml(source), { mathml: source, changed: false }, source);
    }
  });

  test("that is far longer than any equation is not kept", () => {
    const long = M(`<mi>${"x".repeat(600_000)}</mi>`);
    assert.deepEqual(cleanMathml(long), { mathml: "", changed: true });
  });

  test("a list of equations is the same list when none changed, and a copy with each changed one cleaned when some did", () => {
    const clean: MathRef[] = [{ id: "e1", latex: "x", mathml: M("<mi>x</mi>") }];
    assert.equal(cleanMathList(clean).list, clean);
    assert.equal(cleanMathList(clean).changed, 0);
    const mixed: MathRef[] = [...clean, { id: "e2", latex: "y", mathml: M('<mi href="x">y</mi>') }];
    const cleaned = cleanMathList(mixed);
    assert.equal(cleaned.changed, 1);
    assert.equal(cleaned.list[0], mixed[0], "an equation that did not change is the same object");
    assert.deepEqual(cleaned.list[1], { id: "e2", latex: "y", mathml: M("<mi>y</mi>") });
  });
});

describe("the MathML of a question", () => {
  const hostile = M('<mi href="javascript:alert(1)">x</mi><semantics><mn>2</mn><annotation-xml encoding="text/html"><img src="x" onerror="alert(1)"/></annotation-xml></semantics>');

  test("is cleaned when the question is made", () => {
    const q = createQuestion({ type: "essay", stem: rich(`<p>Solve ${mathPlaceholder("e1")}.</p>`), body: {}, math: [{ id: "e1", latex: "x2", mathml: hostile }], by: "test", at: "2026-01-01T00:00:00.000Z" });
    assert.equal(q.math[0]?.mathml, M("<mi>x</mi><mn>2</mn>"));
  });

  test("is cleaned again by the QTI 2.1 exporter, whatever way the question came to it", () => {
    const q = createQuestion({ type: "essay", stem: rich(`<p>Solve ${mathPlaceholder("e1")}.</p>`), body: {}, math: [{ id: "e1", latex: "x2", mathml: M("<mi>x</mi>") }], by: "test", at: "2026-01-01T00:00:00.000Z" });
    // As if a caller handed over a question that never went through createQuestion or a bank.
    const handed = { ...q, math: [{ id: "e1", latex: "x2", mathml: hostile }] };
    const result = exportQti21([handed], { name: "Probe" });
    const text = result.files
      .flatMap((f) => (f.bytes ? [...unzipSync(f.bytes).values()].map((b) => Buffer.from(b).toString("utf8")) : [f.content]))
      .join("\n");
    assert.match(text, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"><mi>x<\/mi><mn>2<\/mn><\/math>/);
    assert.doesNotMatch(text, /javascript:|onerror|annotation-xml/);
  });
});
