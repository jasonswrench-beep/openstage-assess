/**
 * The scores file, the figures a bank keeps, and what is exported: round trips, what may never be in them, and what is said of damage.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bank } from "../src/bank/store.ts";
import { textEntry, unzipSync, zipSync } from "../src/container/zip.ts";
import { readXlsx } from "../src/import/table-xlsx.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { administrationFrom, validateAdministration, type Administration } from "../src/model/statistics.ts";
import type { Question } from "../src/model/question.ts";
import { assembleBatch, type BatchEntry } from "../src/sheets/batch.ts";
import { imageFingerprint } from "../src/sheets/image.ts";
import { SheetReader } from "../src/sheets/read.ts";
import { exportResults, itemAnalysisHtml } from "../src/sheets/results-export.ts";
import { adjustmentEffect, scoreSheets, settleSheets, type Adjustment, type Decision, type SettledSheet } from "../src/sheets/score.ts";
import { SCORES_EXTENSION, newScoresFile, readScoresFile, restore, scoresFileName, writeScoresFile } from "../src/sheets/scores-file.ts";
import { itemStatistics } from "../src/sheets/stats.ts";
import { drawn, mcq, testOf, tfq } from "./support/sheet-fixtures.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 7000;
const choice = (stem: string, right: number, n = 4): Question =>
  createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: true, options: Array.from({ length: n }, (_x, i) => ({ id: `o${i}`, content: plainToRich(`Answer ${i}`), correct: i === right })) }, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}` });

const record = testOf([choice("What is 2 + 2?", 1), choice('A <b>risky</b> & "quoted" stem', 0), tfq(), choice("The last one", 2)], { versions: 2, name: "Unit 3: Cells & Tissues" });
const reader = new SheetReader(record);
const d = drawn(record, { dpi: 100 });
const solid = (place: number) => ({ place, mark: { kind: "solid" as const } });
const sheetPicture = (version: number, answers: Record<number, number>) => d.render({ answers: Object.fromEntries(Object.entries(answers).map(([q, p]) => [q, [solid(p)]])), versions: [{ version, mark: { kind: "solid" } }] });

// four students: three version A, one version B (a place is a bank answer's place in that version's own order)
const images = [sheetPicture(1, { 1: 1, 2: 0, 3: 0, 4: 2 }), sheetPicture(1, { 1: 0, 2: 0, 3: 1, 4: 2 }), sheetPicture(1, { 1: 1, 2: 1, 3: 0, 4: 0 }), sheetPicture(2, { 1: 1, 2: 1, 3: 0, 4: 1 })];
const entries: BatchEntry[] = images.map((image, i) => ({ source: { file: `Smith_John_${i}.pdf`, page: 1 }, fingerprint: imageFingerprint(image), result: reader.read(image) }));
const batch = assembleBatch(entries, 1);
const decisions: Decision[] = [{ sheet: 1, kind: "answer", question: 1, places: [1], readerSaw: "marked B", at: AT }];

describe("the scores file", () => {
  const adjustments: Adjustment[] = [{ id: "adj1", kind: "drop", questionId: record.questions[1]!.id, note: "Ambiguous wording", at: AT }];
  const file = newScoresFile(record, batch, entries, { decisions, adjustments, pagesPerSheet: 1, now: AT, id: "s_TEST" });

  test("round trips: the readings, the decisions and the adjustments come back as they were put in", () => {
    const bytes = writeScoresFile(file);
    const read = readScoresFile(bytes);
    assert.ok(read.ok, read.ok ? "" : read.reason);
    assert.deepEqual(read.file.decisions, decisions);
    assert.deepEqual(read.file.adjustments, adjustments);
    assert.deepEqual([read.file.testId, read.file.testName, read.file.testFingerprint, read.file.pagesPerSheet, read.file.id], [record.id, "Unit 3: Cells & Tissues", record.fingerprint, 1, "s_TEST"]);
    assert.equal(read.file.sheets.length, 4);
    assert.deepEqual(read.file.sheets[0], file.sheets[0]);
    assert.deepEqual(writeScoresFile(read.file), bytes, "written again it is the same bytes");
  });

  test("holds each page's sheet number, page number and fingerprint, and no file name, picture or name", () => {
    const bytes = writeScoresFile(file);
    const text = [...unzipSync(bytes).values()].map((b) => Buffer.from(b).toString("utf8")).join("\n");
    assert.ok(!/Smith/.test(text), "a scan named for a student leaves no trace");
    assert.ok(!/\.pdf|\.png|\.jpg/.test(text), "no file name or extension");
    assert.equal(file.sheets[1]?.pages[0]?.fingerprint, entries[1]?.fingerprint);
    assert.deepEqual(Object.keys(file.sheets[0]?.pages[0] as object).sort(), ["fingerprint", "page", "reading"]);
    assert.deepEqual([...unzipSync(bytes).keys()].sort(), ["adjustments.json", "decisions.json", "manifest.json", "sheets/1.json", "sheets/2.json", "sheets/3.json", "sheets/4.json"]);
  });

  test("gives the same scores from a saved file as from the readings it was made from, with no rescan", () => {
    const direct = scoreSheets(record, settleSheets(batch.sheets, entries, decisions, { acceptBlanks: true, reader }), adjustments);
    const read = readScoresFile(writeScoresFile(file));
    assert.ok(read.ok);
    const back = restore(read.file);
    const viaFile = scoreSheets(record, settleSheets(back.sheets, back.entries, read.file.decisions, { acceptBlanks: true, reader }), read.file.adjustments);
    assert.deepEqual(viaFile, direct);
    assert.equal(back.entries[0]?.source.file, "sheet 1", "a saved file does not know the file the picture came from");
    const first = back.entries[0]?.result;
    assert.ok(first?.ok && first.questions.every((q) => q.rect.height > 0), "each question gets its place on the sheet again");
  });

  test("keeps a page that was refused, with its reason, and a page that never came", () => {
    const refused: BatchEntry = { source: { file: "x.png", page: 1 }, fingerprint: "r", result: { ok: false, cause: "corners", reason: "Four corner marks could not be found" } };
    const long = testOf(Array.from({ length: 130 }, () => mcq(4)), { versions: 1 });
    const page1 = drawn(long, { dpi: 100, page: 1 }).render();
    const withMissing: BatchEntry[] = [{ source: { file: "y.png", page: 1 }, fingerprint: imageFingerprint(page1), result: new SheetReader(long).read(page1) }, refused];
    const f = newScoresFile(long, assembleBatch([withMissing[0] as BatchEntry], 2), withMissing, { pagesPerSheet: 2, now: AT });
    assert.deepEqual(f.sheets[0]?.pages.map((p) => p !== null), [true, false]);
    const g = newScoresFile(record, assembleBatch([refused], 1), [refused], { pagesPerSheet: 1, now: AT });
    assert.deepEqual(g.sheets[0]?.pages[0]?.refused, { cause: "corners", reason: "Four corner marks could not be found" });
    const back = readScoresFile(writeScoresFile(g));
    assert.ok(back.ok);
    const r = restore(back.file);
    assert.equal(r.entries[0]?.result.ok, false);
    assert.equal(!r.entries[0]?.result.ok && r.entries[0]?.result.reason, "Four corner marks could not be found");
  });

  test("claims no version for a sheet whose pages name different ones, when it is opened again", () => {
    const long = testOf(Array.from({ length: 130 }, () => mcq(4)), { versions: 2 });
    const longReader = new SheetReader(long);
    const pages = [drawn(long, { dpi: 100, page: 1 }).render({ versions: [{ version: 1, mark: { kind: "solid" } }] }), drawn(long, { dpi: 100, page: 2 }).render({ versions: [{ version: 2, mark: { kind: "solid" } }] })];
    const two: BatchEntry[] = pages.map((image, i) => ({ source: { file: "m.pdf", page: i + 1 }, fingerprint: imageFingerprint(image), result: longReader.read(image) }));
    const f = newScoresFile(long, assembleBatch(two, 2), two, { pagesPerSheet: 2, now: AT });
    const back = restore(f);
    assert.equal(back.sheets[0]?.version, undefined);
    const one = restore(newScoresFile(long, assembleBatch([two[0] as BatchEntry], 2), two, { pagesPerSheet: 2, now: AT }));
    assert.equal(one.sheets[0]?.version, 1, "a sheet whose pages agree has its version");
  });

  test("is named for the test and the day, with nothing in the name a file system refuses", () => {
    assert.equal(scoresFileName("Unit 3: Cells & Tissues", "2026-11-04"), `Unit 3- Cells & Tissues - Scores 2026-11-04${SCORES_EXTENSION}`);
    assert.equal(scoresFileName("", "2026-11-04"), `Test - Scores 2026-11-04${SCORES_EXTENSION}`);
  });

  test("refuses a file that is not one, with the reason, and never half-reads it", () => {
    const reason = (bytes: Uint8Array): string => {
      const r = readScoresFile(bytes);
      return r.ok ? "" : r.reason;
    };
    assert.match(reason(new Uint8Array([1, 2, 3])), /This is not a scores file/);
    assert.match(reason(zipSync([textEntry("hello.txt", "hi")])), /has no manifest\.json/);
    const parts = unzipSync(writeScoresFile(file));
    const repack = (change: (m: Map<string, Uint8Array>) => void): Uint8Array => {
      const copy = new Map(parts);
      change(copy);
      return zipSync([...copy].map(([name, data]) => ({ name, data })));
    };
    assert.match(reason(repack((m) => m.delete("sheets/2.json"))), /has no sheets\/2\.json/);
    assert.match(reason(repack((m) => m.set("sheets/2.json", new Uint8Array(Buffer.from("{not json"))))), /sheets\/2\.json in this scores file is damaged: it is not valid JSON/);
    assert.match(reason(repack((m) => m.set("manifest.json", new Uint8Array(Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts.get("manifest.json") as Uint8Array).toString()), version: 9 })))))), /is version 9, and this program reads version 1/);
    assert.match(reason(repack((m) => m.set("manifest.json", new Uint8Array(Buffer.from(JSON.stringify({ format: "other" })))))), /not an OpenAssess scores file|has a field|missing something/);
  });

  test("refuses a file with a field a scores file does not hold: a name, a file name or a picture could be smuggled in that way", () => {
    const parts = unzipSync(writeScoresFile(file));
    const tamper = (path: string, change: (v: Record<string, unknown>) => void): string => {
      const copy = new Map(parts);
      const value = JSON.parse(Buffer.from(parts.get(path) as Uint8Array).toString()) as Record<string, unknown>;
      change(value);
      copy.set(path, new Uint8Array(Buffer.from(JSON.stringify(value))));
      const r = readScoresFile(zipSync([...copy].map(([name, data]) => ({ name, data }))));
      return r.ok ? "" : r.reason;
    };
    assert.match(tamper("sheets/1.json", (v) => ((v["pages"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["file"] = "Smith_John.pdf"), /has a field, file, that a scores file does not hold \(it holds no names, no file names and no pictures\)/);
    assert.match(tamper("sheets/1.json", (v) => (v["studentName"] = "Jo")), /has a field, studentName/);
    assert.match(tamper("sheets/1.json", (v) => (((v["pages"] as Array<{ reading: Record<string, unknown> }>)[0] as { reading: Record<string, unknown> }).reading["image"] = "AAAA")), /reading has a field, image/);
    assert.match(tamper("sheets/1.json", (v) => (((v["pages"] as Array<{ reading: { code: Record<string, unknown> } }>)[0] as { reading: { code: Record<string, unknown> } }).reading.code["who"] = "Jo")), /code has a field, who/);
    assert.match(tamper("manifest.json", (v) => (v["instructor"] = "me")), /manifest\.json has a field, instructor/);
    assert.match(tamper("sheets/1.json", (v) => (((v["pages"] as Array<{ reading: { quality: Record<string, unknown> } }>)[0] as { reading: { quality: Record<string, unknown> } }).reading.quality["image"] = "AAAA")), /quality has a field, image/);
    assert.match(tamper("sheets/1.json", (v) => (((v["pages"] as Array<{ reading: { fills: Record<string, unknown> } }>)[0] as { reading: { fills: Record<string, unknown> } }).reading.fills["1"] = [2])), /is not a list of fills from 0 to 1/);
  });

  test("refuses decisions and adjustments that are not what this program writes", () => {
    const parts = unzipSync(writeScoresFile(file));
    const with_ = (path: string, value: unknown): string => {
      const copy = new Map(parts);
      copy.set(path, new Uint8Array(Buffer.from(JSON.stringify(value))));
      const r = readScoresFile(zipSync([...copy].map(([name, data]) => ({ name, data }))));
      return r.ok ? "" : r.reason;
    };
    assert.match(with_("decisions.json", [{ sheet: 1, kind: "answer", question: 1, places: [1], studentName: "x" }]), /has a field, studentName/);
    assert.match(with_("decisions.json", [{ sheet: 1, kind: "answer", question: 1, places: "maybe" }]), /is not an answer/);
    assert.match(with_("decisions.json", [{ sheet: 1, kind: "version", version: 9 }]), /is not a version/);
    assert.match(with_("decisions.json", {}), /is not a list/);
    assert.match(with_("adjustments.json", [{ id: "a", kind: "alsoRight", questionId: "q" }]), /gives no answer/);
    assert.match(with_("adjustments.json", [{ id: "a", kind: "points", questionId: "q", points: -1 }]), /gives no points/);
    assert.match(with_("adjustments.json", [{ id: "a", kind: "shrug", questionId: "q" }]), /is not an adjustment/);
    assert.match(with_("adjustments.json", [{ id: "a", kind: "drop", questionId: "q", studentName: "Jo" }]), /has a field, studentName/);
  });
});

describe("the figures a bank keeps", () => {
  const sheets: SettledSheet[] = settleSheets(batch.sheets, entries, decisions, { acceptBlanks: true, reader });
  const scores = scoreSheets(record, sheets);
  const stats = itemStatistics(record, scores);
  const administration = administrationFrom(record, stats, "2026-11-04", "adm_00000000000000000000000001");

  test("hold class-level figures for each question, and nothing about any sheet", () => {
    assert.equal(administration.sheets, 4);
    assert.equal(administration.unstable, true);
    assert.equal(administration.testName, "Unit 3: Cells & Tissues");
    assert.equal(administration.items.length, 4);
    const json = JSON.stringify(administration);
    assert.ok(!/Smith|\.pdf|fingerprint|sheet 1|"number"|"fills"/.test(json), "nothing a student did, and no file");
    assert.deepEqual(Object.keys(administration.items[0] as object).sort(), ["blanks", "difficulty", "options", "pointBiserial", "questionId", "sheets", "upperLower"].filter((k) => k in (administration.items[0] as object)).sort());
    const check = validateAdministration(administration);
    assert.ok(check.ok, check.ok ? "" : check.issues.map((i) => i.message).join("; "));
  });

  test("refuse a field a bank may not hold, and counts that cannot be right", () => {
    const issues = (value: unknown): string => {
      const c = validateAdministration(value);
      return c.ok ? "" : c.issues.map((i) => `${i.path}: ${i.message}`).join(" | ");
    };
    const clone = (): Administration => structuredClone(administration);
    const withName = { ...clone(), studentNames: ["Jo"] };
    assert.match(issues(withName), /studentNames: studentNames is not a field of the figures a bank keeps\. A bank holds class-level figures only, and never a response, a name or a file name/);
    const response = clone() as unknown as { items: Array<Record<string, unknown>> };
    response.items[0]!["responses"] = [1, 0, 1];
    assert.match(issues(response), /items\.0\.responses: responses is not a field/);
    const optionResponse = clone() as unknown as { items: Array<{ options: Array<Record<string, unknown>> }> };
    optionResponse.items[0]!.options[0]!["who"] = "Jo";
    assert.match(issues(optionResponse), /options\.0\.who/);
    assert.match(issues({ ...clone(), date: "yesterday" }), /date: The date is a day/);
    assert.match(issues({ ...clone(), id: "t_00000000000000000000000001" }), /id: The id is not an administration id/);
    const tooMany = clone();
    (tooMany.items[0] as { sheets: number }).sheets = 99;
    assert.match(issues(tooMany), /no more than the sheets in all/);
    const blanksMany = clone();
    (blanksMany.items[0] as { blanks: number }).blanks = 99;
    assert.match(issues(blanksMany), /The blanks are a whole number, no more than the sheets the question counted on/);
    const twice = clone();
    twice.items.push(structuredClone(twice.items[0] as (typeof twice.items)[number]));
    assert.match(issues(twice), /A question is in these figures twice/);
    const choseTooMany = clone();
    (choseTooMany.items[0] as { options: Array<{ chosen: number }> }).options[0]!.chosen = 99;
    assert.match(issues(choseTooMany), /no more than the sheets the question counted on/);
    const odd = clone();
    (odd.items[0] as { difficulty: number }).difficulty = 2;
    assert.match(issues(odd), /difficulty is a number from 0 to 1/);
    assert.match(issues(null), /are an object/);
    assert.match(issues({ ...clone(), recordVersion: 2 }), /is version 2/);
  });

  test("are kept in the bank, saved with it, and given back for a question, and a bank with none opens as it did", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-stats-"));
    try {
      const bank = Bank.createEmpty("Cells", { at: AT });
      bank.addTest(record);
      bank.addAdministration(administration);
      assert.throws(() => bank.addAdministration(administration), /already holds the figures/);
      assert.throws(() => bank.addAdministration({ ...administration, id: "adm_00000000000000000000000002", extra: 1 } as unknown as Administration), /Refusing to add figures that a bank may not hold/);
      const path = join(dir, "cells.openassess");
      await bank.save(path);
      const { bank: reopened, report } = await Bank.open(path);
      assert.deepEqual(report.invalid, []);
      assert.deepEqual(reopened.listAdministrations(), [administration]);
      const second = administrationFrom(record, stats, "2026-12-01", "adm_00000000000000000000000002");
      reopened.addAdministration(second);
      const q = record.questions[0] as Question;
      const history = reopened.statisticsFor(q.id);
      assert.deepEqual(history.map((h) => [h.administration.date, h.item.sheets]), [["2026-11-04", 4], ["2026-12-01", 4]]);
      assert.equal("items" in history[0]!.administration, false);
      assert.equal(reopened.removeAdministration(second.id), true);
      assert.deepEqual(reopened.statisticsFor("q_00000000000000000000000999"), []);
      const plain = Bank.createEmpty("Plain", { at: AT });
      await plain.save(join(dir, "plain.openassess"));
      assert.equal((await Bank.open(join(dir, "plain.openassess"))).bank.administrations.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("that hold something a bank may not are kept exactly as they were, reported, and not used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-stats-"));
    try {
      const bank = Bank.createEmpty("Cells", { at: AT });
      bank.addAdministration(administration);
      const path = join(dir, "cells.openassess");
      await bank.save(path);
      const parts = unzipSync(new Uint8Array(await (await import("node:fs/promises")).readFile(path)));
      const name = "statistics/adm_00000000000000000000000001.json";
      const smuggled = { ...JSON.parse(Buffer.from(parts.get(name) as Uint8Array).toString()), responses: [[1, 0]] };
      parts.set(name, new Uint8Array(Buffer.from(JSON.stringify(smuggled))));
      await (await import("node:fs/promises")).writeFile(path, zipSync([...parts].map(([n, data]) => ({ name: n, data }))));
      const { bank: reopened, report } = await Bank.open(path);
      assert.equal(reopened.administrations.size, 0, "figures with a response in them are not used");
      assert.equal(report.invalid.length, 1);
      assert.match(report.invalid[0]?.issues[0]?.message as string, /responses is not a field of the figures a bank keeps/);
      await reopened.save(path);
      const after = unzipSync(new Uint8Array(await (await import("node:fs/promises")).readFile(path)));
      assert.ok(after.has(name), "and written back as they were");
      assert.deepEqual(JSON.parse(Buffer.from(after.get(name) as Uint8Array).toString()), smuggled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what is exported", () => {
  const sheets: SettledSheet[] = settleSheets(batch.sheets, entries, decisions, { acceptBlanks: true, reader });
  const adjustments: Adjustment[] = [{ id: "a1", kind: "drop", questionId: record.questions[1]!.id, note: "Ambiguous wording", at: AT }];
  const stats = itemStatistics(record, scoreSheets(record, sheets, adjustments));
  const out = exportResults(record, sheets, adjustments, stats, "2026-11-04");

  test("writes a workbook of scores with an empty Name column, each answer as the letters marked, and the totals", () => {
    const wb = readXlsx(out.xlsx);
    assert.deepEqual(wb.sheets.map((s) => s.name), ["Scores", "Key", "Adjustments", "Item statistics"]);
    const scores = wb.sheets[0]!.rows.map((r) => r.cells);
    assert.deepEqual(scores[0]!.slice(0, 5), ["Sheet", "Version", "Name", "1", "2"]);
    assert.deepEqual(scores[0]!.slice(-4), ["Earned", "Possible", "Percent", "Settled"]);
    assert.equal(scores.length, 5, "a row for each sheet");
    assert.ok(scores.slice(1).every((r) => r[2] === ""), "the Name column is empty");
    assert.deepEqual(scores.slice(1).map((r) => r[1]), ["A", "A", "A", "B"]);
    // sheet 1 marked B, A, A, C on version A: question 1 right (B), question 2 dropped, question 3 true is A, question 4 right (C)
    assert.deepEqual(scores[1]!.slice(3, 7), ["B", "A", "A", "C"]);
    assert.deepEqual(scores[1]!.slice(-4), ["3", "3", "100", "Yes"]);
    assert.equal(scores[2]![scores[2]!.length - 4], "1", "sheet 2 earned one of three");
  });

  test("rounds a percentage to a tenth, and shows a question the sheet does not carry as a dash", () => {
    const withEssay = testOf([choice("One", 0), choice("Two", 0), choice("Three", 0), createQuestion({ type: "essay", stem: plainToRich("Discuss."), body: {}, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}` })], { versions: 1 });
    const one: SettledSheet[] = [{ number: 1, version: 1, answers: { 1: { kind: "marked", places: [0], by: "reader" }, 2: { kind: "marked", places: [1], by: "reader" }, 3: { kind: "marked", places: [1], by: "reader" } }, problems: [] }];
    const o = exportResults(withEssay, one, [], itemStatistics(withEssay, scoreSheets(withEssay, one)), "2026-11-04");
    const row = readXlsx(o.xlsx).sheets[0]!.rows[1]!.cells;
    assert.deepEqual(row.slice(3, 7), ["A", "B", "B", "-"], "the essay has no bubbles");
    assert.deepEqual(row.slice(-4), ["1", "3", "33.3", "Yes"], "a third is 33.3 percent and not 33.333333");
    assert.match(o.csv, /,1,3,33\.3,Yes\r\n$/);
  });

  test("writes the key of each version, the adjustments with the sheets each changed, and the item statistics", () => {
    const wb = readXlsx(out.xlsx);
    const key = wb.sheets[1]!.rows.map((r) => r.cells);
    assert.deepEqual(key[0], ["Question", "Points", "Version A", "Version B"]);
    assert.equal(key[1]![2], "B");
    assert.equal(key.length, 5);
    const adj = wb.sheets[2]!.rows.map((r) => r.cells);
    assert.deepEqual(adj[0], ["Question", "Adjustment", "Versions", "Sheets changed", "Note", "Date"]);
    assert.match(adj[1]![0] as string, /^2\. A <b>risky<\/b>/);
    assert.deepEqual(adj[1]!.slice(1, 5), ["Dropped from the total", "All", "4", "Ambiguous wording"]);
    const items = wb.sheets[3]!.rows.map((r) => r.cells);
    assert.deepEqual(items[0]!.slice(0, 4), ["Question", "Question text", "Sheets", "Difficulty"]);
    assert.equal(items.length >= 4, true);
    assert.ok(items.some((r) => r[0] === "Sheets used" && r[2] === "4"));
    assert.ok(items.some((r) => r[0] === "Note" && /Only 4 sheets: fewer than 30/.test(r[1] as string)));
    assert.ok(!items.some((r) => /risky/.test(r[1] as string) && r[0] === "2"), "the dropped question has no figures");
  });

  test("writes the scores as a CSV with a byte order mark and CRLF, quoting what needs it", () => {
    assert.ok(out.csv.startsWith("﻿Sheet,Version,Name,1,2,3,4,Earned,Possible,Percent,Settled\r\n"));
    const lines = out.csv.trimEnd().split("\r\n");
    assert.equal(lines.length, 5);
    assert.equal(lines[1], "1,A,,B,A,A,C,3,3,100,Yes");
    const unsettled = exportResults(record, [{ number: 1, version: 1, answers: { 1: { kind: "unsettled", why: "x" } }, problems: ["Page 2 could not be read (cut off, blurred)."] }], [], itemStatistics(record, []), "2026-11-04");
    assert.ok(unsettled.csv.includes('"No: 4 questions not settled; Page 2 could not be read (cut off, blurred)."'), "a cell with a comma is quoted");
    assert.equal(out.base, "Unit 3- Cells & Tissues - Scores 2026-11-04");
  });

  test("says where a sheet is not settled, and which answers are not on the sheet", () => {
    const partial: SettledSheet[] = [{ number: 1, version: 1, answers: { 1: { kind: "marked", places: [0, 2], by: "person" }, 2: { kind: "unsettled", why: "faint" }, 3: { kind: "blank", by: "reader" } }, problems: [] }];
    const o = exportResults(record, partial, [], itemStatistics(record, scoreSheets(record, partial)), "2026-11-04");
    const row = readXlsx(o.xlsx).sheets[0]!.rows[1]!.cells;
    assert.deepEqual(row.slice(3, 7), ["AC", "?", "", ""]);
    assert.match(row[row.length - 1] as string, /^No: 2 questions not settled/);
  });

  test("makes the item analysis a page with a block for each question, escaped, with the figures and the counts", () => {
    const html = itemAnalysisHtml(record, itemStatistics(record, scoreSheets(record, sheets)), "2026-11-04");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Unit 3: Cells &amp; Tissues: item analysis<\/title>/);
    assert.match(html, /<h2>2\. A &lt;b&gt;risky&lt;\/b&gt; &amp; &quot;quoted&quot; stem<\/h2>/);
    assert.ok(!/<b>risky/.test(html), "the question's own words are never markup");
    assert.equal((html.match(/<section class="item">/g) ?? []).length, 4);
    assert.match(html, /4 sheets\. Difficulty 0\.\d\d\. Point-biserial/);
    assert.match(html, /Only 4 sheets: fewer than 30, so these figures are unstable/);
    assert.match(html, /<tr class="right"><td class="l">B &#10003;<\/td>/);
    assert.match(html, /@media print/);
    assert.ok(!/<script/i.test(html));
  });

  test("works out the effect of an adjustment on the exported sheets the same way as on screen", () => {
    const effect = adjustmentEffect(record, sheets, [], adjustments[0] as Adjustment);
    assert.equal(effect.changed.length, 4);
  });
});
