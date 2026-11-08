/**
 * The names of the files the engine writes from a title: `safeName`, and every place that uses it.
 *
 * The app refuses a name it did not make (`checkName` in `packages/app/src/library.ts`): one that is not its own trim, that ends in a
 * dot or a space or begins with a dot, that has a character a file cannot, that is over 80 units, or that is a device's name. A
 * title such as ". Intro to Psych" or "Aux. Verbs" made the engine write a name the app then refused, in four places (the printed
 * test, the test paper, the results and the scores file), and a scores file it saved could not be opened again. So the rules of the app
 * are copied here, and every name the engine makes from thousands of nasty titles is held to them.
 *
 * Characters outside plain text are written as code point escapes (`\u{200b}`), so that a zero-width space, a combining mark or a
 * line separator can be seen for what it is in this file.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportGift } from "../src/export/gift.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportOpenStageSpreadsheet } from "../src/export/openstage-spreadsheet.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import * as names from "../src/export/text.ts";
import { printOptions, printTest } from "../src/print/index.ts";
import { printTestPaper } from "../src/sheets/paper.ts";
import { exportResults } from "../src/sheets/results-export.ts";
import { scoresFileName } from "../src/sheets/scores-file.ts";
import { scoreSheets } from "../src/sheets/score.ts";
import { itemStatistics } from "../src/sheets/stats.ts";
import { inEngine, seeded, why } from "./support/bank-hostile.ts";
import { mcq, testOf } from "./support/sheet-fixtures.ts";

const { safeName } = names;

// ---------------------------------------------------------------------------
// What the app takes, copied from `packages/app/src/library.ts`
// ---------------------------------------------------------------------------

const APP_ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/;
const APP_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const APP_MAX = 80;

/** Why the app's `checkName` would refuse a name, or undefined when it takes it. `long` leaves out the length, for a name the app cuts to fit. */
function appRefuses(name: string, long = false): string | undefined {
  if (name === "") return "empty";
  if (!long && name.length > APP_MAX) return `${name.length} units`;
  if (APP_ILLEGAL.test(name)) return "a character a name cannot have";
  if (name !== name.trim()) return "not its own trim";
  if (/^\.|[. ]$/.test(name)) return "begins with a dot or ends with a dot or a space";
  if (APP_RESERVED.test(name)) return "a device's name";
  return undefined;
}

/**
 * Windows' own rule, written another way from the code: a name is a device when what comes before its first dot, with the spaces at
 * the end of that taken off, is the name of one. It is wider than the app's, which stops at COM1 to COM9 and LPT1 to LPT9.
 */
const DEVICES = new Set(["con", "prn", "aux", "nul", "conin$", "conout$", ...["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u{b9}", "\u{b2}", "\u{b3}"].flatMap((d) => [`com${d}`, `lpt${d}`])]);
const isDevice = (name: string): boolean => DEVICES.has((name.split(".")[0] as string).replace(/ +$/, "").toLowerCase());

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const withoutLone = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
/** A character that is taken out of a title before anything else is done to it (what XML forbids), as a code. */
const goesAtOnce = (code: number): boolean => code <= 8 || (code >= 0x0e && code <= 0x1f) || code === 0x7f || code === 0xfffe || code === 0xffff;
/** A title with nothing in it that is a name: only white space, dots, and what is taken out. */
const blank = (title: string): boolean => [...withoutLone(title)].every((ch) => /\s/.test(ch) || ch === "." || goesAtOnce(ch.codePointAt(0) as number));

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const boundaries = (text: string): Set<number> => {
  const out = new Set([0]);
  let at = 0;
  for (const { segment } of segmenter.segment(text)) out.add((at += segment.length));
  return out;
};

const EMOJI = "\u{1f600}";
const FLAG = "\u{1f1fa}\u{1f1f8}";
const FAMILY = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
const THUMB = "\u{1f44d}\u{1f3fd}";
const KEYCAP = "1\u{fe0f}\u{20e3}";
const STACK = "e\u{301}\u{302}\u{303}";

// ---------------------------------------------------------------------------
// A table of titles
// ---------------------------------------------------------------------------

describe("the name made from a title", () => {
  const table: Array<[string, string, string?]> = [
    ["Intro to Psych", "Intro to Psych"],
    ["  Intro   to\u{a0}\u{3000}Psych  ", "Intro to Psych", "white space is made one space and trimmed"],
    [". Intro to Psych", "Intro to Psych", "the dots go with the space they left"],
    [".. Chapter 3", "Chapter 3"],
    ["...", "questions", "a name of nothing but dots is no name"],
    [". . .", "questions"],
    ["Chapter 3...", "Chapter 3", "no dot at the end"],
    ["Midterm .", "Midterm"],
    ["Quiz: part 1/2", "Quiz- part 1-2", "what a file cannot hold becomes a dash"],
    ['a<b>c|d?e*f"g\\h', "a-b-c-d-e-f-g-h"],
    ["Aux. Verbs", "Aux_. Verbs", "a device's name followed by a dot is the device"],
    ["Con. Ed. 101", "Con_. Ed. 101"],
    ["aux", "aux_", "and at the end of the name, where an extension is added"],
    ["NUL", "NUL_"],
    ["PRN.", "PRN_"],
    ["Com1", "Com1_"],
    ["COM0. Notes", "COM0_. Notes"],
    ["lpt9", "lpt9_"],
    ["COM\u{b9}", "COM\u{b9}_"],
    ["LPT\u{b3}.pdf", "LPT\u{b3}_.pdf"],
    ["CONIN$", "CONIN$_"],
    ["conout$.x", "conout$_.x"],
    ["Aux .Verbs", "Aux_ .Verbs", "a space before the dot is ignored by Windows"],
    ["Auxiliary verbs", "Auxiliary verbs", "a word that begins with one is not it"],
    ["Aux Verbs", "Aux Verbs"],
    ["Con-Ed", "Con-Ed"],
    ["Icon. 1", "Icon. 1"],
    ["Com10", "Com10"],
    ["Com", "Com"],
    ["Quiz 1. Aux.", "Quiz 1. Aux"],
    [`${EMOJI} Emoji e\u{301} caf\u{e9} \u{7b2c}\u{4e00}\u{7ae0}`, `${EMOJI} Emoji e\u{301} caf\u{e9} \u{7b2c}\u{4e00}\u{7ae0}`, "text a person wrote is kept"],
    ["\u{201c}Quoted\u{201d} \u{2014} and \u{2026} done", "\u{201c}Quoted\u{201d} \u{2014} and \u{2026} done", "typography is kept"],
  ];
  for (const [title, expected, note] of table) {
    test(`${JSON.stringify(title)} is ${JSON.stringify(expected)}${note ? ` (${note})` : ""}`, () => {
      assert.equal(safeName(title), expected);
      assert.equal(appRefuses(expected), undefined, "and the app takes it");
      assert.equal(isDevice(expected), false, "and Windows does not take it for a device");
      assert.equal(safeName(expected), expected, "and a name that is safe is left as it is");
    });
  }

  test("a title of nothing has the name it is given in place of one", () => {
    assert.equal(safeName(undefined), "questions");
    assert.equal(safeName(""), "questions");
    assert.equal(safeName("   "), "questions");
    assert.equal(safeName("..", "Test"), "Test");
    assert.equal(safeName("\x00\x01", "Test"), "Test");
    assert.equal(safeName(". ", ""), "", "the name of a version that has none is none");
  });

  test("is cut at 80, never to end in a dot or a space, and never in the middle of a character", () => {
    assert.equal(safeName("x".repeat(80)).length, 80);
    assert.equal(safeName("x".repeat(81)).length, 80);
    assert.equal(safeName(`${"x".repeat(79)}. y`), "x".repeat(79), "the cut ends in a dot and a space, which are taken off");
    assert.equal(safeName(`${"x".repeat(78)} . y`), "x".repeat(78));
    // A character that straddles the cut at every offset, as far as the cut can fall inside it.
    const units: Array<[string, string]> = [
      ["emoji", EMOJI],
      ["flag", FLAG],
      ["family", FAMILY],
      ["skin tone", THUMB],
      ["keycap", KEYCAP],
      ["accented letter", STACK],
      ["text selector", "\u{2764}\u{fe0e}"],
    ];
    for (const [label, unit] of units) {
      for (let before = 60; before <= 80; before++) {
        const name = safeName(`${"a".repeat(before)}${unit}${"z".repeat(30)}`);
        const rest = name.slice(before);
        assert.ok(rest === "" || rest.startsWith(unit), `${label} after ${before} letters: ${JSON.stringify(rest)}`);
        assert.ok(name.length <= 80, label);
        assert.doesNotThrow(() => encodeURIComponent(name), label);
        if (before + unit.length <= 80) assert.ok(rest.startsWith(unit), `${label} fits after ${before} letters and is kept`);
      }
    }
  });

  test("one character longer than the name is cut between code points and not through a pair", () => {
    const stack = `e${"\u{301}".repeat(200)}`;
    assert.equal(safeName(stack).length, 80);
    const cut = safeName(`a${EMOJI.repeat(100)}`);
    assert.ok(cut.length <= 80 && cut.length >= 79);
    assert.doesNotThrow(() => encodeURIComponent(cut));
    assert.equal(lone.test(cut), false);
  });

  test("does not take time for a long run of dots or spaces in the middle of a title", () => {
    // The pattern that took the dots and spaces off the end started again at every dot of a run: 100,000 took three seconds.
    const run = inEngine<{ ms: number }>(
      `const { safeName } = await engine("export/text.ts");
const started = performance.now();
for (const title of ["x" + ".".repeat(400000) + "x", ". ".repeat(200000) + "x", "a. ".repeat(100000), " ".repeat(300000) + "x" + " .".repeat(100000)]) safeName(title);
report({ ms: performance.now() - started });`,
    );
    assert.ok(run.value !== undefined, `the run did not finish: ${why(run)}`);
    assert.ok(run.value.ms < 1500, `${Math.round(run.value.ms)} ms`);
  });
});

// ---------------------------------------------------------------------------
// Thousands of titles, held to the rules of the app
// ---------------------------------------------------------------------------

describe("whatever the title", () => {
  const pieces = [
    ".", "..", "...", " ", "  ", ". ", " .", "\t", "\n", "\u{a0}", "\u{3000}", "\u{2028}", "\u{feff}",
    "Aux", "aux", "AUX", "Con", "CON", "con", "Prn", "NUL", "nul", "Com1", "COM9", "com0", "Lpt1", "LPT0", "COM\u{b9}", "lpt\u{b2}", "COM\u{b3}", "CONIN$", "CONOUT$", "Com", "Auxiliary", "Icon",
    "a", "Z", "x", "Intro", "Chapter", "3", "Quiz", "\u{e9}", "e\u{301}", "\u{c5}", "\u{7b2c}\u{4e00}\u{7ae0}", "\u{627}\u{644}", "\u{200f}", "\u{200d}", "\u{200b}",
    EMOJI, FAMILY, FLAG, "\u{1f1fa}", KEYCAP, THUMB, "\u{2764}\u{fe0f}", "\u{2764}\u{fe0e}",
    "/", "\\", ":", "*", "?", '"', "<", ">", "|", "\x00", "\x01", "\x1f", "\x7f", "\u{fffe}",
    "\u{2026}", "\u{201c}", "\u{201d}", "\u{2014}", "\u{2013}", "-", "_", "(", ")", "$", "\ud800", "\udc00",
    "x".repeat(10), "y".repeat(40), "ab".repeat(60), ". ".repeat(30),
  ];

  const titles = (seed: number, count: number): string[] => {
    const next = seeded(seed);
    return Array.from({ length: count }, () => {
      let title = "";
      const target = next(4) === 0 ? 55 + next(70) : next(40);
      while (title.length < target || next(3) !== 0) {
        title += pieces[next(pieces.length)] as string;
        if (title.length > 300) break;
      }
      return next(6) === 0 ? `${pieces[next(14)]}${title}` : title;
    });
  };

  test("the name is one the app takes, is not a device, cuts nowhere inside a character, and is left alone when it is run again", () => {
    let fallbacks = 0;
    for (const title of titles(20261108, 6000)) {
      const name = safeName(title, "Test");
      if (name === "Test") {
        fallbacks++;
        assert.ok(blank(title), `a title that is not blank has no name: ${JSON.stringify(title)}`);
        continue;
      }
      assert.equal(appRefuses(name), undefined, `${JSON.stringify(title)} -> ${JSON.stringify(name)}: ${appRefuses(name)}`);
      assert.equal(isDevice(name), false, `${JSON.stringify(title)} -> ${JSON.stringify(name)} is a device`);
      assert.equal(lone.test(name), false, `a lone half of a character in ${JSON.stringify(name)}`);
      assert.doesNotThrow(() => encodeURIComponent(name), JSON.stringify(name));
      assert.equal(safeName(name, "Test"), name, `a second pass changed ${JSON.stringify(name)}`);
      // The names the engine builds around it are the app's to cut to fit, and are safe in every other way.
      for (const whole of [`${name}.txt`, `${name} - Student copy.docx`, `${name} - Scores 2026-11-08.openassess-scores`, `${name} - Answer sheet - Version B.pdf`, `${name}-1.csv`]) {
        assert.equal(appRefuses(whole, true), undefined, `${JSON.stringify(title)} -> ${JSON.stringify(whole)}: ${appRefuses(whole, true)}`);
        assert.equal(isDevice(whole), false, `${JSON.stringify(whole)} is a device`);
      }
    }
    assert.ok(fallbacks > 0 && fallbacks < 1500, `${fallbacks} of 6000 had no name: the pieces must not make most of them blank`);
  });

  test("a title with no dots, spaces, devices, or forbidden characters is cut where a person would cut it, as far as 80 allows", () => {
    const clean = ["a", "Z", "x", "\u{e9}", "e\u{301}", "\u{c5}", "\u{7b2c}", EMOJI, FAMILY, FLAG, KEYCAP, THUMB, "\u{2764}\u{fe0e}", "\u{ac01}", "\u{1100}\u{1161}\u{11a8}", `a${"\u{301}".repeat(6)}`, "\u{2026}", "-"];
    const next = seeded(4242);
    let cutOnes = 0;
    for (let run = 0; run < 4000; run++) {
      let title = "";
      const target = 1 + next(130);
      while (title.length < target) title += clean[next(clean.length)] as string;
      const name = safeName(title);
      assert.ok(title.startsWith(name), `${JSON.stringify(name)} is not the start of ${JSON.stringify(title)}`);
      const cuts = boundaries(title);
      if (title.length <= 80) {
        assert.equal(name, title, "a title that fits is kept whole");
        continue;
      }
      cutOnes++;
      // The cut is at a place between characters, and is the last such place that fits (unless one character alone is longer than 80).
      const after = [...cuts].filter((b) => b > name.length).sort((a, b) => a - b)[0] as number;
      if (cuts.has(name.length)) assert.ok(after > 80, `${JSON.stringify(name)} could have kept more of ${JSON.stringify(title)}`);
      else assert.ok(name.length >= 79 && name.length <= 80, "only a character longer than the name is cut inside itself");
      assert.equal(lone.test(name), false);
    }
    assert.ok(cutOnes > 1500, `${cutOnes} of the titles were long enough to be cut`);
  });

  test("keeps all the words of a title that needs no change, and a device's name is kept with an underscore after it", () => {
    const next = seeded(77);
    const words = ["Intro", "to", "Psych", "Chapter", "3", "Quiz", "caf\u{e9}", "\u{2014}", "Part", "II", "Aux", "Con", "Nul"];
    for (let run = 0; run < 2000; run++) {
      const title = Array.from({ length: 1 + next(8) }, () => words[next(words.length)]).join(next(2) === 0 ? " " : ". ");
      const first = title.split(/[. ]/)[0] as string;
      const device = ["Aux", "Con", "Nul"].includes(first) && (title === first || title.startsWith(`${first}.`));
      assert.equal(safeName(title), device ? `${first}_${title.slice(first.length)}` : title, JSON.stringify(title));
    }
  });
});

// ---------------------------------------------------------------------------
// Every place a name is made from a title
// ---------------------------------------------------------------------------

describe("every file the engine names from a title", () => {
  const titles = [". Intro to Psych", ".. Chapter 3", "Aux. Verbs", "Con. Ed. 101", "COM1", "nul.", "Midterm", `${"x".repeat(80)}. y`, `${"a".repeat(79)}${EMOJI} tail`, "Quiz: 1/2 *final*", `${FLAG} `.repeat(40)];
  const question = mcq(3);
  const at = new Date("2026-01-01T00:00:00.000Z");

  test("a printed test", () => {
    for (const title of titles) {
      for (const format of ["docx", "pdf"] as const) {
        const result = printTest([question], printOptions({ title, kind: "student" }), format);
        assert.equal(appRefuses(result.file.name, true), undefined, `${JSON.stringify(title)}: ${result.file.name}`);
        assert.equal(isDevice(result.file.name), false, result.file.name);
        assert.deepEqual(result.report.files, [result.file.name]);
      }
    }
    assert.equal(printTest([question], printOptions({ title: ". Intro to Psych", kind: "student" }), "docx").file.name, "Intro to Psych - Student copy.docx");
    assert.equal(printTest([question], printOptions({ title: "Aux. Verbs", kind: "key" }), "pdf").file.name, "Aux_. Verbs - Answer key.pdf");
  });

  test("the paper for a test, with its answer sheets", () => {
    for (const title of titles) {
      const record = testOf([mcq(4), mcq(4)], { versions: 2, name: title });
      const made = printTestPaper(record, { sheet: "each" }, at);
      assert.ok(made.ok, JSON.stringify(title));
      for (const file of made.files) {
        assert.equal(appRefuses(file.name, true), undefined, `${JSON.stringify(title)}: ${file.name}`);
        assert.equal(isDevice(file.name), false, file.name);
      }
    }
    const made = printTestPaper(testOf([mcq(4)], { versions: 1, name: ". Intro" }), {}, at);
    assert.ok(made.ok);
    assert.deepEqual(made.files.map((f) => f.name), ["Intro - Answer sheet.pdf", "Intro - Student copy.pdf", "Intro - Answer key.pdf"]);
  });

  test("a scores file", () => {
    for (const title of titles) {
      const name = scoresFileName(title, "2026-11-08");
      assert.equal(appRefuses(name, true), undefined, `${JSON.stringify(title)}: ${name}`);
      assert.ok(name.endsWith(" - Scores 2026-11-08.openassess-scores"), name);
    }
    assert.equal(scoresFileName(". Intro to Psych", "2026-11-08"), "Intro to Psych - Scores 2026-11-08.openassess-scores");
    assert.equal(scoresFileName("Aux. Verbs", "2026-11-08"), "Aux_. Verbs - Scores 2026-11-08.openassess-scores");
  });

  test("the results of a class", () => {
    for (const title of titles) {
      const record = testOf([mcq(4), mcq(4)], { versions: 1, name: title });
      const out = exportResults(record, [], [], itemStatistics(record, scoreSheets(record, [])), "2026-11-08");
      assert.equal(appRefuses(`${out.base}.xlsx`, true), undefined, `${JSON.stringify(title)}: ${out.base}`);
      assert.equal(appRefuses(`${out.base}.csv`, true), undefined);
    }
    const record = testOf([mcq(4)], { versions: 1, name: ".. Chapter 3" });
    assert.equal(exportResults(record, [], [], itemStatistics(record, scoreSheets(record, [])), "2026-11-08").base, "Chapter 3 - Scores 2026-11-08");
  });

  test("every export", () => {
    const exporters = [exportGift, exportMoodleXml, exportD2lCsv, exportBlackboardUpload, exportQti12, exportQti21, exportCommonCartridge, exportOpenStageSpreadsheet] as const;
    for (const title of titles) {
      for (const exporter of exporters) {
        const result = (exporter as (q: unknown[], o: { name: string }) => { files: Array<{ name: string }> })([question], { name: title });
        assert.ok(result.files.length > 0);
        for (const file of result.files) {
          assert.equal(appRefuses(file.name, true), undefined, `${JSON.stringify(title)}: ${file.name}`);
          assert.equal(isDevice(file.name), false, file.name);
        }
      }
    }
    assert.deepEqual(exportGift([question], { name: "Aux. Verbs" }).files.map((f) => f.name), ["Aux_. Verbs.txt"]);
    assert.deepEqual(exportGift([question], { name: ". Intro" }).files.map((f) => f.name), ["Intro.txt"]);
    assert.deepEqual(exportGift([question], { name: "Con" }).files.map((f) => f.name), ["Con_.txt"], "the extension is what makes Con a device");
  });

  test("the cut is the one the engine gives the app", () => {
    assert.equal(names.FILE_NAME_MAX, 80);
    assert.equal(names.cutToLength("abcdef", 3), "abc");
    assert.equal(names.cutToLength("abc", 3), "abc");
    assert.equal(names.cutToLength(`ab${EMOJI}`, 3), "ab", "half of a pair is not kept");
    assert.equal(names.cutToLength(`${EMOJI}${EMOJI}`, 1), "", "a character that does not fit alone gives nothing, and never half");
  });
});
