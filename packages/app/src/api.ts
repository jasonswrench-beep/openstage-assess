/**
 * What the screen can ask for.
 *
 * Every route is a function of a request already read and checked by the server (who is asking, from where, how big), and
 * answers with JSON or a file. Nothing here touches the network. Names that come from the request are checked before they
 * are used, and a change to a bank is written before the answer says it was made.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  BANK_EXTENSION,
  cannotRead,
  createQuestion,
  dismissFinding,
  docxToBlocks,
  editQuestion,
  ENGINE_VERSION,
  FindingCode,
  finding,
  importerForContent,
  liveFindings,
  linesToBlocks,
  newQuestionId,
  COVERAGE_AXES,
  coverage,
  facets,
  isCoverageAxis,
  matchesFacets,
  QUALITY_CODES,
  QUESTION_TYPES,
  cleanFolderName,
  runImporter,
  addPicture,
  PictureError,
  removePicture,
  replacePicture,
  sniffImage,
  validateQuestion,
  verdictOf,
  type Bank,
  type PictureEdit,
  type QualityRun,
  type Question,
  type QuestionType,
} from "./engine.ts";
import type { BankStore } from "./banks.ts";
import { blankInput, editFromInput, EDITABLE_TYPES, missingText, parseInput, questionFromInput, toEditor, type EditorInput } from "./editor.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { destinationsRoute, exportRoute } from "./exports.ts";
import { printRoute } from "./printing.ts";
import { scoresRoute, scoringRoute } from "./scoring-routes.ts";
import { checkForUpdates, type UpdateSettings } from "./updates.ts";
import { sheetsRoute } from "./sheets.ts";
import { checkName, cleanName, insideLibrary, type Library } from "./library.ts";
import { sampleById, samplePath, SAMPLES } from "./samples.ts";
import type { ScoringSessions } from "./scoring.ts";
import { summarise, type Sessions } from "./sessions.ts";

/**
 * What an edit replaced: the checks that were live and are now dismissed, with their codes. An answer chosen by hand replaces what
 * the file's key said, and words written where a placeholder was replace what was said about that, and the person is told which,
 * so that nothing the file said is dropped without a word.
 */
function replacedBy(before: Question, after: Question): Array<{ code: string; message: string }> {
  return liveFindings(before.findings)
    .filter((f) => after.findings.some((g) => g.dismissed === true && g.code === f.code && g.message === f.message))
    .map((f) => ({ code: f.code, message: f.message }));
}

/** Who changes are recorded as made by. Nobody's name is asked for or kept. */
const BY = "you";

export interface ApiRequest {
  method: string;
  /** The path after /api, split and decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
}

export interface ApiResponse {
  status: number;
  json?: unknown;
  /** A file under the library to send, by the path the server gave out. */
  file?: { path: string; name: string; type: string };
  /** Bytes held in memory to send as they are: a piece of a picture for Review, which is never written to a file. */
  bytes?: { data: Uint8Array; type: string };
}

export interface Context {
  library: Library;
  banks: BankStore;
  sessions: Sessions;
  /** Answer sheets being scored. In memory, and gone when the app closes unless saved as a scores file. */
  scoring: ScoringSessions;
  /** Shows a file in the folder it is in. Replaced in tests. */
  reveal: (path: string) => void | Promise<void>;
  /** Further routes, added by the export and print screens. */
  extra?: Array<(ctx: Context, req: ApiRequest) => Promise<ApiResponse | undefined>>;
  /** Check for updates: the release this copy is, whether checking is on, and how the list of releases is fetched (`updates.ts`). */
  updates?: UpdateSettings;
}

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

function jsonBody(req: ApiRequest): Record<string, unknown> {
  if (req.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString("utf8"));
  } catch {
    throw badRequest("The request was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw badRequest("The request was not a JSON object.");
  return parsed as Record<string, unknown>;
}

/** The engine refuses a change that would leave a question invalid, with words; that is the person's to read, not a crash. */
function asBadRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = (error as Error).message;
    // The engine's own sentences about a request that cannot be done (a folder with no name, two folders of one name, a folder that is
    // not there): said to the person as they are, where anything else is a fault and stays one.
    if (/^(Refusing to add|That edit would leave|No question with the id|This bank already holds|No folder with the id|A folder\b|There is already a folder called)/.test(message)) throw badRequest(message);
    throw error;
  }
}

/**
 * A picture's bytes as an answer. The name is the part after `media/` and is checked before it is looked up, and the type sent is
 * the one the bytes are (a PNG, a JPEG or a GIF), never one the name or a file claims: a bank can come from anywhere, and what is
 * not a picture is not served. The server marks every answer nosniff, so the browser does not decide otherwise.
 */
function pictureResponse(name: string | undefined, held: ReadonlyMap<string, Uint8Array>): ApiResponse {
  if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) || name.includes("..")) throw notFound("There is no such picture.");
  const bytes = held.get(`media/${name}`);
  const info = bytes === undefined ? undefined : sniffImage(bytes);
  if (bytes === undefined || info === undefined) throw notFound("There is no such picture.");
  return { status: 200, bytes: { data: bytes, type: info.mime } };
}

/**
 * What a request to /pictures asks of a question: POST the picture's bytes to add one (put at the end of the text unless ?place=0), POST
 * the bytes to .../<id>/replace to give a picture other bytes, DELETE .../<id> to take one away that no text has in place. The same
 * for a question in a bank and one in an import under review: the address is /banks/<name>/questions/<id>/pictures... or
 * /sessions/<id>/questions/<n>/pictures..., so the picture's id and what follows it are the sixth and seventh parts either way.
 */
function pictureEdit(question: Question, req: ApiRequest): PictureEdit | undefined {
  const pictureId = req.segments[5];
  const sub = req.segments[6];
  try {
    if (pictureId === undefined && req.method === "POST") return addPicture(question, new Uint8Array(req.body), { place: req.query.get("place") !== "0" });
    if (pictureId !== undefined && sub === "replace" && req.method === "POST") return replacePicture(question, pictureId, new Uint8Array(req.body));
    if (pictureId !== undefined && sub === undefined && req.method === "DELETE") return removePicture(question, pictureId);
  } catch (error) {
    if (error instanceof PictureError) throw badRequest(error.message);
    throw error;
  }
  throw notFound("There is no such page.");
}

function index(segment: string | undefined, length: number, what: string): number {
  const n = Number(segment);
  if (!Number.isInteger(n) || n < 0 || n >= length) throw notFound(`There is no ${what} ${segment ?? ""}.`.trim());
  return n;
}

/** The same question, as the screen would send it back: used to tell a save that changes nothing from one that does. */
function inputOf(question: Question): EditorInput {
  const e = toEditor(question);
  return {
    type: e.type,
    title: e.title,
    stem: e.stem,
    points: e.points,
    feedback: e.feedback,
    metadata: e.metadata,
    body: e.body,
    // The key is left out for a question with no pictures, as the screen leaves it out, so the two compare the same.
    ...(e.pictures.length > 0 ? { pictures: e.pictures.map((p) => ({ id: p.id, alt: p.alt, decorative: p.decorative })) } : {}),
  };
}

const unchanged = (question: Question, input: EditorInput): boolean => JSON.stringify(inputOf(question)) === JSON.stringify(input);

function readInput(raw: Record<string, unknown>): EditorInput {
  const parsed = parseInput(raw["input"]);
  if (!parsed.ok) throw badRequest(parsed.errors.join(" "));
  const missing = missingText(parsed.input);
  if (missing.length > 0) throw badRequest(missing.join(" "));
  return parsed.input;
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

async function importFile(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  return importBytes(ctx, req.query.get("name") ?? "import.txt", req.body, req.query.get("keyMark"));
}

/** Reads a file's bytes into an import to look at. The same for a file the person chose and for a sample. */
function importBytes(ctx: Context, name: string, body: Buffer, keyMark: string | null): ApiResponse {
  const extension = extname(name).toLowerCase();
  // A file of a kind this does not read (an older Word or Excel file, OpenDocument, a Google Drive shortcut, a web page) is said to be
  // one and told what to do instead, and is not read as text.
  const cannot = cannotRead(name);
  if (cannot) throw badRequest(cannot);
  if (extension === BANK_EXTENSION) throw badRequest("This is an OpenAssess bank, not a file to import. Use Open a bank.");
  if (body.length === 0) throw badRequest("That file is empty.");

  const bytes = new Uint8Array(body);
  const importer = importerForContent(name, bytes);
  let result;
  try {
    result = runImporter(importer, bytes, { file: name, author: BY, ...(keyMark ? { keyMark } : {}) });
  } catch (error) {
    throw new HttpError(422, `That file could not be read: ${(error as Error).message}`);
  }

  // The lines of the file as the importer saw them, so that a question's block numbers point at the same lines on screen. A
  // table has its rows for lines, and says so itself.
  const source =
    result.sourceLines ??
    (extension === ".docx"
      ? docxToBlocks(bytes).blocks.map((b) => `${b.listLabel ? `${b.listLabel} ` : ""}${b.text}`)
      : linesToBlocks(Buffer.from(bytes).toString("utf8")).map((b) => b.text));

  return ok(ctx.sessions.view(ctx.sessions.create(result, source)));
}

/**
 * The samples: what there is, and one of them made into an import. A copy to keep is not a route here: it is a download, at
 * `/files/samples/<id>` on the server itself, so that the window can ask where to put it like it does for any file.
 */
async function samplesRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [, id, action] = req.segments;
  if (id === undefined) {
    if (req.method !== "GET") throw notFound("There is no such page.");
    return ok({ samples: SAMPLES.map(({ id, title, description, kind, template }) => ({ id, title, description, kind, template: template === true })) });
  }
  const sample = sampleById(id);
  if (!sample || req.method !== "POST") throw notFound("There is no such sample.");
  if (action === "import") return importBytes(ctx, sample.file, Buffer.from(await readFile(samplePath(sample))), null);
  throw notFound("There is no such page.");
}

async function sessionRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [, id, what, which, action] = req.segments;
  const session = ctx.sessions.get(id ?? "");

  if (what === undefined) return ok(ctx.sessions.view(session));

  // A picture the file held, for the review to show beside the question that has it.
  if (what === "media" && req.method === "GET") return pictureResponse(which, session.media);

  if (what === "questions") {
    const at = index(which, session.questions.length, "question");
    const question = session.questions[at] as Question;

    if (action === undefined && req.method === "GET") return ok({ question: toEditor(question), skipped: session.skipped[at] === true });

    if (action === undefined && req.method === "PUT") {
      const body = jsonBody(req);
      const input = readInput(body);
      if (typeof body["expectVersion"] === "number" && body["expectVersion"] !== question.version) {
        throw new HttpError(409, "This question was changed since you opened it. Open it again to see the change.");
      }
      if (unchanged(question, input)) return ok({ question: toEditor(question), summary: summarise(question, at), flattened: [], replaced: [], counts: ctx.sessions.view(session)["counts"] });
      const { edit, flattened } = editFromInput(question, input);
      const next = asBadRequest(() => {
        const edited = editQuestion(question, edit, { by: BY });
        const checked = validateQuestion(edited);
        if (!checked.ok) throw badRequest(`That edit would leave the question invalid, so nothing was changed: ${checked.issues.map((i) => `${i.path || "question"}: ${i.message}`).join("; ")}`);
        return edited;
      });
      session.questions[at] = next;
      return ok({ question: toEditor(next), summary: summarise(next, at), flattened, replaced: replacedBy(question, next), counts: ctx.sessions.view(session)["counts"] });
    }

    if (action === "dismiss" && req.method === "POST") {
      const next = dismiss(question, jsonBody(req));
      session.questions[at] = next;
      return ok({ question: toEditor(next), summary: summarise(next, at), counts: ctx.sessions.view(session)["counts"] });
    }

    if (action === "pictures") {
      const made = pictureEdit(question, req);
      if (made === undefined) return ok({ question: toEditor(question), summary: summarise(question, at), counts: ctx.sessions.view(session)["counts"] });
      const next = asBadRequest(() => {
        const edited = editQuestion(question, made.edit, { by: BY, change: made.change });
        const checked = validateQuestion(edited);
        if (!checked.ok) throw badRequest(`That change would leave the question invalid, so nothing was changed: ${checked.issues.map((i) => `${i.path || "question"}: ${i.message}`).join("; ")}`);
        return edited;
      });
      session.questions[at] = next;
      if (req.method === "POST" && !session.media.has(made.file)) session.media.set(made.file, new Uint8Array(req.body));
      return ok({ question: toEditor(next), summary: summarise(next, at), counts: ctx.sessions.view(session)["counts"] });
    }

    if (action === "skip" && req.method === "POST") {
      const body = jsonBody(req);
      session.skipped[at] = body["skipped"] !== false;
      return ok({ summary: { ...summarise(question, at), skipped: session.skipped[at] === true }, counts: ctx.sessions.view(session)["counts"] });
    }
  }

  if (what === "orphans" && action === "question" && req.method === "POST") {
    const at = index(which, session.orphans.length, "piece of text");
    const orphan = session.orphans[at];
    if (!orphan || orphan.made) throw badRequest("A question was already made from that text.");
    const made = createQuestion({
      type: "essay",
      stem: orphan.text,
      body: {},
      by: BY,
      metadata: { status: "draft", tags: [] },
      origin: { kind: "import", source: orphan.source, profile: session.profile, at: new Date().toISOString() },
      findings: [
        finding(
          FindingCode.TypeInferred,
          "warn",
          "Made from text that no question used. It is an essay question only because it has to be some type: set the type and the answer.",
        ),
      ],
    });
    session.questions.push(made);
    session.skipped.push(false);
    orphan.made = true;
    return ok({ summary: summarise(made, session.questions.length - 1), view: ctx.sessions.view(session) });
  }

  if (what === "save" && req.method === "POST") return saveSession(ctx, session, jsonBody(req));

  throw notFound("There is no such page.");
}

function dismiss(question: Question, body: Record<string, unknown>): Question {
  const live = liveFindings(question.findings);
  // An error is fixed, not dismissed. Dismissing a missing answer would make a question that cannot be scored look finished.
  if (typeof body["code"] === "string") {
    const target = live.find((f) => f.code === body["code"]);
    if (!target) throw badRequest("That check is not on this question.");
    if (target.severity === "error") throw badRequest("An error cannot be dismissed. Fix the question, and the error goes.");
    return dismissFinding(question, target.code, BY);
  }
  if (body["all"] === true) {
    let next = question;
    for (const f of live) if (f.severity !== "error") next = dismissFinding(next, f.code, BY);
    return next;
  }
  throw badRequest("Say which check to dismiss.");
}

/**
 * Saves an import into a bank, once. The button that asks for it can be pressed again before the first answer comes back, and a
 * request that comes while the first is being done waits for it and is told what it made: it used to make a bank for each (eight
 * requests, eight banks, each holding the questions). The request in progress is kept on the session before anything is awaited, and
 * is let go when it is done, so that a save that failed can be asked for again.
 */
async function saveSession(ctx: Context, session: ReturnType<Sessions["get"]>, body: Record<string, unknown>): Promise<ApiResponse> {
  if (session.savedTo) {
    throw new HttpError(409, `This import was already saved to "${session.savedTo.bank}". Import the file again to save it somewhere else.`);
  }
  if (session.saving) return session.saving;
  const saving = saveSessionOnce(ctx, session, body).finally(() => {
    if (session.saving === saving) delete session.saving;
  });
  session.saving = saving;
  return saving;
}

async function saveSessionOnce(ctx: Context, session: ReturnType<Sessions["get"]>, body: Record<string, unknown>): Promise<ApiResponse> {
  const existing = typeof body["bank"] === "string" && body["bank"] !== "" ? checkName(body["bank"]) : undefined;
  const title = typeof body["title"] === "string" ? body["title"].trim() : "";
  if (!existing && title === "") throw badRequest("Say which bank to save into, or give a title for a new one.");

  // A folder to put the questions in, by name: found if the bank has one of that name at the top, made if not. The name is checked
  // before a bank is made, so that a name that cannot be used does not leave an empty bank behind.
  if (body["folder"] !== undefined && body["folder"] !== null && typeof body["folder"] !== "string") throw badRequest("The folder has to be a name.");
  const rawFolder = typeof body["folder"] === "string" && body["folder"].trim() !== "" ? body["folder"] : undefined;
  const folderName = rawFolder === undefined ? undefined : asBadRequest(() => cleanFolderName(rawFolder));

  const name = existing ?? (await ctx.banks.create(title));
  const chosen = session.questions.flatMap((q, i) => (session.skipped[i] ? [] : [[i, q] as const]));
  const notSaved: Array<{ index: number; title: string; reason: string }> = [];
  let added = 0;
  await ctx.banks.change(name, (bank) => {
    const folderId = folderName === undefined ? undefined : bank.ensureFolder(folderName).id;
    for (const [i, q] of chosen) {
      try {
        bank.add(q, { folderId, media: session.media });
        added++;
      } catch (error) {
        notSaved.push({ index: i, title: q.title, reason: (error as Error).message });
      }
    }
  });
  session.savedTo = { bank: name, added };
  const left = session.orphans.filter((o) => !o.made).length;
  return ok({ bank: name, added, folder: folderName ?? null, skipped: session.skipped.filter(Boolean).length, notSaved, orphansLeft: left });
}

// ---------------------------------------------------------------------------
// Banks
// ---------------------------------------------------------------------------

/** The notes about writing and accessibility a question has that nobody has dismissed. */
function liveNotes(q: Question) {
  return q.findings.filter((f) => !f.dismissed && QUALITY_CODES.has(f.code));
}

/**
 * What checking a bank for quality found, as the screen shows it. The notes were written to the questions by the check itself; what
 * looks across questions (copies, where the right answers sit) was worked out just now and is not kept anywhere.
 */
export function qualityView(bank: Bank, run: QualityRun) {
  return {
    checked: run.checked,
    changed: run.changed,
    notes: run.notes,
    questions: run.questions.map(({ id, title }) => ({ id, title, notes: liveNotes(bank.get(id) as Question).map((f) => ({ code: f.code, message: f.message })) })),
    duplicates: run.report.duplicates.map(({ kind, questionIds, titles, message }) => ({ kind, questionIds, titles, message })),
    keyBalance: run.report.keyBalance.map(({ scope, label, message }) => ({ scope, label, message })),
    // What the check could not do in full (the search for questions that are very much alike is limited for a bank of thousands that
    // share their words), said where the person reads the result and not only on the command line.
    limits: run.report.limits.map(({ severity, check, message }) => ({ severity, check, message })),
  };
}

/**
 * What the bank covers, for the grid: two of objective, chapter, section, tag, Bloom level, difficulty, kind and status, against
 * each other. Nothing is stored, and nothing is changed.
 */
function coverageRoute(ctx: Context, name: string, query: URLSearchParams) {
  const rows = query.get("rows") ?? "objective";
  const cols = query.get("cols") ?? "bloom";
  if (!isCoverageAxis(rows) || !isCoverageAxis(cols)) throw badRequest(`Choose rows and columns from ${COVERAGE_AXES.join(", ")}.`);
  return ctx.banks.open(name).then((bank) => ok(coverage(bank.sortedQuestions(), rows, cols, { includeRetired: query.get("retired") === "1" })));
}

/** The things a list can be narrowed by, from the address: each is one value, and "(none)" asks for a question without one. */
function facetFilters(query: URLSearchParams): Partial<Record<(typeof COVERAGE_AXES)[number], string>> {
  const out: Partial<Record<(typeof COVERAGE_AXES)[number], string>> = {};
  for (const axis of COVERAGE_AXES) {
    const value = query.get(axis);
    if (value) out[axis] = value;
  }
  return out;
}

/**
 * The questions a folder choice in the address means: the ones in a folder and in the folders inside it, or (with "(none)") the ones in
 * no folder. A folder that is not there any more (taken away in another window) holds nothing, so the list is empty and the screen,
 * which is sent the folders that are there, can see it and say so.
 */
function folderChoice(bank: Bank, query: URLSearchParams): Set<string> | undefined {
  const folder = query.get("folder");
  if (!folder) return undefined;
  if (folder === "(none)") return bank.unfiledIds();
  return bank.allFolders().some((f) => f.id === folder) ? bank.questionIdsUnder(folder) : new Set();
}

function listQuestions(questions: Question[], query: URLSearchParams, inFolder?: Set<string>): Question[] {
  const type = query.get("type");
  const status = query.get("status");
  const check = query.get("check");
  const narrowed = facetFilters(query);
  // Retired questions are left out when asked: a cell of the coverage grid does not count them, so the list it opens must not show them.
  const hideRetired = query.get("hideRetired") === "1";
  return questions.filter((q) => {
    if (inFolder && !inFolder.has(q.id)) return false;
    if (hideRetired && q.metadata.status === "retired") return false;
    if (type && q.type !== type) return false;
    if (status && q.metadata.status !== status) return false;
    if (!matchesFacets(q, narrowed)) return false;
    if (check === "notes") return liveNotes(q).length > 0;
    if (check) {
      const verdict = verdictOf(q);
      if (check === "problems" && verdict === "parsed") return false;
      if (check === "errors" && verdict !== "failed") return false;
      if (check === "clean" && verdict !== "parsed") return false;
    }
    return true;
  });
}

/**
 * Folders in a bank: made, renamed, moved and taken away. A folder is a way of finding questions and never holds one: taking a folder
 * away leaves its questions in the bank, in no folder, and moves the folders inside it up. Every answer carries the folders as they are
 * now, so the screen draws what the bank holds and not what it expects to.
 */
async function folderRoute(ctx: Context, req: ApiRequest, name: string, id: string | undefined): Promise<ApiResponse> {
  if (id === undefined && req.method === "POST") {
    const body = jsonBody(req);
    const parentId = typeof body["parentId"] === "string" && body["parentId"] !== "" ? body["parentId"] : undefined;
    return ok(
      await ctx.banks.change(name, (bank) => {
        const node = asBadRequest(() => bank.addFolder(typeof body["name"] === "string" ? body["name"] : "", parentId));
        return { folder: node.id, folders: bank.folderList() };
      }),
    );
  }

  if (id !== undefined && req.method === "PUT") {
    const body = jsonBody(req);
    const renames = "name" in body;
    const moves = "parentId" in body;
    if (!renames && !moves) throw badRequest("Say a new name, or a new place for the folder (parentId, or null for the top of the bank).");
    if (renames && typeof body["name"] !== "string") throw badRequest("A folder's name has to be text.");
    const parent = body["parentId"];
    if (moves && parent !== null && (typeof parent !== "string" || parent === "")) throw badRequest("Say which folder to put it in, or null for the top of the bank.");
    return ok(
      await ctx.banks.change(name, (bank) => {
        // A rename that worked and a move that was refused is not kept: a refusal drops the bank from memory, and nothing is saved.
        if (!bank.allFolders().some((f) => f.id === id)) throw notFound("There is no such folder in this bank.");
        asBadRequest(() => {
          if (renames) bank.renameFolder(id, body["name"] as string);
          if (moves) bank.moveFolder(id, parent === null ? undefined : (parent as string));
        });
        return { folder: id, folders: bank.folderList() };
      }),
    );
  }

  if (id !== undefined && req.method === "DELETE") {
    return ok(
      await ctx.banks.change(name, (bank) => {
        if (!bank.allFolders().some((f) => f.id === id)) throw notFound("There is no such folder in this bank.");
        const done = asBadRequest(() => bank.removeFolder(id));
        return { ...done, folders: bank.folderList(), unfiled: bank.unfiledIds().size };
      }),
    );
  }

  throw notFound("There is no such page.");
}

async function bankRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [, rawName, what, id, action] = req.segments;

  if (rawName === undefined) {
    if (req.method === "POST") {
      const body = jsonBody(req);
      const title = typeof body["title"] === "string" ? body["title"] : "";
      return ok({ name: await ctx.banks.create(title) });
    }
    throw notFound("There is no such page.");
  }

  // Opening a bank file from somewhere else is the one route here where the name is not already a bank's name.
  // Only the address with nothing after it: a bank called "open" has routes of its own (/banks/open/questions), and a bank that was
  // given that name could not be written to, because every one of them was taken for opening a file.
  if (rawName === "open" && what === undefined && req.method === "POST") {
    if (req.body.length === 0) throw badRequest("That file is empty.");
    const fileName = req.query.get("name") ?? "Imported bank.openassess";
    const adopted = await ctx.banks.adopt(new Uint8Array(req.body), cleanName(fileName.replace(/\.openassess$/i, "")));
    return ok(adopted);
  }

  const name = checkName(rawName);

  if (what === undefined) {
    if (req.method === "GET") {
      const bank = await ctx.banks.open(name);
      const all = bank.sortedQuestions();
      const shown = listQuestions(req.query.get("q")?.trim() ? bank.search(req.query.get("q") as string) : all, req.query, folderChoice(bank, req.query));
      shown.sort((a, b) => a.id.localeCompare(b.id));
      return ok({
        name,
        title: bank.manifest.title,
        created: bank.manifest.created,
        modified: bank.manifest.modified,
        stats: bank.stats(),
        total: all.length,
        // The choices for narrowing the list, counted over the whole bank (retired included, since a list can show them).
        facets: facets(all, { includeRetired: true }),
        // The folders, in the order they are shown, with how many questions are in each alone and under it, and how many are in none.
        folders: bank.folderList(),
        unfiled: bank.unfiledIds().size,
        // What could not be read when the file was opened. Those files are kept as they were, and are not in the list.
        problems: await ctx.banks.problems(name),
        questions: shown.map((q) => ({ ...summarise(q, all.indexOf(q)), notes: liveNotes(q).length, folderId: bank.folderIdOf(q.id) ?? null })),
      });
    }
    if (req.method === "PUT") {
      const body = jsonBody(req);
      await ctx.banks.retitle(name, typeof body["title"] === "string" ? body["title"] : "");
      return ok({ name });
    }
    if (req.method === "DELETE") {
      const moved = await ctx.banks.remove(name);
      return ok({ moved });
    }
  }

  if (what === "export" && req.method === "POST" && (id === "check" || id === undefined)) {
    return exportRoute(ctx, req, name, id === "check" ? "check" : "write");
  }

  if (what === "print" && req.method === "POST" && (id === "check" || id === undefined)) {
    return printRoute(ctx, req, name, id === "check" ? "check" : "write");
  }

  if (what === "coverage" && id === undefined && req.method === "GET") return coverageRoute(ctx, name, req.query);

  // Check quality: the notes are written to the questions (not as an edit: no version, no history entry on a question, no change of
  // status), and what is across the bank is worked out and sent, not kept.
  if (what === "quality" && id === undefined && req.method === "POST") {
    return ok(await ctx.banks.change(name, (b) => qualityView(b, b.checkQuality(BY))));
  }

  if (what === "folders") return folderRoute(ctx, req, name, id);

  // Filing several questions at once: POST { folderId: <a folder, or null for none>, questionIds: [...] }. All or nothing, and not an
  // edit of any question. The screen sends the questions the list is showing, so a bank is filed by what was searched or narrowed to.
  if (what === "filing" && id === undefined && req.method === "POST") {
    const body = jsonBody(req);
    const folderId = body["folderId"];
    if (folderId !== null && (typeof folderId !== "string" || folderId === "")) throw badRequest("Say which folder, or null for none.");
    const ids = body["questionIds"];
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100_000 || ids.some((q) => typeof q !== "string")) throw badRequest("Say which questions, as a list of their ids.");
    return ok(
      await ctx.banks.change(name, (bank) => {
        const done = asBadRequest(() => bank.moveManyToFolder(ids as string[], folderId === null ? undefined : (folderId as string)));
        return { ...done, folderId, folders: bank.folderList(), unfiled: bank.unfiledIds().size };
      }),
    );
  }

  // A picture a question in this bank carries. The bank is opened for it like for any read.
  if (what === "media" && req.method === "GET") return pictureResponse(id, (await ctx.banks.open(name)).media);

  if (what === "questions") {
    if (id === undefined && req.method === "POST") {
      const body = jsonBody(req);
      const input = readInput(body);
      // A question written while a folder is open is put in it, so that it is not lost to the top of the bank.
      const folderId = typeof body["folderId"] === "string" && body["folderId"] !== "" ? body["folderId"] : undefined;
      const created = await ctx.banks.change(name, (bank) => {
        const question = questionFromInput(input, BY);
        return asBadRequest(() => bank.add(question, { folderId }));
      });
      return ok({ question: toEditor(created), summary: summarise(created, 0) });
    }

    if (id !== undefined) {
      const bank = await ctx.banks.open(name);
      const question = bank.get(id);
      if (!question) throw notFound("There is no such question in this bank.");

      if (action === undefined && req.method === "GET") return ok({ question: toEditor(question), folderId: bank.folderIdOf(id) ?? null });

      // Filing a question in a folder, or taking it out of one (folderId null). It is not an edit of the question: the version, the
      // history and the notes of the question are as they were.
      if (action === "folder" && req.method === "POST") {
        const body = jsonBody(req);
        const folderId = body["folderId"];
        if (folderId !== null && (typeof folderId !== "string" || folderId === "")) throw badRequest("Say which folder, or null for none.");
        await ctx.banks.change(name, (b) =>
          asBadRequest(() => {
            if (folderId === null) b.unfile(id);
            else b.moveToFolder(id, folderId);
          }),
        );
        return ok({ folderId });
      }

      if (action === undefined && req.method === "PUT") {
        const body = jsonBody(req);
        const input = readInput(body);
        if (typeof body["expectVersion"] === "number" && body["expectVersion"] !== question.version) {
          throw new HttpError(409, "This question was changed since you opened it. Open it again to see the change.");
        }
        if (unchanged(question, input)) return ok({ question: toEditor(question), summary: summarise(question, 0), flattened: [], replaced: [] });
        const { edit, flattened } = editFromInput(question, input);
        const next = await ctx.banks.change(name, (b) => asBadRequest(() => b.update(id, edit, { by: BY })));
        return ok({ question: toEditor(next), summary: summarise(next, 0), flattened, replaced: replacedBy(question, next) });
      }

      if (action === undefined && req.method === "DELETE") {
        await ctx.banks.change(name, (b) => b.remove(id));
        return ok({ removed: id });
      }

      if (action === "pictures") {
        const made = pictureEdit(question, req);
        if (made === undefined) return ok({ question: toEditor(question), summary: summarise(question, 0) });
        const next = await ctx.banks.change(name, (b) => {
          const updated = asBadRequest(() => b.update(id, made.edit, { by: BY, change: made.change }));
          if (req.method === "POST" && !b.media.has(made.file)) b.media.set(made.file, new Uint8Array(req.body));
          return updated;
        });
        return ok({ question: toEditor(next), summary: summarise(next, 0) });
      }

      if (action === "dismiss" && req.method === "POST") {
        const next = dismiss(question, jsonBody(req));
        await ctx.banks.change(name, (b) => {
          b.questions.set(id, next);
          b.rebuildIndex();
        });
        return ok({ question: toEditor(next), summary: summarise(next, 0) });
      }

      if (action === "duplicate" && req.method === "POST") {
        const copy = createQuestion({
          type: question.type,
          stem: question.stem,
          title: `${question.title} (copy)`.slice(0, 120),
          points: question.points,
          body: structuredClone(question.body),
          feedback: structuredClone(question.feedback),
          metadata: { ...structuredClone(question.metadata), status: "draft" },
          media: structuredClone(question.media),
          math: structuredClone(question.math),
          findings: structuredClone(question.findings),
          origin: { kind: "copy", questionId: question.id },
          by: BY,
          id: newQuestionId(),
        });
        // The copy goes where the question is, so that duplicating one in a folder does not send the copy to the top of the bank.
        const folderId = bank.folderIdOf(id);
        await ctx.banks.change(name, (b) => asBadRequest(() => b.add(copy, { folderId })));
        return ok({ question: toEditor(copy), summary: summarise(copy, 0) });
      }
    }
  }

  throw notFound("There is no such page.");
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export async function handleApi(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [first] = req.segments;

  for (const route of ctx.extra ?? []) {
    const answered = await route(ctx, req);
    if (answered) return answered;
  }

  if (first === "state" && req.method === "GET") {
    return ok({ version: ENGINE_VERSION, home: ctx.library.home, exports: ctx.library.exports, banks: await ctx.banks.list() });
  }
  if (first === "blank" && req.method === "GET") {
    const type = req.query.get("type") ?? "multipleChoice";
    if (!(QUESTION_TYPES as readonly string[]).includes(type) || !EDITABLE_TYPES.includes(type as QuestionType)) {
      throw badRequest("That kind of question cannot be written here yet.");
    }
    return ok({ input: blankInput(type as QuestionType) });
  }
  if (first === "destinations" && req.method === "GET") return destinationsRoute();
  if (first === "banks") return bankRoute(ctx, req);
  if (first === "import" && req.method === "POST") return importFile(ctx, req);
  if (first === "samples") return samplesRoute(ctx, req);
  if (first === "sessions") return sessionRoute(ctx, req);
  if (first === "sheets") return sheetsRoute(ctx, req);
  if (first === "scoring") return scoringRoute(ctx, req);
  if (first === "scores") return scoresRoute(ctx, req);
  // Check for updates, which asks GitHub for the list of releases. A POST, so that it is an action the page asked for with its key
  // and its header, and never something another page could set off by pointing at an address.
  if (first === "updates" && req.segments[1] === "check" && req.segments.length === 2 && req.method === "POST") {
    return ok(ctx.updates ? await checkForUpdates(ctx.updates) : { state: "off", message: "Checking for updates is turned off on this computer." });
  }
  if (first === "reveal" && req.method === "POST") {
    const body = jsonBody(req);
    const path = typeof body["path"] === "string" ? body["path"] : "";
    if (path === "" || !insideLibrary(ctx.library, path)) throw badRequest("That file is not in your OpenAssess folder.");
    await ctx.reveal(path);
    return ok({ shown: path });
  }
  throw notFound("There is no such page.");
}
