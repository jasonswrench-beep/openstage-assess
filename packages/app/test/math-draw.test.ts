/**
 * The MathML the engine writes, and the list of what the window draws.
 *
 * The window builds an equation from MathML one element at a time, from a short list of elements and attributes (`ui/math.js`), and
 * draws nothing it does not list. If the engine ever wrote an element that is not on the list, every equation that held one would stop
 * being drawn and nothing would say why. This holds the engine's output, for equations of every kind it reads and for thousands of
 * random ones, to the list. It cannot draw anything (there is no window here): it holds the two lists to each other.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { cleanOmml, readEquation } from "../../assess/src/import/docx/omml.ts";
import { parseXml, type XmlElement } from "../../assess/src/import/docx/xml.ts";
import { cleanMathml, MATH_ATTRIBUTES, MATH_ELEMENTS } from "../../assess/src/model/mathml.ts";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { ATTRIBUTES, ELEMENTS } from "../ui/math.js";

const NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A small, repeatable random source, so that a failure is the same one the next time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const TEXTS = ["x", "y+1", "2", "3.14", "α", "β=γ", "∑", "∫", "≤", "ℝ", "a<b", "a&b", "\\", "{}", "$%#_^~", "constructor", "__proto__", "😀", "é", "̂", " "];
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ESCAPES[c] as string);

function equationOf(rng: () => number, depth: number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
  const run = (): string => {
    const style = pick(["", '<m:rPr><m:sty m:val="p"/></m:rPr>', '<m:rPr><m:sty m:val="b"/></m:rPr>', '<m:rPr><m:nor/></m:rPr>', '<m:rPr><m:scr m:val="double-struck"/></m:rPr>', '<m:rPr><m:scr m:val="script"/></m:rPr>']);
    return `<m:r>${style}<m:t>${esc(pick(TEXTS))}</m:t></m:r>`;
  };
  const sub = (): string => (depth >= 3 ? run() : equationOf(rng, depth + 1));
  // A part that is wrong is rare, so that most equations are read and the property is tried on them; it is there to be refused.
  const rarely = (good: string, bad: string): string => (rng() < 0.01 ? bad : good);
  const kinds = [
    run, run, run,
    () => `<m:f><m:fPr><m:type m:val="${pick(["bar", "noBar", "skw", "lin"])}"/></m:fPr><m:num>${sub()}</m:num><m:den>${sub()}</m:den></m:f>`,
    () => `<m:rad><m:radPr>${rng() < 0.5 ? '<m:degHide m:val="1"/>' : ""}</m:radPr><m:deg>${rng() < 0.5 ? sub() : ""}</m:deg><m:e>${sub()}</m:e></m:rad>`,
    () => `<m:sSup><m:e>${sub()}</m:e><m:sup>${sub()}</m:sup></m:sSup>`,
    () => `<m:sSub><m:e>${sub()}</m:e><m:sub>${sub()}</m:sub></m:sSub>`,
    () => `<m:sSubSup><m:e>${sub()}</m:e><m:sub>${sub()}</m:sub><m:sup>${sub()}</m:sup></m:sSubSup>`,
    () => `<m:sPre><m:e>${sub()}</m:e><m:sub>${sub()}</m:sub><m:sup>${sub()}</m:sup></m:sPre>`,
    () => `<m:nary><m:naryPr><m:chr m:val="${pick(["∑", "∏", "∫", "∮", "⋃", ""])}"/>${rng() < 0.3 ? `<m:limLoc m:val="${pick(["undOvr", "subSup"])}"/>` : ""}${rng() < 0.2 ? '<m:subHide m:val="1"/>' : ""}${rng() < 0.2 ? '<m:supHide m:val="1"/>' : ""}</m:naryPr><m:sub>${sub()}</m:sub><m:sup>${sub()}</m:sup><m:e>${sub()}</m:e></m:nary>`,
    () => `<m:d><m:dPr><m:begChr m:val="${rarely(pick(["(", "[", "{", "|", "⟨", "⌊", "&lt;", ""]), pick(["constructor", "\\"]))}"/><m:endChr m:val="${pick([")", "]", "}", "|", "⟩", "⌋", "&gt;", ""])}"/><m:sepChr m:val="${rarely(pick(["|", ",", ";", ""]), "xyz")}"/></m:dPr><m:e>${sub()}</m:e><m:e>${sub()}</m:e></m:d>`,
    () => `<m:func><m:fName>${run()}</m:fName><m:e>${sub()}</m:e></m:func>`,
    () => `<m:acc><m:accPr><m:chr m:val="${pick(["̂", "̃", "⃗", "̄", "x", ""])}"/></m:accPr><m:e>${sub()}</m:e></m:acc>`,
    () => `<m:bar><m:barPr>${rng() < 0.99 ? `<m:pos m:val="${pick(["top", "bot"])}"/>` : ""}</m:barPr><m:e>${sub()}</m:e></m:bar>`,
    () => `<m:limLow><m:e>${sub()}</m:e><m:lim>${sub()}</m:lim></m:limLow>`,
    () => `<m:limUpp><m:e>${sub()}</m:e><m:lim>${sub()}</m:lim></m:limUpp>`,
    () => `<m:m><m:mr><m:e>${sub()}</m:e><m:e>${sub()}</m:e></m:mr><m:mr><m:e>${sub()}</m:e><m:e>${sub()}</m:e></m:mr></m:m>`,
    () => `<m:eqArr><m:e>${sub()}</m:e><m:e>${sub()}</m:e></m:eqArr>`,
    () => `<m:groupChr><m:groupChrPr><m:chr m:val="${pick(["⏟", "⏞", "→", ""])}"/><m:pos m:val="${pick(["top", "bot"])}"/></m:groupChrPr><m:e>${sub()}</m:e></m:groupChr>`,
    () => `<m:borderBox><m:e>${sub()}</m:e></m:borderBox>`,
    () => `<m:phant><m:e>${sub()}</m:e></m:phant>`,
    () => `<m:box><m:e>${sub()}</m:e></m:box>`,
    () => `<w:ins>${sub()}</w:ins>`,
    () => `<w:del>${sub()}</w:del>`,
  ];
  const parts: string[] = [];
  for (let i = 0, n = 1 + Math.floor(rng() * (depth === 0 ? 3 : 2)); i < n; i++) parts.push(rng() < 0.004 ? `<m:unknownPart>${run()}</m:unknownPart>` : pick(kinds)());
  return parts.join("");
}

function walk(el: XmlElement, visit: (e: XmlElement) => void): void {
  visit(el);
  for (const child of el.children) if (typeof child !== "string") walk(child, visit);
}

describe("the MathML the engine writes is only what the window draws", () => {
  test("and the engine's clean-up of a bank's equations keeps to the same lists (model/mathml.ts)", () => {
    assert.deepEqual([...MATH_ELEMENTS].sort(), [...ELEMENTS].sort());
    assert.deepEqual(Object.keys(MATH_ATTRIBUTES).sort(), Object.keys(ATTRIBUTES).sort());
    const tries = ["true", "false", "0", "1px", "box", "circle", "normal", "bold", "italic", "script", "double-struck", "", "javascript:x"];
    for (const name of Object.keys(ATTRIBUTES)) {
      for (const value of tries) assert.equal(MATH_ATTRIBUTES[name]?.(value), ATTRIBUTES[name](value), `${name}="${value}"`);
    }
  });

  test("for equations of every kind the engine reads, in thousands of random arrangements", () => {
    const rng = random(20261106);
    let read = 0;
    let refused = 0;
    for (let i = 0; i < 4000; i++) {
      const source = `<m:oMath ${NS}>${equationOf(rng, 0)}</m:oMath>`;
      const result = readEquation(parseXml(source));
      if (!result.ok) {
        refused++;
        assert.ok(result.reason.length > 0);
        continue;
      }
      read++;
      const { latex, mathml, omml } = result.math;
      assert.ok(latex.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(latex), latex);
      assert.ok(!/\\left\w|\\operatorname\{\}|undefined|\[object|function/.test(latex), `${latex} came out of ${source}`);

      const tree = parseXml(mathml);
      assert.equal(tree.name, "math");
      walk(tree, (e) => {
        assert.ok(ELEMENTS.has(e.name), `${e.name} is not on the window's list (${mathml})`);
        for (const [name, value] of Object.entries(e.attrs)) {
          if (name === "xmlns") continue;
          const allowed = ATTRIBUTES[name];
          assert.ok(allowed !== undefined && allowed(value), `${name}="${value}" is not on the window's list (${mathml})`);
        }
      });

      // The copy of Word's own XML is itself a thing the reader accepts, and writes out as it is: reading it again changes nothing.
      assert.equal(cleanOmml(omml), omml, omml);
      // And the clean-up a bank's equations go through when it is opened keeps what the engine wrote byte for byte.
      assert.deepEqual(cleanMathml(mathml), { mathml, changed: false }, mathml);
    }
    assert.ok(read > 1500, `only ${read} of 4000 equations were read, so the property was not tried on enough`);
    assert.ok(refused > 100, `only ${refused} were refused, so the refusals were not tried on enough`);
  });

  test("and for an equation with the constructs one after another and nothing else", () => {
    const text = (t: string): string => `<m:r><m:t>${t}</m:t></m:r>`;
    const everything = [
      `<m:f><m:num>${text("a")}</m:num><m:den>${text("b")}</m:den></m:f>`,
      `<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${text("n")}</m:num><m:den>${text("k")}</m:den></m:f>`,
      `<m:rad><m:radPr/><m:deg>${text("3")}</m:deg><m:e>${text("x")}</m:e></m:rad>`,
      `<m:sPre><m:e>${text("C")}</m:e><m:sub>${text("6")}</m:sub><m:sup>${text("12")}</m:sup></m:sPre>`,
      `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${text("i")}</m:sub><m:sup>${text("n")}</m:sup><m:e>${text("i")}</m:e></m:nary>`,
      `<m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="bot"/></m:groupChrPr><m:e>${text("a")}</m:e></m:groupChr>`,
      `<m:borderBox><m:e>${text("x")}</m:e></m:borderBox>`,
      `<m:phant><m:phantPr><m:show m:val="0"/></m:phantPr><m:e>${text("x")}</m:e></m:phant>`,
      text("bold"),
    ].join("");
    const result = readEquation(parseXml(`<m:oMath ${NS}>${everything}</m:oMath>`));
    assert.ok(result.ok, result.ok ? "" : result.reason);
    walk(parseXml(result.math.mathml), (e) => assert.ok(ELEMENTS.has(e.name), e.name));
  });
});
