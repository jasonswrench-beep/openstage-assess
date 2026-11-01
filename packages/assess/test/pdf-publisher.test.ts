/**
 * Real PDF test banks, when they are on this machine.
 *
 * They are in fixtures/publisher/pdf, which is git-ignored, each with an .expected.json beside it written from the document and
 * not from the importer. The folder is read when it is there and skipped when it is not, as the Word chapters are, so the
 * coverage is here without the material ever entering the repository.
 *
 * PDF-TB-1 is the one that does not score in full, and what it does instead is held here so that it cannot get worse unnoticed:
 * its pages begin with a lecture outline whose eight numbered items are not questions. They are read as eight essays, each
 * flagged for review, and shift every question after them by eight places, which a score by position counts as every question
 * wrong. The questions themselves are read right, and are checked here as such.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreFile, type ExpectedFile } from "../src/harness/score.ts";
import { runHarness } from "../src/harness/run.ts";
import { pdfImporter } from "../src/import/pdf.ts";
import { verdictFrom } from "../src/model/findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const folder = join(here, "..", "..", "..", "fixtures", "publisher", "pdf");
const present = existsSync(folder) && readdirSync(folder).some((n) => n.endsWith(".expected.json"));
const skip = present ? false : "none there; the folder is git-ignored and local";

describe("real PDF test banks", () => {
  test("every one but the first scores in full, with the verdicts that were declared for it", { skip }, async () => {
    const scored = await runHarness(folder);
    assert.ok(scored.files.length >= 4);
    for (const file of scored.files.filter((f) => f.file !== "PDF-TB-1.pdf")) {
      assert.deepEqual(file.mismatches, [], `${file.file}: ${file.mismatches.map((m) => `${m.field} ${m.expected} vs ${m.actual}`).join("; ")}`);
      assert.equal(file.correct, file.expectedCount, file.file);
    }
  });

  test("the first reads all its 28 questions right, behind eight outline items that are read as essays and flagged", { skip: present && existsSync(join(folder, "PDF-TB-1.pdf")) ? false : "not there" }, () => {
    const expected = JSON.parse(readFileSync(join(folder, "PDF-TB-1.pdf.expected.json"), "utf8")) as ExpectedFile;
    const result = pdfImporter.parseBytes(new Uint8Array(readFileSync(join(folder, "PDF-TB-1.pdf"))), { file: "PDF-TB-1.pdf", at: "2026-01-01T00:00:00.000Z", author: "test" });
    const outline = result.questions.slice(0, 8);
    assert.equal(result.questions.length, 36);
    for (const q of outline) {
      assert.equal(q.type, "essay");
      assert.equal(verdictFrom(q.findings), "needsReview", "an outline item is never passed off as a parsed question");
    }
    const { orphans: _unused, ...rest } = expected;
    const score = scoreFile({ ...rest, file: "PDF-TB-1.pdf" }, { ...result, questions: result.questions.slice(8) });
    assert.deepEqual(score.mismatches, []);
    assert.equal(score.correct, 28);
  });
});
