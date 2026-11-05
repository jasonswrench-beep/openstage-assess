/**
 * Tests assembled from a bank, and the paper that goes with them: the answer sheet, a booklet and an answer key for each version.
 *
 * A test holds a copy of its questions as they were used, so editing the bank never changes a test already given. It is kept in the
 * bank beside the questions. Printing writes into the exports folder and never over an earlier file, like every other export, and a
 * check of a printed blank copy (Check my printing) writes nothing.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  checkPrinting,
  COVERAGE_AXES,
  createTest,
  keyOf,
  MAX_VERSIONS,
  MOST_PICKED,
  openScans,
  pickQuestions,
  planSheet,
  pointsOf,
  printTestPaper,
  richTextToPlain,
  SheetReader,
  versionQuestions,
  type GreyImage,
  type PrintFormat,
  type Question,
  type TestRecord,
} from "./engine.ts";
import type { ApiRequest, ApiResponse, Context } from "./api.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { checkName, freeFileName } from "./library.ts";
import { flag, jsonObject, oneOf, onlyFields, text, whole } from "./request.ts";
import { view } from "./scoring.ts";

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(5, "0");
const clip = (value: string, n: number): string => (value.length > n ? `${value.slice(0, n - 3).trimEnd()}...` : value);

export function summary(record: TestRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    created: record.created,
    versions: record.versions.map((v) => v.label),
    questions: record.questions.length,
    points: Math.round(record.questions.reduce((sum, q) => sum + pointsOf(q), 0) * 1000) / 1000,
    questionOrder: record.questionOrder,
    fingerprint: hex(record.fingerprint),
  };
}

/** A test as the screen shows it: what the sheet carries, what it cannot, and what is not scored. */
function detail(record: TestRecord): Record<string, unknown> {
  const planned = planSheet(record, { paper: "letter", large: false });
  const questions = versionQuestions(record, "A").map((q: Question, i: number) => {
    const use = planned.ok ? planned.plan.uses["A"]?.[i] : undefined;
    const carried = use !== undefined && use.kind !== "none";
    return {
      number: i + 1,
      id: q.id,
      type: q.type,
      stem: clip(richTextToPlain(q.stem).replace(/\s+/g, " ").trim(), 140),
      points: pointsOf(q),
      onSheet: carried,
      places: use?.places ?? 0,
      notOnSheetBecause: carried ? null : (use?.why ?? "A bubble sheet cannot carry this kind of question."),
      scored: carried && keyOf(q).length > 0,
      keepsOrder: record.keptInOrder[q.id] ?? null,
    };
  });
  return {
    ...summary(record),
    sections: record.sections.map((s) => ({ title: s.title, questions: s.questionIds.length })),
    questions,
    sheet: planned.ok ? { ok: true, pages: planned.plan.pages, style: planned.plan.style, notes: planned.plan.notes, lettersForTrueFalse: planned.plan.lettersForTrueFalse } : { ok: false, reason: planned.reason },
  };
}

function find(bank: Awaited<ReturnType<Context["banks"]["open"]>>, id: string | undefined): TestRecord {
  const record = id ? bank.getTest(id) : undefined;
  if (!record) throw notFound("There is no such test in this bank.");
  return record;
}

/** Rows of grey pixels as the window sends them, one byte each: the width and height are in the address and must match the bytes. */
export function greyFromRequest(req: ApiRequest, most: number): GreyImage {
  const width = Number(req.query.get("width"));
  const height = Number(req.query.get("height"));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 20000 || height > 20000) throw badRequest("The picture's size is not one a page can have.");
  if (width * height > most) throw badRequest("That picture is too large to read. Scan at 150 to 300 dots to the inch.");
  if (req.body.length !== width * height) throw badRequest("The picture's bytes are not its width times its height.");
  return { width, height, data: new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.length).slice() };
}

export const MOST_PIXELS = 16_000_000;

async function assemble(ctx: Context, req: ApiRequest, bankName: string): Promise<ApiResponse> {
  const input = jsonObject(req);
  onlyFields(input, ["name", "questionIds", "versions", "questionOrder", "sections"], "The request");
  const name = text(input["name"], "The test's name", 120, true) as string;
  if (name.trim() === "") throw badRequest("The test's name is needed.");
  const versions = whole(input["versions"], "The number of versions", 1, MAX_VERSIONS, 1);
  const questionOrder = oneOf(input["questionOrder"], ["kept", "shuffled"] as const, "whether the questions are kept or shuffled between versions", "kept");

  const raw = input["sections"];
  let sections: Array<{ title: string; questionIds: string[] }> | undefined;
  let ids: string[];
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) throw badRequest("The sections must be a list of at most 40.");
    sections = raw.map((s: unknown) => {
      if (typeof s !== "object" || s === null || Array.isArray(s)) throw badRequest("A section must be an object.");
      const section = s as Record<string, unknown>;
      onlyFields(section, ["title", "questionIds"], "A section");
      return { title: text(section["title"], "A section's title", 120) ?? "", questionIds: idList(section["questionIds"]) };
    });
    ids = sections.flatMap((s) => s.questionIds);
  } else {
    ids = idList(input["questionIds"]);
  }
  if (ids.length === 0) throw badRequest("Choose the questions for the test.");

  const created = await ctx.banks.change(bankName, (bank) => {
    const questions = ids.map((id) => {
      const q = bank.get(id);
      if (!q) throw badRequest(`The question ${id} is not in this bank.`);
      return q;
    });
    let record: TestRecord;
    try {
      record = createTest({ name, questions, versions, questionOrder, ...(sections ? { sections } : {}) });
      bank.addTest(record);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw badRequest((error as Error).message);
    }
    return record;
  });
  return ok({ test: detail(created) });
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((v) => typeof v !== "string" || v.length > 80)) throw badRequest("The questions must be a list of question ids.");
  return value as string[];
}

const PAPERS = ["letter", "a4"] as const;
const FORMATS = ["pdf", "docx"] as const;

/** The paper is made by the engine, the same function the command line uses; what is done here is to read the request and to write the files. */
async function printTestPaperRoute(ctx: Context, req: ApiRequest, record: TestRecord): Promise<ApiResponse> {
  const input = jsonObject(req);
  onlyFields(input, ["paper", "large", "sheet", "booklets", "keys", "formats", "nameBox"], "The request");
  const paper = oneOf(input["paper"], PAPERS, "the paper", "letter");
  const large = flag(input["large"], "Large print", false);
  const sheet = oneOf(input["sheet"], ["shared", "each", "none"] as const, "which answer sheets to print", "shared");
  const booklets = flag(input["booklets"], "The booklets", true);
  const keys = flag(input["keys"], "The answer keys", true);
  const nameBox = flag(input["nameBox"], "The name box", true);
  const formats: PrintFormat[] =
    input["formats"] === undefined
      ? ["pdf"]
      : Array.isArray(input["formats"]) && input["formats"].length > 0 && input["formats"].every((f) => (FORMATS as readonly unknown[]).includes(f))
        ? [...new Set(input["formats"] as PrintFormat[])]
        : (() => {
            throw badRequest("Say what to print the booklets and keys as, from pdf and docx.");
          })();

  const made = printTestPaper(record, { paper, large, sheet, booklets, keys, nameBox, formats });
  if (!made.ok) throw badRequest(made.reason);
  const written: Array<{ name: string; path: string; kind: string; version?: string; format: string; pages?: number }> = [];
  for (const file of made.files) {
    const name = await freeFileName(ctx.library.exports, checkName(file.name));
    const path = join(ctx.library.exports, name);
    await writeFile(path, file.bytes);
    written.push({ name, path, kind: file.kind, ...(file.version !== undefined ? { version: file.version } : {}), format: file.format, ...(file.pages !== undefined ? { pages: file.pages } : {}) });
  }
  return ok({ written, notes: made.notes, unprinted: made.unprinted });
}

/** A scan of a blank printed copy, read to see whether the printing is true to size and the reader can use it. Writes nothing. */
async function checkPrintingRoute(req: ApiRequest, record: TestRecord): Promise<ApiResponse> {
  const reader = new SheetReader(record);
  let image: GreyImage;
  let dpi: number | undefined;
  if (req.query.has("width")) {
    image = greyFromRequest(req, MOST_PIXELS);
  } else {
    if (req.body.length === 0) throw badRequest("That file is empty.");
    const opened = openScans(new Uint8Array(req.body));
    if (!opened.ok) throw badRequest(opened.reason);
    const page = opened.pages[0];
    if (!page) throw badRequest("There is no picture in that file.");
    if (!page.result.ok) throw badRequest(page.result.reason);
    if (page.result.source.kind !== "grey") {
      throw badRequest("This picture has to be decoded by the window first. Choose it again in the app and it will be sent ready to read.");
    }
    image = page.result.source.image;
    dpi = page.result.source.dpi;
  }
  const check = checkPrinting(reader, image, dpi !== undefined ? { dpi } : {});
  return ok({ ok: check.ok, found: check.found, problems: check.problems, ...(check.refusal ? { cause: check.refusal.cause } : {}) });
}

/**
 * Some of the bank's questions that have a value (this chapter, this tag), chosen at random, for a test being made. Nothing is kept:
 * the questions are put to the person, who still chooses what goes in. The answer says what was left out and why, so a short
 * answer is never a mystery.
 */
async function pickRoute(ctx: Context, req: ApiRequest, bankName: string): Promise<ApiResponse> {
  const input = jsonObject(req);
  onlyFields(input, ["axis", "value", "count", "chosen"], "The request");
  const axis = oneOf(input["axis"], COVERAGE_AXES, "what to pick by");
  const value = text(input["value"], "The value to pick", 200, true) as string;
  const count = whole(input["count"], "How many to pick", 1, MOST_PICKED);
  const chosen = input["chosen"] === undefined ? [] : idList(input["chosen"]);
  const bank = await ctx.banks.open(bankName);
  const seed = randomBytes(6).toString("hex");
  return ok({ ...pickQuestions(bank.sortedQuestions(), { axis, value, count, chosen, seed }), seed });
}

/** /api/sheets/:bank/tests... and /api/sheets/:bank/pick */
export async function sheetsRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [, rawBank, what, id, action] = req.segments;
  if (rawBank !== undefined && what === "pick" && id === undefined && req.method === "POST") return pickRoute(ctx, req, checkName(rawBank));
  if (rawBank === undefined || what !== "tests") throw notFound("There is no such page.");
  const bankName = checkName(rawBank);

  if (id === undefined) {
    if (req.method === "GET") {
      const bank = await ctx.banks.open(bankName);
      return ok({ bank: bankName, title: bank.manifest.title, tests: bank.listTests().map(summary), figures: bank.listAdministrations().map((a) => ({ id: a.id, test: a.testName, date: a.date, sheets: a.sheets })) });
    }
    if (req.method === "POST") return assemble(ctx, req, bankName);
    throw notFound("There is no such page.");
  }

  const bank = await ctx.banks.open(bankName);
  const record = find(bank, id);

  if (action === undefined) {
    if (req.method === "GET") return ok({ test: detail(record) });
    if (req.method === "DELETE") {
      await ctx.banks.change(bankName, (b) => void b.removeTest(record.id));
      return ok({ removed: record.id });
    }
  }
  if (action === "print" && req.method === "POST") return printTestPaperRoute(ctx, req, record);
  if (action === "printing-check" && req.method === "POST") return checkPrintingRoute(req, record);
  if (action === "score" && req.method === "POST") return ok(view(ctx.scoring.create(bankName, record)));
  throw notFound("There is no such page.");
}
