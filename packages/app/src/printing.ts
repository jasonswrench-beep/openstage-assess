/**
 * Printing a bank as a test: what the student copy and the answer key would hold, and writing them as Word or PDF files.
 *
 * Like an export, the check and the writing are the same pass over the same questions, nothing is written by a check, and a
 * file is never written over another. What the screen sends is read field by field: a number outside what a page can hold is
 * brought back inside it, and anything it does not know is refused.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { printOptions, printTest, STATUSES, type DestinationReport, type PrintFormat, type PrintOptions, type Question } from "./engine.ts";
import type { ApiRequest, ApiResponse, Context } from "./api.ts";
import { badRequest } from "./errors.ts";
import { checkName, freeFileName } from "./library.ts";

const KINDS = ["student", "key"] as const;
const FORMATS = ["docx", "pdf"] as const;

interface Request {
  kinds: Array<(typeof KINDS)[number]>;
  formats: PrintFormat[];
  statuses: string[] | undefined;
  options: Omit<PrintOptions, "kind" | "title"> & { title: string | undefined };
}

function body(req: ApiRequest): Record<string, unknown> {
  if (req.body.length === 0) return {};
  try {
    const parsed = JSON.parse(req.body.toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the message below
  }
  throw badRequest("The request was not valid JSON.");
}

function pick<T extends string>(value: unknown, allowed: readonly T[], what: string): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => !(allowed as readonly unknown[]).includes(v))) {
    throw badRequest(`Say ${what}, from ${allowed.join(" and ")}.`);
  }
  return [...new Set(value as T[])];
}

function text(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw badRequest(`${what} must be text of at most ${max} characters.`);
  return value;
}

function flag(value: unknown, what: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw badRequest(`${what} must be true or false.`);
  return value;
}

function whole(value: unknown, what: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw badRequest(`${what} must be a number.`);
  return value;
}

function read(input: Record<string, unknown>): Request {
  const paper = input["paper"] ?? "letter";
  if (paper !== "letter" && paper !== "a4") throw badRequest("The paper must be letter or a4.");
  const statuses = input["statuses"];
  if (statuses !== undefined && (!Array.isArray(statuses) || statuses.some((s) => typeof s !== "string" || !(STATUSES as readonly string[]).includes(s)))) {
    throw badRequest("Say which statuses to print, from draft, reviewed, approved and retired.");
  }
  const instructions = text(input["instructions"], "The instructions", 5000);
  return {
    kinds: pick(input["kinds"], KINDS, "what to print"),
    formats: pick(input["formats"], FORMATS, "what to print it as"),
    statuses: statuses as string[] | undefined,
    options: {
      title: text(input["title"], "The title", 200),
      paper,
      ...(instructions ? { instructions } : {}),
      nameLine: flag(input["nameLine"], "The name line", true),
      dateLine: flag(input["dateLine"], "The date line", true),
      showPoints: flag(input["showPoints"], "Show points", true),
      shortAnswerLines: whole(input["shortAnswerLines"], "The lines for a short answer", 1),
      essayLines: whole(input["essayLines"], "The lines for an essay", 8),
      includeFeedback: flag(input["includeFeedback"], "Include feedback", false),
      fontSize: whole(input["fontSize"], "The size of the text", 11),
    },
  };
}

function chosen(questions: Question[], statuses: string[] | undefined): Question[] {
  if (statuses === undefined) return questions.filter((q) => q.metadata.status !== "retired");
  const wanted = new Set(statuses);
  return questions.filter((q) => wanted.has(q.metadata.status));
}

/** POST /banks/:name/print/check and POST /banks/:name/print */
export async function printRoute(ctx: Context, req: ApiRequest, rawName: string, action: "check" | "write"): Promise<ApiResponse> {
  const name = checkName(rawName);
  const request = read(body(req));
  const bank = await ctx.banks.open(name);
  const questions = chosen(bank.sortedQuestions(), request.statuses);
  const title = request.options.title ?? bank.manifest.title;

  const reports: Record<string, DestinationReport> = {};
  const written: Array<{ name: string; path: string; kind: string; format: string; pages?: number }> = [];
  const at = new Date();
  for (const kind of request.kinds) {
    for (const format of request.formats) {
      const options = printOptions({ ...request.options, title, kind, media: bank.media });
      const result = printTest(questions, options, format, at);
      // The report of a copy covers every format it is made in: the files of each, and the notes that are true of any.
      const before = reports[kind];
      reports[kind] = before
        ? { ...before, files: [...before.files, ...result.report.files], general: [...new Set([...before.general, ...result.report.general])] }
        : result.report;
      if (action === "write" && result.file.bytes.length > 0) {
        const fileName = await freeFileName(ctx.library.exports, checkName(result.file.name));
        const path = join(ctx.library.exports, fileName);
        await writeFile(path, result.file.bytes);
        written.push({ name: fileName, path, kind, format, ...(result.file.pages !== undefined ? { pages: result.file.pages } : {}) });
      }
    }
  }
  return { status: 200, json: action === "check" ? { reports, questions: questions.length } : { reports, written } };
}
