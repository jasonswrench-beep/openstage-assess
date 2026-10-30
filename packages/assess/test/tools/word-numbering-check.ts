/**
 * Checks the list numbering reader against Word itself.
 *
 * The reader works out the number or letter that a Word list puts in front of a
 * paragraph. That number is not in the file, and a wrong one points an answer key
 * at the wrong question without a word, so "the tests pass" is not enough: the tests
 * only show the reader agrees with the rules as understood. This builds documents
 * (the text fixtures numbered by Word's lists in every form the writer has, and a
 * set of hand-built cases, many of them written to answer a question about what Word
 * does), asks Word for the label it shows on every paragraph, and compares.
 *
 * Several rules in src/import/docx/numbering.ts were found this way, because Word
 * disagreed with the first reading of the specification: which style holds a list
 * level, that a skipped level counts as used, that legal style turns the level's own
 * number into digits, that a list that links to a numbering style counts on its own,
 * and that Word shows nothing for a level whose restart is not above it. The cases
 * that hold those answers are here so that they can be asked again.
 *
 * It needs Windows with Microsoft Word installed, and it is not part of `npm test`.
 * Run it with `npm run check:word -w packages/assess`. It starts a separate, hidden
 * Word, opens each document read-only, and closes only the Word it started.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { docxToBlocks } from "../../src/import/word.ts";
import { askWord, wordIsAvailable } from "./ask-word.ts";
import {
  abstractNum,
  docx,
  docxFromLines,
  level,
  listProperties,
  num,
  numberingPart,
  numberLines,
  paragraph,
  run,
  style,
  type NumberingOptions,
} from "../support/docx-writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "fixtures", "standard-format");

interface Case {
  name: string;
  bytes: Uint8Array;
  /** The label the writer meant each paragraph to show, for the fixture documents. */
  meant?: string[];
  /** The reader gives no label on purpose, so Word showing one is not a disagreement. */
  mayAbstain?: boolean;
}

const cases: Case[] = [];
const add = (name: string, bytes: Uint8Array, extra: Partial<Case> = {}): void => void cases.push({ name, bytes, ...extra });

// ---------------------------------------------------------------------------
// The text fixtures, numbered by Word in each form
// ---------------------------------------------------------------------------

const forms: Array<[string, NumberingOptions]> = [
  ["lists", { mode: "lists" }],
  ["split", { mode: "lists", split: true }],
  ["options", { mode: "lists", optionsOnly: true }],
  ["multilevel", { mode: "multilevel" }],
  ["style", { mode: "style" }],
];
for (const file of readdirSync(FIXTURES).filter((n) => n.endsWith(".txt"))) {
  const lines = readFileSync(join(FIXTURES, file), "utf8").replace(/\r\n?/g, "\n").split("\n");
  for (const [tag, numbering] of forms) {
    add(`fixture-${file.slice(0, 2)}-${tag}`, docxFromLines(lines, { numbering }), { meant: numberLines(lines, numbering).labels });
  }
}

// ---------------------------------------------------------------------------
// Hand-built cases
// ---------------------------------------------------------------------------

interface Where {
  numId?: number;
  level?: number;
  style?: string;
}
const P = (text: string, where: Where = {}): string => paragraph(run(text), listProperties(where));
const L = (numId: number, at: number): string => P("x", { numId, level: at });
const many = (numId: number, at: number, count: number): string => Array.from({ length: count }, () => L(numId, at)).join("");
const NORMAL = style({ id: "Normal", isDefault: true });
const S = (id: string, numId?: number, at?: number): string =>
  style({ id, basedOn: "Normal", ...(numId !== undefined ? { numId } : {}), ...(at !== undefined ? { level: at } : {}) });

// number formats
for (const [format, count, text] of [
  ["decimal", 12, "%1."],
  ["decimalZero", 12, "%1."],
  ["lowerLetter", 55, "%1."],
  ["upperLetter", 55, "%1)"],
  ["lowerRoman", 45, "%1."],
  ["upperRoman", 45, "(%1)"],
  ["ordinal", 25, "%1"],
] as const) {
  add(`format-${format}`, docx({ body: many(1, 0, count), numbering: numberingPart([abstractNum(1, [level(0, { format, text })])], [num(1, 1)]) }));
}
add("start-5", docx({ body: many(1, 0, 3), numbering: numberingPart([abstractNum(1, [level(0, { start: 5 })])], [num(1, 1)]) }));
add("start-absent-counts-from-zero", docx({
  body: many(1, 0, 3),
  numbering: `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>${num(1, 1)}`,
}));
add("none-format", docx({ body: many(1, 0, 2), numbering: numberingPart([abstractNum(1, [level(0, { format: "none", text: "Question" })])], [num(1, 1)]) }));
add("format-word-knows-and-the-reader-does-not", docx({ body: many(1, 0, 3), numbering: numberingPart([abstractNum(1, [level(0, { format: "cardinalText" })])], [num(1, 1)]) }), { mayAbstain: true });

// levels, restarts and legal style
const outline = (extra: Array<Parameters<typeof level>[1]> = []) =>
  numberingPart([abstractNum(1, [level(0), level(1, { text: "%1.%2", ...extra[0] }), level(2, { text: "%1.%2.%3", ...extra[1] })])], [num(1, 1)]);
const sequence = [0, 1, 2, 2, 1, 2, 0, 1, 2, 2, 0];
add("outline", docx({ body: sequence.map((at) => L(1, at)).join(""), numbering: outline() }));
for (const restart of [0, 1, 2, 3]) {
  const numbering = numberingPart([abstractNum(1, [level(0), level(1, { text: "%2." }), level(2, { text: "%3.", restart })])], [num(1, 1)]);
  add(`restart-${restart}-on-the-third-level`, docx({ body: sequence.map((at) => L(1, at)).join(""), numbering }));
}
for (const restart of [0, 1, 2]) {
  const numbering = numberingPart([abstractNum(1, [level(0), level(1, { text: "%2.", restart })])], [num(1, 1)]);
  add(`restart-${restart}-on-the-second-level`, docx({ body: [0, 1, 1, 0, 1].map((at) => L(1, at)).join(""), numbering }));
}
for (const legal of [false, true]) {
  const numbering = numberingPart(
    [abstractNum(1, [level(0, { format: "upperRoman" }), level(1, { text: "%1.%2", legal }), level(2, { format: "lowerLetter", text: "%1.%2.%3", legal })])],
    [num(1, 1)],
  );
  add(`legal-${legal}`, docx({ body: sequence.map((at) => L(1, at)).join(""), numbering }));
}
add("level-used-before-the-levels-above", docx({ body: L(1, 1) + L(1, 1) + L(1, 0) + L(1, 2) + L(1, 1), numbering: outline() }));
add("paragraphs-between-items", docx({ body: L(1, 0) + P("plain") + P("plain") + L(1, 0) + P("plain") + L(1, 0), numbering: numberingPart([abstractNum(1, [level(0)])], [num(1, 1)]) }));

// instances of one list, and overrides
const instances = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)" })])], [
  num(1, 1),
  num(2, 1),
  num(3, 1, [{ level: 0, start: 1 }]),
  num(4, 1, [{ level: 0, start: 10 }]),
  num(5, 1, [{ level: 1, start: 5 }]),
  num(6, 1, [{ level: 0, start: 7 }, { level: 1, start: 3 }]),
]);
add("instances-carry-on-and-restart", docx({ body: [1, 1, 2, 2, 3, 3, 1, 4, 4].map((n) => L(n, 0)).join(""), numbering: instances }));
add("override-on-a-level-first-met-further-up", docx({ body: L(1, 0) + L(5, 0) + L(5, 1) + L(5, 1) + L(1, 0) + L(1, 1) + L(5, 1), numbering: instances }));
add("two-overrides-in-one-instance", docx({ body: L(1, 0) + L(1, 1) + L(6, 0) + L(6, 1) + L(6, 1) + L(1, 0) + L(1, 1), numbering: instances }));
add("back-to-an-instance-already-used", docx({ body: L(1, 0) + L(1, 0) + L(3, 0) + L(1, 0) + L(3, 0), numbering: instances }));
add("sublevels-over-instances", docx({ body: L(1, 0) + L(1, 1) + L(1, 1) + L(2, 0) + L(2, 1) + L(3, 0) + L(3, 1), numbering: instances }));
add("level-replaced-by-an-override", docx({
  body: L(1, 0) + L(2, 0) + L(2, 0) + L(1, 0),
  numbering: numberingPart([abstractNum(1, [level(0)])], [num(1, 1), num(2, 1, [{ level: 0, start: 1, replacement: level(0, { format: "upperLetter", text: "%1." }) }])]),
}));
add("a-list-that-links-to-a-numbering-style", docx({
  body: L(1, 0) + L(2, 0) + L(1, 0) + L(2, 0),
  numbering: numberingPart([abstractNum(1, [level(0)], '<w:styleLink w:val="Outline"/>'), abstractNum(2, [], '<w:numStyleLink w:val="Outline"/>')], [num(1, 1), num(2, 2)]),
  styles: style({ id: "Outline", type: "numbering", numId: 1 }),
}));

// paragraph styles
const two = (tiedZero?: string, tiedOne?: string) =>
  numberingPart(
    [abstractNum(1, [level(0, tiedZero ? { style: tiedZero } : {}), level(1, { format: "lowerLetter", text: "%2)", ...(tiedOne ? { style: tiedOne } : {}) })])],
    [num(1, 1)],
  );
const seq = (...ids: string[]): string => ids.map((id, i) => P(String(i + 1), { style: id })).join("");
const styled = (name: string, body: string, numbering: string, styles: string): void => add(name, docx({ body, numbering, styles }));

styled("style-untied-id-only-and-level-one", seq("S0", "S1", "S1", "S0", "S1"), two(), NORMAL + S("S0", 1) + S("S1", 1, 1));
styled("style-tied-the-way-word-writes-it", seq("S0", "S1", "S1", "S0", "S1"), two("S0", "S1"), NORMAL + S("S0", 1) + S("S1", 1, 1));
styled("style-names-only-the-list-for-a-level-another-holds", seq("S0", "S1", "S1", "S0", "S1"), two("S0", "S1"), NORMAL + S("S0", 1) + S("S1", 1));
styled("style-level-one-untied", seq("S0", "S1", "S1", "S0", "S1"), two("S0"), NORMAL + S("S0", 1) + S("S1", 1, 1));
styled("style-dropped-then-a-level-on-the-paragraph", [P("1", { style: "S0" }), P("2", { style: "S1", level: 1 }), P("3", { style: "S1", level: 1 })].join(""), two("S0", "S1"), NORMAL + S("S0", 1) + S("S1", 1));
styled("paragraph-names-the-list-itself", [P("1", { numId: 1, level: 0 }), P("2", { numId: 1, level: 1 }), P("3", { numId: 1, level: 1 })].join(""), two("S0", "S1"), NORMAL + S("S0", 1) + S("S1", 1, 1));
styled(
  "paragraph-names-the-list-over-another-style",
  [P("1", { style: "S0" }), P("2", { style: "Plain", numId: 1, level: 1 }), P("3", { style: "S1", numId: 1, level: 0 })].join(""),
  two("S0", "S1"),
  NORMAL + S("S0", 1) + S("S1", 1, 1) + S("Plain"),
);
styled("two-untied-styles-ask-for-the-same-level", seq("S0", "S1", "S1", "S0"), two(), NORMAL + S("S1", 1) + S("S0", 1));
styled("two-untied-styles-ask-for-level-one-first-declared", seq("S1", "S2", "S2", "S1"), two(), NORMAL + S("S1", 1, 1) + S("S2", 1, 1));
styled("two-untied-styles-ask-for-level-one-second-declared", seq("S1", "S2", "S2", "S1"), two(), NORMAL + S("S2", 1, 1) + S("S1", 1, 1));
styled("styles-over-two-instances-of-one-list", seq("S0", "S3", "S0", "S3"), numberingPart([abstractNum(1, [level(0), level(1)])], [num(1, 1), num(2, 1)]), NORMAL + S("S0", 1) + S("S3", 2));
styled("style-tied-to-a-level-it-does-not-name-q-first", seq("Q", "S1", "S1", "Q"), two(undefined, "S1"), NORMAL + S("Q", 1) + S("S1", 1));
styled("style-tied-to-a-level-it-does-not-name-s1-first", seq("S1", "Q", "Q", "S1"), two(undefined, "S1"), NORMAL + S("S1", 1) + S("Q", 1));
styled("style-tied-to-level-one-and-names-only-the-list", seq("S1", "S1", "S1"), two(undefined, "S1"), NORMAL + S("S1", 1));
styled("a-style-based-on-a-numbered-style", [P("1", { style: "S0" }), P("2", { style: "S1" }), P("3", { style: "S1b" }), P("4", { style: "S1b" })].join(""), two("S0", "S1"), NORMAL + S("S0", 1) + S("S1", 1, 1) + style({ id: "S1b", basedOn: "S1" }));
styled("a-style-that-repeats-its-base", seq("S0", "S0b", "S0"), two(), NORMAL + S("S0", 1) + style({ id: "S0b", basedOn: "S0", numId: 1 }));
styled("style-with-a-level-and-the-paragraph-names-only-the-level", [P("1", { style: "A" }), P("2", { style: "A", level: 1 }), P("3", { style: "A", level: 1 }), P("4", { style: "A" })].join(""), two(), NORMAL + S("A", 1));
styled("style-with-a-level-and-the-paragraph-names-only-the-list", [P("1", { style: "B", numId: 1 }), P("2", { style: "B", numId: 1 })].join(""), two(), NORMAL + S("B", 1, 1));
styled(
  "style-with-a-level-and-the-paragraph-names-another-list",
  [P("1", { style: "B", numId: 2 }), P("2", { style: "B", numId: 2 }), P("3", { style: "B" })].join(""),
  numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)" })]), abstractNum(2, [level(0, { format: "upperRoman" }), level(1, { format: "upperLetter", text: "%2." })])], [num(1, 1), num(2, 2)]),
  NORMAL + S("B", 1, 1),
);
styled("default-style-is-numbered", [P("1"), P("2"), P("3", { numId: 0 })].join(""), two(), style({ id: "Normal", isDefault: true, numId: 1 }));
styled("style-says-no-list", [P("1", { style: "C" }), P("2", { style: "C", numId: 1 })].join(""), two(), NORMAL + S("C", 0));

// ---------------------------------------------------------------------------
// Asking Word
// ---------------------------------------------------------------------------

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const word = askWord(new Map(cases.map((c) => [c.name, c.bytes])), "labels");

  let paragraphs = 0;
  let disagreements = 0;
  const abstained: string[] = [];
  for (const c of cases) {
    const theirs = word[c.name] ?? [];
    if (theirs[0]?.startsWith("ERROR")) {
      console.log(`${c.name}: Word could not open it. ${theirs[0]}`);
      disagreements++;
      continue;
    }
    const ours = docxToBlocks(c.bytes).blocks.map((b) => b.listLabel ?? "");
    if (ours.length !== theirs.length) {
      console.log(`${c.name}: Word reads ${theirs.length} paragraphs, the reader ${ours.length}`);
      disagreements++;
      continue;
    }
    for (let i = 0; i < ours.length; i++) {
      paragraphs++;
      if (c.mayAbstain && ours[i] === "" && theirs[i] !== "") {
        abstained.push(`${c.name}[${i}] Word shows "${theirs[i]}"`);
      } else if (ours[i] !== theirs[i]) {
        console.log(`${c.name}[${i}]: the reader says "${ours[i]}", Word says "${theirs[i]}"`);
        disagreements++;
      } else if (c.meant && c.meant[i] && c.meant[i] !== theirs[i]) {
        console.log(`${c.name}[${i}]: Word says "${theirs[i]}", the writer meant "${c.meant[i]}"`);
        disagreements++;
      }
    }
  }
  console.log(`${cases.length} documents, ${paragraphs} paragraphs, ${disagreements} disagreements with Word.`);
  if (abstained.length > 0) console.log(`Left unnumbered on purpose, where Word shows a number: ${abstained.length} (${abstained.slice(0, 3).join("; ")}...)`);
  if (disagreements > 0) process.exitCode = 1;
}

main();
