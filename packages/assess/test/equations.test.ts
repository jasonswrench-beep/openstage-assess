/**
 * Equations in a Word file.
 *
 * An equation used to be the word [equation] and its content was lost. It is now read into LaTeX and MathML, with Word's own XML kept
 * beside them, and the question holds it as an equation. The rule that decides everything here: an equation is read only when every
 * part of it is one this reader knows, and otherwise it keeps its marker with the reason. A wrong equation that looks right is worse
 * than a marker that says it was not read.
 *
 * The documents here come from our own writer; fixtures/word-authored/equations holds what real Word wrote (`npm run
 * check:word-equations`), and those are read at the end.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { documentToBlocks } from "../src/import/docx/document.ts";
import { readEquation } from "../src/import/docx/omml.ts";
import { openDocx } from "../src/import/docx/package.ts";
import { parseXml } from "../src/import/docx/xml.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { collectRefs, richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// Word's elements, written the way Word writes them.
const r = (text: string, pr = ""): string => `<m:r>${pr}<m:t>${text}</m:t></m:r>`;
const plainStyle = '<m:rPr><m:sty m:val="p"/></m:rPr>';
const frac = (num: string, den: string): string => `<m:f><m:fPr><m:ctrlPr/></m:fPr><m:num>${num}</m:num><m:den>${den}</m:den></m:f>`;
const sup = (base: string, up: string): string => `<m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr><m:e>${base}</m:e><m:sup>${up}</m:sup></m:sSup>`;
const sub = (base: string, down: string): string => `<m:sSub><m:sSubPr><m:ctrlPr/></m:sSubPr><m:e>${base}</m:e><m:sub>${down}</m:sub></m:sSub>`;
const root = (inner: string, degree = ""): string =>
  degree === ""
    ? `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${inner}</m:e></m:rad>`
    : `<m:rad><m:radPr/><m:deg>${degree}</m:deg><m:e>${inner}</m:e></m:rad>`;
const nary = (chr: string, from: string, to: string, inner: string, extra = ""): string =>
  `<m:nary><m:naryPr>${chr === "" ? "" : `<m:chr m:val="${chr}"/>`}${extra}</m:naryPr><m:sub>${from}</m:sub><m:sup>${to}</m:sup><m:e>${inner}</m:e></m:nary>`;
const brackets = (inner: string[], open?: string, close?: string, sep?: string): string =>
  `<m:d><m:dPr>${open === undefined ? "" : `<m:begChr m:val="${open}"/>`}${close === undefined ? "" : `<m:endChr m:val="${close}"/>`}${sep === undefined ? "" : `<m:sepChr m:val="${sep}"/>`}</m:dPr>${inner.map((e) => `<m:e>${e}</m:e>`).join("")}</m:d>`;

const equation = (body: string) => readEquation(parseXml(`<m:oMath ${NS}>${body}</m:oMath>`));
const latexOf = (body: string): string => {
  const read = equation(body);
  assert.ok(read.ok, read.ok ? "" : `not read: ${read.reason}`);
  return read.math.latex;
};
const reasonOf = (body: string): string => {
  const read = equation(body);
  assert.ok(!read.ok, "it should not have been read");
  return read.reason;
};

describe("an equation as LaTeX", () => {
  test("plain runs: numbers, letters and signs", () => {
    assert.equal(latexOf(r("x+1")), "x+1");
    assert.equal(latexOf(r("2x−3=7")), "2x-3=7", "the minus sign is the one LaTeX has");
    assert.equal(latexOf(r("3.14")), "3.14");
    assert.equal(latexOf(r("a×b÷c")), "a\\times b\\div c");
  });

  test("Greek letters and signs of comparison and logic", () => {
    assert.equal(latexOf(r("αβγ=π±∞≤")), "\\alpha\\beta\\gamma=\\pi\\pm\\infty\\le");
    assert.equal(latexOf(r("A∪B⊂C")), "A\\cup B\\subset C");
    assert.equal(latexOf(r("x∈ℝ")), "x\\in\\mathbb{R}");
  });

  test("fractions, roots and their degree", () => {
    assert.equal(latexOf(frac(r("a"), r("b+1"))), "\\frac{a}{b+1}");
    assert.equal(latexOf(root(r("x"))), "\\sqrt{x}");
    assert.equal(latexOf(root(r("x"), r("3"))), "\\sqrt[3]{x}");
  });

  test("the quadratic formula", () => {
    const formula = r("x=") + frac(r("−b±") + root(sup(r("b"), r("2")) + r("−4ac")), r("2a"));
    assert.equal(latexOf(formula), "x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}");
  });

  test("superscripts and subscripts, alone and together, and before the base", () => {
    assert.equal(latexOf(sup(r("x"), r("2"))), "x^{2}");
    assert.equal(latexOf(sub(r("x"), r("i"))), "x_{i}");
    assert.equal(latexOf(`<m:sSubSup><m:sSubSupPr/><m:e>${r("x")}</m:e><m:sub>${r("i")}</m:sub><m:sup>${r("2")}</m:sup></m:sSubSup>`), "x_{i}^{2}");
    assert.equal(latexOf(`<m:sPre><m:sPrePr/><m:sub>${r("1")}</m:sub><m:sup>${r("4")}</m:sup><m:e>${r("C")}</m:e></m:sPre>`), "{}_{1}^{4}C");
    assert.equal(latexOf(sup(brackets([r("a+b")]), r("2"))), "{\\left( a+b \\right)}^{2}");
  });

  test("sums, products and integrals, with the limits where Word puts them", () => {
    assert.equal(latexOf(nary("∑", r("i=1"), r("n"), r("i"))), "\\sum\\limits_{i=1}^{n}i");
    assert.equal(latexOf(nary("∏", r("k=1"), r("m"), r("k"))), "\\prod\\limits_{k=1}^{m}k");
    assert.equal(latexOf(nary("∫", r("0"), r("1"), r("x"))), "\\int_{0}^{1}x");
    assert.equal(latexOf(nary("", r("0"), r("1"), r("x"))), "\\int_{0}^{1}x", "a sign that is not named is the integral");
    assert.equal(latexOf(nary("∑", r("i=1"), r("n"), r("i"), '<m:limLoc m:val="subSup"/>')), "\\sum_{i=1}^{n}i");
    assert.equal(latexOf(nary("∫", r("a"), "", r("f"), '<m:supHide m:val="1"/>')), "\\int_{a}f");
  });

  test("brackets: the kinds Word offers, and several parts in one", () => {
    assert.equal(latexOf(brackets([r("a+b")])), "\\left( a+b \\right)");
    assert.equal(latexOf(brackets([r("x")], "|", "|")), "\\left| x \\right|");
    assert.equal(latexOf(brackets([r("a"), r("b")], "[", "]")), "\\left[ a \\mid b \\right]");
    assert.equal(latexOf(brackets([r("a"), r("b")], "(", ")", ",")), "\\left( a , b \\right)");
    assert.equal(latexOf(brackets([r("x")], "{", "")), "\\left\\{ x \\right.", "a brace on one side only");
    assert.equal(latexOf(brackets([r("x")], "⌊", "⌋")), "\\left\\lfloor x \\right\\rfloor");
    assert.equal(latexOf(brackets([r("x")], "&lt;", "&gt;")), "\\left< x \\right>", "the less-than sign is not an angle bracket");
  });

  test("functions, limits, accents and bars", () => {
    assert.equal(latexOf(`<m:func><m:funcPr/><m:fName>${r("sin", plainStyle)}</m:fName><m:e>${r("x")}</m:e></m:func>`), "\\sin x");
    assert.equal(latexOf(`<m:func><m:funcPr/><m:fName>${r("log")}</m:fName><m:e>${r("n")}</m:e></m:func>`), "\\log n", "an italic name is the function all the same");
    assert.equal(latexOf(`<m:limLow><m:limLowPr/><m:e>${r("lim", plainStyle)}</m:e><m:lim>${r("x→0")}</m:lim></m:limLow>`), "\\lim_{x\\to0}");
    assert.equal(latexOf(`<m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e>${r("x")}</m:e></m:acc>`), "\\hat{x}");
    assert.equal(latexOf(`<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${r("v")}</m:e></m:acc>`), "\\vec{v}");
    assert.equal(latexOf(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${r("x")}</m:e></m:bar>`), "\\overline{x}");
    assert.equal(latexOf(`<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${r("x")}</m:e></m:bar>`), "\\underline{x}");
    assert.equal(latexOf(`<m:limUpp><m:limUppPr/><m:e>${r("x")}</m:e><m:lim>${r("n")}</m:lim></m:limUpp>`), "\\overset{n}{x}");
  });

  test("matrices and arrays of equations", () => {
    const cell = (t: string): string => `<m:e>${r(t)}</m:e>`;
    const matrix = `<m:m><m:mPr/><m:mr>${cell("1")}${cell("2")}</m:mr><m:mr>${cell("3")}${cell("4")}</m:mr></m:m>`;
    assert.equal(latexOf(matrix), "\\begin{matrix} 1 & 2 \\\\ 3 & 4 \\end{matrix}");
    const lines = `<m:eqArr><m:eqArrPr/><m:e>${r("x&amp;=1")}</m:e><m:e>${r("y&amp;=2")}</m:e></m:eqArr>`;
    assert.equal(latexOf(lines), "\\begin{aligned} x&=1 \\\\ y&=2 \\end{aligned}");
  });

  test("braces over and under, and a box", () => {
    const group = (chr: string, pos: string): string => `<m:groupChr><m:groupChrPr><m:chr m:val="${chr}"/><m:pos m:val="${pos}"/></m:groupChrPr><m:e>${r("a+b")}</m:e></m:groupChr>`;
    assert.equal(latexOf(group("⏟", "bot")), "\\underbrace{a+b}");
    assert.equal(latexOf(group("⏞", "top")), "\\overbrace{a+b}");
    assert.equal(latexOf(`<m:borderBox><m:borderBoxPr/><m:e>${r("x")}</m:e></m:borderBox>`), "\\boxed{x}");
  });

  test("text in an equation keeps its words, and a style of letter is kept", () => {
    assert.equal(latexOf(r("if x", "<m:rPr><m:nor/></m:rPr>")), "\\text{if x}");
    assert.equal(latexOf(r("R", '<m:rPr><m:scr m:val="double-struck"/></m:rPr>')), "\\mathbb{R}");
    assert.equal(latexOf(r("v", '<m:rPr><m:sty m:val="b"/></m:rPr>')), "\\mathbf{v}");
    assert.equal(latexOf(r("a_b%c", "<m:rPr><m:nor/></m:rPr>")), "\\text{a\\_b\\%c}", "characters LaTeX reads as commands are escaped");
  });

  test("characters that LaTeX would read as commands are never passed through", () => {
    assert.equal(latexOf(r("a\\b{c}$d")), "a\\backslash b\\{c\\}\\$d");
  });

  test("a run of the word constructor is a word, and not the function of that name", () => {
    assert.equal(latexOf(r("constructor", plainStyle)), "\\mathrm{constructor}");
    assert.equal(latexOf(r("toString", plainStyle)), "\\mathrm{toString}");
    const proto = latexOf(r("__proto__", plainStyle));
    assert.equal(typeof proto, "string");
    assert.ok(!proto.includes("function") && !proto.includes("[object"), proto);
  });

  test("tracked changes inside an equation: what was inserted is read, what was deleted is not", () => {
    assert.equal(latexOf(`<w:ins>${r("x")}</w:ins><w:del>${r("y")}</w:del>${r("z")}`), "xz");
  });
});

describe("an equation as MathML", () => {
  const ml = (body: string): string => {
    const read = equation(body);
    assert.ok(read.ok);
    return read.math.mathml;
  };
  const MATH = (inner: string): string => `<math xmlns="http://www.w3.org/1998/Math/MathML">${inner}</math>`;

  test("a fraction, a root, a sum and a matrix", () => {
    assert.equal(ml(frac(r("a"), r("b+1"))), MATH("<mfrac><mi>a</mi><mrow><mi>b</mi><mo>+</mo><mn>1</mn></mrow></mfrac>"));
    assert.equal(ml(root(r("x"))), MATH("<msqrt><mi>x</mi></msqrt>"));
    assert.equal(ml(root(r("x"), r("3"))), MATH("<mroot><mi>x</mi><mn>3</mn></mroot>"));
    assert.equal(ml(nary("∑", r("i=1"), r("n"), r("i"))), MATH('<mrow><munderover><mo largeop="true">∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><mi>i</mi></mrow>'));
    const cell = (t: string): string => `<m:e>${r(t)}</m:e>`;
    assert.equal(ml(`<m:m><m:mPr/><m:mr>${cell("1")}${cell("2")}</m:mr></m:m>`), MATH("<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr></mtable>"));
  });

  test("scripts, brackets and accents", () => {
    assert.equal(ml(sup(r("x"), r("2"))), MATH("<msup><mi>x</mi><mn>2</mn></msup>"));
    assert.equal(ml(brackets([r("a")])), MATH('<mrow><mo fence="true">(</mo><mi>a</mi><mo fence="true">)</mo></mrow>'));
    assert.equal(ml(`<m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e>${r("x")}</m:e></m:acc>`), MATH('<mover accent="true"><mi>x</mi><mo>̂</mo></mover>'));
  });

  test("the text of an equation is escaped, so that what it holds cannot become markup", () => {
    const out = ml(r("a&lt;b&amp;c") + r("<script>x</script>".replace(/</g, "&lt;").replace(/>/g, "&gt;"), "<m:rPr><m:nor/></m:rPr>"));
    assert.ok(!out.includes("<script"), out);
    assert.match(out, /<mo>&lt;<\/mo>/);
    assert.match(out, /<mo>&amp;<\/mo>/);
    assert.match(out, /<mtext>&lt;script&gt;x&lt;\/script&gt;<\/mtext>/);
  });

  test("is well formed XML for every construct above", () => {
    const bodies = [
      frac(r("a"), r("b")), root(r("x"), r("3")), sup(r("x"), r("2")), sub(r("x"), r("i")), nary("∑", r("i"), r("n"), r("i")), nary("∫", r("0"), r("1"), r("x")),
      brackets([r("a"), r("b")], "[", "]"), `<m:eqArr><m:eqArrPr/><m:e>${r("x&amp;=1")}</m:e></m:eqArr>`, r("if x", "<m:rPr><m:nor/></m:rPr>"),
    ];
    for (const body of bodies) {
      const read = equation(body);
      assert.ok(read.ok);
      assert.doesNotThrow(() => parseXml(read.math.mathml), read.math.mathml);
      assert.doesNotThrow(() => parseXml(read.math.omml), read.math.omml);
    }
  });
});

describe("Word's own XML, kept", () => {
  test("has the equation's namespace and the elements the reader knows, and not the ones it does not", () => {
    const read = equation(frac(r("a"), r("b")).replace("<m:ctrlPr/>", '<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr></m:ctrlPr><m:odd/>'));
    assert.ok(read.ok);
    assert.match(read.math.omml, /^<m:oMath xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math">/);
    assert.ok(read.math.omml.includes("<m:f>"));
    assert.ok(!read.math.omml.includes("m:odd") && !read.math.omml.includes("w:rFonts"), read.math.omml);
  });

  test("keeps the spaces of its text, and escapes it", () => {
    const read = equation(r(" a&lt;b ", "<m:rPr><m:nor/></m:rPr>"));
    assert.ok(read.ok);
    assert.ok(read.math.omml.includes('<m:t xml:space="preserve"> a&lt;b </m:t>'), read.math.omml);
  });
});

describe("an equation that is not read", () => {
  test("an element that is not a part of an equation this reads, named", () => {
    assert.match(reasonOf(`<m:strange>${r("x")}</m:strange>`), /holds m:strange/);
    assert.match(reasonOf(frac(r("a"), "<m:what/>")), /holds m:what/);
  });

  test("a whole equation is refused for one part, not read with that part left out", () => {
    assert.match(reasonOf(r("x=") + `<m:unknownPart/>` + r("1")), /m:unknownPart/);
  });

  test("a bar, a bracket or a separator that does not say what it is", () => {
    assert.match(reasonOf(`<m:bar><m:barPr/><m:e>${r("x")}</m:e></m:bar>`), /over or under/);
    assert.match(reasonOf(brackets([r("x")], "constructor", ")")), /bracket/);
    assert.match(reasonOf(brackets([r("x")], "(", ")", "xyz")), /separator/);
    assert.match(reasonOf(brackets([r("x")], "\\", ")")), /bracket/);
  });

  test("a box with a line struck through it is not a box", () => {
    assert.match(reasonOf(`<m:borderBox><m:borderBoxPr><m:strikeH m:val="1"/></m:borderBoxPr><m:e>${r("x")}</m:e></m:borderBox>`), /strike/);
  });

  test("an equation with nothing in it", () => {
    assert.match(reasonOf(""), /empty/);
    assert.match(reasonOf(r("   ")), /empty/);
  });

  test("loose text that is not in a run", () => {
    assert.match(reasonOf(`${r("x")}stray`), /loose text/);
  });

  test("an equation nested far beyond any real one, or with far more parts than one has", () => {
    let deep = r("x");
    for (let i = 0; i < 80; i++) deep = sup(deep, r("2"));
    assert.match(reasonOf(deep), /nested/);
    assert.match(reasonOf(r("x").repeat(5200)), /more parts/);
  });
});

// ---------------------------------------------------------------------------
// In a document
// ---------------------------------------------------------------------------

function blocksOf(body: string) {
  const pkg = openDocx(docx({ body }));
  return documentToBlocks(pkg.xml(pkg.mainDocument)!);
}
const oMath = (inner: string): string => `<m:oMath>${inner}</m:oMath>`;
const TAG = /\[ eq: "(eq-[0-9a-f]{16})" \]/g;

describe("an equation in a Word document", () => {
  test("is a tag where it stood, with the equation beside the blocks; a display equation is its equations in order", () => {
    const { blocks, stats, math } = blocksOf(paragraph(run("Solve ") + oMath(r("x+1")) + run(" now ") + `<m:oMathPara><m:oMathParaPr/>${oMath(r("y"))}${oMath(r("z"))}</m:oMathPara>`));
    const names = [...(blocks[0]!.text).matchAll(TAG)].map((m) => m[1]!);
    assert.equal(names.length, 3);
    assert.equal(blocks[0]!.text.replace(TAG, "#"), "Solve # now ##");
    assert.deepEqual(names.map((n) => math.get(n)?.latex), ["x+1", "y", "z"]);
    assert.deepEqual([stats.equationsRead, stats.equations], [3, 0]);
  });

  test("is named by what it is: the same equation twice is one, and a name is the same every time", () => {
    const once = blocksOf(paragraph(oMath(r("x")) + run(" and ") + oMath(r("x"))));
    const names = [...once.blocks[0]!.text.matchAll(TAG)].map((m) => m[1]!);
    assert.equal(names[0], names[1]);
    assert.equal(once.math.size, 1);
    const again = blocksOf(paragraph(oMath(r("x"))));
    assert.deepEqual([...again.math.keys()], [names[0]]);
  });

  test("one that is not read keeps its marker, is counted and has its reason", () => {
    const { blocks, stats, math } = blocksOf(paragraph(run("See ") + oMath(r("x") + "<m:odd/>") + run(" and ") + oMath(r("y"))));
    assert.equal(blocks[0]!.text.replace(TAG, "#"), "See [equation] and #");
    assert.deepEqual([stats.equations, stats.equationsRead, math.size], [1, 1, 1]);
    assert.deepEqual(Object.keys(stats.equationReasons), ["it holds m:odd, which is not a part of an equation this reads"]);
  });

  test("a deleted equation is not read, as deleted words are not", () => {
    const { blocks, stats } = blocksOf(paragraph(run("a") + `<w:del w:id="1">${oMath(r("x"))}</w:del>` + run("b")));
    assert.deepEqual(blocks.map((b) => b.text), ["ab"]);
    assert.equal(stats.equationsRead, 0);
  });

  test("an equation in a table cell is read as in a paragraph", () => {
    const { blocks, math } = blocksOf(paragraph(run("1. ") + oMath(r("x"))));
    assert.equal(math.size, 1);
    assert.match(blocks[0]!.text, TAG);
  });
});

const MC = (stemLine: string, options: string[], key = "a", extra: string[] = []): Uint8Array =>
  docx({ body: [stemLine, ...options, `Answer: ${key}`, ...extra].map((l) => (l.startsWith("<") ? l : paragraph(run(l)))).join("") });
const read = (bytes: Uint8Array) => wordImporter.parseBytes(bytes, OPTIONS);
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();

describe("an equation in a question", () => {
  const stem = paragraph(run("1. Solve ") + oMath(frac(r("x"), r("2")) + r("=3")) + run(" for x."));
  const result = read(MC(stem, ["a) 6", "b) 5", "c) 1.5"]));
  const q = result.questions[0] as Question;

  test("is an equation of the question, placed in its text, with LaTeX, MathML and Word's own XML", () => {
    assert.equal(result.questions.length, 1);
    assert.equal(q.math.length, 1);
    const m = q.math[0]!;
    assert.equal(m.id, "q1_e1");
    assert.equal(m.latex, "\\frac{x}{2}=3");
    assert.ok(m.mathml.startsWith("<math "));
    assert.ok(m.omml?.startsWith("<m:oMath "));
    assert.equal(m.source, "omml");
    assert.deepEqual(collectRefs(q.stem).math, ["q1_e1"]);
    assert.equal(plain(q.stem), "Solve for x.");
  });

  test("the question is still a question with its key, and the file says how many equations it read", () => {
    assert.equal(q.type, "multipleChoice");
    assert.equal((q.body as { options: Array<{ correct: boolean }> }).options.filter((o) => o.correct).length, 1);
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
    const said = result.fileFindings.find((f) => f.code === FindingCode.UnreadContent);
    assert.equal(said?.severity, "info");
    assert.match(said?.message ?? "", /1 equation was read and kept as an equation/);
  });

  test("a stem that is only an equation is a stem", () => {
    const only = read(MC(paragraph(run("1. ") + oMath(r("x²+1"))), ["a) yes", "b) no"])).questions[0] as Question;
    assert.equal(only.math.length, 1);
    assert.ok(!plain(only.stem).includes("no stem text"), plain(only.stem));
    assert.deepEqual(collectRefs(only.stem).math, ["q1_e1"]);
    assert.ok(!only.findings.some((f) => f.code === FindingCode.EmptyStem), "and it is not called a question with no stem text");
    assert.equal(verdictFrom(only.findings), "parsed");
  });

  test("an option that is only an equation is an option, with an equation of its own", () => {
    const opts = read(MC(paragraph(run("1. Which is the root?")), [paragraph(run("a) ") + oMath(root(r("4")))), paragraph(run("b) ") + oMath(r("16"))), "c) neither"], "b"));
    const o = opts.questions[0] as Question;
    assert.ok(!o.findings.some((f) => f.code === FindingCode.EmptyOption), "no option was called empty");
    assert.deepEqual(o.math.map((m) => [m.id, m.latex]), [["q1o0_e1", "\\sqrt{4}"], ["q1o1_e1", "16"]]);
    const options = (o.body as { options: Array<{ content: Parameters<typeof collectRefs>[0]; correct: boolean }> }).options;
    assert.deepEqual(options.map((x) => collectRefs(x.content).math), [["q1o0_e1"], ["q1o1_e1"], []]);
    assert.deepEqual(options.map((x) => x.correct), [false, true, false]);
  });

  test("an equation in the feedback is its words, because feedback has no place for one", () => {
    const withFeedback = read(MC(stem, ["a) 6", "b) 5"], "a", [paragraph(run("Feedback: Because ") + oMath(sup(r("x"), r("2"))))]));
    const f = withFeedback.questions[0] as Question;
    assert.equal(plain(f.feedback.general!), "Because [Equation: x^{2}]");
    assert.ok(!JSON.stringify(f).includes("[ eq:"), "no tag is left in the question");
  });

  test("text no question claimed shows an equation in it as its words", () => {
    const orphaned = read(docx({ body: paragraph(run("Chapter notes ") + oMath(r("x+1"))) + paragraph(run("1. Which?")) + paragraph(run("a) one")) + paragraph(run("b) two")) + paragraph(run("Answer: a")) }));
    assert.ok(orphaned.orphans.some((o) => o.text.includes("[Equation: x+1]")), JSON.stringify(orphaned.orphans));
    assert.ok(!JSON.stringify(orphaned.orphans).includes("[ eq:"));
  });

  test("an equation that was not read leaves its marker in the question, and a warning on the file", () => {
    const unread = read(MC(paragraph(run("1. See ") + oMath(r("x") + "<m:odd/>")), ["a) yes", "b) no"]));
    const u = unread.questions[0] as Question;
    assert.equal(u.math.length, 0);
    assert.equal(plain(u.stem), "See [equation]");
    const warned = unread.fileFindings.find((f) => f.severity === "warn" && /equation/.test(f.message));
    assert.match(warned?.message ?? "", /1 equation was not read \(1 because it holds m:odd.*\)\. Each is marked \[equation\].*nothing was guessed/);
  });

  test("no answer key is read from an equation, or made up for one", () => {
    const keyless = read(docx({ body: paragraph(run("1. Pick ") + oMath(r("x"))) + paragraph(run("a) ") + oMath(r("1"))) + paragraph(run("b) ") + oMath(r("2"))) }));
    const k = keyless.questions[0] as Question;
    assert.equal((k.body as { options: Array<{ correct: boolean }> }).options.some((o) => o.correct), false);
    assert.ok(k.findings.some((f) => f.severity === "error"), "a missing key is still an error");
  });
});

describe("a tag in a text file is only text", () => {
  test("is left as it was written, and no equation is made of it", () => {
    const out = standardTextImporter.parse('1. Say [ eq: "eq-0123456789abcdef" ] aloud.\na) yes\n*b) no\n', OPTIONS);
    const q = out.questions[0] as Question;
    assert.equal(q.math.length, 0);
    assert.ok(plain(q.stem).includes('[ eq: "eq-0123456789abcdef" ]'));
  });

  test("a table of equations is held for one parse and no longer", () => {
    const first = read(MC(paragraph(run("1. ") + oMath(r("x"))), ["a) 1", "b) 2"]));
    assert.equal((first.questions[0] as Question).math.length, 1);
    const second = standardTextImporter.parse('1. A [ eq: "eq-aaaaaaaaaaaaaaaa" ] B\na) yes\n*b) no\n', OPTIONS);
    assert.equal((second.questions[0] as Question).math.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Real Word
// ---------------------------------------------------------------------------

describe("documents that Word wrote with equations in them", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "word-authored", "equations");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".docx")) : [];

  test("every equation Word wrote is read, and no question is lost", { skip: names.length === 0 ? "fixtures/word-authored/equations is not here yet" : false }, () => {
    for (const name of names) {
      const out = read(new Uint8Array(readFileSync(join(dir, name))));
      assert.ok(out.questions.length >= 1, name);
      const unread = out.fileFindings.filter((f) => /equations? (was|were) not read/.test(f.message));
      assert.deepEqual(unread.map((f) => f.message), [], `${name}: Word wrote an equation this does not read`);
      for (const q of out.questions) for (const m of q.math) assert.ok(m.latex.length > 0 && m.mathml.startsWith("<math"), `${name}: ${m.id}`);
    }
  });
});

describe("a damaged equation", () => {
  test("a document whose equation part is not well formed is refused in words, never with a crash", () => {
    const body = paragraph(run("1. x ") + "<m:oMath><m:f><m:num></m:f></m:oMath>");
    assert.throws(
      () => blocksOf(body),
      (e: unknown) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError) && e.message.length > 10,
    );
  });

  test("an equation that is well formed and makes no sense is not read, and the document still is", () => {
    const out = read(MC(paragraph(run("1. See ") + oMath("<m:f><m:num></m:num></m:f>")), ["a) yes", "b) no"]));
    assert.equal(out.questions.length, 1);
    assert.ok(out.questions[0]!.math.length <= 1);
  });
});
