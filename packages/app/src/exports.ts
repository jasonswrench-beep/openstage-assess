/**
 * Exporting a bank: which formats there are, what would happen to the questions in each, and writing the files.
 *
 * The check and the export are the same pass over the same questions, so what the screen shows before is what the file
 * holds after. Nothing is written by a check. A file is never written over another: an export of the same bank twice gives
 * two files, the second with a number in its name.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  exportGift,
  exportMoodleXml,
  exportOpenStageSpreadsheet,
  GIFT_ID,
  GIFT_LABEL,
  MOODLE_XML_ID,
  MOODLE_XML_LABEL,
  OPENSTAGE_SPREADSHEET,
  OPENSTAGE_SPREADSHEET_LABEL,
  STATUSES,
  type ExportResult,
  type Question,
} from "./engine.ts";
import type { ApiRequest, ApiResponse, Context } from "./api.ts";
import { badRequest } from "./errors.ts";
import { checkName, cleanName, freeFileName } from "./library.ts";

interface Destination {
  id: string;
  label: string;
  blurb: string;
  run: (questions: Question[], options: { name: string }) => ExportResult;
}

export const DESTINATIONS: Destination[] = [
  {
    id: OPENSTAGE_SPREADSHEET,
    label: OPENSTAGE_SPREADSHEET_LABEL,
    blurb: "A spreadsheet (CSV) that OpenStage Author and Scroll read. It holds multiple choice, multiple response, true or false and short answer questions, as plain text.",
    run: exportOpenStageSpreadsheet,
  },
  {
    id: MOODLE_XML_ID,
    label: MOODLE_XML_LABEL,
    blurb: "Moodle's own format. It keeps formatting, feedback for a right and a wrong answer, spare matching answers and the points of each question.",
    run: exportMoodleXml,
  },
  {
    id: GIFT_ID,
    label: GIFT_LABEL,
    blurb: "A plain-text format that Moodle and several other tools read. It holds less than Moodle XML, and the check says what.",
    run: exportGift,
  },
];

/** The questions to export: by default every one that is not retired, in the order the bank lists them. */
function chosen(questions: Question[], statuses: unknown): Question[] {
  if (statuses === undefined || statuses === null) return questions.filter((q) => q.metadata.status !== "retired");
  if (!Array.isArray(statuses) || statuses.some((s) => typeof s !== "string" || !(STATUSES as readonly string[]).includes(s))) {
    throw badRequest("Say which statuses to export, from draft, reviewed, approved and retired.");
  }
  const wanted = new Set(statuses as string[]);
  return questions.filter((q) => wanted.has(q.metadata.status));
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

export async function destinationsRoute(): Promise<ApiResponse> {
  return { status: 200, json: { destinations: DESTINATIONS.map(({ id, label, blurb }) => ({ id, label, blurb })) } };
}

/** POST /banks/:name/export/check and POST /banks/:name/export */
export async function exportRoute(ctx: Context, req: ApiRequest, rawName: string, action: "check" | "write"): Promise<ApiResponse> {
  const name = checkName(rawName);
  const input = body(req);
  const destination = DESTINATIONS.find((d) => d.id === input["destination"]);
  if (!destination) throw badRequest(`Say where to export to: ${DESTINATIONS.map((d) => d.id).join(", ")}.`);

  const bank = await ctx.banks.open(name);
  const questions = chosen(bank.sortedQuestions(), input["statuses"]);
  // The file is named for the bank's title, made safe: a title such as CON is a name Windows will not give a file.
  const result = destination.run(questions, { name: cleanName(bank.manifest.title, "Questions") });

  if (action === "check") return { status: 200, json: { report: result.report, questions: questions.length } };

  const written: Array<{ name: string; path: string; questions: number }> = [];
  for (const file of result.files) {
    const fileName = await freeFileName(ctx.library.exports, checkName(file.name));
    const path = join(ctx.library.exports, fileName);
    await writeFile(path, file.content, "utf8");
    written.push({ name: fileName, path, questions: file.questions });
  }
  return { status: 200, json: { report: result.report, written } };
}
