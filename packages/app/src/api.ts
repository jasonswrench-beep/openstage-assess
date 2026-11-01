/**
 * What the screen can ask for.
 *
 * Every route is a function of a request already read and checked by the server (who is asking, from where, how big), and
 * answers with JSON or a file. Nothing here touches the network. Names that come from the request are checked before they
 * are used, and a change to a bank is written before the answer says it was made.
 */

import { extname } from "node:path";

import {
  BANK_EXTENSION,
  createQuestion,
  dismissFinding,
  docxToBlocks,
  editQuestion,
  ENGINE_VERSION,
  FindingCode,
  finding,
  importerFor,
  liveFindings,
  linesToBlocks,
  newQuestionId,
  QUESTION_TYPES,
  runImporter,
  standardTextImporter,
  validateQuestion,
  verdictOf,
  type Question,
  type QuestionType,
} from "./engine.ts";
import type { BankStore } from "./banks.ts";
import { blankInput, editFromInput, EDITABLE_TYPES, missingText, parseInput, questionFromInput, toEditor, type EditorInput } from "./editor.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { checkName, cleanName, insideLibrary, type Library } from "./library.ts";
import { summarise, type Sessions } from "./sessions.ts";

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
}

export interface Context {
  library: Library;
  banks: BankStore;
  sessions: Sessions;
  /** Shows a file in the folder it is in. Replaced in tests. */
  reveal: (path: string) => void | Promise<void>;
  /** Further routes, added by the export and print screens. */
  extra?: Array<(ctx: Context, req: ApiRequest) => Promise<ApiResponse | undefined>>;
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
    if (/^(Refusing to add|That edit would leave|No question with the id|This bank already holds)/.test(message)) throw badRequest(message);
    throw error;
  }
}

function index(segment: string | undefined, length: number, what: string): number {
  const n = Number(segment);
  if (!Number.isInteger(n) || n < 0 || n >= length) throw notFound(`There is no ${what} ${segment ?? ""}.`.trim());
  return n;
}

/** The same question, as the screen would send it back: used to tell a save that changes nothing from one that does. */
function inputOf(question: Question): EditorInput {
  const e = toEditor(question);
  return { type: e.type, title: e.title, stem: e.stem, points: e.points, feedback: e.feedback, metadata: e.metadata, body: e.body };
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
  const name = req.query.get("name") ?? "import.txt";
  const extension = extname(name).toLowerCase();
  if (extension === ".doc") {
    throw badRequest("This is an older Word file (.doc). In Word, choose File, then Save As, and pick Word Document (*.docx).");
  }
  if (extension === BANK_EXTENSION) throw badRequest("This is an OpenAssess bank, not a file to import. Use Open a bank.");
  if (req.body.length === 0) throw badRequest("That file is empty.");

  const bytes = new Uint8Array(req.body);
  const importer = importerFor(name) ?? standardTextImporter;
  const keyMark = req.query.get("keyMark");
  let result;
  try {
    result = runImporter(importer, bytes, { file: name, author: BY, ...(keyMark ? { keyMark } : {}) });
  } catch (error) {
    throw new HttpError(422, `That file could not be read: ${(error as Error).message}`);
  }

  // The lines of the file as the importer saw them, so that a question's block numbers point at the same lines on screen.
  const source =
    extension === ".docx"
      ? docxToBlocks(bytes).blocks.map((b) => `${b.listLabel ? `${b.listLabel} ` : ""}${b.text}`)
      : linesToBlocks(Buffer.from(bytes).toString("utf8")).map((b) => b.text);

  return ok(ctx.sessions.view(ctx.sessions.create(result, source)));
}

async function sessionRoute(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const [, id, what, which, action] = req.segments;
  const session = ctx.sessions.get(id ?? "");

  if (what === undefined) return ok(ctx.sessions.view(session));

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
      if (unchanged(question, input)) return ok({ question: toEditor(question), summary: summarise(question, at), flattened: [], counts: ctx.sessions.view(session)["counts"] });
      const { edit, flattened } = editFromInput(question, input);
      const next = asBadRequest(() => {
        const edited = editQuestion(question, edit, { by: BY });
        const checked = validateQuestion(edited);
        if (!checked.ok) throw badRequest(`That edit would leave the question invalid, so nothing was changed: ${checked.issues.map((i) => `${i.path || "question"}: ${i.message}`).join("; ")}`);
        return edited;
      });
      session.questions[at] = next;
      return ok({ question: toEditor(next), summary: summarise(next, at), flattened, counts: ctx.sessions.view(session)["counts"] });
    }

    if (action === "dismiss" && req.method === "POST") {
      const next = dismiss(question, jsonBody(req));
      session.questions[at] = next;
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

async function saveSession(ctx: Context, session: ReturnType<Sessions["get"]>, body: Record<string, unknown>): Promise<ApiResponse> {
  if (session.savedTo) {
    throw new HttpError(409, `This import was already saved to "${session.savedTo.bank}". Import the file again to save it somewhere else.`);
  }
  const existing = typeof body["bank"] === "string" && body["bank"] !== "" ? checkName(body["bank"]) : undefined;
  const title = typeof body["title"] === "string" ? body["title"].trim() : "";
  if (!existing && title === "") throw badRequest("Say which bank to save into, or give a title for a new one.");

  const name = existing ?? (await ctx.banks.create(title));
  const chosen = session.questions.flatMap((q, i) => (session.skipped[i] ? [] : [[i, q] as const]));
  const notSaved: Array<{ index: number; title: string; reason: string }> = [];
  let added = 0;
  await ctx.banks.change(name, (bank) => {
    for (const [i, q] of chosen) {
      try {
        bank.add(q);
        added++;
      } catch (error) {
        notSaved.push({ index: i, title: q.title, reason: (error as Error).message });
      }
    }
  });
  session.savedTo = { bank: name, added };
  const left = session.orphans.filter((o) => !o.made).length;
  return ok({ bank: name, added, skipped: session.skipped.filter(Boolean).length, notSaved, orphansLeft: left });
}

// ---------------------------------------------------------------------------
// Banks
// ---------------------------------------------------------------------------

function listQuestions(questions: Question[], query: URLSearchParams): Question[] {
  const type = query.get("type");
  const status = query.get("status");
  const check = query.get("check");
  return questions.filter((q) => {
    if (type && q.type !== type) return false;
    if (status && q.metadata.status !== status) return false;
    if (check) {
      const verdict = verdictOf(q);
      if (check === "problems" && verdict === "parsed") return false;
      if (check === "errors" && verdict !== "failed") return false;
      if (check === "clean" && verdict !== "parsed") return false;
    }
    return true;
  });
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
  if (rawName === "open" && req.method === "POST") {
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
      const shown = listQuestions(req.query.get("q")?.trim() ? bank.search(req.query.get("q") as string) : all, req.query);
      shown.sort((a, b) => a.id.localeCompare(b.id));
      return ok({
        name,
        title: bank.manifest.title,
        created: bank.manifest.created,
        modified: bank.manifest.modified,
        stats: bank.stats(),
        total: all.length,
        questions: shown.map((q) => summarise(q, all.indexOf(q))),
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

  if (what === "questions") {
    if (id === undefined && req.method === "POST") {
      const input = readInput(jsonBody(req));
      const created = await ctx.banks.change(name, (bank) => {
        const question = questionFromInput(input, BY);
        return asBadRequest(() => bank.add(question));
      });
      return ok({ question: toEditor(created), summary: summarise(created, 0) });
    }

    if (id !== undefined) {
      const bank = await ctx.banks.open(name);
      const question = bank.get(id);
      if (!question) throw notFound("There is no such question in this bank.");

      if (action === undefined && req.method === "GET") return ok({ question: toEditor(question) });

      if (action === undefined && req.method === "PUT") {
        const body = jsonBody(req);
        const input = readInput(body);
        if (typeof body["expectVersion"] === "number" && body["expectVersion"] !== question.version) {
          throw new HttpError(409, "This question was changed since you opened it. Open it again to see the change.");
        }
        if (unchanged(question, input)) return ok({ question: toEditor(question), summary: summarise(question, 0), flattened: [] });
        const { edit, flattened } = editFromInput(question, input);
        const next = await ctx.banks.change(name, (b) => asBadRequest(() => b.update(id, edit, { by: BY })));
        return ok({ question: toEditor(next), summary: summarise(next, 0), flattened });
      }

      if (action === undefined && req.method === "DELETE") {
        await ctx.banks.change(name, (b) => b.remove(id));
        return ok({ removed: id });
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
        await ctx.banks.change(name, (b) => asBadRequest(() => b.add(copy)));
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
  if (first === "banks") return bankRoute(ctx, req);
  if (first === "import" && req.method === "POST") return importFile(ctx, req);
  if (first === "sessions") return sessionRoute(ctx, req);
  if (first === "reveal" && req.method === "POST") {
    const body = jsonBody(req);
    const path = typeof body["path"] === "string" ? body["path"] : "";
    if (path === "" || !insideLibrary(ctx.library, path)) throw badRequest("That file is not in your OpenAssess folder.");
    await ctx.reveal(path);
    return ok({ shown: path });
  }
  throw notFound("There is no such page.");
}
