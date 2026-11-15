/**
 * Setting the fill lines from a real-sheet corpus: the answer list volunteers write, the halves, the lines proposed from one half and
 * judged on the other, and the rule that a line set which reads an answer wrong, or a marked answer as blank, is never proposed.
 *
 * The pages are one drawn sheet, read once, with the fills of its bubbles set by hand. That stands in for what pencil on a real scanner
 * might measure (a light #2 pencil at 0.35, say), which is the case the provisional lines were not chosen on.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { calibrate, formatCalibration, halvesOf, LEAST_TO_TUNE, listTemplate, readList, type CorpusPage, type Expected } from "../src/sheets/calibrate.ts";
import { BLANK, BLANK_MULTIPLE, FILLED, LINES } from "../src/sheets/decide.ts";
import { writePng } from "../src/sheets/image.ts";
import { SheetReader, type SheetReading } from "../src/sheets/read.ts";
import { drawn, mcq, mrq, solid, testOf } from "./support/sheet-fixtures.ts";

const record = testOf([...Array.from({ length: 18 }, () => mcq(4)), mrq(5), mrq(5)]);
const reader = new SheetReader(record);
const base = reader.read(drawn(record).render()) as SheetReading;

/** A page whose bubbles read as given: `marks[q]` is the places marked, at the fill `ink`; every other bubble reads `paper`. */
function page(n: number, marks: Record<number, Expected>, ink: number, paper: number, more: Partial<CorpusPage> = {}, fill?: (q: number, place: number) => number | undefined): CorpusPage {
  assert.ok(base.ok);
  const fills: Record<number, number[]> = {};
  for (const [q, row] of Object.entries(base.fills)) {
    const e = marks[Number(q)];
    fills[Number(q)] = row.map((_f, place) => fill?.(Number(q), place) ?? (Array.isArray(e) && e.includes(place) ? ink : paper));
  }
  return { where: `page-${n}.png p1`, sheet: `sheet ${n}`, source: "scan", condition: "copier 300 grey, light pencil", answers: new Map(Object.entries(marks).map(([q, e]) => [Number(q), e])), reading: { ...base, fills }, ...more };
}

/** Twenty questions: the first eighteen take one answer and the last two several. */
const answersFor = (n: number): Record<number, Expected> => {
  const out: Record<number, Expected> = {};
  for (let q = 1; q <= 18; q++) out[q] = q % 9 === 0 ? [] : [(q + n) % 4];
  out[19] = [0, 2];
  out[20] = [1 + (n % 3)];
  return out;
};

describe("the answer list", () => {
  test("reads letters, a blank and an unclear mark, and the columns that say how the page was made", () => {
    const { rows, problems } = readList([
      ["file", "page", "sheet", "source", "condition", "version", "1", "2", "3", "4"],
      ["a.pdf", "2", "Ana", "Photo", "iPhone, office light", "b", "c", "", "a, c", "?"],
    ]);
    assert.deepEqual(problems, []);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.deepEqual([r.file, r.page, r.sheet, r.source, r.condition, r.version], ["a.pdf", 2, "Ana", "photo", "iPhone, office light", 2]);
    assert.deepEqual([...r.answers], [[1, [2]], [2, []], [3, [0, 2]], [4, "unclear"]]);
  });

  test("refuses a row it cannot read and says which, rather than guess at what the volunteer meant", () => {
    const { rows, problems } = readList([
      ["file", "source", "1", "2"],
      ["a.png", "scan", "B", "B?"],
      ["b.png", "copier", "B", "C"],
      ["c.png", "scan", "B", "C"],
    ]);
    assert.deepEqual(rows.map((r) => r.file), ["c.png"]);
    assert.match(problems.find((p) => p.line === 2)?.message ?? "", /Question 2 says "B\?"/);
    assert.match(problems.find((p) => p.line === 3)?.message ?? "", /neither scan nor photo/);
    assert.equal(rows[0]?.sheet, "c.png 1", "a row with no sheet named is a sheet of its own");
  });

  test("refuses a list with no file or source column, or no question", () => {
    assert.equal(readList([["picture", "source", "1"]]).problems[0]?.message.includes("no file column"), true);
    assert.equal(readList([["file", "1"]]).problems.some((p) => /no source column/.test(p.message)), true);
    assert.equal(readList([["file", "source", "notes"]]).problems.some((p) => /names no question/.test(p.message)), true);
    assert.equal(readList([]).problems.length, 1);
  });

  test("the template names every question of the test and reads back as a list", () => {
    const text = listTemplate(20);
    const cells = text.trim().split("\n").map((l) => l.split(","));
    assert.equal(cells[0]?.at(-1), "20");
    const { problems } = readList(cells);
    assert.deepEqual(problems, []);
  });
});

describe("the halves", () => {
  test("every condition is dealt into both halves, and the pages of one sheet stay together", () => {
    const p = (sheet: string, condition: string): CorpusPage => ({ ...page(0, {}, 0.8, 0), sheet, condition });
    const pages = [p("s1", "copier"), p("s1", "copier"), p("s2", "copier"), p("s3", "phone"), p("s4", "phone"), p("s5", "copier")];
    assert.deepEqual(halvesOf(pages), [true, true, false, true, false, true]);
  });
});

describe("calibrating", () => {
  test("light pencil that the lines in use flag is read once the line for a mark comes down, and the second half bears it out", () => {
    // Light marks at 0.33 to 0.40, clean paper at 0.01 to 0.03: every marked answer is flagged as faint under the lines in use.
    const pages = Array.from({ length: 24 }, (_x, n) => page(n, answersFor(n), 0.33 + (n % 8) * 0.01, 0.01 + (n % 3) * 0.01));
    const r = calibrate(pages, reader);
    assert.equal(r.now.tune.wrong + r.now.report.wrong, 0);
    assert.ok(r.now.tune.answersFlagged >= LEAST_TO_TUNE, `the lines in use flag the light marks (${r.now.tune.answersFlagged})`);
    assert.equal(r.noProposal, undefined, r.noProposal);
    const l = r.proposed!.lines;
    assert.ok(l.filled <= 0.33 && l.filled > 0.03, `filled ${l.filled}`);
    assert.ok(l.blank >= 0.03 && l.blank < l.filled && l.blankMultiple <= l.blank, JSON.stringify(l));
    assert.equal(r.proposed!.report.answersFlagged, 0, "the second half, which the lines were not fitted to, reads too");
    assert.equal(r.proposed!.report.wrong, 0);
    assert.equal(r.proposed!.report.missed, 0);
    assert.ok(r.targets.some((t) => /The lines in use, scans: 100\.0 percent .* not met/.test(t)), r.targets.join("\n"));
    assert.ok(r.targets.some((t) => /The proposed lines, scans: 0\.0 percent .* met/.test(t)), r.targets.join("\n"));
    assert.match(formatCalibration(r), /A person writes them into packages\/assess\/src\/sheets\/decide\.ts/);
  });

  test("never changes the lines a reading uses", () => {
    calibrate(Array.from({ length: 24 }, (_x, n) => page(n, answersFor(n), 0.35, 0.02)), reader);
    assert.deepEqual(LINES, { filled: FILLED, blank: BLANK, blankMultiple: BLANK_MULTIPLE });
    assert.deepEqual([FILLED, BLANK, BLANK_MULTIPLE], [0.5, 0.1, 0.06]);
    assert.ok(Object.isFrozen(LINES));
  });

  test("proposes no lines that would read an answer wrong or as blank: a smudge darker than a light mark keeps the line above the smudge", () => {
    // Each page has a light mark at 0.30 on question 1, and a smudge at 0.32 on question 9, which the volunteer left blank. Any line
    // that reads the mark reads the smudge as an answer the volunteer never gave, so the line stays above both and both are flagged.
    const pages = Array.from({ length: 24 }, (_x, n) =>
      page(n, answersFor(n), 0.8, 0.02, {}, (q, place) => {
        if (q === 1 && place === (answersFor(n)[1] as number[])[0]) return 0.3;
        if (q === 9 && place === 1) return 0.32;
        return undefined;
      }),
    );
    const r = calibrate(pages, reader);
    assert.equal(r.noProposal, undefined, r.noProposal);
    const l = r.proposed!.lines;
    assert.ok(l.filled > 0.32, `the line for a mark stays above the smudge (${l.filled})`);
    assert.ok(l.blank < 0.3, "and the line for clean paper below the light mark, so both are flagged and neither is taken for paper");
    assert.ok(r.proposed!.tune.answersFlagged >= 12 && r.proposed!.tune.blanksFlagged >= 12);
    assert.equal(r.proposed!.tune.wrong, 0);
    assert.equal(r.proposed!.tune.missed, 0);
  });

  test("a mark meant to be unclear must be flagged: reading it as an answer is wrong", () => {
    const pages = Array.from({ length: 24 }, (_x, n) => page(n, { ...answersFor(n), 5: "unclear" }, 0.8, 0.02, {}, (q, place) => (q === 5 && place === 1 ? 0.8 : undefined)));
    const r = calibrate(pages, reader);
    assert.ok(r.now.tune.wrong > 0, "an erasure that reads as solid is an answer read wrong");
    assert.ok(r.now.report.cases.some((c) => /question 5 read as B, the volunteer's was an unclear mark/.test(c)));
    assert.match(r.noProposal ?? "", /No lines in the range tried/);
    assert.ok(r.targets.some((t) => /read wrong without a flag: the gate fails/.test(t)));
  });

  test("says when the corpus is too small to move a line", () => {
    const r = calibrate([page(0, answersFor(0), 0.35, 0.02), page(1, answersFor(1), 0.35, 0.02)], reader);
    assert.equal(r.proposed, undefined);
    assert.match(r.noProposal ?? "", /at least 200 are needed/);
  });

  test("reports by condition: the fill of the marked bubbles and the empty ones, and refused pages against the target", () => {
    const refused: CorpusPage = { ...page(99, {}, 0.8, 0), reading: { ok: false, cause: "quality", reason: "blurred" }, condition: "feeder 200 bw" };
    const r = calibrate([page(0, answersFor(0), 0.7, 0.02), page(1, answersFor(1), 0.7, 0.02), refused, { ...page(2, answersFor(2), 0.6, 0.04), source: "photo", condition: "iPhone" }], reader);
    const copier = r.conditions.find((c) => c.condition === "copier 300 grey, light pencil")!;
    assert.equal(copier.marked.least, 0.7);
    assert.equal(copier.empty.most, 0.02);
    assert.equal(copier.marked.n, 2 * (16 + 2 + 1));
    const phone = r.conditions.find((c) => c.source === "photo")!;
    assert.equal(phone.marked.p50, 0.6);
    assert.equal(r.conditions.find((c) => c.condition === "feeder 200 bw")?.refused, 1);
    assert.ok(r.targets.some((t) => /Scans refused: 1 of 3/.test(t)));
  });

  test("judges a question at the version the volunteer wrote down, and says so when the list and the printed sheet disagree", () => {
    const r = calibrate([page(0, answersFor(0), 0.8, 0.02, { version: 2 })], reader);
    assert.match(r.unjudged[0] ?? "", /the list says version B and the sheet was printed for A/);
    assert.equal(r.now.tune.questions, 0);
  });
});

describe("openassess sheets calibrate", () => {
  let dir = "";
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "sheets", "calibrate", ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "openassess-calibrate-"));
    const bank = Bank.createEmpty("Calibration", { at: "2026-01-01T00:00:00.000Z" });
    bank.addTest(record);
    return bank.save(join(dir, "c.openassess"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("writes a template, never over one that is there, and reads scans against it", () => {
    const corpus = join(dir, "corpus");
    assert.equal(run(join(dir, "c.openassess"), corpus, "--template").code, 0);
    assert.match(readFileSync(join(corpus, "answers.csv"), "utf8"), /^file,page,sheet,source,condition,version,1,2,/);
    const again = run(join(dir, "c.openassess"), corpus, "--template");
    assert.equal(again.code, 2);
    assert.match(again.err, /never written over/);

    const d = drawn(record, { dpi: 200 });
    writeFileSync(join(corpus, "one.png"), writePng(d.render(solid([1, 0, 2, 3])), { dpi: 200 }));
    writeFileSync(join(corpus, "answers.csv"), ["file,page,sheet,source,condition,version,1,2,3,4,5", "one.png,1,Ana,scan,flatbed 200 grey,,B,A,C,D,", "../c.openassess,1,Bo,scan,flatbed,,A,,,,", "missing.png,1,Cy,scan,flatbed,,A,,,,"].join("\n"));
    const r = run(join(dir, "c.openassess"), corpus);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /line 3: "\.\.\/c\.openassess" is not inside the corpus folder/);
    assert.match(r.out, /line 4: missing\.png has no page 1 \(the file is not there\)/);
    assert.match(r.out, /5 questions \(4 marked\): right 5/);
    assert.match(r.out, /No lines are proposed: the half the lines are tried on holds 4 marked answers/i);
  });
});
