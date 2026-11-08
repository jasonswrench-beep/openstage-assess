/**
 * Scoring a class of answer sheets: the state of one sitting, in memory, and the views of it the screen shows.
 *
 * A session holds the pages as they were read, a person's decisions, the adjustments, and, for the questions a person has to look
 * at, a small cut-out of the picture (a row of bubbles) so that no whole picture of a student's sheet stays in memory or is written
 * anywhere. Scores are worked out from all of that every time they are asked for, which is what lets a new answer, an adjustment or a
 * new key show at once with no rescan. A session writes nothing until it is saved, and what a saved scores file holds is decided in
 * the engine (sheets/scores-file.ts): sheet numbers, page numbers, picture fingerprints, readings, decisions and adjustments, and no
 * name, no file name and no picture.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  adjustmentWords,
  assembleBatch,
  cropRects,
  imageFingerprint,
  itemStatistics,
  openScans,
  orient,
  placeLetter,
  richTextToPlain,
  scoreSheets,
  settleSheets,
  SheetReader,
  sheetGeometry,
  versionQuestions,
  VERSION_LABELS,
  writePng,
  type Adjustment,
  type Batch,
  type BatchEntry,
  type BatchSheet,
  type Decision,
  type GreyImage,
  type Orientation,
  type SettledSheet,
  type SheetReading,
  type SheetScore,
  type TestRecord,
  type TestStatistics,
  type VersionLabel,
} from "./engine.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";

/** Most sittings kept open at once. The one not used for longest is let go when another is opened, as with imports. */
const MAX_SESSIONS = 8;
/** The most queue items sent at a time. The rest follow as these are settled. */
export const QUEUE_PAGE = 100;
/** The most pixels a page picture may have when the window sends it: a scan at 300 dots to the inch is about 8.4 million. */
export const MAX_PAGE_PIXELS = 16_000_000;

export interface ScanEntry {
  entry: BatchEntry;
  /** The pieces of the picture kept for Review, as PNG, by name: `q12` for the row of question 12, `version` for the version bubbles. */
  crops: Map<string, Uint8Array>;
  /** A picture the window has to decode before it can be read: held in its place so that the order of the batch is kept. */
  waiting?: { format: string; bytes: Uint8Array; orientation: Orientation };
}

export interface ScoringSession {
  id: string;
  /** The bank's file name, and the test in it. */
  bank: string;
  test: TestRecord;
  reader: SheetReader;
  created: string;
  entries: ScanEntry[];
  /** Set when the session was opened from a scores file: its sheets are as they were saved, and no more pages can be added. */
  fixed?: BatchSheet[];
  pagesPerSheet: number;
  decisions: Decision[];
  adjustments: Adjustment[];
  acceptBlanks: boolean;
  /** The scores file this session was opened from or saved to, which a later save updates (it is this session's own file). */
  savedAs?: string;
  /** The id a scores file of this sitting carries, kept the same through every save. */
  fileId?: string;
  /** The revision at which the class figures were kept in the bank, so that keeping them twice is not done by accident. */
  statsKeptAt?: number;
  /**
   * The save in progress and the revision it was asked for at, so that a save asked for while it is being done waits for it (and is
   * told the same name) and does not claim a second scores file: eight clicks of the Save button made eight files.
   */
  saving?: { revision: number; done: Promise<unknown> };
  revision: number;
  savedRevision: number;
  used: number;
  cache?: { revision: number; value: Computed };
}

export interface Computed {
  batch: Batch;
  entries: BatchEntry[];
  settled: SettledSheet[];
  scores: SheetScore[];
  stats: TestStatistics;
}

const sha = (...parts: Array<Uint8Array | string>): string => {
  const h = createHash("sha1");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};

export const letterOf = (version: number | undefined): string | undefined => (version === undefined ? undefined : VERSION_LABELS[version - 1]);

// ---------------------------------------------------------------------------------------------------------------------------
// The store

export class ScoringSessions {
  private readonly sessions = new Map<string, ScoringSession>();
  private clock = 0;

  private add(session: ScoringSession): ScoringSession {
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.used - b.used)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    session.used = ++this.clock;
    this.sessions.set(session.id, session);
    return session;
  }

  create(bank: string, test: TestRecord): ScoringSession {
    return this.add(blank(bank, test));
  }

  /** A sitting opened from a saved scores file: the readings and decisions come back, and no pictures. */
  restored(bank: string, test: TestRecord, file: { sheets: BatchSheet[]; entries: BatchEntry[]; decisions: Decision[]; adjustments: Adjustment[]; acceptBlanks: boolean; pagesPerSheet: number; id: string }, savedAs: string): ScoringSession {
    const session = blank(bank, test);
    session.entries = file.entries.map((entry) => ({ entry, crops: new Map() }));
    session.fixed = file.sheets;
    session.pagesPerSheet = file.pagesPerSheet;
    session.decisions = [...file.decisions];
    session.adjustments = [...file.adjustments];
    session.acceptBlanks = file.acceptBlanks;
    session.savedAs = savedAs;
    session.fileId = file.id;
    return this.add(session);
  }

  get(id: string): ScoringSession {
    const session = /^[A-Za-z0-9_-]{16}$/.test(id) ? this.sessions.get(id) : undefined;
    if (!session) throw new HttpError(404, "This scoring is no longer open. Open the scores file that was saved to carry on.");
    session.used = ++this.clock;
    return session;
  }

  close(id: string): boolean {
    return this.sessions.delete(id);
  }
}

function blank(bank: string, test: TestRecord): ScoringSession {
  return {
    id: randomBytes(12).toString("base64url"),
    bank,
    test,
    reader: new SheetReader(test),
    created: new Date().toISOString(),
    entries: [],
    pagesPerSheet: 1,
    decisions: [],
    adjustments: [],
    acceptBlanks: false,
    revision: 0,
    savedRevision: 0,
    used: 0,
  };
}

export const changed = (s: ScoringSession): void => {
  s.revision++;
  delete s.cache;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Adding pages

function pagesPerSheetOf(entries: readonly BatchEntry[], fallback: number): number {
  const first = entries.find((e) => e.result.ok);
  return first && first.result.ok ? first.result.code.pages : fallback;
}

/** The rectangles of the picture to keep for review: the rows of the questions a person may have to settle, and the version bubbles. */
function reviewRects(s: ScoringSession, reading: SheetReading): Array<{ key: string; rect: sheetGeometry.Rect }> {
  const out: Array<{ key: string; rect: sheetGeometry.Rect }> = [];
  for (const q of reading.questions) if (q.status === "flagged" || q.status === "blank") out.push({ key: `q${q.number}`, rect: q.rect });
  for (const f of reading.flags) if (f.kind === "version") out.push({ key: "version", rect: f.rect });
  // A page whose version is not settled has no decisions yet; once a person settles the version, any row may need looking at.
  if (reading.version === undefined) {
    const planned = s.reader.plan(reading.code.paper, reading.code.large);
    if (planned.ok) {
      const layout = sheetGeometry.layoutFor(reading.code.paper, planned.plan.style);
      for (const n of Object.keys(reading.fills).map(Number)) out.push({ key: `q${n}`, rect: sheetGeometry.slotRow(layout, (n - 1) % layout.questionsPerPage) });
    }
  }
  return out;
}

function cropsOf(s: ScoringSession, image: GreyImage, reading: SheetReading): Map<string, Uint8Array> {
  const wanted = reviewRects(s, reading);
  const crops = new Map<string, Uint8Array>();
  if (wanted.length === 0) return crops;
  const cut = cropRects(image, reading.code.paper, wanted.map((w) => w.rect));
  if (!cut) return crops;
  wanted.forEach((w, i) => {
    const piece = cut[i];
    if (piece && !crops.has(w.key)) crops.set(w.key, writePng(piece));
  });
  return crops;
}

function readPicture(s: ScoringSession, image: GreyImage, source: BatchEntry["source"]): ScanEntry {
  const result = s.reader.read(image);
  return { entry: { source, fingerprint: imageFingerprint(image), result }, crops: result.ok ? cropsOf(s, image, result) : new Map() };
}

function refusedEntry(file: string, page: number, reason: string, fingerprint: string): ScanEntry {
  return { entry: { source: { file, page }, fingerprint, result: { ok: false, cause: "quality", reason } }, crops: new Map() };
}

function push(s: ScoringSession, entry: ScanEntry): number {
  if (s.fixed) throw new HttpError(409, "These scores were opened from a saved file, and more scans cannot be added to them. Score the new scans as a new batch.");
  s.entries.push(entry);
  s.pagesPerSheet = pagesPerSheetOf(s.entries.map((e) => e.entry), s.pagesPerSheet);
  changed(s);
  return s.entries.length - 1;
}

/** A file of scans: a PNG or a PDF, which the engine opens. A page that is a JPEG is held in its place until the window decodes it. */
export function addFile(s: ScoringSession, file: string, bytes: Uint8Array): { added: number; waiting: Array<{ entry: number; page: number; format: string }>; notes: string[] } {
  const opened = openScans(bytes);
  if (!opened.ok) {
    push(s, refusedEntry(file, 1, opened.reason, sha(bytes)));
    return { added: 1, waiting: [], notes: [] };
  }
  const waiting: Array<{ entry: number; page: number; format: string }> = [];
  for (const page of opened.pages) {
    const source = { file, page: page.page };
    if (!page.result.ok) {
      push(s, refusedEntry(file, page.page, page.result.reason, sha(bytes, String(page.page))));
    } else if (page.result.source.kind === "window") {
      const w = page.result.source;
      const at = push(s, refusedEntry(file, page.page, `This ${w.format.toUpperCase()} page is waiting to be decoded by the window.`, sha(w.bytes)));
      (s.entries[at] as ScanEntry).waiting = { format: w.format, bytes: w.bytes, orientation: w.orientation };
      waiting.push({ entry: at, page: page.page, format: w.format });
    } else {
      push(s, readPicture(s, page.result.source.image, source));
    }
  }
  return { added: opened.pages.length, waiting, notes: opened.notes };
}

/** A picture the window decoded: a whole file the window could open, or a page it was waiting on (which is read in its place). */
export function addPicture(s: ScoringSession, file: string, page: number, image: GreyImage, replacing?: number): number {
  if (replacing === undefined) return push(s, readPicture(s, image, { file, page }));
  const held = s.entries[replacing];
  if (!held?.waiting) throw badRequest("That page is not waiting for a picture.");
  const turned = orient(image, held.waiting.orientation);
  s.entries[replacing] = readPicture(s, turned, held.entry.source);
  changed(s);
  return replacing;
}

/** A picture the window could not open, kept in its place with the reason, so that nothing is lost without a word. */
export function addRefused(s: ScoringSession, file: string, page: number, reason: string): number {
  return push(s, refusedEntry(file, page, reason, sha(file, String(page), reason, String(s.entries.length))));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Working it out

export function compute(s: ScoringSession): Computed {
  if (s.cache && s.cache.revision === s.revision) return s.cache.value;
  const entries = s.entries.map((e) => e.entry);
  const batch: Batch = s.fixed ? { sheets: s.fixed, flags: [], duplicates: [] } : assembleBatch(entries, s.pagesPerSheet);
  const settled = settleSheets(batch.sheets, entries, s.decisions, { acceptBlanks: s.acceptBlanks, reader: s.reader });
  const scores = scoreSheets(s.test, settled, s.adjustments);
  const value: Computed = { batch, entries, settled, scores, stats: itemStatistics(s.test, scores) };
  s.cache = { revision: s.revision, value };
  return value;
}

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 3).trimEnd()}...` : text);

function stemOf(s: ScoringSession, version: number | undefined, number: number): string {
  const label = (letterOf(version) ?? "A") as VersionLabel;
  const q = versionQuestions(s.test, label)[number - 1];
  return q ? clip(richTextToPlain(q.stem).replace(/\s+/g, " ").trim(), 140) : "";
}

/** The first read page of a sheet, which says how the sheet was printed. */
function printedAs(c: Computed, sheet: BatchSheet): SheetReading | undefined {
  for (const p of sheet.pages) {
    const r = p ? (c.entries[p.entry] as BatchEntry).result : undefined;
    if (r?.ok) return r;
  }
  return undefined;
}

/** What each place of a question is called on the sheet (A, B, C; or T and F), and whether it takes several. */
function placesOf(s: ScoringSession, c: Computed, sheet: BatchSheet, version: number | undefined, number: number): { labels: string[]; multiple: boolean } {
  const printed = printedAs(c, sheet);
  const label = letterOf(version) as VersionLabel | undefined;
  if (!printed || !label) return { labels: [], multiple: false };
  const planned = s.reader.plan(printed.code.paper, printed.code.large);
  if (!planned.ok) return { labels: [], multiple: false };
  const use = planned.plan.uses[label]?.[number - 1];
  const drawn = planned.plan.drawn[number - 1];
  if (!use || !drawn || use.places === 0) return { labels: [], multiple: false };
  return { labels: drawn.labels.slice(0, use.places), multiple: use.kind === "multiple" };
}

/** The page of a sheet that carries a question, and the reading of it. */
function pageOf(c: Computed, sheet: BatchSheet, number: number): { entry: number; reading: SheetReading } | undefined {
  for (const p of sheet.pages) {
    if (!p) continue;
    const r = (c.entries[p.entry] as BatchEntry).result;
    if (r.ok && r.fills[number]) return { entry: p.entry, reading: r };
  }
  return undefined;
}

export interface QueueItem {
  sheet: number;
  kind: "question" | "version";
  question?: number;
  why: string;
  entry?: number;
  /** A cut-out of the picture is kept for this one. */
  picture: boolean;
  /** How full each bubble was read, from the first place. */
  fills: number[];
  labels: string[];
  multiple: boolean;
  stem?: string;
  version?: string;
}

export function queueOf(s: ScoringSession, c: Computed): QueueItem[] {
  const out: QueueItem[] = [];
  c.settled.forEach((settled, i) => {
    const sheet = c.batch.sheets[i] as BatchSheet;
    if (settled.version === undefined) {
      const page = sheet.pages.find((p) => p && !p.refused && (c.entries[p.entry] as BatchEntry).result.ok);
      const reading = page ? ((c.entries[page.entry] as BatchEntry).result as SheetReading) : undefined;
      if (page && reading) {
        const flag = reading.flags.find((f) => f.kind === "version");
        out.push({
          sheet: settled.number,
          kind: "version",
          why: flag?.reason ?? "The version of this sheet is not settled.",
          entry: page.entry,
          picture: (s.entries[page.entry] as ScanEntry).crops.has("version"),
          fills: reading.versionFills ?? [],
          labels: s.test.versions.map((v) => v.label),
          multiple: false,
        });
      }
      return;
    }
    for (const [key, answer] of Object.entries(settled.answers)) {
      if (answer.kind !== "unsettled") continue;
      const number = Number(key);
      const where = pageOf(c, sheet, number);
      const places = placesOf(s, c, sheet, settled.version, number);
      out.push({
        sheet: settled.number,
        kind: "question",
        question: number,
        why: answer.why,
        ...(where ? { entry: where.entry } : {}),
        picture: where ? (s.entries[where.entry] as ScanEntry).crops.has(`q${number}`) : false,
        fills: where?.reading.fills[number] ?? [],
        labels: places.labels,
        multiple: places.multiple,
        stem: stemOf(s, settled.version, number),
        version: letterOf(settled.version) as string,
      });
    }
  });
  return out.sort((a, b) => a.sheet - b.sheet || (a.question ?? 0) - (b.question ?? 0));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Views

export function view(s: ScoringSession, after = 0): Record<string, unknown> {
  const c = compute(s);
  const queue = queueOf(s, c);
  const possible = c.scores.reduce((m, x) => Math.max(m, x.possible), 0);
  return {
    id: s.id,
    bank: s.bank,
    test: { id: s.test.id, name: s.test.name, versions: s.test.versions.map((v) => v.label), questions: s.test.questions.length, fingerprint: s.test.fingerprint.toString(16).toUpperCase().padStart(5, "0"), possible, items: itemsOf(s) },
    opened: s.fixed !== undefined,
    acceptBlanks: s.acceptBlanks,
    savedAs: s.savedAs ?? null,
    unsaved: s.revision !== s.savedRevision,
    pages: s.entries.map((e, index) => {
      const r = e.entry.result;
      return {
        index,
        file: e.entry.source.file,
        page: e.entry.source.page,
        ok: r.ok,
        ...(r.ok ? { dpi: Math.round(r.quality.dpi), notes: r.notes, version: letterOf(r.version) ?? null } : { cause: r.cause, reason: r.reason }),
        ...(e.waiting ? { waiting: e.waiting.format } : {}),
      };
    }),
    batchFlags: c.batch.flags,
    duplicates: c.batch.duplicates,
    sheets: c.scores.map((score, i) => {
      const settled = c.settled[i] as SettledSheet;
      const sheet = c.batch.sheets[i] as BatchSheet;
      const answers = Object.values(settled.answers);
      return {
        number: score.number,
        version: letterOf(score.version) ?? null,
        earned: score.earned,
        possible: score.possible,
        percent: score.percent ?? null,
        complete: score.complete,
        unsettled: score.unsettled,
        problems: score.problems,
        answered: answers.filter((a) => a.kind === "marked").length,
        blank: answers.filter((a) => a.kind === "blank").length,
        pages: sheet.pages.map((p) => (p ? { entry: p.entry, page: p.page, refused: p.refused } : null)),
        decided: s.decisions.filter((d) => d.sheet === score.number).length,
      };
    }),
    queue: { total: queue.length, items: queue.slice(after, after + QUEUE_PAGE) },
    stats: c.stats,
    adjustments: s.adjustments.map((a) => ({ ...a, question: questionNumberOf(s, a.questionId), words: adjustmentWords(a, s.test) })),
    decisions: s.decisions.length,
  };
}

/** The questions as version A prints them, with the letters of their answers, which is how an adjustment names a question and an answer. */
function itemsOf(s: ScoringSession): Array<{ number: number; id: string; stem: string; options: Array<{ letter: string; text: string }> }> {
  return versionQuestions(s.test, "A").map((q, i) => ({
    number: i + 1,
    id: q.id,
    stem: clip(richTextToPlain(q.stem).replace(/\s+/g, " ").trim(), 100),
    options:
      q.type === "trueFalse"
        ? [{ letter: "A", text: "True" }, { letter: "B", text: "False" }]
        : q.type === "multipleChoice" || q.type === "multipleResponse"
          ? (q.body as { options: Array<{ content: Parameters<typeof richTextToPlain>[0] }> }).options.map((o, at) => ({ letter: placeLetter(at), text: clip(richTextToPlain(o.content).replace(/\s+/g, " ").trim(), 60) }))
          : [],
  }));
}

/** The number of a question in version A, which is how the screen names it. */
export function questionNumberOf(s: ScoringSession, questionId: string): number | null {
  const at = versionQuestions(s.test, "A").findIndex((q) => q.id === questionId);
  return at === -1 ? null : at + 1;
}

/** One sheet, question by question. */
export function sheetView(s: ScoringSession, number: number): Record<string, unknown> {
  const c = compute(s);
  const at = c.scores.findIndex((x) => x.number === number);
  if (at === -1) throw notFound(`There is no sheet ${number}.`);
  const score = c.scores[at] as SheetScore;
  const settled = c.settled[at] as SettledSheet;
  const sheet = c.batch.sheets[at] as BatchSheet;
  const decided = new Set(s.decisions.filter((d) => d.sheet === number && d.kind === "answer").map((d) => (d as { question: number }).question));
  return {
    number,
    version: letterOf(score.version) ?? null,
    earned: score.earned,
    possible: score.possible,
    percent: score.percent ?? null,
    complete: score.complete,
    problems: score.problems,
    pages: sheet.pages.map((p) => (p ? { entry: p.entry, page: p.page, refused: p.refused, file: (c.entries[p.entry] as BatchEntry).source.file, source: (c.entries[p.entry] as BatchEntry).source.page } : null)),
    questions: score.questions
      .filter((q) => q.outcome !== "notOnSheet")
      .map((q) => {
        const answer = settled.answers[q.number];
        const places = placesOf(s, c, sheet, score.version, q.number);
        const name = (p: number): string => places.labels[p] ?? placeLetter(p);
        const where = pageOf(c, sheet, q.number);
        return {
          labels: places.labels,
          multiple: places.multiple,
          entry: where?.entry ?? null,
          picture: where ? (s.entries[where.entry] as ScanEntry).crops.has(`q${q.number}`) : false,
          fills: where?.reading.fills[q.number] ?? [],
          number: q.number,
          stem: stemOf(s, score.version, q.number),
          outcome: q.outcome,
          earned: q.earned,
          possible: q.possible,
          marked: answer?.kind === "marked" ? answer.places.map(name).join("") : answer?.kind === "blank" ? "" : null,
          by: answer && answer.kind !== "unsettled" ? answer.by : null,
          decided: decided.has(q.number),
          why: q.why ?? (answer?.kind === "unsettled" ? answer.why : null),
        };
      }),
  };
}

export function cropOf(s: ScoringSession, entry: number, key: string): Uint8Array {
  const held = s.entries[entry];
  const crop = held?.crops.get(key);
  if (!crop) throw notFound("No picture of that part of the sheet is kept. Pictures are not saved with the scores; scan the sheet again to see it.");
  return crop;
}
