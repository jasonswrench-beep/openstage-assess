/**
 * A learning system's quiz results report, for a bank: read, matched to the bank's questions and shown as item statistics, and, when
 * asked, written as a `.pstat` file for PrismStatistics or kept in the bank as class figures.
 *
 * Nothing is held between requests: the window sends the report each time, with what to do, so no response of a student is kept in
 * memory after the answer goes back, and the report's columns about students are never read (`lms-results.ts` in the engine). The
 * class figures go into the bank only when the request says `confirm=true`, as for scanned sheets.
 */

import { join } from "node:path";

import { administrationFrom, ENGINE_VERSION, LMS_REPORTS, lmsResults, PSTAT_EXTENSION, pstatAppVersion, pstatProject2, richTextToPlain, writePstatFile, type LmsId } from "./engine.ts";
import type { ApiRequest, ApiResponse, Context } from "./api.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { checkName, cleanName, fitFileName, writeNewFile } from "./library.ts";
import { dateOf } from "./request.ts";

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

/** GET /api/lms-reports: the systems and the report to download from each, for the import menu. */
export function lmsReportsRoute(req: ApiRequest): ApiResponse {
  if (req.method !== "GET") throw notFound("There is no such page.");
  return ok({ reports: LMS_REPORTS });
}

/** POST /api/sheets/<bank>/lms-results?lms=canvas[&name=...][&date=...][&write=statistics][&confirm=true], with the report as the body. */
export async function lmsResultsRoute(ctx: Context, req: ApiRequest, bankName: string): Promise<ApiResponse> {
  if (req.method !== "POST") throw notFound("There is no such page.");
  const lms = req.query.get("lms") ?? "";
  if (!LMS_REPORTS.some((r) => r.id === lms)) throw badRequest(`Say which learning system the report is from: ${LMS_REPORTS.map((r) => r.id).join(", ")}.`);
  if (req.body.length === 0) throw badRequest("Send the report file.");
  const rawName = (req.query.get("name") ?? "").replace(/[\u0000-\u001f]/g, " ").trim();
  if (rawName.length > 120) throw badRequest("The quiz's name must be at most 120 characters.");
  const report = LMS_REPORTS.find((r) => r.id === lms) as (typeof LMS_REPORTS)[number];
  const name = rawName || `Quiz results (${report.lms})`;
  const date = dateOf(req.query.get("date") ?? undefined);
  const write = req.query.get("write");
  if (write !== null && write !== "statistics") throw badRequest("What can be written is statistics, a .pstat file.");
  const confirm = req.query.get("confirm");
  if (confirm !== null && confirm !== "true") throw badRequest("Keeping the class figures in the bank has to be asked for with confirm=true.");

  const bank = await ctx.banks.open(bankName);
  const done = lmsResults(lms as LmsId, new Uint8Array(req.body), bank.sortedQuestions(), { name, date });
  if (!done.ok) throw new HttpError(422, done.reason);
  const { read, matches, record, scores, stats } = done;
  const numberOf = new Map(record.questions.map((q, i) => [q.id, i + 1]));
  const textOf = new Map(read.questions.map((q) => [q.key, q.text]));

  const written: Array<{ name: string; path: string; kind: string }> = [];
  if (write === "statistics") {
    const made = pstatProject2(record, scores, pstatAppVersion(ctx.updates?.current, ENGINE_VERSION), { source: "learning system report", given: date });
    if (made.refused) throw badRequest(made.refused.replace("No sheet is complete", "No attempt has points for every question").replace("settle the flagged questions first", "the learning system gave no points for some question"));
    made.project.source.report.notes.unshift(`From ${report.lms}'s ${report.report} report, with the learning system's own points.`);
    const file = await writeNewFile(ctx.library.exports, checkName(fitFileName(`${cleanName(name, "Quiz")} - Results for statistics ${date}${PSTAT_EXTENSION}`)), writePstatFile(made.project, made.part));
    written.push({ name: file, path: join(ctx.library.exports, file), kind: "statistics" });
  }
  let kept: { id: string; sheets: number } | undefined;
  if (confirm === "true") {
    if (stats.sheets === 0) throw badRequest("No attempt has points for every question, so there are no figures to keep in the bank.");
    const administration = administrationFrom(record, stats, date);
    await ctx.banks.change(bankName, (b) => void b.addAdministration(administration));
    kept = { id: administration.id, sheets: administration.sheets };
  }

  return ok({
    lms: report.id,
    report: `${report.lms}, ${report.report}`,
    name,
    date,
    attempts: read.attempts.length,
    notes: read.notes,
    matched: matches.filter((m) => m.questionId).map((m) => ({ key: m.key, number: numberOf.get(m.questionId as string), by: m.by, text: textOf.get(m.key) ?? "" })),
    unmatched: matches.filter((m) => !m.questionId).map((m) => ({ key: m.key, text: textOf.get(m.key) ?? "", reason: m.reason })),
    stats: {
      sheets: stats.sheets,
      leftOut: stats.leftOut,
      mean: stats.mean,
      sd: stats.sd,
      possible: stats.possible,
      reliability: stats.reliability,
      notes: stats.notes,
      items: stats.items.map((i) => ({ number: numberOf.get(i.questionId), stem: richTextToPlain(record.questions.find((q) => q.id === i.questionId)?.stem ?? "").slice(0, 200), sheets: i.sheets, difficulty: i.difficulty, pointBiserial: i.discrimination.pointBiserial, upperLower: i.discrimination.upperLower, blanks: i.blanks })),
    },
    written,
    ...(kept ? { kept } : {}),
  });
}
