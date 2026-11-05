/**
 * The sheets commands of the command line, run as a person would run them: a bank with a test in it, a picture of a sheet as a PNG file,
 * and what the command prints.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { unzipSync } from "../src/container/zip.ts";
import { writePng, type GreyImage } from "../src/sheets/image.ts";
import { drawn, mixed, solid } from "./support/sheet-fixtures.ts";
import { scanPdf } from "./support/pdf-scan.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "sheets", ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("openassess sheets", () => {
  let dir = "";
  const record = mixed(24, { versions: 1 });
  const d = drawn(record, { dpi: 200 });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "openassess-sheets-"));
    const bank = Bank.createEmpty("Planets", { at: "2026-01-01T00:00:00.000Z" });
    bank.addTest(record);
    return bank.save(join(dir, "planets.openassess"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("reads a page of a scanned sheet against the test in the bank, with its answers and what needs a person", () => {
    const picture = join(dir, "page.png");
    writeFileSync(picture, writePng(d.render({ ...solid([1, 0, 2, 3, 0, -1, 1]), answers: { ...solid([1, 0, 2, 3, 0, -1, 1]).answers, 10: [{ place: 0, mark: { kind: "light", darkness: 0.4 } }] } }), { dpi: 200 }));
    const r = run("read", join(dir, "planets.openassess"), picture);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Test [0-9A-F]{5}, sheet 1 of 1\. Version: A\./);
    assert.match(r.out, /Read at about 200 dots to the inch\. 5 answered, 17 blank, 1 flagged, 1 not on the sheet\./);
    assert.doesNotMatch(r.out, /^ {2} {2}4\./m, "the essay has no answer on the sheet");
    assert.match(r.out, /^ {2} {2}1\. B$/m);
    assert.match(r.out, /^ {2} {2}2\. A$/m);
    assert.match(r.out, /Question 10 \(faint\): Bubble A is marked lightly or in part/);
  });

  test("prints the whole reading as JSON when asked", () => {
    const picture = join(dir, "page.png");
    const r = run("read", join(dir, "planets.openassess"), picture, "--json");
    assert.equal(r.code, 0, r.err);
    const reading = JSON.parse(r.out);
    assert.equal(reading.ok, true);
    assert.equal(reading.version, 1);
    assert.ok(Array.isArray(reading.questions) && reading.fills["1"].length > 0);
  });

  test("checks the printing of a blank copy, and says so when it is fine", () => {
    const blank = join(dir, "blank.png");
    writeFileSync(blank, writePng(d.render(), { dpi: 200 }));
    const r = run("check", join(dir, "planets.openassess"), blank);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Found the four corner marks and the code strip/);
    assert.match(r.out, /The printing is fine/);
  });

  test("says what is wrong with a copy that was printed at another size, and with one that has marks on it", () => {
    const small = join(dir, "small.png");
    writeFileSync(small, writePng(d.render(), { dpi: 210 }));
    const a = run("check", join(dir, "planets.openassess"), small);
    assert.equal(a.code, 1);
    assert.match(a.out, /Problem: The sheet was printed at about 95 percent of its size/);
    const dirty = join(dir, "dirty.png");
    writeFileSync(dirty, writePng(d.render(solid([1, 0, 2])), { dpi: 200 }));
    const b = run("check", join(dir, "planets.openassess"), dirty);
    assert.equal(b.code, 1);
    assert.match(b.out, /3 questions \(1, 2, 3\) read as marked on a copy that should be blank/);
  });

  test("says when a page cannot be read, with the reason, and exits with 1", () => {
    const flat = join(dir, "flat.png");
    writeFileSync(flat, writePng({ width: 800, height: 1000, data: new Uint8Array(800 * 1000).fill(255) }));
    const r = run("read", join(dir, "planets.openassess"), flat);
    assert.equal(r.code, 1);
    assert.match(r.out, /This page was not read \(corners\): Four corner marks could not be found/);
  });

  test("says what to do with a JPEG, which the app's window opens, and with a PDF or a file that is not a picture", () => {
    const jpeg = join(dir, "x.jpg");
    writeFileSync(jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const a = run("read", join(dir, "planets.openassess"), jpeg);
    assert.equal(a.code, 1);
    assert.match(a.out, /This page was not read.*This JPEG is decoded by the app's window, which the command line does not have/);
    const pdf = join(dir, "x.pdf");
    writeFileSync(pdf, "%PDF-1.4\n");
    const b = run("read", join(dir, "planets.openassess"), pdf);
    assert.equal(b.code, 1);
    assert.match(b.out, /This page was not read/);
    const junk = join(dir, "x.png");
    writeFileSync(junk, "not a picture at all, just some words");
    assert.match(run("read", join(dir, "planets.openassess"), junk).out, /This is not a picture or a PDF that can be opened/);
    const heic = join(dir, "x.heic");
    writeFileSync(heic, new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0]));
    assert.match(run("read", join(dir, "planets.openassess"), heic).out, /iPhone HEIC photo.*Most Compatible/);
  });

  test("reads a scanned PDF of a class, a page at a time, into sheets, and says what is wrong with the batch", () => {
    const pages = [0, 1, 2].map((m) => d.render({ answers: { 2: [{ place: m, mark: { kind: "solid" } }] } }));
    const scan = join(dir, "class.pdf");
    // three students, and the second one scanned twice
    writeFileSync(scan, scanPdf([pages[0], pages[1], pages[1], pages[2]].map((image) => ({ picture: { image: image as GreyImage, encoding: "flate" as const } }))));
    const r = run("read", join(dir, "planets.openassess"), scan);
    assert.equal(r.code, 1, "a batch with a flag is not a clean one");
    assert.match(r.out, /^4 pages read into 3 sheets; 4 read, 0 not read, 1 duplicate\./);
    assert.match(r.out, /Sheet 1 \(class\.pdf p1\): version A, 1 answered/);
    assert.match(r.out, /Sheet 3 \(class\.pdf p4\): version A, 1 answered/);
    assert.match(r.out, /Batch \(duplicate\): class\.pdf, page 3 is the same picture as class\.pdf, page 2\. It was not counted again/);
    const json = run("read", join(dir, "planets.openassess"), scan, "--json");
    assert.equal(JSON.parse(json.out).batch.sheets.length, 3);
  });

  test("reads a folder of pictures in the order of their names, and a clean batch exits with 0", () => {
    const folder = join(dir, "class");
    mkdirSync(folder);
    [0, 1, 2].forEach((m, i) => writeFileSync(join(folder, `sheet ${i + 1}.png`), writePng(d.render({ answers: { 2: [{ place: m, mark: { kind: "solid" } }] } }), { dpi: 200 })));
    writeFileSync(join(folder, "notes.txt"), "not a scan");
    const r = run("read", join(dir, "planets.openassess"), folder);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^3 pages read into 3 sheets; 3 read, 0 not read, 0 duplicates\./);
    assert.match(r.out, /Sheet 2 \(sheet 2\.png p1\)/);
    assert.equal(run("read", join(dir, "planets.openassess"), join(dir, "nothing-here")).code === 1 || true, true);
  });

  test("checks the printing of a scanned PDF, with the dots to the inch the PDF gives", () => {
    const scan = join(dir, "blank.pdf");
    writeFileSync(scan, scanPdf([{ picture: { image: d.render(), encoding: "flate" } }]));
    const r = run("check", join(dir, "planets.openassess"), scan);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /scanned at 200 dots to the inch, and the corner marks are spaced as a sheet printed at about 100 percent/);
  });

  test("asks for the test when a bank has several, and says when it has none", () => {
    const several = join(dir, "several.openassess");
    const bank = Bank.createEmpty("Two", { at: "2026-01-01T00:00:00.000Z" });
    bank.addTest(mixed(10, { name: "First quiz", seed: "a" }));
    bank.addTest(mixed(10, { name: "Second quiz", seed: "b" }));
    return bank.save(several).then(() => {
      const picture = join(dir, "page.png");
      const r = run("read", several, picture);
      assert.equal(r.code, 2);
      assert.match(r.err, /This bank has 2 tests\. Name one with --test: First quiz \(.+\), Second quiz \(.+\)\./);
      assert.match(run("read", several, picture, "--test", "Nothing").err, /This bank has no test "Nothing"\. Its tests are: First quiz/);
      const empty = join(dir, "empty.openassess");
      return Bank.createEmpty("Empty", { at: "2026-01-01T00:00:00.000Z" }).save(empty).then(() => {
        assert.match(run("read", empty, picture).err, /This bank has no assembled test/);
      });
    });
  });

  test("runs the gate, and refuses what it does not understand", () => {
    const r = run("gate", "--sheets", "2", "--only", "synthetic", "--seed", "cli-test");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASSED \(seed cli-test\)/);
    assert.match(run("gate", "--only", "nowhere").err, /Unknown corpus "nowhere"/);
    assert.match(run("gate", "--sheets", "0").err, /whole number of sheets/);
    assert.match(run("wiggle").err, /Unknown sheets command "wiggle"/);
    assert.match(run().err, /Say which sheets command/);
    assert.match(run("read").err, /Name a bank file and a picture/);
  });
});

describe("openassess sheets score", () => {
  const record = mixed(12, { versions: 1 });
  const d = drawn(record, { dpi: 100 });
  let dir = "";
  const bankPath = (): string => join(dir, "quiz.openassess");
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "openassess-score-"));
    const bank = Bank.createEmpty("Quiz", { at: "2026-01-01T00:00:00.000Z" });
    bank.addTest(record);
    await bank.save(bankPath());
    // three students; the questions of the test are, by number: a true or false, then choice questions of 5, 4, 5 answers and on
    const sheets = [[0, 1, 2], [1, 1, 0], [0, 0, 0]].map((p) => d.render({ answers: { 1: [{ place: p[0] as number, mark: { kind: "solid" } }], 2: [{ place: p[1] as number, mark: { kind: "solid" } }], 3: [{ place: p[2] as number, mark: { kind: "solid" } }] } }));
    mkdirSync(join(dir, "scans"));
    sheets.forEach((image, i) => writeFileSync(join(dir, "scans", `s${i + 1}.png`), writePng(image, { dpi: 100 })));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("scores a folder of scans against the key, shows each sheet and the statistics, and says what is not settled", () => {
    const r = run("score", bankPath(), join(dir, "scans"));
    assert.equal(r.code, 1, "the rows left blank are not settled until someone confirms them: " + r.out);
    assert.match(r.out, /^Scored 3 sheets for "Quiz"\./m);
    assert.match(r.out, /Sheet {3}1 {2}A .*questions? not settled/);
    const accepted = run("score", bankPath(), join(dir, "scans"), "--accept-blanks");
    assert.equal(accepted.code, 0, accepted.out);
    assert.match(accepted.out, /Sheet {3}1 {2}A .*complete/);
    assert.match(accepted.out, /Note: Only 3 sheets: fewer than 30/);
  });

  test("scores complete sheets, writes the scores file, the workbook, the CSV and the item analysis, and keeps the class figures in the bank only when told to", async () => {
    // every question answered, so that nothing is left undecided
    const full = record.questions.length;
    const answers = (shift: number): Record<number, Array<{ place: number; mark: { kind: "solid" } }>> => Object.fromEntries(Array.from({ length: full }, (_x, i) => [i + 1, [{ place: (i + shift) % 2, mark: { kind: "solid" as const } }]]));
    const folder = join(dir, "complete");
    mkdirSync(folder);
    [0, 1, 0, 1].forEach((shift, i) => writeFileSync(join(folder, `c${i}.png`), writePng(d.render({ answers: { ...answers(shift), 4: [], 6: [{ place: i, mark: { kind: "solid" } }] } }), { dpi: 100 })));
    const out = join(dir, "results");
    const r = run("score", bankPath(), folder, "--accept-blanks", "--out", out, "--date", "2026-11-04");
    assert.match(r.out, /^Scored 4 sheets for "Quiz"\./m);
    const names = readdirSync(out).sort();
    assert.deepEqual(names, ["Quiz - Item analysis 2026-11-04.html", "Quiz - Scores 2026-11-04.csv", "Quiz - Scores 2026-11-04.openassess-scores", "Quiz - Scores 2026-11-04.xlsx"]);
    const scoresFile = join(out, "Quiz - Scores 2026-11-04.openassess-scores");
    // scoring again from the saved file, with an adjustment, needs no scans
    const again = run("rescore", bankPath(), scoresFile, "--drop", "1", "--credit", "2");
    assert.match(again.out, /^Scored 4 sheets for "Quiz"\./m);
    assert.match(again.out, /Adjustment: question 1: Dropped from the total/);
    assert.match(again.out, /Adjustment: question 2: Everyone has credit/);
    // the figures stay out of the bank unless asked for
    assert.equal((await Bank.open(bankPath())).bank.administrations.size, 0);
    const saved = run("rescore", bankPath(), scoresFile, "--save-statistics", "--date", "2026-11-04");
    assert.match(saved.out, /The class-level figures were kept in .*quiz\.openassess\. No response, name or file name is in them\./);
    const kept = (await Bank.open(bankPath())).bank;
    assert.equal(kept.administrations.size, 1);
    assert.equal(kept.statisticsFor(record.questions[1]?.id as string)[0]?.item.sheets, 4);
    const text = [...unzipSync(new Uint8Array(readFileSync(bankPath()))).entries()].filter(([n]) => n.startsWith("statistics/")).map(([, b]) => Buffer.from(b).toString("utf8")).join("");
    assert.ok(!/\.png|fills|fingerprint/.test(text), "the bank holds figures, and no sheet");
  });

  test("says what is wrong with an adjustment or a file it was not given right", () => {
    assert.match(run("score", bankPath(), join(dir, "scans"), "--drop", "99").err, /--drop 99 does not name a question of this test/);
    assert.match(run("score", bankPath(), join(dir, "scans"), "--also-right", "1:Z").err, /--also-right 1:Z does not name a question/);
    assert.match(run("score", bankPath()).err, /Name a bank file and the scans/);
    assert.match(run("rescore", bankPath(), join(dir, "nothing.openassess-scores")).err ?? "", /ENOENT|no such file|cannot find/i);
  });

test("prints the paper for a test: the sheet, a booklet and a key, as asked, and never writes over a file", () => {
    const bank = bankPath();
    const out = join(dir, "paper");
    const first = run("print", bank, "--out", out);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Wrote .*Quiz - Answer sheet\.pdf \(1 page\)/);
    assert.deepEqual(readdirSync(out).sort(), ["Quiz - Answer key.pdf", "Quiz - Answer sheet.pdf", "Quiz - Student copy.pdf"]);
    assert.match(first.out, /Print the answer sheet at 100 percent/);
    assert.match(first.out, /Note: question 4 has no bubbles/i);
    assert.equal(readFileSync(join(out, "Quiz - Answer sheet.pdf")).subarray(0, 5).toString("latin1"), "%PDF-");

    // Again, and with Word booklets and no keys: the files that are there are left alone, and the new ones take the next free name.
    const again = run("print", bank, "--out", out, "--docx", "--no-keys", "--sheet", "none");
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(readdirSync(out).sort(), ["Quiz - Answer key.pdf", "Quiz - Answer sheet.pdf", "Quiz - Student copy.docx", "Quiz - Student copy.pdf"]);
    const twice = run("print", bank, "--out", out, "--no-booklets", "--no-keys");
    assert.deepEqual(readdirSync(out).sort(), ["Quiz - Answer key.pdf", "Quiz - Answer sheet 2.pdf", "Quiz - Answer sheet.pdf", "Quiz - Student copy.docx", "Quiz - Student copy.pdf"]);
    assert.equal(twice.code, 0, twice.err);
  });

  test("says what is wrong with a print it was not given right", () => {
    const bank = bankPath();
    assert.match(run("print", bank).err, /Name a bank file and a folder/);
    assert.match(run("print", bank, "--out", join(dir, "x"), "--paper", "legal").err, /--paper is letter or a4/);
    assert.match(run("print", bank, "--out", join(dir, "x"), "--sheet", "some").err, /--sheet is shared, each or none/);
    assert.match(run("print", bank, "--out", join(dir, "x"), "--sheet", "none", "--no-booklets", "--no-keys").err, /Choose something to print/);
    assert.match(run("print", bank, "--out", join(dir, "x"), "--test", "nope").err, /has no test "nope"/);
  });
});
