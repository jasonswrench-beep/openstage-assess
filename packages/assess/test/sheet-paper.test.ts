/**
 * The paper for a test: the answer sheet, and a booklet and a key for each version. One function makes it for the app and for the command
 * line, so it is tested once, on what it makes and on what it says.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { printTestPaper } from "../src/sheets/paper.ts";
import { readSheetPdf } from "./support/pdf-ops.ts";
import { essayq, mcq, mixed, testOf, tfq } from "./support/sheet-fixtures.ts";

const AT = new Date("2026-01-01T00:00:00.000Z");
const pdf = (bytes: Uint8Array): string => Buffer.from(bytes.subarray(0, 5)).toString("latin1");

describe("the paper for a test", () => {
  const several = testOf([mcq(4), mcq(4), tfq(), essayq()], { versions: 2, name: "Quiz 3" });
  const one = testOf([mcq(4), mcq(4)], { versions: 1, name: "Quiz 1" });

  test("makes the shared answer sheet, and a booklet and a key for each version, named for the test", () => {
    const made = printTestPaper(several, {}, AT);
    assert.ok(made.ok);
    assert.deepEqual(
      made.files.map((f) => [f.kind, f.version ?? "", f.name]),
      [
        ["sheet", "", "Quiz 3 - Answer sheet.pdf"],
        ["booklet", "A", "Quiz 3 - Version A - Student copy.pdf"],
        ["key", "A", "Quiz 3 - Version A - Answer key.pdf"],
        ["booklet", "B", "Quiz 3 - Version B - Student copy.pdf"],
        ["key", "B", "Quiz 3 - Version B - Answer key.pdf"],
      ],
    );
    for (const f of made.files) assert.equal(pdf(f.bytes), "%PDF-", f.name);
    assert.equal(made.files[0]?.pages, 1);
    assert.ok(made.notes.some((n) => /question 4 has no bubbles/i.test(n)), "says what the sheet cannot carry");
  });

  test("makes a sheet for each version when asked, with the version printed on it, and one for a test of one version either way", () => {
    const each = printTestPaper(several, { sheet: "each", booklets: false, keys: false }, AT);
    assert.ok(each.ok);
    assert.deepEqual(each.files.map((f) => f.name), ["Quiz 3 - Answer sheet - Version A.pdf", "Quiz 3 - Answer sheet - Version B.pdf"]);
    const text = (i: number): string => readSheetPdf(each.files[i]!.bytes)[0]!.shapes.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text).join(" ");
    assert.match(text(0), /Version A/);
    assert.match(text(1), /Version B/);
    assert.doesNotMatch(text(0), /Version B/);
    const single = printTestPaper(one, { sheet: "each", booklets: false, keys: false }, AT);
    assert.ok(single.ok);
    assert.deepEqual(single.files.map((f) => f.name), ["Quiz 1 - Answer sheet.pdf"], "there is nothing to tell apart");
    assert.equal(single.files[0]?.version, undefined);
  });

  test("shows the version bubbles on the shared sheet of several versions, and none on a sheet of one", () => {
    const shared = printTestPaper(several, { booklets: false, keys: false }, AT);
    const alone = printTestPaper(one, { booklets: false, keys: false }, AT);
    assert.ok(shared.ok && alone.ok);
    const words = (bytes: Uint8Array): string => readSheetPdf(bytes)[0]!.shapes.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text).join(" ");
    assert.match(words(shared.files[0]!.bytes), /\bVersion\b/);
    assert.doesNotMatch(words(alone.files[0]!.bytes), /\bVersion\b/);
  });

  test("leaves out what was not asked for, and says a request for nothing is a request for nothing", () => {
    const onlyKeys = printTestPaper(several, { sheet: "none", booklets: false, keys: true }, AT);
    assert.ok(onlyKeys.ok);
    assert.deepEqual(onlyKeys.files.map((f) => f.kind), ["key", "key"]);
    const none = printTestPaper(several, { sheet: "none", booklets: false, keys: false }, AT);
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.reason, /Choose something to print/);
  });

  test("makes the booklets and keys as Word as well, and never the sheet", () => {
    const made = printTestPaper(one, { formats: ["pdf", "docx"] }, AT);
    assert.ok(made.ok);
    assert.deepEqual(made.files.map((f) => `${f.kind}.${f.format}`), ["sheet.pdf", "booklet.pdf", "key.pdf", "booklet.docx", "key.docx"]);
    assert.equal(Buffer.from(made.files[3]!.bytes.subarray(0, 2)).toString("latin1"), "PK", "a Word file is a zip");
  });

  test("tells the student to mark the answer sheet only when a sheet is printed", () => {
    // A booklet's words are in a compressed stream, so the two are compared as files: the one printed for use with a sheet says to mark it.
    const withSheet = printTestPaper(one, { sheet: "shared", keys: false }, AT);
    const without = printTestPaper(one, { sheet: "none", keys: false }, AT);
    assert.ok(withSheet.ok && without.ok);
    assert.notDeepEqual(Array.from(withSheet.files.find((f) => f.kind === "booklet")!.bytes), Array.from(without.files.find((f) => f.kind === "booklet")!.bytes), "the two booklets are not the same page");
  });

  test("makes large print and A4 sheets, and refuses a test a sheet cannot be made for with the reason", () => {
    const large = printTestPaper(mixed(60), { large: true, booklets: false, keys: false }, AT);
    assert.ok(large.ok);
    assert.ok((large.files[0]?.pages ?? 0) >= 2, "large print takes more pages");
    const a4 = printTestPaper(one, { paper: "a4", booklets: false, keys: false }, AT);
    assert.ok(a4.ok);
    // Large print takes 51 questions a page and a test at most eight pages, so 420 questions fit in standard print and not in large.
    const long = testOf(Array.from({ length: 420 }, () => mcq(4)));
    assert.ok(printTestPaper(long, { booklets: false, keys: false }, AT).ok);
    const crowded = printTestPaper(long, { large: true, booklets: false, keys: false }, AT);
    assert.equal(crowded.ok, false);
    assert.match(crowded.ok ? "" : crowded.reason, /answer sheet for this test cannot be made/);
  });

  test("leaves the name box off when asked", () => {
    const withBox = printTestPaper(one, { booklets: false, keys: false }, AT);
    const without = printTestPaper(one, { booklets: false, keys: false, nameBox: false }, AT);
    assert.ok(withBox.ok && without.ok);
    const words = (bytes: Uint8Array): string => readSheetPdf(bytes)[0]!.shapes.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text).join(" ");
    assert.match(words(withBox.files[0]!.bytes), /\bName\b/);
    assert.doesNotMatch(words(without.files[0]!.bytes), /\bName\b/);
  });
});
