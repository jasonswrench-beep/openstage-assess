/**
 * Equations in exports.
 *
 * Only Moodle XML has a way to write an equation that its readers know without a picture: LaTeX between \( and \), which Moodle's
 * MathJax filter shows as an equation. Everywhere else an equation is the words [Equation: LaTeX], counted and said, as before. An
 * equation is never dropped, and LaTeX that could end the delimiters early is words and not markup.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseXml } from "../src/import/docx/xml.ts";
import { exportGift } from "../src/export/gift.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { createQuestion } from "../src/model/create.ts";
import { mathPlaceholder, plainToRich, rich } from "../src/model/richtext.ts";
import type { MathRef, Question } from "../src/model/question.ts";

function withMath(math: MathRef[], stemMath = "e1", optionMath?: string): Question {
  return createQuestion({
    type: "multipleChoice",
    stem: rich(`<p>Solve ${mathPlaceholder(stemMath)} for x.</p>`),
    body: {
      shuffle: false,
      options: [
        { id: "o0", content: optionMath ? rich(`<p>${mathPlaceholder(optionMath)}</p>`) : plainToRich("six"), correct: true },
        { id: "o1", content: plainToRich("five"), correct: false },
      ],
    } as never,
    math,
    by: "test",
    at: "2026-01-01T00:00:00.000Z",
  });
}

const MATH: MathRef[] = [
  { id: "e1", latex: "\\frac{x}{2}=3", mathml: "<math/>", source: "omml" },
  { id: "e2", latex: "\\sqrt{16}", mathml: "<math/>", source: "omml" },
];
const xmlOf = (q: Question[]): string => exportMoodleXml(q, { name: "Maths" }).files[0]?.content ?? "";

describe("an equation in Moodle XML", () => {
  test("is LaTeX between the delimiters Moodle reads, in the stem and in an answer", () => {
    const xml = xmlOf([withMath(MATH, "e1", "e2")]);
    assert.ok(xml.includes("Solve  \\(\\frac{x}{2}=3\\)  for x."), xml);
    assert.ok(xml.includes("\\(\\sqrt{16}\\)"));
    assert.ok(!xml.includes("[Equation"), "no words stand in its place");
    assert.doesNotThrow(() => parseXml(xml.replace(/^<\?xml[^>]*\?>\s*/, "")));
  });

  test("is not a loss: the question is exported whole, and the file says how it was written", () => {
    const result = exportMoodleXml([withMath(MATH, "e1", "e2")], { name: "Maths" });
    assert.deepEqual(result.report.items.map((i) => [i.outcome, i.notes]), [["exported", []]]);
    assert.ok(result.report.general.some((g) => /2 equations are written as LaTeX between \\\( and \\\)/.test(g)), result.report.general.join("|"));
  });

  test("says nothing about equations in a file that has none", () => {
    const result = exportMoodleXml([withMath([], "e1")], { name: "Maths" });
    assert.ok(!result.report.general.some((g) => /equation/.test(g)));
  });

  test("has its LaTeX escaped as text, so that less-than and ampersands are not markup", () => {
    const q = withMath([{ id: "e1", latex: "a<b\\&c>d", mathml: "<math/>" }]);
    const xml = xmlOf([q]);
    assert.ok(xml.includes("\\(a&lt;b\\&amp;c&gt;d\\)"), xml);
    assert.doesNotThrow(() => parseXml(xml.replace(/^<\?xml[^>]*\?>\s*/, "")));
  });

  test("with LaTeX that could end the delimiters early, or none, is words, and is counted as a loss", () => {
    for (const latex of ["a\\)b", "$$x$$", ""]) {
      const result = exportMoodleXml([withMath([{ id: "e1", latex, mathml: "<math/>" }])], { name: "Maths" });
      const xml = result.files[0]?.content ?? "";
      assert.ok(!xml.includes("\\(") || latex === "", `${JSON.stringify(latex)} is not written between delimiters`);
      assert.ok(xml.includes(latex === "" ? "[Equation]" : `[Equation: ${latex}]`), JSON.stringify(latex));
      assert.equal(result.report.items[0]!.outcome, "exportedWithLosses");
      assert.ok(result.report.items[0]!.notes.some((n) => /1 equation became text/.test(n)));
    }
  });

  test("with a reference to an equation the question does not carry is words, as before", () => {
    const xml = xmlOf([withMath(MATH, "gone")]);
    assert.ok(xml.includes("[Equation]"));
  });
});

describe("an equation in the other exports", () => {
  test("is still the words [Equation: LaTeX] with a note, in GIFT", () => {
    const result = exportGift([withMath(MATH, "e1")]);
    // GIFT escapes the characters it reads as its own, so the colon and the braces carry a backslash.
    assert.ok(result.files[0]!.content.includes("[Equation\\: "), result.files[0]!.content);
    assert.ok(result.report.items[0]!.notes.some((n) => /1 equation became text/.test(n)));
  });
});

describe("an answer that is only an equation, in every export", () => {
  const q = (): Question => withMath(MATH, "e1", "e2");

  test("is an answer and not an empty one, so the question is exported and the equation is written out", async () => {
    const { exportBlackboardUpload } = await import("../src/export/blackboard-upload.ts");
    const { exportCommonCartridge } = await import("../src/export/common-cartridge.ts");
    const { exportD2lCsv } = await import("../src/export/d2l-csv.ts");
    const { exportQti12 } = await import("../src/export/qti12.ts");
    const { exportOpenStageSpreadsheet } = await import("../src/export/openstage-spreadsheet.ts");
    const results = {
      blackboard: exportBlackboardUpload([q()]),
      commonCartridge: exportCommonCartridge([q()]),
      d2l: exportD2lCsv([q()]),
      gift: exportGift([q()]),
      moodle: exportMoodleXml([q()]),
      qti: exportQti12([q()]),
      openstage: exportOpenStageSpreadsheet([q()]),
    };
    for (const [name, result] of Object.entries(results)) {
      assert.notEqual(result.report.items[0]!.outcome, "leftOut", `${name}: ${result.report.items[0]!.notes.join(" ")}`);
      assert.equal(result.files.length > 0, true, name);
    }
  });
});
