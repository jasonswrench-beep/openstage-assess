/**
 * Scoring a class of answer sheets: what the screen can ask of a sitting.
 *
 * The window decodes the pictures it can (a JPEG, a phone's photo) into grey pixels and sends those; PNG and PDF files are sent as
 * they are and opened here. Nothing about a student is asked for or kept: a sheet is its number in the batch, and what is written
 * (a scores file, a workbook, a CSV, an item analysis) is written by the engine's own writers into the library's folders and never
 * over an earlier file, except the scores file this sitting made itself, which a later save updates.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  administrationFrom,
  adjustmentEffect,
  adjustmentWords,
  answerAt,
  exportResults,
  itemAnalysisHtml,
  newScoresFile,
  readScoresFile,
  restore,
  SCORES_EXTENSION,
  scoresFileName,
  versionQuestions,
  writeScoresFile,
  type Adjustment,
  type BatchEntry,
  type Decision,
  type TestRecord,
  type VersionLabel,
} from "./engine.ts";
import type { ApiRequest, ApiResponse, Context } from "./api.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { checkName, cleanName, fitFileName, freeFileName, type Library } from "./library.ts";
import { dateOf, flag, jsonObject, oneOf, onlyFields, queryWhole, text, whole } from "./request.ts";
import { addFile, addPicture, addRefused, changed, compute, cropOf, letterOf, sheetView, view, type ScoringSession } from "./scoring.ts";
import { greyFromRequest, MOST_PIXELS } from "./sheets.ts";

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

/** The label under which a file of scans is shown. It is the name the window gave it, kept for the session only and never written. */
function fileLabel(value: string | null, fallback: string): string {
  const label = (value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
  return label === "" ? fallback : label;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Saved scores

async function scoresFiles(library: Library): Promise<Array<{ name: string; bytes: number; modified: string; test?: string; sheets?: number; problem?: string }>> {
  const names = (await readdir(library.scores)).filter((n) => n.toLowerCase().endsWith(SCORES_EXTENSION)).sort((a, b) => a.localeCompare(b));
  const out = [];
  for (const name of names) {
    const path = join(library.scores, name);
    const info = await stat(path);
    const read = readScoresFile(new Uint8Array(await readFile(path)));
    out.push({
      name,
      bytes: info.size,
      modified: info.mtime.toISOString(),
      ...(read.ok ? { test: read.file.testName, sheets: read.file.sheets.length } : { problem: read.reason }),
    });
  }
  return out;
}

/** GET /api/scores: the scores files in the library's folder, listed with what is wrong with any that cannot be read. */
export async function scoresRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  if (req.method === "GET" && req.segments.length === 1) return ok({ files: await scoresFiles(ctx.library), folder: ctx.library.scores });
  throw notFound("There is no such page.");
}

/** The bank that holds a test, found by the test's id. A scores file does not say which bank, only which test. */
async function bankOfTest(ctx: Context, testId: string, hint: string | undefined): Promise<{ bank: string; record: TestRecord } | undefined> {
  const names = hint ? [checkName(hint)] : (await ctx.banks.list()).filter((b) => b.error === undefined).map((b) => b.name);
  for (const name of names) {
    const bank = await ctx.banks.open(name);
    const record = bank.getTest(testId);
    if (record) return { bank: name, record };
  }
  return undefined;
}

async function openScores(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  let name: string;
  let bytes: Uint8Array;
  let hint: string | undefined;
  if (req.body.length > 0 && req.query.has("upload")) {
    // A scores file from somewhere else: kept in the library's folder under a free name, once it has been read and found to be one.
    bytes = new Uint8Array(req.body);
    name = "";
  } else {
    const input = jsonObject(req);
    onlyFields(input, ["name", "bank"], "The request");
    name = checkName(input["name"]);
    if (!name.toLowerCase().endsWith(SCORES_EXTENSION)) throw badRequest("That is not a scores file.");
    hint = text(input["bank"], "The bank", 80);
    try {
      bytes = new Uint8Array(await readFile(join(ctx.library.scores, name)));
    } catch {
      throw notFound("There is no such scores file.");
    }
  }
  const read = readScoresFile(bytes);
  if (!read.ok) throw new HttpError(422, read.reason);
  const file = read.file;
  const home = await bankOfTest(ctx, file.testId, hint);
  if (!home) throw new HttpError(409, `These scores are for the test "${file.testName}", which none of your banks holds. Open the bank the test was made in.`);
  if (home.record.fingerprint !== file.testFingerprint) {
    throw new HttpError(409, "These scores are for a test whose record has changed since: its fingerprint is not the one in the bank, so the scores cannot be read against it.");
  }
  if (name === "") {
    name = await freeFileName(ctx.library.scores, cleanName(`${file.testName} - Scores ${file.updated.slice(0, 10)}`, "Scores") + SCORES_EXTENSION);
    await writeFile(join(ctx.library.scores, name), bytes);
  }
  const back = restore(file);
  const session = ctx.scoring.restored(home.bank, home.record, { ...back, decisions: file.decisions, adjustments: file.adjustments, acceptBlanks: file.acceptBlanks, pagesPerSheet: file.pagesPerSheet, id: file.id }, name);
  session.savedRevision = session.revision;
  return ok(view(session));
}

async function save(ctx: Context, s: ScoringSession): Promise<ApiResponse> {
  const c = compute(s);
  const file = newScoresFile(s.test, c.batch, c.entries, {
    decisions: s.decisions,
    adjustments: s.adjustments,
    acceptBlanks: s.acceptBlanks,
    pagesPerSheet: s.pagesPerSheet,
    ...(s.fileId ? { id: s.fileId } : {}),
  });
  s.fileId = file.id;
  const bytes = writeScoresFile(file);
  // The first save makes a new file under a name no other file has. A later save updates that same file, which is this sitting's own.
  const name = s.savedAs ?? (await freeFileName(ctx.library.scores, scoresFileName(s.test.name, dateOf(undefined))));
  await writeFile(join(ctx.library.scores, name), bytes);
  s.savedAs = name;
  s.savedRevision = s.revision;
  return ok({ name, path: join(ctx.library.scores, name), sheets: c.batch.sheets.length, view: view(s) });
}

async function exportFiles(ctx: Context, req: ApiRequest, s: ScoringSession): Promise<ApiResponse> {
  const input = jsonObject(req);
  onlyFields(input, ["what", "date"], "The request");
  const WHAT = ["workbook", "csv", "analysis"] as const;
  const what = input["what"] === undefined ? [...WHAT] : Array.isArray(input["what"]) && input["what"].length > 0 && input["what"].every((w) => (WHAT as readonly unknown[]).includes(w)) ? [...new Set(input["what"] as Array<(typeof WHAT)[number]>)] : (() => { throw badRequest("Say what to write, from workbook, csv and analysis."); })();
  const date = dateOf(input["date"]);
  const c = compute(s);
  if (c.scores.length === 0) throw badRequest("There are no sheets to write results for yet.");
  const made = exportResults(s.test, c.settled, s.adjustments, c.stats, date);
  const files: Array<[string, Uint8Array | string, string]> = [];
  if (what.includes("workbook")) files.push([`${made.base}.xlsx`, made.xlsx, "workbook"]);
  if (what.includes("csv")) files.push([`${made.base}.csv`, made.csv, "csv"]);
  if (what.includes("analysis")) files.push([`${cleanName(s.test.name, "Test")} - Item analysis ${date}.html`, itemAnalysisHtml(s.test, c.stats, date), "analysis"]);
  const written = [];
  for (const [wanted, data, kind] of files) {
    const name = await freeFileName(ctx.library.exports, checkName(fitFileName(wanted)));
    const path = join(ctx.library.exports, name);
    await writeFile(path, data);
    written.push({ name, path, kind });
  }
  return ok({ written });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Decisions and adjustments

/** How many bubbles a question has on a sheet of this version, and whether it takes several answers. */
function placesFor(s: ScoringSession, sheetNumber: number, question: number): { places: number; multiple: boolean } {
  const c = compute(s);
  const at = c.settled.findIndex((x) => x.number === sheetNumber);
  const sheet = c.batch.sheets[at];
  const settled = c.settled[at];
  if (!sheet || !settled) throw notFound(`There is no sheet ${sheetNumber}.`);
  if (settled.version === undefined) throw badRequest("Settle the version of this sheet first: which answers are meant depends on it.");
  if (!settled.answers[question]) throw badRequest(`Sheet ${sheetNumber} does not carry question ${question}.`);
  for (const p of sheet.pages) {
    const r = p ? (c.entries[p.entry] as BatchEntry).result : undefined;
    if (!r?.ok) continue;
    const planned = s.reader.plan(r.code.paper, r.code.large);
    if (!planned.ok) break;
    const use = planned.plan.uses[letterOf(settled.version) as VersionLabel]?.[question - 1];
    if (use && use.places > 0) return { places: use.places, multiple: use.kind === "multiple" };
  }
  throw badRequest(`Question ${question} has no bubbles on this sheet, so it cannot be settled by choosing a bubble.`);
}

function decide(s: ScoringSession, req: ApiRequest): void {
  const input = jsonObject(req);
  onlyFields(input, ["sheet", "kind", "question", "places", "version"], "The decision");
  const sheet = whole(input["sheet"], "The sheet", 1, 100000);
  const c = compute(s);
  if (!c.batch.sheets.some((x) => x.number === sheet)) throw notFound(`There is no sheet ${sheet}.`);
  const kind = oneOf(input["kind"], ["answer", "version"] as const, "what is being decided");
  let decision: Decision;
  if (kind === "version") {
    const version = whole(input["version"], "The version", 1, s.test.versions.length);
    decision = { sheet, kind: "version", version, readerSaw: "The version was not certain." };
  } else {
    const question = whole(input["question"], "The question", 1, s.test.questions.length);
    const { places: count, multiple } = placesFor(s, sheet, question);
    const raw = input["places"];
    let places: number[] | "blank";
    if (raw === "blank") places = "blank";
    else if (Array.isArray(raw) && raw.length > 0 && raw.length <= count && raw.every((p) => Number.isInteger(p) && (p as number) >= 0 && (p as number) < count) && new Set(raw).size === raw.length) {
      if (raw.length > 1 && !multiple) throw badRequest("This question takes one answer. Choose one bubble, or say it is blank.");
      places = [...(raw as number[])].sort((a, b) => a - b);
    } else throw badRequest(`Choose the bubbles that are marked, from the ${count} this question has, or say it is blank.`);
    const was = (c.settled.find((x) => x.number === sheet)?.answers[question]) ?? undefined;
    decision = { sheet, kind: "answer", question, places, readerSaw: was?.kind === "unsettled" ? was.why : was?.kind === "marked" ? "The reader had read an answer." : "The reader had read it blank." };
  }
  decision.at = new Date().toISOString();
  // A later decision on the same thing replaces an earlier one; the earlier is not kept, since Undo is what takes a decision back.
  s.decisions = s.decisions.filter((d) => !(d.sheet === decision.sheet && d.kind === decision.kind && (d.kind === "version" || (d as { question: number }).question === (decision as { question: number }).question)));
  s.decisions.push(decision);
  changed(s);
}

function undo(s: ScoringSession, req: ApiRequest): void {
  const input = jsonObject(req);
  onlyFields(input, ["sheet", "kind", "question"], "The request");
  const sheet = whole(input["sheet"], "The sheet", 1, 100000);
  const kind = oneOf(input["kind"], ["answer", "version"] as const, "what is being taken back");
  const question = kind === "answer" ? whole(input["question"], "The question", 1, s.test.questions.length) : undefined;
  const before = s.decisions.length;
  s.decisions = s.decisions.filter((d) => !(d.sheet === sheet && d.kind === kind && (d.kind === "version" || (d as { question: number }).question === question)));
  if (s.decisions.length === before) throw badRequest("There is no such decision to take back.");
  changed(s);
}

function adjustmentFrom(s: ScoringSession, req: ApiRequest): Adjustment {
  const input = jsonObject(req);
  onlyFields(input, ["kind", "question", "versions", "answer", "points", "note"], "The adjustment");
  const kind = oneOf(input["kind"], ["drop", "credit", "alsoRight", "points"] as const, "which adjustment");
  const number = whole(input["question"], "The question", 1, s.test.questions.length);
  // The screen names a question by its number in version A, and a letter by its place in version A, so that it matches the booklet.
  const q = versionQuestions(s.test, "A")[number - 1];
  if (!q) throw badRequest(`The test has no question ${number}.`);
  const note = text(input["note"], "The note", 300);
  let versions: number[] | undefined;
  if (input["versions"] !== undefined) {
    const v = input["versions"];
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => !Number.isInteger(x) || (x as number) < 1 || (x as number) > s.test.versions.length)) throw badRequest("Say which versions, from 1 to the number of versions.");
    versions = [...new Set(v as number[])].sort((a, b) => a - b);
    if (versions.length === s.test.versions.length) versions = undefined;
  }
  let n = s.adjustments.length + 1;
  while (s.adjustments.some((a) => a.id === `adj_${n}`)) n++;
  const base = { id: `adj_${n}`, questionId: q.id, ...(versions ? { versions } : {}), ...(note ? { note } : {}), at: new Date().toISOString() };
  if (kind === "drop" || kind === "credit") return { ...base, kind };
  if (kind === "points") {
    const points = input["points"];
    if (typeof points !== "number" || !Number.isFinite(points) || points < 0 || points > 1000) throw badRequest("The points must be a number from 0 to 1000.");
    return { ...base, kind, points };
  }
  const letter = text(input["answer"], "The answer", 1, true) as string;
  const answer = answerAt(s.test, "A", q.id, letter.toUpperCase());
  if (!answer) throw badRequest(`Question ${number} has no answer ${letter}.`);
  return { ...base, kind, answer };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The route

/** /api/scoring/... */
export async function scoringRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [, id, what, a, b, c3] = req.segments;
  if (id === "open" && req.method === "POST" && what === undefined) return openScores(ctx, req);
  if (id === undefined) throw notFound("There is no such page.");
  const s = ctx.scoring.get(id);

  if (what === undefined) {
    if (req.method === "GET") return ok(view(s, queryWhole(req.query, "after", 0, 1_000_000, 0)));
    if (req.method === "DELETE") return ok({ closed: ctx.scoring.close(id) });
  }

  if (what === "files" && req.method === "POST") {
    if (req.body.length === 0) throw badRequest("That file is empty.");
    const result = addFile(s, fileLabel(req.query.get("name"), "scan"), new Uint8Array(req.body));
    return ok({ ...result, pages: s.entries.length });
  }

  if (what === "pages" && req.method === "POST") {
    const image = greyFromRequest(req, MOST_PIXELS);
    const file = fileLabel(req.query.get("file"), "picture");
    const page = queryWhole(req.query, "page", 1, 100000, 1);
    const replacing = req.query.has("replace") ? queryWhole(req.query, "replace", 0, 1_000_000) : undefined;
    const entry = addPicture(s, file, page, image, replacing);
    return ok({ entry, pages: s.entries.length });
  }

  if (what === "refused" && req.method === "POST") {
    const input = jsonObject(req);
    onlyFields(input, ["file", "page", "reason", "replace"], "The request");
    const reason = text(input["reason"], "The reason", 400, true) as string;
    const file = fileLabel(text(input["file"], "The file", 120) ?? null, "picture");
    const page = whole(input["page"], "The page", 1, 100000, 1);
    if (input["replace"] !== undefined) {
      const at = whole(input["replace"], "The place", 0, 1_000_000);
      const held = s.entries[at];
      if (!held?.waiting) throw badRequest("That page is not waiting for a picture.");
      delete held.waiting;
      held.entry.result = { ok: false, cause: "quality", reason };
      changed(s);
      return ok({ entry: at, pages: s.entries.length });
    }
    return ok({ entry: addRefused(s, file, page, reason), pages: s.entries.length });
  }

  if (what === "waiting" && req.method === "GET") {
    const held = s.entries[Number(a)];
    if (!/^\d{1,7}$/.test(a ?? "") || !held?.waiting) throw notFound("That page is not waiting for the window.");
    return { status: 200, bytes: { data: held.waiting.bytes, type: "application/octet-stream" } };
  }

  if (what === "sheets" && a !== undefined && req.method === "GET") {
    if (!/^\d{1,6}$/.test(a)) throw notFound("There is no such sheet.");
    return ok(sheetView(s, Number(a)));
  }

  if (what === "entries" && b === "crops" && c3 !== undefined && req.method === "GET") {
    if (!/^\d{1,7}$/.test(a ?? "") || !/^(q\d{1,4}|version)$/.test(c3)) throw notFound("There is no such picture.");
    return { status: 200, bytes: { data: cropOf(s, Number(a), c3), type: "image/png" } };
  }

  if (what === "settings" && req.method === "PUT") {
    const input = jsonObject(req);
    onlyFields(input, ["acceptBlanks"], "The settings");
    s.acceptBlanks = flag(input["acceptBlanks"], "Taking blanks as read", s.acceptBlanks);
    changed(s);
    return ok(view(s));
  }

  if (what === "decisions" && req.method === "POST") {
    if (a === "undo") undo(s, req);
    else decide(s, req);
    return ok(view(s));
  }

  if (what === "adjustments") {
    if (a === "check" && req.method === "POST") {
      const candidate = adjustmentFrom(s, req);
      const c = compute(s);
      const effect = adjustmentEffect(s.test, c.settled, s.adjustments, candidate);
      return ok({ words: adjustmentWords(candidate, s.test), changed: effect.changed, sheets: effect.sheets });
    }
    if (a === undefined && req.method === "POST") {
      const candidate = adjustmentFrom(s, req);
      s.adjustments.push(candidate);
      changed(s);
      return ok(view(s));
    }
    if (a !== undefined && req.method === "DELETE") {
      const before = s.adjustments.length;
      s.adjustments = s.adjustments.filter((x) => x.id !== a);
      if (s.adjustments.length === before) throw notFound("There is no such adjustment.");
      changed(s);
      return ok(view(s));
    }
  }

  if (what === "save" && req.method === "POST") return save(ctx, s);
  if (what === "export" && req.method === "POST") return exportFiles(ctx, req, s);

  if (what === "statistics" && req.method === "POST") {
    const input = jsonObject(req);
    onlyFields(input, ["date", "confirm"], "The request");
    // The figures go into the bank, which is a file that is shared, so it is done only when the instructor says so.
    if (input["confirm"] !== true) throw badRequest("Keeping the class figures in the bank has to be asked for.");
    const c = compute(s);
    if (c.stats.sheets === 0) throw badRequest("There are no complete sheets, so there are no figures to keep in the bank.");
    if (s.statsKeptAt === s.revision) throw new HttpError(409, "These figures are already kept in the bank.");
    const administration = administrationFrom(s.test, c.stats, dateOf(input["date"]));
    await ctx.banks.change(s.bank, (bank) => void bank.addAdministration(administration));
    s.statsKeptAt = s.revision;
    return ok({ kept: administration.id, sheets: administration.sheets });
  }

  throw notFound("There is no such page.");
}
