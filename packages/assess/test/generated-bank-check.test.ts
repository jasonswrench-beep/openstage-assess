/**
 * The checker that holds a generated test bank to its assignment (test/tools/generated-bank-check.ts). The first
 * batch of generated banks came back as five documents under 24 names, in one layout, with a checker that printed
 * success whatever it found, so this checker is tested the way the importer is: documents in every assigned layout
 * that it must pass, and documents broken in one way each that it must not. The documents are written here by the
 * test writer, with invented questions, and are read by the checker's own reader.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkFile, checkFolder, readDocx, type CheckLimits } from "./tools/generated-bank-check.ts";
import { BEGIN, MARK, OPTIONS, PLAN, assignmentFor, pieceText, type Begin, type Mark, type Options, type PlanEntry, type Trap } from "./tools/generated-bank-plan.ts";
import { abstractNum, docx, level, listProperties, num, numberingPart, paragraph, run, style, table } from "./support/docx-writer.ts";

const LIMITS: CheckLimits = { minQuestions: 4, maxQuestions: 30, minChoice: 4 };
const bold = "<w:b/>";
const underline = '<w:u w:val="single"/>';
const highlight = '<w:highlight w:val="yellow"/>';
const red = '<w:color w:val="FF0000"/>';

interface Q {
  stem: string;
  options: string[];
  correct: number[];
  /** Left unmarked, or marked twice, in the document. */
  fault?: "none" | "two";
}

const WORDS = ["Alder", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hazel"];
const QUESTIONS: Q[] = Array.from({ length: 6 }, (_, i) => ({
  stem: `Which of these trees is number ${i + 1} on the survey list?`,
  options: [0, 1, 2, 3].map((j) => `${WORDS[(i + j) % WORDS.length]} ${i + 1}`),
  correct: [(i * 2 + 1) % 4],
}));

const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({
  name: "c-99", piece: 1, begin: "B1", options: "O1", mark: "K8", word: "Answer", extras: [], trap: "T0", questions: 6, lapses: 0, subject: "trees", ...over,
});

const numbering = numberingPart(
  [abstractNum(0, [level(0, { format: "decimal" })]), abstractNum(1, [level(0, { format: "bullet", text: "•" })])],
  [num(1, 0), num(2, 1)],
);

const label = (o: Options, j: number): string => {
  const upper = String.fromCharCode(65 + j);
  return { O1: `${upper}.`, O2: `${upper})`, O3: `(${upper})`, O4: `${upper.toLowerCase()}.`, O5: `${upper}:`, O6: "", O7: `${upper}.`, O8: "" }[o];
};

const prefix = (b: Begin, n: number): string =>
  ({ B1: `${n}. `, B2: `${n}) `, B3: `(${n}) `, B4: `Q${n}. `, B5: `Question ${n}: `, B6: "", B7: `4.${n} `, B8: "" })[b];

/** The XML of a document laid out as the entry says, and the expected file for it. */
function build(e: PlanEntry, qs: readonly Q[] = QUESTIONS, tweak: (parts: string[]) => void = () => {}): { bytes: Uint8Array; expected: object } {
  const parts: string[] = [paragraph(run("A short test"))];
  const key: Array<[number, string]> = [];
  qs.forEach((q, i) => {
    const n = i + 1;
    const stemPara = e.begin === "B6" ? paragraph(run(q.stem), listProperties({ numId: 1 })) : paragraph(run(prefix(e.begin, n) + q.stem));
    parts.push(stemPara);
    const marked = (j: number): boolean => q.fault !== "none" && (q.correct.includes(j) || (q.fault === "two" && j === ((q.correct[0] as number) + 1) % q.options.length));
    const optionRun = (j: number): string => {
      const words = q.options[j] as string;
      const lab = label(e.options, j);
      const lead = lab === "" ? "" : `${lab} `;
      const props = e.mark === "K3" ? bold : e.mark === "K4" ? underline : e.mark === "K5" ? highlight : e.mark === "K6" ? red : "";
      if (props !== "") return run(lead) + (marked(j) ? run(words, props) : run(words));
      if (e.mark === "K1") return run(`${lead}${marked(j) ? "*" : ""}${words}`);
      if (e.mark === "K2") return run(`${lead}${words}${marked(j) ? " *" : ""}`);
      if (e.mark === "K7") return run(`${lead}${words}${marked(j) ? " (Correct)" : ""}`);
      return run(`${lead}${words}`);
    };
    const letters = q.options.map((_, j) => String.fromCharCode(65 + j)).filter((_, j) => marked(j)).join(", ");
    if (e.options === "O7") {
      const joined = q.options.map((_, j) => optionRun(j)).join(run("   "));
      parts.push(paragraph(joined + (e.mark === "K11" && letters ? run(`   ${e.word}: ${letters}`) : "")));
    } else {
      q.options.forEach((_, j) => parts.push(paragraph(optionRun(j), e.options === "O8" ? listProperties({ numId: 2 }) : "")));
      if (e.mark === "K8" && letters) parts.push(paragraph(run(`${e.word}: ${letters}`)));
    }
    if (letters) key.push([n, letters]);
    if (e.begin === "B8") parts.push(paragraph());
  });
  if (e.mark === "K9") {
    parts.push(paragraph(run("Answer Key")));
    for (let i = 0; i < key.length; i += 3) parts.push(paragraph(run(key.slice(i, i + 3).map(([n, l]) => `${n}. ${l}`).join("   "))));
  }
  if (e.mark === "K10") parts.push(paragraph(run("Answer Key")), table([["No.", "Answer"], ...key.map(([n, l]) => [String(n), l])].map((r) => r.map((c) => paragraph(run(c))))));
  tweak(parts);
  const expected = {
    file: `${e.name}.docx`,
    questions: qs.map((q) => ({
      type: "multipleChoice",
      stem: q.stem,
      // A copy, because tests change the expected file in place and QUESTIONS is shared by all of them.
      options: [...q.options],
      ...(q.fault ? { verdict: "failed" } : { correct: [...q.correct] }),
    })),
  };
  return { bytes: docx({ body: parts.join(""), numbering }), expected };
}

const check = (e: PlanEntry, qs?: readonly Q[], tweak?: (parts: string[]) => void, edit?: (expected: any) => void): string[] => {
  const { bytes, expected } = build(e, qs, tweak);
  edit?.(expected);
  return checkFile(e, readDocx(bytes), expected, LIMITS).problems;
};

describe("the reader of the document", () => {
  test("an empty paragraph that Word writes with attributes does not swallow the table after it", () => {
    // Word writes <w:p w14:paraId="..." .../> for a blank line. A reader that took it for the start of a paragraph
    // ran on to the next </w:p>, which was inside the first cell, and found no table at all.
    const bytes = docx({
      body:
        '<w:p w:rsidR="005B773D" w:rsidRDefault="005B773D"/>' +
        table([[paragraph(run("1.")), paragraph(run("Which is a tree?"))], [paragraph(run("a.")), paragraph(run("Alder"))]]) +
        '<w:p w:rsidR="005B773D"/><w:p/>' +
        paragraph(run("After the table")),
    });
    const doc = readDocx(bytes);
    assert.deepEqual(doc.lines.map((l) => l.text), ["", "1.", "Which is a tree?", "a.", "Alder", "", "", "After the table"]);
    assert.deepEqual(doc.lines.map((l) => (l.cell ? `${l.cell.row}:${l.cell.col}` : "-")), ["-", "0:0", "0:1", "1:0", "1:1", "-", "-", "-"]);
    assert.equal(doc.tables, 1);
  });

  test("an empty run with attributes does not swallow the run after it", () => {
    const doc = readDocx(docx({ body: paragraph('<w:r w:rsidR="00AB"/>' + run("kept", bold)) }));
    assert.equal(doc.lines[0]?.text, "kept");
    assert.equal(doc.lines[0]?.runs[0]?.bold, true);
  });

  test("a document Word wrote: its tables, its lists and its bold are found", () => {
    const read = (name: string) => readDocx(new Uint8Array(readFileSync(new URL(`../../../fixtures/word-authored/${name}`, import.meta.url))));
    for (const name of ["A-question-per-table.docx", "B-grid.docx", "C-answer-key-table.docx", "H-nested-option-tables.docx", "I-matching-rows.docx"]) {
      const doc = read(name);
      assert.ok(doc.tables >= 1 && doc.lines.some((l) => l.cell), `${name} has a table`);
    }
    for (const name of ["D-outline-list-bold-key.docx", "G-numbered-and-lettered-lists.docx"]) {
      assert.ok(read(name).lines.filter((l) => l.list === "number").length >= 6, `${name} has Word's own numbering`);
    }
    assert.ok(read("B-grid.docx").lines.some((l) => l.runs.some((r) => r.bold)), "bold is found in a table cell");
  });

  test("a line break splits a paragraph into lines, and a page break does not", () => {
    const doc = readDocx(docx({ body: paragraph(run("one") + "<w:r><w:br/></w:r>" + run("two") + '<w:r><w:br w:type="page"/></w:r>' + run(" three")) }));
    assert.deepEqual(doc.lines.map((l) => l.text), ["one", "two three"]);
    assert.equal(doc.paragraphsWithBreaks, 1);
    assert.equal(new Set(doc.lines.map((l) => l.para)).size, 1);
  });

  test("a style that carries a list is a list, as python-docx's List Number and List Bullet do", () => {
    const styles = style({ id: "ListNumber", numId: 1 }) + style({ id: "ListBullet", numId: 2 }) + style({ id: "ListNumber2", basedOn: "ListNumber" });
    const doc = readDocx(
      docx({
        body: paragraph(run("a"), listProperties({ style: "ListNumber" })) + paragraph(run("b"), listProperties({ style: "ListBullet" })) + paragraph(run("c"), listProperties({ style: "ListNumber2" })) + paragraph(run("d")),
        numbering,
        styles,
      }),
    );
    assert.deepEqual(doc.lines.map((l) => l.list ?? "none"), ["number", "bullet", "number", "none"]);
  });
});

describe("a document laid out as assigned passes", () => {
  for (const b of Object.keys(BEGIN) as Begin[]) {
    test(`questions begin as ${b}`, () => {
      assert.deepEqual(check(entry({ begin: b })), []);
    });
  }
  for (const o of Object.keys(OPTIONS) as Options[]) {
    test(`options are labelled as ${o}`, () => {
      const mark: Mark = o === "O7" ? "K11" : o === "O8" ? "K7" : o === "O6" ? "K3" : "K8";
      assert.deepEqual(check(entry({ options: o, mark })), []);
    });
  }
  for (const k of Object.keys(MARK) as Mark[]) {
    test(`the right option is marked as ${k}`, () => {
      assert.deepEqual(check(entry({ mark: k, ...(k === "K11" ? { options: "O7" as Options } : {}) })), []);
    });
  }
  test("the word that introduces the answer is held to the assignment", () => {
    for (const [mark, options] of [["K8", "O1"], ["K11", "O7"]] as const) {
      const { bytes, expected } = build(entry({ mark, options, word: "Answer" }));
      const problems = checkFile(entry({ mark, options, word: "ANS" }), readDocx(bytes), expected, LIMITS).problems;
      assert.match(problems.join("\n"), /introduced by "ANS:", and 6 of 6 use another word/, mark);
    }
  });
});

describe("a document that is not as assigned does not pass", () => {
  test("questions that begin another way", () => {
    const { bytes, expected } = build(entry({ begin: "B2" }));
    const problems = checkFile(entry({ begin: "B1" }), readDocx(bytes), expected, LIMITS).problems;
    assert.match(problems.join("\n"), /Questions were to begin as B1, and only 0 of 6 do/);
  });

  test("options labelled another way", () => {
    const { bytes, expected } = build(entry({ options: "O2" }));
    assert.match(checkFile(entry({ options: "O1" }), readDocx(bytes), expected, LIMITS).problems.join("\n"), /labelled as O1, and only 0 of 24 are/);
  });

  test("Word's own numbering is not typed numbers, and the reverse", () => {
    const typed = build(entry({ begin: "B1" }));
    assert.match(checkFile(entry({ begin: "B6" }), readDocx(typed.bytes), typed.expected, LIMITS).problems.join("\n"), /begin as B6, and only 0 of 6/);
    const auto = build(entry({ begin: "B6" }));
    assert.match(checkFile(entry({ begin: "B1" }), readDocx(auto.bytes), auto.expected, LIMITS).problems.join("\n"), /begin as B1/);
  });

  test("bullets that are typed characters pass, and plain paragraphs do not", () => {
    const plain = build(entry({ options: "O6", mark: "K3" }));
    assert.match(checkFile(entry({ options: "O8", mark: "K3" }), readDocx(plain.bytes), plain.expected, LIMITS).problems.join("\n"), /labelled as O8/);
  });

  test("a mark that is not there", () => {
    const { bytes, expected } = build(entry({ mark: "K8" }));
    const problems = checkFile(entry({ mark: "K3" }), readDocx(bytes), expected, LIMITS).problems;
    assert.ok(problems.some((p) => /the document marks nothing \(by K3\)/.test(p)), problems.join("\n"));
  });

  test("a mark on the wrong option is named, with what the document says and what the expected file says", () => {
    for (const k of ["K1", "K3", "K8", "K9"] as const) {
      const problems = check(entry({ mark: k }), undefined, undefined, (expected) => {
        expected.questions[2].correct = [(expected.questions[2].correct[0] + 1) % 4];
      });
      assert.equal(problems.length, 1, `${k}: ${problems.join(" | ")}`);
      assert.match(problems[0] as string, /^question 3: the document marks [A-D] \(by .*\), but the expected file says [A-D]\.$/);
    }
  });

  test("a key by number that follows the numbers the file shows", () => {
    // The key is read by the number the question carries, so a question that carries another number is another's.
    const problems = check(entry({ begin: "B1", mark: "K9" }), undefined, (parts) => {
      const at = parts.findIndex((p) => p.includes("3. Which of these"));
      parts[at] = parts[at]!.replace("3. Which", "7. Which");
    });
    assert.ok(problems.length > 0);
  });

  test("a stem that is reworded, or out of order", () => {
    const reworded = check(entry(), undefined, undefined, (expected) => (expected.questions[1].stem = "Which tree is second?"));
    assert.match(reworded.join("\n"), /question 2: the stem "Which tree is second\?" is not in the document/);
    const swapped = check(entry(), undefined, undefined, (expected) => expected.questions.reverse());
    assert.ok(swapped.length > 0);
  });

  test("an option that is reworded", () => {
    const problems = check(entry(), undefined, undefined, (expected) => (expected.questions[0].options[2] = "Willow"));
    assert.match(problems.join("\n"), /question 1: option 3 "Willow" is not under its stem/);
  });

  test("curly quotes and spacing are not differences", () => {
    const qs: Q[] = QUESTIONS.map((q, i) => (i === 0 ? { ...q, stem: "Which tree is Alder’s closest “relative” here?" } : q));
    const problems = check(entry(), qs, undefined, (expected) => (expected.questions[0].stem = "Which tree is Alder's closest \"relative\" here?"));
    assert.deepEqual(problems, []);
  });

  test("too few questions, and too few that are multiple choice", () => {
    const few = checkFile(entry(), readDocx(build(entry(), QUESTIONS.slice(0, 2)).bytes), build(entry(), QUESTIONS.slice(0, 2)).expected, { ...LIMITS, minQuestions: 12 }).problems;
    assert.match(few.join("\n"), /It has 2 questions; 12 to 30 were asked for/);
    const noChoice = checkFile(entry(), readDocx(build(entry()).bytes), build(entry()).expected, { ...LIMITS, minChoice: 8 }).problems;
    assert.match(noChoice.join("\n"), /Only 6 questions are single-answer multiple choice; at least 8/);
  });

  test("an expected file that is not well formed", () => {
    for (const [edit, message] of [
      [(x: any) => (x.questions[0].type = "choice"), /the type "choice"/],
      [(x: any) => delete x.questions[0].correct, /correct has to be a list/],
      [(x: any) => (x.questions[0].correct = [0, 1]), /one correct option/],
      [(x: any) => (x.questions[0].options = ["only"]), /at least two options/],
      [(x: any) => (x.file = "c-98.docx"), /says it is for "c-98.docx"/],
      [(x: any) => (x.orphans = []), /orphans field/],
    ] as const) {
      assert.match(check(entry(), undefined, undefined, edit).join("\n"), message);
    }
  });
});

describe("the hard case it was assigned", () => {
  const withFault = (index: number, fault: "none" | "two"): Q[] => QUESTIONS.map((q, i) => (i === index ? { ...q, fault } : q));

  test("a question with no answer marked, in every way of marking", () => {
    for (const k of ["K1", "K3", "K7", "K8", "K9", "K10"] as const) {
      assert.deepEqual(check(entry({ mark: k, trap: "T6" }), withFault(2, "none")), [], k);
    }
    assert.deepEqual(check(entry({ mark: "K11", options: "O7", trap: "T6" }), withFault(2, "none")), []);
  });

  test("a question with two answers marked", () => {
    for (const k of ["K2", "K4", "K8", "K10"] as const) {
      assert.deepEqual(check(entry({ mark: k, trap: "T7" }), withFault(1, "two")), [], k);
    }
  });

  test("a failed question that the document marks once", () => {
    const problems = check(entry({ trap: "T6" }), undefined, undefined, (expected) => {
      expected.questions[2] = { type: "multipleChoice", stem: expected.questions[2].stem, options: expected.questions[2].options, verdict: "failed" };
    });
    assert.match(problems.join("\n"), /question 3: the expected file calls it failed, but the document marks one option/);
    assert.match(problems.join("\n"), /T6: no multiple choice question is both failed/);
  });

  test("the case is missing, or the file was to be clean", () => {
    for (const trap of ["T1", "T2", "T3", "T4", "T5", "T6", "T7"] as Trap[]) {
      assert.match(check(entry({ trap })).join("\n"), new RegExp(`${trap}: `), trap);
    }
    assert.match(check(entry({ trap: "T0" }), withFault(0, "none")).join("\n"), /A clean file was asked for/);
  });

  test("a stem over two paragraphs, a line break inside a paragraph, a stem with a list in it", () => {
    const qs = QUESTIONS.map((q, i) =>
      i === 0 ? { ...q, stem: "Read the steps. 1. Plan the survey 2. Count the trees 3. Report. Which step is first?" } : q,
    );
    assert.deepEqual(check(entry({ trap: "T1" }), qs), []);
    const two = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("number 2 on the survey list"));
      parts[at] = paragraph(run("1) The first half of the stem.")) + paragraph(run("Which of these trees is number 2 on the survey list?"));
    };
    const { bytes } = build(entry({ trap: "T4" }), QUESTIONS, two);
    const expected = { file: "c-99.docx", questions: QUESTIONS.map((q, i) => ({ type: "multipleChoice", stem: i === 1 ? `The first half of the stem. ${q.stem}` : q.stem, options: q.options, correct: q.correct })) };
    expected.questions[1]!.stem = `The first half of the stem. ${QUESTIONS[1]!.stem}`;
    const problems = checkFile(entry({ trap: "T4" }), readDocx(bytes), expected, LIMITS).problems;
    assert.deepEqual(problems.filter((p) => !/begin as/.test(p)), []);
    const broken = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("number 3 on the survey list"));
      parts[at] = paragraph(run("3. Which of these trees is number 3") + "<w:r><w:br/></w:r>" + run("on the survey list?"));
    };
    assert.deepEqual(check(entry({ trap: "T5" }), undefined, broken), []);
  });
});

describe("the other types", () => {
  const e = entry({ extras: ["TFo", "TFp", "TFa", "FIB", "SA", "ESS", "MTt"], mark: "K8", options: "O1", begin: "B1" });
  const extraQuestions = [
    { type: "trueFalse", form: "options", stem: "The oak is a conifer.", correctBoolean: false },
    { type: "trueFalse", form: "inline", stem: "Maples lose their leaves.", correctBoolean: true },
    { type: "trueFalse", form: "answerLine", stem: "Pines are broadleaf trees.", correctBoolean: false },
    { type: "fillInBlank", stem: "The tallest tree species is the ____.", accepted: ["redwood"] },
    { type: "shortAnswer", stem: "Name the process by which leaves make sugar.", accepted: ["photosynthesis"] },
    { type: "essay", stem: "Discuss how forests change after a fire." },
    { type: "matching", stem: "Match each tree to its leaf.", pairs: ["Oak = Lobed", "Pine = Needle"] },
  ];
  const lines = [
    "7. The oak is a conifer.", "A. True", "B. False", "Answer: B",
    "8. Maples lose their leaves. (T)",
    "9. Pines are broadleaf trees.", "Answer: False",
    "10. The tallest tree species is the ____.", "Answer: redwood",
    "11. Name the process by which leaves make sugar.", "Answer: photosynthesis",
    "12. Discuss how forests change after a fire.",
    "13. Match each tree to its leaf.",
  ];
  const withExtras = (): { bytes: Uint8Array; expected: any } => {
    const base = build(e, QUESTIONS, (parts) => {
      for (const l of lines) parts.push(paragraph(run(l)));
      parts.push(table([["Oak", "Lobed"], ["Pine", "Needle"]].map((r) => r.map((c) => paragraph(run(c))))));
    });
    const expected = base.expected as { questions: unknown[] };
    expected.questions.push(...extraQuestions);
    return { bytes: base.bytes, expected };
  };
  const run_ = (edit?: (x: any) => void): string[] => {
    const { bytes, expected } = withExtras();
    edit?.(expected);
    return checkFile(e, readDocx(bytes), expected, LIMITS).problems;
  };

  test("true or false in three forms, fill in the blank, short answer, essay and a matching table pass", () => {
    assert.deepEqual(run_(), []);
  });

  test("a true or false answer that disagrees with the document", () => {
    assert.match(run_((x) => (x.questions[6].correctBoolean = true)).join("\n"), /question 7: the document marks B \(by K8\), but the expected file says A/);
    assert.match(run_((x) => (x.questions[7].correctBoolean = false)).join("\n"), /question 8: the statement ends with \(T\) but the expected file says false/);
    assert.match(run_((x) => (x.questions[8].correctBoolean = true)).join("\n"), /question 9: the file says False but the expected file says true/);
  });

  test("a fill in the blank whose answer is not the one the file gives", () => {
    assert.match(run_((x) => (x.questions[9].accepted = ["sequoia"])).join("\n"), /question 10: no Answer line under .* gives "sequoia"/);
    assert.match(run_((x) => (x.questions[10].accepted = ["respiration"])).join("\n"), /question 11: no Answer line/);
  });

  test("a pair that is not on one row of the table", () => {
    assert.match(run_((x) => (x.questions[12].pairs = ["Oak = Needle", "Pine = Lobed"])).join("\n"), /the pair "Oak = Needle" is not on one row of a table/);
  });

  test("an extra type that is asked for and missing", () => {
    assert.match(run_((x) => (x.questions = x.questions.filter((q: any) => q.type !== "essay"))).join("\n"), /asked to include ESS/);
  });
});

describe("a folder of files", () => {
  const plan = (): PlanEntry[] => [entry({ name: "c-91" }), entry({ name: "c-92", begin: "B2" })];
  const write = (dir: string, e: PlanEntry, qs: readonly Q[] = QUESTIONS): void => {
    const { bytes, expected } = build(e, qs);
    writeFileSync(join(dir, `${e.name}.docx`), bytes);
    writeFileSync(join(dir, `${e.name}.docx.expected.json`), JSON.stringify(expected));
  };
  const other = QUESTIONS.map((q, i) => ({ ...q, stem: `On the second survey, which tree is number ${i + 1}?` }));

  test("two distinct files pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankcheck-"));
    try {
      const [a, b] = plan() as [PlanEntry, PlanEntry];
      write(dir, a);
      write(dir, b, other);
      const report = checkFolder(dir, undefined, [a, b], LIMITS);
      assert.deepEqual(report.files.flatMap((f) => f.problems), []);
      assert.equal(report.checked, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same questions under two names are caught, and which file has them is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankcheck-"));
    try {
      const [a, b] = plan() as [PlanEntry, PlanEntry];
      write(dir, a);
      write(dir, b);
      const report = checkFolder(dir, undefined, [a, b], LIMITS);
      const second = report.files[1]!.problems.join("\n");
      assert.match(second, /is also in c-91\.docx/);
      assert.equal(report.files[0]!.problems.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same plain stem in two files is not a repeat when what goes with it differs, and is when it does not", () => {
    // "Match each term with its definition." is in real banks everywhere. The repeat that matters is a copied document.
    const dir = mkdtempSync(join(tmpdir(), "bankcheck-"));
    try {
      const [a, b] = plan() as [PlanEntry, PlanEntry];
      write(dir, a);
      write(dir, b, QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => `${o} again`) })));
      assert.deepEqual(checkFolder(dir, undefined, [a, b], LIMITS).files[1]!.problems, [], "the same stems, other options");
      write(dir, b, QUESTIONS.map((q) => ({ ...q, options: [...q.options].reverse(), correct: q.correct.map((j) => 3 - j) })));
      assert.match(checkFolder(dir, undefined, [a, b], LIMITS).files[1]!.problems.join("\n"), /is also in c-91\.docx, with the same options, pairs or answers/, "the same options in another order are the same options");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("what makes a question the same one: its stem with its options, pairs or answers, in any order", () => {
    const doc = readDocx(docx({ body: para("x") }));
    const idOf = (q: object): string => checkFile(entry(), doc, { file: "c-99.docx", questions: [q] }, LIMITS).identities[0] as string;
    const match = (pairs: string[]) => ({ type: "matching", stem: "Match each term with its definition.", pairs });
    assert.notEqual(idOf(match(["Oak = Lobed", "Pine = Needle"])), idOf(match(["Fir = Needle", "Elm = Toothed"])), "other pairs");
    assert.equal(idOf(match(["Oak = Lobed", "Pine = Needle"])), idOf(match(["Pine = Needle", "Oak = Lobed"])), "the same pairs in another order");
    const blank = (accepted: string[]) => ({ type: "fillInBlank", stem: "The tallest tree is the ____.", accepted });
    assert.notEqual(idOf(blank(["redwood"])), idOf(blank(["sequoia"])), "another accepted answer");
    assert.equal(idOf(blank(["redwood"])), idOf(blank(["Redwood."])), "case and punctuation");
    const essay = (stem: string) => ({ type: "essay", stem });
    assert.equal(idOf(essay("Discuss how forests change after a fire.")), idOf(essay("discuss how FORESTS change after a fire")), "an essay is its stem");
    assert.notEqual(idOf(essay("Discuss how forests change after a fire.")), idOf(essay("Discuss how forests change after a flood.")), "another essay");
  });

  test("a missing file, a file that is not a Word document, a damaged expected file and a file not in the plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankcheck-"));
    try {
      const [a, b] = plan() as [PlanEntry, PlanEntry];
      write(dir, a);
      writeFileSync(join(dir, "c-92.docx"), "not a zip");
      writeFileSync(join(dir, "c-92.docx.expected.json"), "{");
      writeFileSync(join(dir, "c-93.docx"), "x");
      const report = checkFolder(dir, undefined, [a, b], LIMITS);
      assert.match(report.files[1]!.problems.join("\n"), /could not be read as a Word document/);
      assert.match(report.problems.join("\n"), /c-93\.docx is not a file in the plan/);
      rmSync(join(dir, "c-91.docx"));
      assert.match(checkFolder(dir, undefined, [a], LIMITS).files[0]!.problems.join("\n"), /c-91\.docx is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only the pieces asked for are held to the plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankcheck-"));
    try {
      const [a, b] = plan() as [PlanEntry, PlanEntry];
      write(dir, a);
      assert.equal(checkFolder(dir, [1], [a, { ...b, piece: 2 }], LIMITS).files.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A document of a few paragraphs written by hand, for a check that needs one thing wrong and nothing else. */
const mini = (e: PlanEntry, body: string[], questions: object[], limits: CheckLimits = { minQuestions: 1, maxQuestions: 30, minChoice: 0 }): string[] =>
  checkFile(e, readDocx(docx({ body: body.join(""), numbering })), { file: `${e.name}.docx`, questions }, limits).problems;
const para = (text: string): string => paragraph(run(text));
const GRASS = { type: "multipleChoice", stem: "Which colour is grass?", options: ["red", "blue", "green", "grey"], correct: [2] };
const asOf = (checked: PlanEntry, source: PlanEntry, qs?: readonly Q[], tweak?: (parts: string[]) => void): string => {
  const { bytes, expected } = build(source, qs, tweak);
  return checkFile(checked, readDocx(bytes), expected, LIMITS).problems.join("\n");
};

describe("each check can fail", () => {
  test("Word's numbering is what B6 means, and the blank line is what B8 means", () => {
    assert.match(asOf(entry({ begin: "B6" }), entry({ begin: "B8" })), /begin as B6, and only 0 of 6/, "no list, no number");
    const listed = (parts: string[]): void => {
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.includes("<w:numPr>")) parts.splice(i, 0, paragraph());
    };
    assert.match(asOf(entry({ begin: "B8" }), entry({ begin: "B6" }), undefined, listed), /begin as B8, and only 0 of 6/, "a list is a number");
    const typedToo = (parts: string[]): void => {
      parts.forEach((p, i) => {
        if (p.includes("<w:numPr>")) parts[i] = p.replace('<w:t xml:space="preserve">', '<w:t xml:space="preserve">9. ');
      });
    };
    assert.match(asOf(entry({ begin: "B6" }), entry({ begin: "B6" }), undefined, typedToo), /begin as B6, and only 0 of 6/, "a typed number as well");
    const runOn = (parts: string[]): void => void parts.splice(0, parts.length, ...parts.filter((p) => p !== paragraph()));
    assert.match(asOf(entry({ begin: "B8" }), entry({ begin: "B8" }), undefined, runOn), /begin as B8, and only 0 of 6/, "no blank line between");
  });

  test("unlabelled options are not labelled and not in a list; bullets are in one", () => {
    assert.match(asOf(entry({ options: "O6", mark: "K7" }), entry({ options: "O1", mark: "K7" })), /labelled as O6, and only 0 of 24/, "a label");
    assert.match(asOf(entry({ options: "O6", mark: "K7" }), entry({ options: "O8", mark: "K7" })), /labelled as O6, and only 0 of 24/, "a bullet list");
    assert.match(asOf(entry({ options: "O8", mark: "K7" }), entry({ options: "O6", mark: "K7" })), /labelled as O8, and only 0 of 24/, "plain paragraphs");
  });

  test("O7 means several options to a paragraph", () => {
    assert.match(asOf(entry({ options: "O7", mark: "K8" }), entry({ options: "O1", mark: "K8" })), /Several options were to share a paragraph, and that is so for only 0 of 6/);
  });

  test("a star at the end is not a star in front, and the reverse", () => {
    assert.match(asOf(entry({ mark: "K1" }), entry({ mark: "K2" })), /the document marks nothing \(by K1\)/);
    assert.match(asOf(entry({ mark: "K2" }), entry({ mark: "K1" })), /the document marks nothing \(by K2\)/);
  });

  test("one bold word in a wrong option is emphasis, not the mark", () => {
    const emphasis = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Alder 1"));
      parts[at] = parts[at]!.replace(run("Alder 1"), run("Alder", bold) + run(" 1"));
    };
    assert.equal(asOf(entry({ mark: "K3" }), entry({ mark: "K3" }), undefined, emphasis), "");
  });

  test("a mark that is switched off, or is the colour of ordinary text, is not a mark", () => {
    const only = (words: string, props: string) => (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes(words));
      parts[at] = parts[at]!.replace(run(words), run(words, props));
    };
    assert.equal(asOf(entry({ mark: "K3" }), entry({ mark: "K3" }), undefined, only("Alder 1", '<w:b w:val="0"/>')), "", "bold off");
    assert.equal(asOf(entry({ mark: "K4" }), entry({ mark: "K4" }), undefined, only("Alder 1", '<w:u w:val="none"/>')), "", "underline none");
    assert.equal(asOf(entry({ mark: "K6" }), entry({ mark: "K6" }), undefined, only("Alder 1", '<w:color w:val="000000"/>')), "", "black");
    assert.equal(asOf(entry({ mark: "K6" }), entry({ mark: "K6" }), undefined, only("Alder 1", '<w:color w:val="auto"/>')), "", "automatic");
    assert.match(asOf(entry({ mark: "K3" }), entry({ mark: "K3" }), undefined, only("Alder 1", "<w:b/>")), /question 1: the document marks A, B \(by K3\), but the expected file says B/, "bold on");
  });

  test("(Correct) is the mark, and another bracket is not", () => {
    const note = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Alder 1"));
      parts[at] = parts[at]!.replace("Alder 1", "Alder 1 (see note 3)");
    };
    assert.equal(asOf(entry({ mark: "K7" }), entry({ mark: "K7" }), undefined, note), "");
  });

  test("an Answer line that points at options with no letters says so", () => {
    assert.match(asOf(entry({ options: "O6", mark: "K8" }), entry({ options: "O6", mark: "K8" })), /the Answer line .* does not name options that have letters/);
  });

  test("the answer at the end of the options is at the end of the last paragraph of them", () => {
    const e = entry({ options: "O7", mark: "K11", word: "ANS" });
    const body = (...lines: string[]): string[] => [para("1. Which colour is grass?"), ...lines.map(para)];
    assert.deepEqual(mini(e, body("A. red   B. blue   C. green   D. grey   ANS: C"), [GRASS]), [], "one paragraph");
    assert.deepEqual(mini(e, body("A. red   B. blue", "C. green   D. grey   ANS: C"), [GRASS]), [], "two paragraphs, the answer at the end of the second");
    assert.match(mini(e, body("A. red   B. blue   ANS: C", "C. green   D. grey"), [GRASS]).join("\n"), /marks nothing/, "the answer in the first of two");
    assert.match(mini(e, body("ANS: C   A. red   B. blue   C. green   D. grey"), [GRASS]).join("\n"), /not under its stem|marks nothing/, "the answer at the start");
    assert.match(mini(e, body("A. red   B. blue   C. green   D. grey   ANS: C   (page 3)"), [GRASS]).join("\n"), /marks nothing/, "the answer, then more");
    assert.match(mini(e, body("A. red   B. blue   C. green   D. grey", "ANS: C"), [GRASS]).join("\n"), /marks nothing/, "the answer on a paragraph of its own");
  });

  test("a key at the end is after the last question, and has to be there", () => {
    const keyed = entry({ mark: "K9" });
    const without = (parts: string[]): void => void parts.splice(parts.findIndex((p) => p.includes("Answer Key")));
    assert.match(asOf(keyed, keyed, undefined, without), /none was found there/, "no key");
    const first = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Answer Key"));
      const key = parts.splice(at);
      parts.splice(1, 0, ...key);
    };
    assert.match(asOf(keyed, keyed, undefined, first), /none was found there/, "a key before the questions");
    const tabled = entry({ mark: "K10" });
    assert.match(asOf(tabled, tabled, undefined, (parts) => void parts.pop()), /none was found there/, "no table");
    assert.match(asOf(entry({ mark: "K10" }), entry({ mark: "K9" })), /none was found there/, "a list where a table was assigned");
  });

  test("a key by number reads the second column and not the first", () => {
    const tabled = entry({ mark: "K10" });
    const swapped = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("<w:tbl>"));
      parts[at] = parts[at]!.replace(/<w:tc>.*?<\/w:tc>/s, (first) => first); // the first cell stays the number
    };
    assert.equal(asOf(tabled, tabled, undefined, swapped), "");
    const reversed = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("<w:tbl>"));
      parts[at] = table([["No.", "Answer"], ...[1, 2, 3, 4, 5, 6].map((n) => [String(n), "A"]).map((r) => r.reverse())].map((r) => r.map((c) => paragraph(run(c)))));
    };
    assert.match(asOf(tabled, tabled, undefined, reversed), /the document marks/);
  });

  test("a stem is found after the one before it, not anywhere", () => {
    const problems = check(entry(), undefined, undefined, (expected) => expected.questions.reverse());
    assert.match(problems.join("\n"), /question 2: the stem ".*number 5.*" is not in the document after question 1/);
  });

  test("an option from another question is not this question's option", () => {
    const problems = check(entry(), undefined, undefined, (expected) => (expected.questions[0].options[2] = QUESTIONS[4]!.options[2]));
    assert.match(problems.join("\n"), /question 1: option 3 ".*5" is not under its stem/);
  });

  test("too many questions", () => {
    const { bytes, expected } = build(entry());
    assert.match(checkFile(entry(), readDocx(bytes), expected, { ...LIMITS, maxQuestions: 5 }).problems.join("\n"), /It has 6 questions; 4 to 5 were asked for/);
  });

  test("a tab between words is a space, and curly quotes and dashes are the straight ones", () => {
    const stem = "Which “tree” grows tallest – the redwood’s cousin?";
    assert.deepEqual(mini(entry(), [para("1. Which\t“tree” grows tallest – the redwood’s cousin?"), para("A. red"), para("B. blue"), para("Answer: B")], [{ type: "multipleChoice", stem: "Which \"tree\" grows tallest - the redwood's cousin?", options: ["red", "blue"], correct: [1] }]), []);
    void stem;
  });

  test("each other type holds the file to what it was asked for", () => {
    const tfo = entry({ extras: ["TFo"] });
    const inline = { type: "trueFalse", form: "inline", stem: "Maples lose leaves.", correctBoolean: true };
    assert.match(mini(tfo, [para("1. Maples lose leaves. (T)")], [inline]).join("\n"), /asked to include TFo/, "the wrong form of true or false");
    assert.match(mini(entry({ extras: ["TFp"] }), [para("1. Maples lose leaves.")], [inline]).join("\n"), /does not end with \(T\) or \(F\)/, "no (T) or (F)");
    assert.match(mini(entry({ extras: ["TFa"] }), [para("1. Maples lose leaves.")], [{ ...inline, form: "answerLine" }]).join("\n"), /no Answer: True or Answer: False line/, "no Answer line");
    const mtl = entry({ extras: ["MTl"] });
    const pairs = { type: "matching", stem: "Match each tree to its leaf.", pairs: ["Oak = Lobed", "Pine = Needle"] };
    assert.deepEqual(mini(mtl, [para("1. Match each tree to its leaf."), para("Oak = Lobed"), para("Pine = Needle")], [pairs]), []);
    assert.match(mini(mtl, [para("1. Match each tree to its leaf."), para("Oak = Lobed"), para("Pine - Needle")], [pairs]).join("\n"), /the pair "Pine = Needle" is not on one line as "term = definition"/);
    const fib = entry({ extras: ["FIB"] });
    assert.match(mini(fib, [para("1. The tallest tree is the ____.")], [{ type: "fillInBlank", stem: "The tallest tree is the ____.", accepted: ["redwood"] }]).join("\n"), /no Answer line under/);
  });

  test("a slip in spacing is named as one, and the expected file has to carry it", () => {
    // The scorer collapses a run of spaces and nothing else, so "tempo ?" and "tempo?" are different text.
    const stem = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("number 3 on the survey list"));
      parts[at] = parts[at]!.replace("list?", "list ?");
    };
    const problems = check(entry(), undefined, stem);
    assert.equal(problems.length, 1, problems.join(" | "));
    assert.match(problems[0] as string, /^question 3: the stem is in the document but spaced differently\. The line reads "3\. Which of these trees is number 3 on the survey list \?" and the expected file has "Which of these trees is number 3 on the survey list\?"\. The answers are compared as written/);
    // Carried exactly, it passes.
    assert.deepEqual(check(entry(), undefined, stem, (expected) => (expected.questions[2].stem = "Which of these trees is number 3 on the survey list ?")), []);
    // The same for an option. Two spaces in a row are one, and are not a slip.
    const option = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Cedar 1"));
      parts[at] = parts[at]!.replace("Cedar 1", "Cedar1");
    };
    assert.match(check(entry(), undefined, option).join("\n"), /question 1: option 3 is under its stem but spaced differently\. The line reads "C\. Cedar1" and the expected file has "Cedar 1"/);
    // Different words are not a spacing slip.
    const words = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Cedar 1"));
      parts[at] = parts[at]!.replace("Cedar 1", "Cedar , 1");
    };
    assert.match(check(entry(), undefined, words).join("\n"), /question 1: option 3 "Cedar 1" is not under its stem\./);
    const twice = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Cedar 1"));
      parts[at] = parts[at]!.replace("Cedar 1", "Cedar   1");
    };
    assert.deepEqual(check(entry(), undefined, twice), []);
  });

  test("a stem is called misspaced only when the words are after the question before it", () => {
    // The second stem is the first one with its spaces taken out. It is not in the document after the first, so it is
    // missing, and that is what is said: the line before it is another question's.
    const e = entry();
    const qs = [
      { type: "multipleChoice", stem: "Which tree is tallest?", options: ["Fir", "Elm"], correct: [0] },
      { type: "multipleChoice", stem: "Whichtreeistallest?", options: ["Fir", "Elm"], correct: [0] },
    ];
    const body = [para("A short test"), para("1. Which tree is tallest?"), para("A. Fir"), para("B. Elm"), para("Answer: A")];
    const problems = mini(e, body, qs);
    assert.ok(problems.some((p) => /question 2: the stem "Whichtreeistallest\?" is not in the document after question 1/.test(p)), problems.join(" | "));
  });

  test("an option is called misspaced only when the words are under the stem, not in the stem", () => {
    const qs = [{ type: "multipleChoice", stem: "Which tree is a Dog wood?", options: ["Dogwood", "Elm"], correct: [0] }];
    const body = [para("A short test"), para("1. Which tree is a Dog wood?"), para("A. Fir"), para("B. Elm"), para("Answer: A")];
    const problems = mini(entry(), body, qs).join(" | ");
    assert.match(problems, /question 1: option 1 "Dogwood" is not under its stem\./);
    assert.doesNotMatch(problems, /spaced differently/);
  });

  test("a star that is the first word of an option, in a file that marks its answers another way, is words and not a mark", () => {
    // The hard case "an asterisk as part of its words". With the answer given by an Answer line, "A. * Reliability" is an
    // option whose words begin with a star, and the answer file keeps it.
    const star = (parts: string[]): void => {
      const at = parts.findIndex((p) => p.includes("Cedar 1"));
      parts[at] = parts[at]!.replace("Cedar 1", "* Cedar 1");
    };
    assert.deepEqual(check(entry({ trap: "T3" }), undefined, star, (expected) => (expected.questions[0].options[2] = "* Cedar 1")), []);
    // The star as the mark is still the mark, and is not part of the words, when the file marks that way.
    assert.deepEqual(check(entry({ mark: "K1" })), []);
    // And where the file marks with a star, an expected option that keeps the star is not what the document says: the
    // document has the star as a mark, hard against the word, and the answer file has it as a word.
    assert.match(check(entry({ mark: "K1" }), undefined, undefined, (expected) => (expected.questions[0].options[1] = "* Birch 1")).join("\n"), /question 1: option 2 .*(spaced differently|is not under its stem)/);
  });

  test("a stem that has swallowed its (T) or (F) is named, and so is a statement with none", () => {
    const e = entry({ extras: ["TFp"] });
    const ends = (stem: string, answer: boolean) => [{ type: "trueFalse", form: "inline", stem, correctBoolean: answer }];
    const swallowed = mini(e, [para("A short test"), para("1. Maples lose their leaves (T)")], ends("Maples lose their leaves (T)", true)).join("\n");
    assert.match(swallowed, /question 1: the stem "Maples lose their leaves \(T\)" ends with its \(T\) or \(F\)\. That is the answer and not part of the statement, so leave it out/);
    assert.doesNotMatch(swallowed, /does not end with/);
    assert.deepEqual(mini(e, [para("A short test"), para("1. Maples lose their leaves (T)")], ends("Maples lose their leaves", true)), []);
    assert.match(mini(e, [para("A short test"), para("1. Maples lose their leaves.")], ends("Maples lose their leaves.", true)).join("\n"), /does not end with \(T\) or \(F\)/);
  });

  test("the case with two answers needs the document to mark two, and the case with none needs it to mark none", () => {
    const unmarked = QUESTIONS.map((q, i) => (i === 2 ? { ...q, fault: "none" as const } : q));
    assert.match(check(entry({ trap: "T7" }), unmarked).join("\n"), /T7: no multiple choice question is both failed/);
    const two = QUESTIONS.map((q, i) => (i === 2 ? { ...q, fault: "two" as const } : q));
    assert.match(check(entry({ trap: "T6" }), two).join("\n"), /T6: no multiple choice question is both failed/);
  });

  test("an expected file can be wrong in the ways the brief forbids", () => {
    for (const [edit, message] of [
      [(x: any) => ((x.questions[0] = { type: "trueFalse", stem: "A statement.", correctBoolean: true })), /needs "form"/],
      [(x: any) => ((x.questions[0].type = "multipleResponse"), (x.questions[0].correct = [1])), /at least two correct options/],
      [(x: any) => (x.questions[0].correct = [7]), /positions in options/],
      [(x: any) => (x.questions[0] = { type: "matching", stem: "Match.", pairs: ["Oak", "Pine"] }), /pairs written "left = right"/],
      [(x: any) => (x.questions[0] = { type: "fillInBlank", stem: "A ____." }), /list of accepted answers/],
      [(x: any) => (x.questions[0].stem = "  "), /has no stem/],
    ] as const) {
      assert.match(check(entry(), undefined, undefined, edit).join("\n"), message);
    }
  });

  test("a repeat is found whatever the case or the punctuation, and a different number is not a repeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankcheck-"));
    try {
      const [a, b] = [entry({ name: "c-91" }), entry({ name: "c-92", begin: "B2" })] as [PlanEntry, PlanEntry];
      const put = (e: PlanEntry, qs: readonly Q[]): void => {
        const built = build(e, qs);
        writeFileSync(join(dir, `${e.name}.docx`), built.bytes);
        writeFileSync(join(dir, `${e.name}.docx.expected.json`), JSON.stringify(built.expected));
      };
      put(a, QUESTIONS);
      put(b, QUESTIONS.map((q) => ({ ...q, stem: q.stem.toUpperCase().replace("?", " !") })));
      assert.match(checkFolder(dir, undefined, [a, b], LIMITS).files[1]!.problems.join("\n"), /is also in c-91\.docx/, "case and punctuation");
      put(b, QUESTIONS.map((q, i) => ({ ...q, stem: q.stem.replace(`number ${i + 1}`, `number ${i + 7}`) })));
      assert.deepEqual(checkFolder(dir, undefined, [a, b], LIMITS).files[1]!.problems, [], "another number is another question");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the plan", () => {
  test("names every file once, in pieces of four, with no two about the same thing", () => {
    assert.equal(PLAN.length, 24);
    assert.equal(new Set(PLAN.map((e) => e.name)).size, 24);
    assert.equal(new Set(PLAN.map((e) => e.subject)).size, 24);
    for (const piece of [1, 2, 3, 4, 5, 6]) assert.equal(PLAN.filter((e) => e.piece === piece).length, 4, `piece ${piece}`);
  });

  test("uses every way a question begins, every way options are labelled, every mark and every hard case at least twice", () => {
    for (const field of ["begin", "options", "mark", "trap"] as const) {
      const counts = new Map<string, number>();
      for (const e of PLAN) counts.set(e[field], (counts.get(e[field]) ?? 0) + 1);
      for (const [value, n] of counts) assert.ok(n >= 2, `${field} ${value} is used ${n} time`);
    }
    assert.equal(new Set(PLAN.map((e) => e.begin)).size, 8);
    assert.equal(new Set(PLAN.map((e) => e.options)).size, 8);
    assert.equal(new Set(PLAN.map((e) => e.mark)).size, 11);
    assert.equal(new Set(PLAN.map((e) => e.trap)).size, 8);
  });

  test("never asks for what cannot be built: a key by letter with no letters, a key by number with no numbers", () => {
    for (const e of PLAN) {
      if (["K8", "K9", "K10", "K11"].includes(e.mark)) assert.ok(!["O6", "O8"].includes(e.options), `${e.name} points at letters that are not there`);
      if (["K9", "K10"].includes(e.mark)) assert.ok(!["B6", "B8"].includes(e.begin), `${e.name} has a key by number and no numbers`);
      if (e.mark === "K11") assert.equal(e.options, "O7", e.name);
      if (e.options === "O7") assert.equal(e.mark, "K11", e.name);
      if (["K8", "K11"].includes(e.mark)) assert.ok(e.word, `${e.name} has no word for its answer`);
      if (e.trap === "T0") assert.equal(e.lapses, 0, e.name);
      else assert.ok(e.lapses >= 2 && e.lapses <= 4, e.name);
      assert.ok(e.questions >= 12 && e.questions <= 30, e.name);
    }
  });

  test("keeps the blind set to pieces one to four", () => {
    assert.deepEqual([...new Set(PLAN.filter((e) => e.piece <= 4).map((e) => e.piece))], [1, 2, 3, 4]);
  });

  test("a piece's text names each file and what it must have, and tells a file with a key by number not to break the numbers", () => {
    const text = pieceText(4);
    for (const e of PLAN.filter((x) => x.piece === 4)) assert.ok(text.includes(`${e.name}.docx`));
    assert.match(text, /Your assignment is piece 4: 4 files/);
    const keyed = assignmentFor(PLAN.find((e) => e.mark === "K9")!);
    assert.match(keyed, /do not skip or repeat a question number/);
    assert.doesNotMatch(assignmentFor(PLAN.find((e) => e.name === "c-02")!), /do not skip or repeat/);
    assert.match(assignmentFor(PLAN.find((e) => e.name === "c-06")!), /'ANS: C'/);
    // The hard cases that are about marks say what they mean for the way this file marks.
    assert.match(assignmentFor(PLAN.find((e) => e.name === "c-07")!), /two letters for it in the key/, "T7 in a table key");
    assert.match(assignmentFor(PLAN.find((e) => e.name === "c-13")!), /leaving the question out of the key/, "T6 in a list key");
    assert.match(assignmentFor(PLAN.find((e) => e.name === "c-04")!), /no answer marked at all: leave the mark off it\. In the expected file it has "verdict": "failed" and no "correct"\.\n/, "T6 with a highlight says nothing more");
    assert.match(assignmentFor(PLAN.find((e) => e.name === "c-06")!), /second paragraph carries no number and no label/, "T4");
    assert.match(assignmentFor(PLAN.find((e) => e.name === "c-18")!), /^  Include a question whose stem or an option contains/m, "T3 on a file with an answer at the end of the options");
  });
});
