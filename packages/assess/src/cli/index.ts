#!/usr/bin/env node
/**
 * The OpenAssess command-line tool.
 *
 * Phase 1 and phase 2 have no user interface on purpose: the 95 percent parse
 * target cannot be iterated on through one. This is how the engine is driven
 * until the Tauri shell arrives in phase 3, and it stays afterwards as the way
 * the harness runs in continuous integration.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BANK_EXTENSION, PRODUCT_NAME, ENGINE_VERSION } from "../naming.ts";
import { Bank, countMismatchMessage } from "../bank/store.ts";
import { cannotRead } from "../import/cannot-read.ts";
import { importerForContent, runImporter } from "../import/registry.ts";
import { linesToBlocks, verdictOf } from "../import/types.ts";
import { docxToBlocks } from "../import/word.ts";
import { reviewHtml } from "../report/review-html.ts";
import { formatSummary, summarise } from "../harness/score.ts";
import { runHarness, TARGET_SCORE } from "../harness/run.ts";
import { validateQuestion } from "../model/schema.ts";
import { liveFindings } from "../model/findings.ts";
import { QUALITY_CODES } from "../quality/items.ts";
import { COVERAGE_AXES, coverage, isCoverageAxis } from "../bank/coverage.ts";
import { describeDraw, drawBlueprint, newBlueprint, type Blueprint } from "../bank/blueprint.ts";
import { allCapabilities, READ_CONTRACT_VERSION, typeVerdicts } from "../read/index.ts";
import { QUESTION_TYPES } from "../model/question.ts";
import { createQuestion } from "../model/create.ts";
import { localId } from "../model/ids.ts";
import { formatReport } from "../export/types.ts";
import { DESTINATION_ID, exportOpenStageSpreadsheet } from "../export/openstage-spreadsheet.ts";
import { D2L_CSV_ID, exportD2lCsv } from "../export/d2l-csv.ts";
import { BLACKBOARD_UPLOAD_ID, exportBlackboardUpload } from "../export/blackboard-upload.ts";
import { exportQti12, QTI12_ID } from "../export/qti12.ts";
import { exportQti21, QTI21_ID } from "../export/qti21.ts";
import { COMMON_CARTRIDGE_ID, exportCommonCartridge } from "../export/common-cartridge.ts";
import { exportGift, GIFT_ID } from "../export/gift.ts";
import { exportMoodleXml, MOODLE_XML_ID } from "../export/moodle-xml.ts";
import type { ExportResult } from "../export/types.ts";
import { printOptions, printTest } from "../print/index.ts";
import type { Question } from "../model/question.ts";
import { formatGate, runSheetGate } from "../sheets/gate.ts";
import { imageFingerprint } from "../sheets/image.ts";
import { openScans } from "../sheets/intake.ts";
import { assembleBatch, type BatchEntry, type BatchSheet } from "../sheets/batch.ts";
import { adjustmentWords, scoreSheets, settleSheets, type Adjustment, type Decision } from "../sheets/score.ts";
import { itemStatistics } from "../sheets/stats.ts";
import { exportResults, itemAnalysisHtml } from "../sheets/results-export.ts";
import { newScoresFile, readScoresFile, restore, scoresFileName, writeScoresFile } from "../sheets/scores-file.ts";
import { administrationFrom } from "../model/statistics.ts";
import { answerAt, versionQuestions, type TestRecord } from "../model/test.ts";
import { safeName } from "../export/text.ts";
import { SheetReader } from "../sheets/read.ts";
import { checkPrinting } from "../sheets/check-print.ts";
import { printTestPaper } from "../sheets/paper.ts";

const USAGE = `${PRODUCT_NAME} engine ${ENGINE_VERSION}

  openassess info <bank${BANK_EXTENSION}>
      Manifest, counts by type and status, finding totals.

  openassess validate <bank${BANK_EXTENSION}>
      Check every question against the model and report what fails.

  openassess new <bank${BANK_EXTENSION}> --title "Course bank"
      Create an empty bank.

  openassess import <file.txt|file.docx|file.gift|file.aiken|file.xml|file.zip|file.imscc|file.csv> [--out <bank${BANK_EXTENSION}>] [--details] [--key-mark <mark>]
      Read a file (the standard test-bank format, Aiken or GIFT as text, Moodle XML, a QTI file or package, a
      Common Cartridge .imscc, a question table or a Brightspace question library as .csv, a Blackboard upload file as .txt, or a Word .docx) and report the verdicts. A .txt file is told apart by what is
      in it. With --out, write the questions into a new bank.
      A Word file may mark the correct option by formatting it. The file is
      read to see whether it does, and the report says what was decided.
      --key-mark overrides that: off, bold, italic, underline, highlight,
      highlight:yellow, color, or color:FF0000. Put label: in front (label:bold)
      for a mark on the option letter alone, as some publishers use.

  openassess print <bank${BANK_EXTENSION}> [--kind student|key|both] [--format docx|pdf] [--paper letter|a4] [--out <folder>]
      Say what a printed test holds (a student copy, an answer key) and, with
      --out, write it as a Word file or a PDF. The student copy shows no answer.
      The key marks only what the bank records, and says when it records none.

  openassess review <file> [--out <review.html>] [--key-mark <mark>]   (a .docx, .xlsx, .csv, .pdf, .txt, .aiken, .gift Moodle .xml or QTI .xml, .zip or .imscc file)
      Read a file as import does and write one web page that shows each question
      with its answer, its checks and the lines of the file it came from, then
      the text no question used. Open the page in any browser. Nothing is
      written to a bank and the file is not changed.

  openassess export <bank${BANK_EXTENSION}> [--to ${DESTINATION_ID}|${GIFT_ID}|${MOODLE_XML_ID}|${D2L_CSV_ID}|${QTI12_ID}|${QTI21_ID}|${COMMON_CARTRIDGE_ID}|${BLACKBOARD_UPLOAD_ID}] [--out <folder>]
      Run the destination check for a format: the question spreadsheet that
      OpenStage Author and Scroll read (the default), GIFT, Moodle XML,
      Brightspace's CSV, a QTI 1.2 package (Brightspace and Canvas), a QTI 2.1 package (Canvas and Brightspace's Course Import), a
      Common Cartridge package (Brightspace), or Blackboard's upload file. It says what will arrive, what will be lost,
      what cannot go. With --out, write the file or files into that folder.

  openassess check <bank${BANK_EXTENSION}> [--save]
      Look at every question for notes about its writing and its accessibility (an option that
      says "all of the above", the longest answer being the right one, a NOT that is not set
      apart, a picture described with its own answer), and across the bank for the same question
      twice and for right answers that sit in one place too often. They are notes: nothing is
      changed and the exit code is 0. With --save the notes are written to the questions, as
      Check quality in the app does; the version, history and status of a question stay as they were.

  openassess coverage <bank${BANK_EXTENSION}> [--rows objective] [--cols bloom] [--retired]
      What the bank covers: how many questions for each value of two things set against each other
      (objective, chapter, section, tag, bloom, difficulty, type or status). A question with no value is
      counted under (none), so the grid shows how much is not yet tagged. Retired questions are left
      out unless --retired. Nothing is changed.

  openassess blueprint <bank${BANK_EXTENSION}> list
  openassess blueprint <bank${BANK_EXTENSION}> add <name> --rule <axis>=<value>:<count> [--rule ...]
  openassess blueprint <bank${BANK_EXTENSION}> draw <name> [--seed <text>]
  openassess blueprint <bank${BANK_EXTENSION}> remove <name>
      A blueprint is a recipe for a test that the bank keeps: each rule is a value on one axis (objective, chapter,
      section, tag, bloom, difficulty or type) and how many questions to take that have it, as in
      --rule "chapter=Chapter 1:5" --rule bloom=apply:2. A rule may ask for values on several axes together, joined
      with "and": --rule "chapter=Chapter 2 and bloom=apply:3" takes three from chapter 2 that are at the apply level
      (a cell of the grid "assess coverage" shows). "draw" shows the questions the recipe takes (the same seed
      takes the same ones) and, for a rule that found fewer than it wanted, how many short and why; it writes nothing
      and never fills a rule up from another value. "add" and "remove" change the bank. A retired question, one with
      no usable answer key and a copy of one already taken are never taken.

  openassess search <bank${BANK_EXTENSION}> <words...>
      Search a bank.

  openassess score [fixtures directory] [--details]
      Run the accuracy harness. Exits non-zero below ${(TARGET_SCORE * 100).toFixed(0)} percent.

  openassess sheets gate [--sheets 60] [--seed gate-1] [--only synthetic|damaged]
      The accuracy gate for the answer sheet reader. Sheets with known answers are
      drawn, filled in like a student's, damaged like a scan or a photograph, and read.
      An answer read wrong without a flag fails it. Exit code 1 on failure.

  openassess sheets print <bank${BANK_EXTENSION}> --out <folder> [--test <id or name>] [--paper letter|a4] [--sheet shared|each|none] [--large] [--no-booklets] [--no-keys] [--docx] [--no-name-box]
      Write the paper for an assembled test: the answer sheet (a PDF, one for every version or
      one for each), and a student booklet and an answer key for each version. The booklets and
      keys are PDF, or Word with --docx. A file already in the folder is never written over.

  openassess sheets read <bank${BANK_EXTENSION}> <picture.png|scan.pdf|folder...> [--test <id or name>] [--json]
      Read scanned answer sheets against a test in the bank. One picture is shown in
      full: its version, each question's answer, and every question that needs a
      person to look. Several (a scanned PDF, a folder) are put into sheets in the
      order they came, and what is wrong with the batch is said: the same picture
      twice, a page 2 with no page 1, pages in the wrong order. A PDF is read where
      each page is one picture; the setting to change is said when it is not.

  openassess sheets check <bank${BANK_EXTENSION}> <picture.png|scan.pdf> [--test <id or name>]
      Check my printing: read a scan of a blank printed copy of the sheet, and say
      whether the printer, the paper and the scanner are doing what the reading needs.

  openassess sheets score <bank${BANK_EXTENSION}> <picture.png|scan.pdf|folder...> [--test <id or name>] [--accept-blanks] [--drop N] [--credit N] [--points N:P] [--also-right N:L] [--out <folder>] [--save-statistics]
      Read the scans as read does, settle what the reader was sure of, score every sheet against
      the test's own key, and show the scores and the item statistics. A flagged question is
      undecided and earns nothing, and is counted: use the app's review to settle it.
      --accept-blanks takes a row the reader found blank as blank. The adjustments name a question
      by its number in version A: drop it from the total, give everyone credit, change its points,
      or count another letter as right as well. With --out, write the scores file, a workbook, a
      CSV and the item analysis page. --save-statistics keeps the class-level figures in the bank.

  openassess sheets rescore <bank${BANK_EXTENSION}> <file.openassess-scores> [the same adjustments and options]
      Score again from a saved scores file, with its decisions and adjustments and any more given
      here, with no rescan.

  openassess perf [--count 500]
      Build a bank of N questions and time open, search and save.

  openassess contract
      Print the read contract version and what each consumer can deliver.
`;

function arg(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

/** Every value given for a flag that may be given more than once. */
function all(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1] as string);
  });
  return out;
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i] as string;
    if (value.startsWith("--")) {
      // Flags that take a value consume the next item.
      if (["out", "title", "count", "profile", "to", "key-mark", "sheets", "seed", "only", "test", "date", "drop", "credit", "points", "also-right", "paper", "sheet", "rows", "cols", "rule"].includes(value.slice(2))) i++;
      continue;
    }
    out.push(value);
  }
  return out;
}

async function cmdInfo(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const { bank, report } = await Bank.open(resolve(path));
  const stats = bank.stats();

  console.log(`${bank.manifest.title}  (${bank.manifest.bankId})`);
  console.log(`  format        ${bank.manifest.format} v${bank.manifest.formatVersion}`);
  console.log(`  created       ${bank.manifest.created}`);
  console.log(`  modified      ${bank.manifest.modified}`);
  console.log(`  questions     ${stats.questions}`);
  console.log(`  total points  ${stats.totalPoints}`);
  console.log(`  media files   ${stats.mediaFiles}`);
  console.log(`  opened in     ${report.elapsedMs.toFixed(1)} ms`);

  if (Object.keys(stats.byType).length > 0) {
    console.log("\n  by type");
    for (const [type, count] of Object.entries(stats.byType).sort()) {
      console.log(`    ${type.padEnd(18)} ${count}`);
    }
  }
  if (Object.keys(stats.byStatus).length > 0) {
    console.log("\n  by status");
    for (const [status, count] of Object.entries(stats.byStatus).sort()) {
      console.log(`    ${status.padEnd(18)} ${count}`);
    }
  }
  console.log(`\n  questions with errors    ${stats.withErrors}`);
  console.log(`  questions with warnings  ${stats.withWarnings}`);

  if (report.invalid.length > 0) {
    console.log(`\n  ${report.invalid.length} question file(s) could not be read and were kept untouched:`);
    for (const entry of report.invalid) console.log(`    ${entry.id}`);
  }
  if (report.countMismatch) console.log(`\n  ${countMismatchMessage(report.countMismatch)}`);
  if (report.migratedFrom !== undefined) {
    console.log(`\n  migrated from format version ${report.migratedFrom}`);
    for (const note of report.migrationNotes) console.log(`    ${note}`);
  }
  return 0;
}

async function cmdValidate(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const { bank, report } = await Bank.open(resolve(path));

  let bad = 0;
  for (const question of bank.sortedQuestions()) {
    const result = validateQuestion(question);
    if (result.ok) continue;
    bad++;
    console.log(`${question.id}  ${question.title}`);
    for (const issue of result.issues) console.log(`    ${issue.path || "<root>"}: ${issue.message}`);
  }
  for (const entry of report.invalid) {
    bad++;
    console.log(`${entry.id}  (unreadable)`);
    for (const issue of entry.issues) console.log(`    ${issue.path || "<root>"}: ${issue.message}`);
  }
  if (report.countMismatch) {
    bad++;
    console.log(`(the bank as a whole)\n    ${countMismatchMessage(report.countMismatch)}`);
  }

  if (bad === 0) {
    console.log(`All ${bank.questions.size} questions satisfy the model.`);
    return 0;
  }
  console.log(`\n${bad} question(s) do not satisfy the model.`);
  return 1;
}

async function cmdNew(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name the bank file to create.");
  const title = arg(args, "title") ?? basename(path, BANK_EXTENSION);
  const bank = Bank.createEmpty(title);
  const written = await bank.save(resolve(path));
  console.log(`Created ${written}`);
  console.log(`  bank id ${bank.manifest.bankId}`);
  return 0;
}

async function cmdImport(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a file to import.");
  const full = resolve(path);
  const cannot = cannotRead(full);
  if (cannot) return fail(cannot);
  // A .txt file may be the Standard Format, Aiken or GIFT, and is told by what is in it. A file with an extension no importer
  // claims is read as the plain-text format, as it always was.
  const bytes = await readInput(full);
  const importer = importerForContent(full, bytes);
  const keyMark = arg(args, "key-mark");
  const result = runImporter(importer, bytes, { file: basename(full), ...(keyMark ? { keyMark } : {}) });

  console.log(`${result.file}  profile ${result.profile}`);
  console.log(`  parsed        ${result.counts.parsed}`);
  console.log(`  needs review  ${result.counts.needsReview}`);
  console.log(`  failed        ${result.counts.failed}`);
  console.log(`  orphan blocks ${result.counts.orphans}`);

  for (const f of result.fileFindings) console.log(`  [${f.severity}] ${f.message}`);

  if (has(args, "details")) {
    for (const question of result.questions) {
      const verdict = verdictOf(question);
      if (verdict === "parsed") continue;
      const source = question.origin?.source;
      const where = source ? ` (lines ${source.firstBlock + 1}-${source.lastBlock + 1})` : "";
      console.log(`\n  ${verdict.toUpperCase()}  ${question.title}${where}`);
      for (const f of liveFindings(question.findings)) {
        console.log(`    [${f.severity}] ${f.message}`);
      }
    }
    for (const orphan of result.orphans) {
      console.log(`\n  ORPHAN  line ${orphan.source.firstBlock + 1}: ${orphan.text}`);
      console.log(`    ${orphan.reason}`);
    }
  }

  const out = arg(args, "out");
  if (out) {
    const bank = Bank.createEmpty(basename(out, BANK_EXTENSION));
    for (const question of result.questions) bank.add(question, result.media ? { media: result.media } : {});
    const written = await bank.save(resolve(out));
    console.log(`\nWrote ${result.questions.length} question(s) to ${written}${bank.media.size > 0 ? `, with ${bank.media.size} picture(s)` : ""}`);
  }
  return result.counts.failed > 0 ? 1 : 0;
}

async function cmdPrint(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const kindArg = arg(args, "kind") ?? "both";
  const format = arg(args, "format") ?? "docx";
  const paper = arg(args, "paper") ?? "letter";
  if (!["student", "key", "both"].includes(kindArg)) return fail(`Unknown kind "${kindArg}". The kinds are student, key and both.`);
  if (format !== "docx" && format !== "pdf") return fail(`Unknown format "${format}". The formats are docx and pdf.`);
  if (paper !== "letter" && paper !== "a4") return fail(`Unknown paper "${paper}". The papers are letter and a4.`);

  const { bank } = await Bank.open(resolve(path));
  const questions = bank.sortedQuestions().filter((q) => q.metadata.status !== "retired");
  const out = arg(args, "out");
  let wrote = 0;
  for (const kind of kindArg === "both" ? (["student", "key"] as const) : [kindArg as "student" | "key"]) {
    const result = printTest(questions, printOptions({ title: bank.manifest.title, kind, paper, media: bank.media }), format);
    const report = result.report;
    console.log(`${kind === "key" ? "Answer key" : "Student copy"}: ${report.total} question(s), ${report.exported} print as written, ${report.exportedWithLosses} with a note, ${report.leftOut} cannot be printed.`);
    for (const item of report.items) for (const note of item.notes) console.log(`  #${item.position} ${note}`);
    if (out && result.file.bytes.length > 0) {
      const folder = resolve(out);
      await mkdir(folder, { recursive: true });
      const target = join(folder, result.file.name);
      await writeFile(target, result.file.bytes);
      console.log(`  Wrote ${target}`);
      wrote++;
    }
  }
  if (!out) console.log("\nNothing was written. Add --out <folder> to write the file.");
  else if (wrote === 0) {
    console.log("\nNo question could be printed, so no file was written.");
    return 1;
  }
  return 0;
}

async function cmdReview(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a file to review.");
  const full = resolve(path);
  const extension = extname(full).toLowerCase();
  const cannot = cannotRead(full);
  if (cannot) return fail(cannot);
  const bytes = await readInput(full);
  const importer = importerForContent(full, bytes);
  const keyMark = arg(args, "key-mark");
  const result = runImporter(importer, bytes, { file: basename(full), ...(keyMark ? { keyMark } : {}) });

  // The lines as the importer saw them, so that a question's block numbers point at the same lines on the page. A list
  // number Word supplies is shown in front of its line, as it was read.
  // A table's lines are its rows and a PDF's are its paragraphs, and the importer says so itself.
  const source =
    result.sourceLines ??
    (extension === ".docx"
      ? docxToBlocks(bytes).blocks.map((b) => `${b.listLabel ? `${b.listLabel} ` : ""}${b.text}`)
      : linesToBlocks(Buffer.from(bytes).toString("utf8")).map((b) => b.text));

  const out = resolve(arg(args, "out") ?? `${basename(full, extname(full))}-review.html`);
  await writeFile(out, reviewHtml(result, source), "utf8");
  const { counts } = result;
  console.log(`${result.file}: ${result.questions.length} question(s), ${counts.parsed} parsed, ${counts.needsReview} need review, ${counts.failed} failed, ${counts.orphans} line(s) no question used.`);
  console.log(`Wrote ${out}`);
  return 0;
}

/** Where a bank can be exported to: each takes the questions and a name, and answers with the files and the destination check. */
const EXPORTERS: Record<string, (questions: Question[], options: { name: string; media?: ReadonlyMap<string, Uint8Array> }) => ExportResult> = {
  [DESTINATION_ID]: exportOpenStageSpreadsheet,
  [GIFT_ID]: exportGift,
  [MOODLE_XML_ID]: exportMoodleXml,
  [D2L_CSV_ID]: exportD2lCsv,
  [QTI12_ID]: exportQti12,
  [QTI21_ID]: exportQti21,
  [COMMON_CARTRIDGE_ID]: exportCommonCartridge,
  [BLACKBOARD_UPLOAD_ID]: exportBlackboardUpload,
};

async function cmdExport(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const to = arg(args, "to") ?? DESTINATION_ID;
  const exporter = EXPORTERS[to];
  if (!exporter) return fail(`Unknown destination "${to}". The destinations are ${Object.keys(EXPORTERS).join(", ")}.`);

  const { bank } = await Bank.open(resolve(path));
  const result = exporter(bank.list(), { name: bank.manifest.title, media: bank.media });
  for (const line of formatReport(result.report)) console.log(line);

  const out = arg(args, "out");
  if (!out) {
    console.log("\nNothing was written. Add --out <folder> to write the file.");
    return 0;
  }
  if (result.files.length === 0) {
    console.log("\nNo question could be exported, so no file was written.");
    return 1;
  }
  const folder = resolve(out);
  await mkdir(folder, { recursive: true });
  for (const file of result.files) {
    const target = join(folder, file.name);
    await writeFile(target, file.bytes ?? file.content, "utf8");
    console.log(`\nWrote ${file.questions} question(s) to ${target}`);
  }
  return 0;
}

async function cmdCheck(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const { bank } = await Bank.open(resolve(path));
  const run = bank.checkQuality("openassess check");

  const noted = bank.sortedQuestions().flatMap((q) => {
    const live = q.findings.filter((f) => !f.dismissed && QUALITY_CODES.has(f.code));
    return live.length > 0 ? [{ q, live }] : [];
  });
  const total = Object.values(run.notes).reduce((sum, n) => sum + n, 0);
  console.log(`Checked ${run.checked} question(s). ${noted.length} have notes (${total} in all).`);
  for (const { q, live } of noted) {
    console.log(`\n${q.id}  ${q.title}`);
    for (const f of live) console.log(`    ${f.message}`);
  }

  const { duplicates, keyBalance, limits } = run.report;
  if (duplicates.length > 0) {
    console.log(`\nThe same question more than once:`);
    for (const group of duplicates) console.log(`    ${group.message}`);
  }
  if (keyBalance.length > 0) {
    console.log(`\nWhere the right answers sit:`);
    for (const note of keyBalance) console.log(`    ${note.message}`);
  }
  // Said whether or not anything else was: a check that was held back is not a check that found nothing.
  if (limits.length > 0) {
    console.log(`\nWhat the check could not do in full:`);
    for (const limit of limits) console.log(`    ${limit.message}`);
  }
  if (noted.length === 0 && duplicates.length === 0 && keyBalance.length === 0 && limits.length === 0) console.log("Nothing to note.");

  if (has(args, "save")) {
    await bank.save();
    console.log(`\nThe notes were written to ${resolve(path)}.`);
  } else if (run.changed > 0) {
    console.log(`\nNothing was written. Add --save to keep these notes on the questions.`);
  }
  return 0;
}

async function cmdCoverage(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const rows = arg(args, "rows") ?? "objective";
  const cols = arg(args, "cols") ?? "bloom";
  if (!isCoverageAxis(rows) || !isCoverageAxis(cols)) return fail(`Choose from ${COVERAGE_AXES.join(", ")} for --rows and --cols.`);
  const { bank } = await Bank.open(resolve(path));
  const grid = coverage(bank.sortedQuestions(), rows, cols, { includeRetired: has(args, "retired") });
  if (grid.total === 0) {
    console.log("There are no questions to count.");
    return 0;
  }

  const head = ["", ...grid.colLabels, "Total"];
  const body = grid.rowLabels.map((label, r) => [label, ...(grid.cells[r] as number[]).map(String), String(grid.rowTotals[r])]);
  const foot = ["Total", ...grid.colTotals.map(String), String(grid.total)];
  const table = [head, ...body, foot];
  const widths = head.map((_, c) => table.reduce((most, row) => Math.max(most, (row[c] as string).length), 0));
  const line = (row: string[]) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c] as number) : cell.padStart(widths[c] as number))).join("  ");
  console.log(`${grid.total} question(s), ${rows} down and ${cols} across.\n`);
  for (const row of table) console.log(line(row));
  if (rows === "tag" || cols === "tag") console.log("\nA question with several tags is counted under each, so the totals can be more than the number of questions.");
  return 0;
}

/**
 * A rule as written on the command line: axis=value:count, or several values that must all hold, joined with "and" (axis=value and
 * axis=value:count). The value may hold a colon or an equals sign, so the count is after the last colon, and the word "and" splits
 * only where an axis name and an equals sign follow it, so "type=Rock and Roll:2" is one value.
 */
function parseRule(text: string): { axis: string; value: string; count: number; and?: Array<{ axis: string; value: string }> } | string {
  const colon = text.lastIndexOf(":");
  const bad = `"${text}" is not a rule. Write it as axis=value:count, such as chapter=Chapter 1:5, or chapter=Chapter 2 and bloom=apply:3.`;
  if (colon < 1) return bad;
  const countText = text.slice(colon + 1).trim();
  if (!/^[0-9]+$/.test(countText)) return `The rule "${text}" has no number of questions after the last colon.`;
  const split = new RegExp(`\\s+and\\s+(?=(?:${COVERAGE_AXES.join("|")})\\s*=)`, "i");
  const pairs: Array<{ axis: string; value: string }> = [];
  for (const part of text.slice(0, colon).split(split)) {
    const eq = part.indexOf("=");
    if (eq < 1) return bad;
    const axis = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!isCoverageAxis(axis)) return `"${axis}" is not something a rule can be by. Choose from ${COVERAGE_AXES.join(", ")}.`;
    if (value === "") return `The rule "${text}" has no value. A blank value would match every question. (The blank one is the value for ${axis}.)`;
    // "and" splits only before a known axis name, so a mistyped one (colour=red) would stay inside the value and match nothing, and
    // read as a bank that was short. It is refused instead, by the word that was not an axis.
    // (?<!\s): the match begins at the start of a run of white space and not at every character of it, which read the run again each time.
    const odd = /(?<!\s)\s+and\s+([A-Za-z]+)\s*=/.exec(value);
    if (odd) return `The rule "${text}" joins values with "and", and "${odd[1]}" is not something a rule can be by. Choose from ${COVERAGE_AXES.join(", ")}.`;
    pairs.push({ axis, value });
  }
  const [first, ...rest] = pairs as [{ axis: string; value: string }, ...Array<{ axis: string; value: string }>];
  return { ...first, count: Number(countText), ...(rest.length > 0 ? { and: rest } : {}) };
}

/** A rule in a line for a person: "5 where chapter is Chapter 1", or "3 where chapter is Chapter 2 and bloom is apply". */
function ruleLine(rule: { axis: string; value: string; count: number; and?: ReadonlyArray<{ axis: string; value: string }> }): string {
  return `${rule.count} where ${[{ axis: rule.axis, value: rule.value }, ...(rule.and ?? [])].map((c) => `${c.axis} is ${c.value}`).join(" and ")}`;
}

/** A blueprint is found by its name, in any case, or by its id. */
function findBlueprint(bank: Bank, key: string): Blueprint | undefined {
  const wanted = key.trim().toLocaleLowerCase();
  return bank.listBlueprints().find((b) => b.id === key || b.name.trim().toLocaleLowerCase() === wanted);
}

async function cmdBlueprint(args: string[]): Promise<number> {
  const [path, action, ...rest] = positional(args);
  if (!path || !action) return fail("Name a bank file and what to do: list, add, draw or remove.");
  const target = resolve(path);
  const { bank } = await Bank.open(target);

  if (action === "list") {
    const kept = bank.listBlueprints();
    if (kept.length === 0) console.log("This bank holds no blueprint.");
    for (const b of kept) {
      console.log(`${b.name}  (${b.id})`);
      for (const r of b.rules) console.log(`    ${ruleLine(r)}`);
    }
    return 0;
  }

  const name = rest.join(" ").trim();
  if (name === "") return fail(`Say which blueprint to ${action}.`);

  if (action === "add") {
    const given = all(args, "rule");
    if (given.length === 0) return fail("Give at least one rule, such as --rule chapter=Chapter 1:5.");
    const rules: Array<NonNullable<Exclude<ReturnType<typeof parseRule>, string>>> = [];
    for (const text of given) {
      const rule = parseRule(text);
      if (typeof rule === "string") return fail(rule);
      rules.push(rule);
    }
    try {
      const made = bank.addBlueprint(newBlueprint({ name, rules }));
      await bank.save();
      console.log(`Kept the blueprint "${made.name}" in ${target}.`);
    } catch (error) {
      return fail((error as Error).message);
    }
    return 0;
  }

  const found = findBlueprint(bank, name);
  if (!found) return fail(`This bank holds no blueprint called "${name}". "openassess blueprint <bank> list" shows what it has.`);

  if (action === "remove") {
    bank.removeBlueprint(found.id);
    await bank.save();
    console.log(`Took the blueprint "${found.name}" out of ${target}. No test and no question was changed by it.`);
    return 0;
  }

  if (action === "draw") {
    const seed = arg(args, "seed") ?? randomBytes(6).toString("hex");
    const questions = bank.sortedQuestions();
    const draw = drawBlueprint(questions, found, { seed });
    const byId = new Map(questions.map((q) => [q.id, q] as const));
    console.log(`${found.name}, seed ${seed}`);
    for (const r of draw.rules) {
      console.log(`\n${ruleLine(r.rule)}:`);
      for (const id of r.ids) console.log(`    ${id}  ${byId.get(id)?.title ?? ""}`);
      if (r.ids.length === 0) console.log("    (none)");
    }
    console.log(`\n${describeDraw(draw).join("\n")}`);
    console.log("Nothing was written.");
    return 0;
  }

  return fail(`Unknown action "${action}". Choose list, add, draw or remove.`);
}

async function cmdSearch(args: string[]): Promise<number> {
  const [path, ...words] = positional(args);
  if (!path || words.length === 0) return fail("Name a bank file and something to search for.");
  const { bank } = await Bank.open(resolve(path));
  const started = performance.now();
  const hits = bank.search(words.join(" "));
  const elapsed = performance.now() - started;

  console.log(`${hits.length} of ${bank.questions.size} question(s) in ${elapsed.toFixed(2)} ms\n`);
  for (const question of hits.slice(0, 40)) {
    console.log(`  ${question.id}  [${question.type}]  ${question.title}`);
  }
  if (hits.length > 40) console.log(`  ... and ${hits.length - 40} more`);
  return 0;
}

/**
 * The corpus lives at the repository root, and this file lives four levels
 * below it. Resolving the default against the working directory instead made
 * the command find nothing whenever it was run through the workspace script,
 * which is how it is run in practice.
 */
function defaultFixtures(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "fixtures", "standard-format");
}

async function cmdScore(args: string[]): Promise<number> {
  const given = positional(args)[0];
  const directory = given ? resolve(given) : defaultFixtures();
  const run = await runHarness(directory);

  if (run.directoryMissing) {
    console.log(`No fixture directory at ${directory}.`);
    console.log("The gate did not run, so nothing was measured.");
    return 1;
  }
  if (run.files.length === 0) {
    console.log(`No scored fixtures in ${directory}.`);
    return 1;
  }

  console.log(formatSummary(summarise(run.files), { showMismatches: has(args, "details") }));

  if (run.unscored.length > 0) {
    console.log(`\nNot scored (no .expected.json beside them): ${run.unscored.join(", ")}`);
  }
  if (run.missingSources.length > 0) {
    console.log(`\nExpected files with no source: ${run.missingSources.join(", ")}`);
  }

  const score = summarise(run.files).score;
  const target = `${(TARGET_SCORE * 100).toFixed(0)}%`;
  if (score < TARGET_SCORE) {
    console.log(`\nBelow the ${target} target. Run again with --details to see every mismatch.`);
    return 1;
  }
  console.log(`\nAt or above the ${target} target.`);
  return 0;
}

async function cmdPerf(args: string[]): Promise<number> {
  const count = Number(arg(args, "count") ?? 500);
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { unlink } = await import("node:fs/promises");

  const bank = Bank.createEmpty(`Performance bank of ${count}`);
  const builtStarted = performance.now();
  for (let i = 0; i < count; i++) {
    bank.add(
      createQuestion({
        type: "multipleChoice",
        stem: `Question ${i + 1}: which of the following best describes concept ${i + 1} in chapter ${(i % 12) + 1}?`,
        points: 1,
        metadata: { chapter: String((i % 12) + 1), tags: [`unit-${(i % 4) + 1}`], status: "draft" },
        body: {
          shuffle: true,
          options: [0, 1, 2, 3].map((j) => ({
            id: localId("o", j),
            content: { format: "plain" as const, content: `Option ${j + 1} for question ${i + 1}` },
            correct: j === i % 4,
          })),
        },
        at: "2026-01-01T00:00:00.000Z",
        by: "perf",
      }),
    );
  }
  const built = performance.now() - builtStarted;

  const path = join(tmpdir(), `openassess-perf-${process.pid}${BANK_EXTENSION}`);

  const saveStarted = performance.now();
  await bank.save(path);
  const saved = performance.now() - saveStarted;

  const openStarted = performance.now();
  const reopened = await Bank.open(path);
  const opened = performance.now() - openStarted;

  const searchStarted = performance.now();
  const hits = reopened.bank.search("concept 42");
  const searched = performance.now() - searchStarted;

  const { statSync } = await import("node:fs");
  const bytes = statSync(path).size;
  await unlink(path);

  const budget = 2000;
  const row = (label: string, ms: number) =>
    `  ${label.padEnd(22)} ${ms.toFixed(1).padStart(8)} ms   ${ms < budget ? "within" : "OVER"} the ${budget} ms budget`;

  console.log(`${count} questions, file size ${(bytes / 1024).toFixed(0)} KB\n`);
  console.log(row("build in memory", built));
  console.log(row("save", saved));
  console.log(row("open", opened));
  console.log(row("search", searched));
  console.log(`\n  search returned ${hits.length} question(s)`);
  console.log(`  ${reopened.bank.questions.size} question(s) read back`);

  return [saved, opened, searched].every((ms) => ms < budget) ? 0 : 1;
}

/** The test a command is about: named with --test, or the only one the bank has. */
function pickTest(bank: Bank, args: string[]): { test: ReturnType<Bank["listTests"]>[number] } | { error: string } {
  const tests = bank.listTests();
  const want = arg(args, "test");
  if (want) {
    const found = tests.find((t) => t.id === want) ?? tests.find((t) => t.name === want);
    return found ? { test: found } : { error: `This bank has no test "${want}". Its tests are: ${tests.map((t) => `${t.name} (${t.id})`).join(", ") || "none"}.` };
  }
  if (tests.length === 1) return { test: tests[0] as (typeof tests)[number] };
  return { error: tests.length === 0 ? "This bank has no assembled test, so there is no answer sheet to read." : `This bank has ${tests.length} tests. Name one with --test: ${tests.map((t) => `${t.name} (${t.id})`).join(", ")}.` };
}

/** The files a command was given: a file is itself, and a folder is the scans in it, by name. */
async function scanFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const full = resolve(p);
    const info = await stat(full);
    if (info.isDirectory()) {
      const names = (await readdir(full)).filter((n) => /\.(png|pdf|jpe?g|webp|gif|bmp|tiff?|heic)$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) out.push(join(full, n));
    } else out.push(full);
  }
  return out;
}

interface Opened {
  entry: BatchEntry;
  dpi?: number;
}

/** Every page of every file, read against a test, in the order given. A JPEG is left unread: the window decodes those. */
async function readScans(reader: SheetReader, files: string[]): Promise<Opened[]> {
  const out: Opened[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await readFile(file));
    const opened = openScans(bytes);
    const name = basename(file);
    if (!opened.ok) {
      out.push({ entry: { source: { file: name, page: 1 }, fingerprint: createHash("sha1").update(bytes).digest("hex"), result: { ok: false, cause: "quality", reason: opened.reason } } });
      continue;
    }
    for (const page of opened.pages) {
      const source = { file: name, page: page.page };
      if (!page.result.ok) {
        out.push({ entry: { source, fingerprint: createHash("sha1").update(bytes).update(String(page.page)).digest("hex"), result: { ok: false, cause: "quality", reason: page.result.reason } } });
      } else if (page.result.source.kind === "window") {
        const reason = `This ${page.result.source.format.toUpperCase()} is decoded by the app's window, which the command line does not have. Open it in the app, or save the scan as a PNG.`;
        out.push({ entry: { source, fingerprint: createHash("sha1").update(page.result.source.bytes).digest("hex"), result: { ok: false, cause: "quality", reason } } });
      } else {
        const image = page.result.source.image;
        out.push({ entry: { source, fingerprint: imageFingerprint(image), result: reader.read(image) }, ...(page.result.source.dpi !== undefined ? { dpi: page.result.source.dpi } : {}) });
      }
    }
  }
  return out;
}

async function cmdSheets(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "gate") {
    const only = arg(rest, "only");
    if (only !== undefined && only !== "synthetic" && only !== "damaged") return fail(`Unknown corpus "${only}". The corpora are synthetic and damaged.`);
    const sheets = Number(arg(rest, "sheets") ?? 60);
    if (!Number.isInteger(sheets) || sheets < 1) return fail("--sheets is a whole number of sheets for each corpus.");
    const report = runSheetGate({ sheets, seed: arg(rest, "seed") ?? "gate-1", only });
    console.log(formatGate(report));
    return report.passed ? 0 : 1;
  }
  if (sub === "print") {
    const [bankPath] = positional(rest);
    const out = arg(rest, "out");
    if (!bankPath || !out) return fail("Name a bank file and a folder: sheets print <bank> --out <folder>.");
    const paper = arg(rest, "paper") ?? "letter";
    if (paper !== "letter" && paper !== "a4") return fail(`--paper is letter or a4, not "${paper}".`);
    const sheet = arg(rest, "sheet") ?? "shared";
    if (sheet !== "shared" && sheet !== "each" && sheet !== "none") return fail(`--sheet is shared, each or none, not "${sheet}".`);
    const { bank } = await Bank.open(resolve(bankPath));
    const chosen = pickTest(bank, rest);
    if ("error" in chosen) return fail(chosen.error);
    const made = printTestPaper(chosen.test, { paper, sheet, large: has(rest, "large"), booklets: !has(rest, "no-booklets"), keys: !has(rest, "no-keys"), nameBox: !has(rest, "no-name-box"), formats: has(rest, "docx") ? ["docx"] : ["pdf"], media: bank.media });
    if (!made.ok) return fail(made.reason);
    const folder = resolve(out);
    await mkdir(folder, { recursive: true });
    for (const file of made.files) {
      // A file that is already there is never written over: the new one is named for the next free number.
      let name = file.name;
      for (let n = 2; await stat(join(folder, name)).then(() => true, () => false); n++) name = file.name.replace(/(\.[a-z]+)$/, ` ${n}$1`);
      await writeFile(join(folder, name), file.bytes);
      console.log(`  Wrote ${join(folder, name)}${file.pages ? ` (${file.pages} page${file.pages === 1 ? "" : "s"})` : ""}`);
    }
    for (const note of made.notes) console.log(`Note: ${note}`);
    for (const line of made.unprinted) console.log(`Not printed: ${line}`);
    if (made.files.some((f) => f.kind === "sheet")) console.log("Print the answer sheet at 100 percent (actual size), not fit to page, then use: sheets check.");
    return 0;
  }
  if (sub === "read" || sub === "check") {
    const [bankPath, ...scans] = positional(rest);
    if (!bankPath || scans.length === 0) return fail(`Name a bank file and a picture: sheets ${sub} <bank> <picture.png|scan.pdf|folder>.`);
    const { bank } = await Bank.open(resolve(bankPath));
    const chosen = pickTest(bank, rest);
    if ("error" in chosen) return fail(chosen.error);
    const reader = new SheetReader(chosen.test);
    const files = await scanFiles(scans);
    if (files.length === 0) return fail("There are no scans in what was named: a picture is a PNG, JPG or PDF file.");
    const opened = await readScans(reader, files);

    if (sub === "check") {
      // One blank copy: the first page given, read with the dots to the inch its file says, if it does.
      const first = files[0] as string;
      const one = openScans(new Uint8Array(await readFile(first)));
      if (!one.ok) {
        console.error(one.reason);
        return 1;
      }
      const page = one.pages[0];
      if (!page || !page.result.ok) {
        console.error(page && !page.result.ok ? page.result.reason : "There is no picture to check.");
        return 1;
      }
      if (page.result.source.kind !== "grey") {
        console.error("This is a JPEG, which the app's window decodes. From the command line, save the scan as a PNG or a PDF with no JPEG compression.");
        return 1;
      }
      const check = checkPrinting(reader, page.result.source.image, { dpi: page.result.source.dpi });
      for (const line of check.found) console.log(line);
      if (check.ok) console.log("\nThe printing is fine: a blank copy reads as blank, and the sheet is the size it was made.");
      else for (const problem of check.problems) console.log(`\nProblem: ${problem}`);
      return check.ok ? 0 : 1;
    }

    const results = opened.map((o) => o.entry);
    const read = results.filter((r) => r.result.ok);
    const pagesPerSheet = read.length > 0 ? (read[0]?.result as { code: { pages: number } }).code.pages : 1;
    // One picture is shown in full. A class of them is shown a sheet at a time, with what is wrong with the batch.
    if (results.length === 1) {
      const result = (results[0] as BatchEntry).result;
      if (has(rest, "json")) {
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }
      if (!result.ok) {
        console.log(`This page was not read (${result.cause}): ${result.reason}`);
        return 1;
      }
      const counts = { answered: 0, blank: 0, flagged: 0, notOnSheet: 0 };
      for (const q of result.questions) counts[q.status]++;
      const hex = result.code.test.toString(16).toUpperCase().padStart(5, "0");
      console.log(`Test ${hex}, sheet ${result.code.page} of ${result.code.pages}. Version: ${result.version === undefined ? "not settled" : String.fromCharCode(64 + result.version)}${result.versionSource === "bubble" ? " (the bubble the student filled)" : ""}.`);
      console.log(`Read at about ${Math.round(result.quality.dpi)} dots to the inch. ${counts.answered} answered, ${counts.blank} blank, ${counts.flagged} flagged${counts.notOnSheet ? `, ${counts.notOnSheet} not on the sheet` : ""}.`);
      for (const note of result.notes) console.log(`Note: ${note}`);
      for (const q of result.questions) if (q.status === "answered") console.log(`  ${String(q.number).padStart(3)}. ${q.marked.map((p) => String.fromCharCode(65 + p)).join("")}`);
      for (const flag of result.flags.slice(0, 40)) console.log(`  ${flag.question === undefined ? "Sheet" : `Question ${flag.question}`} (${flag.kind}): ${flag.reason}`);
      if (result.flags.length > 40) console.log(`  and ${result.flags.length - 40} more flags`);
      return 0;
    }
    const batch = assembleBatch(results, pagesPerSheet);
    if (has(rest, "json")) {
      console.log(JSON.stringify({ batch, entries: results }, null, 2));
      return batch.flags.length === 0 && read.length === results.length ? 0 : 1;
    }
    console.log(`${results.length} page${results.length === 1 ? "" : "s"} read into ${batch.sheets.length} sheet${batch.sheets.length === 1 ? "" : "s"}; ${read.length} read, ${results.length - read.length} not read, ${batch.duplicates.length} duplicate${batch.duplicates.length === 1 ? "" : "s"}.`);
    for (const sheet of batch.sheets) {
      const pages = sheet.pages.filter((p): p is NonNullable<typeof p> => p !== undefined);
      let answered = 0;
      let blank = 0;
      let flagged = 0;
      for (const p of pages) {
        const r = (results[p.entry] as BatchEntry).result;
        if (!r.ok) continue;
        for (const q of r.questions) {
          if (q.status === "answered") answered++;
          else if (q.status === "blank") blank++;
          else if (q.status === "flagged") flagged++;
        }
        flagged += r.flags.filter((f) => f.kind === "version").length;
      }
      const where = pages.map((p) => `${(results[p.entry] as BatchEntry).source.file} p${(results[p.entry] as BatchEntry).source.page}`).join(", ");
      console.log(`  Sheet ${sheet.number} (${where}): version ${sheet.version === undefined ? "not settled" : String.fromCharCode(64 + sheet.version)}, ${answered} answered, ${blank} blank, ${flagged} flagged`);
    }
    for (const flag of batch.flags) console.log(`  ${flag.sheet === undefined ? "Batch" : `Sheet ${flag.sheet}`} (${flag.kind}): ${flag.reason}`);
    return batch.flags.length === 0 && read.length === results.length ? 0 : 1;
  }
  if (sub === "score" || sub === "rescore") {
    const [bankPath, ...rest2] = positional(rest);
    if (!bankPath || rest2.length === 0) return fail(sub === "score" ? "Name a bank file and the scans: sheets score <bank> <picture.png|scan.pdf|folder...>." : "Name a bank file and a scores file: sheets rescore <bank> <file.openassess-scores>.");
    const { bank } = await Bank.open(resolve(bankPath));
    const date = arg(rest, "date") ?? new Date().toISOString().slice(0, 10);
    let record: TestRecord;
    let sheets: BatchSheet[];
    let entries: BatchEntry[];
    let decisions: Decision[] = [];
    let adjustments: Adjustment[] = [];
    let acceptBlanks = has(rest, "accept-blanks");
    let pagesPerSheet = 1;
    if (sub === "score") {
      const chosen = pickTest(bank, rest);
      if ("error" in chosen) return fail(chosen.error);
      record = chosen.test;
      const reader = new SheetReader(record);
      const files = await scanFiles(rest2);
      if (files.length === 0) return fail("There are no scans in what was named: a picture is a PNG, JPG or PDF file.");
      entries = (await readScans(reader, files)).map((o) => o.entry);
      const firstRead = entries.find((e) => e.result.ok);
      pagesPerSheet = firstRead && firstRead.result.ok ? firstRead.result.code.pages : 1;
      const batch = assembleBatch(entries, pagesPerSheet);
      sheets = batch.sheets;
      for (const flag of batch.flags) console.log(`${flag.sheet === undefined ? "Batch" : `Sheet ${flag.sheet}`} (${flag.kind}): ${flag.reason}`);
    } else {
      const loaded = readScoresFile(new Uint8Array(await readFile(resolve(rest2[0] as string))));
      if (!loaded.ok) return fail(loaded.reason);
      const found = bank.getTest(loaded.file.testId);
      if (!found) return fail(`This scores file is for the test "${loaded.file.testName}" (${loaded.file.testId}), which this bank does not hold.`);
      if (found.fingerprint !== loaded.file.testFingerprint) return fail("This scores file is for a test whose record has changed since: its fingerprint is not the one in the bank.");
      record = found;
      const back = restore(loaded.file);
      sheets = back.sheets;
      entries = back.entries;
      decisions = loaded.file.decisions;
      adjustments = loaded.file.adjustments;
      acceptBlanks = acceptBlanks || loaded.file.acceptBlanks;
      pagesPerSheet = loaded.file.pagesPerSheet;
    }
    // Adjustments given on the command line are named by the question's number in version A and the letters of version A.
    const questionIdOf = (n: number): string | undefined => versionQuestions(record, "A")[n - 1]?.id;
    const given: Adjustment[] = [];
    const add = (flag: string, make: (n: number, rest: string) => Adjustment | undefined): string | undefined => {
      for (const value of all(rest, flag)) {
        const [n, more] = value.split(":");
        const adjustment = make(Number(n), more ?? "");
        if (!adjustment) return `--${flag} ${value} does not name a question of this test.`;
        given.push(adjustment);
      }
      return undefined;
    };
    const stamp = new Date().toISOString();
    const bad =
      add("drop", (n) => (questionIdOf(n) ? { id: `adj_${adjustments.length + given.length + 1}`, kind: "drop", questionId: questionIdOf(n) as string, at: stamp } : undefined)) ??
      add("credit", (n) => (questionIdOf(n) ? { id: `adj_${adjustments.length + given.length + 1}`, kind: "credit", questionId: questionIdOf(n) as string, at: stamp } : undefined)) ??
      add("points", (n, p) => (questionIdOf(n) && Number.isFinite(Number(p)) && p !== "" ? { id: `adj_${adjustments.length + given.length + 1}`, kind: "points", questionId: questionIdOf(n) as string, points: Number(p), at: stamp } : undefined)) ??
      add("also-right", (n, l) => {
        const answer = questionIdOf(n) ? answerAt(record, "A", questionIdOf(n) as string, l.toUpperCase()) : undefined;
        return answer ? { id: `adj_${adjustments.length + given.length + 1}`, kind: "alsoRight", questionId: questionIdOf(n) as string, answer, at: stamp } : undefined;
      });
    if (bad) return fail(bad);
    adjustments = [...adjustments, ...given];

    const reader = new SheetReader(record);
    const settled = settleSheets(sheets, entries, decisions, { acceptBlanks, reader });
    const scores = scoreSheets(record, settled, adjustments);
    const stats = itemStatistics(record, scores);
    console.log(`Scored ${scores.length} sheet${scores.length === 1 ? "" : "s"} for "${record.name}".`);
    for (const s of scores) {
      const what = s.complete ? "complete" : `${s.unsettled} question${s.unsettled === 1 ? "" : "s"} not settled${s.problems.length ? `; ${s.problems.join(" ")}` : ""}`;
      console.log(`  Sheet ${String(s.number).padStart(3)}  ${s.version === undefined ? "?" : String.fromCharCode(64 + s.version)}  ${String(s.earned).padStart(5)} of ${String(s.possible).padEnd(5)} ${s.percent === undefined ? "     " : `${s.percent.toFixed(1).padStart(5)}%`}  ${what}`);
    }
    if (stats.mean !== undefined) console.log(`Mean ${stats.mean} of ${stats.possible} (standard deviation ${stats.sd}) over ${stats.sheets} complete sheet${stats.sheets === 1 ? "" : "s"}${stats.reliability ? `; ${stats.reliability.kind} ${stats.reliability.value}` : ""}.`);
    for (const note of stats.notes) console.log(`Note: ${note}`);
    for (const a of adjustments) console.log(`Adjustment: question ${versionQuestions(record, "A").findIndex((q) => q.id === a.questionId) + 1}: ${adjustmentWords(a, record)}${a.note ? ` (${a.note})` : ""}`);

    const out = arg(rest, "out");
    if (out) {
      const folder = resolve(out);
      await mkdir(folder, { recursive: true });
      const exported = exportResults(record, settled, adjustments, stats, date);
      const file = newScoresFile(record, { sheets, flags: [], duplicates: [] }, entries, { decisions, adjustments, acceptBlanks, pagesPerSheet });
      const writes: Array<[string, Uint8Array | string]> = [
        [scoresFileName(record.name, date), writeScoresFile(file)],
        [`${exported.base}.xlsx`, exported.xlsx],
        [`${exported.base}.csv`, exported.csv],
        [`${safeName(record.name, "Test")} - Item analysis ${date}.html`, itemAnalysisHtml(record, stats, date)],
      ];
      for (const [name, data] of writes) {
        await writeFile(join(folder, name), data);
        console.log(`  Wrote ${join(folder, name)}`);
      }
    }
    if (has(rest, "save-statistics")) {
      if (stats.sheets === 0) return fail("There are no complete sheets, so there are no figures to keep in the bank.");
      bank.addAdministration(administrationFrom(record, stats, date));
      await bank.save(resolve(bankPath));
      console.log(`The class-level figures were kept in ${bankPath}. No response, name or file name is in them.`);
    }
    return scores.every((s) => s.complete) ? 0 : 1;
  }
  return fail(sub ? `Unknown sheets command "${sub}". The commands are gate, print, read, check, score and rescore.` : "Say which sheets command: gate, print, read, check, score or rescore.");
}

function cmdContract(): number {
  console.log(`Read contract ${READ_CONTRACT_VERSION}`);
  console.log(`Operations: openBank, listQuestions, getQuestion, resolveLink, supportedTypes, toDeliveryPayload\n`);

  for (const capability of allCapabilities()) {
    console.log(`${capability.label}  (${capability.consumer}, ${capability.presentation})`);
    for (const verdict of typeVerdicts(capability.consumer)) {
      if (verdict.supported) {
        console.log(`  ${verdict.type.padEnd(18)} delivers`);
      } else if (verdict.fallback && verdict.fallback.to !== "none") {
        console.log(`  ${verdict.type.padEnd(18)} falls back to ${verdict.fallback.to}`);
        console.log(`  ${"".padEnd(18)}   ${verdict.fallback.note}`);
      } else {
        console.log(`  ${verdict.type.padEnd(18)} cannot deliver`);
        if (verdict.fallback) console.log(`  ${"".padEnd(18)}   ${verdict.fallback.note}`);
      }
    }
    for (const note of capability.notes) console.log(`  note: ${note}`);
    console.log("");
  }
  console.log(`Question types in the model: ${QUESTION_TYPES.length}`);
  return 0;
}

/**
 * A file read whole, with Node's own refusal of one over 2 GiB said in words ("File size (6651950811) is greater than 2 GiB" was all a
 * person saw when a 6 GB zip was named by mistake; 7 of 407 zips in one real downloads folder were over that).
 */
async function readInput(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_FS_FILE_TOO_LARGE") throw error;
    const size = (await stat(path)).size;
    throw new Error(`That file is ${(size / 1073741824).toFixed(1)} GB, more than this can read at once (2 GB). A file of questions is far smaller than that, so check it is the one you meant.`);
  }
}

function fail(message: string): number {
  console.error(`${message}\n`);
  console.error(USAGE);
  return 2;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "info":
      return cmdInfo(args);
    case "validate":
      return cmdValidate(args);
    case "new":
      return cmdNew(args);
    case "import":
      return cmdImport(args);
    case "print":
      return cmdPrint(args);
    case "review":
      return cmdReview(args);
    case "export":
      return cmdExport(args);
    case "check":
      return cmdCheck(args);
    case "coverage":
      return cmdCoverage(args);
    case "blueprint":
      return cmdBlueprint(args);
    case "search":
      return cmdSearch(args);
    case "score":
      return cmdScore(args);
    case "sheets":
      return cmdSheets(args);
    case "perf":
      return cmdPerf(args);
    case "contract":
      return cmdContract();
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      return fail(`Unknown command "${command}".`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
