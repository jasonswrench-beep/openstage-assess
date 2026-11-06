/**
 * An import in progress.
 *
 * Importing a file makes questions, and a person looks at them, repairs some and decides which to keep before anything is
 * written. That in-between state is a session. It lives in memory, belongs to nobody but this run of the app, and writes
 * nothing until it is saved into a bank. A question can be left out of the save, and is still listed, so that leaving one out
 * is a decision and not a loss.
 */

import { randomBytes } from "node:crypto";

import { countVerdicts, liveFindings, richTextToPlain, verdictOf, type Finding, type ImportResult, type Orphan, type Question } from "./engine.ts";
import { notFound } from "./errors.ts";

/** The most lines of a file kept for showing beside a question. A longer file is still read in full. */
const MAX_SOURCE_LINES = 50_000;
const MAX_SESSIONS = 12;

export interface SessionOrphan extends Orphan {
  /** A draft question was made from this text. */
  made: boolean;
}

export interface ImportSession {
  id: string;
  file: string;
  profile: string;
  at: string;
  questions: Question[];
  skipped: boolean[];
  orphans: SessionOrphan[];
  fileFindings: Finding[];
  source: string[];
  sourceTruncated: boolean;
  /** The pictures the file held, by the path each has in a bank. Kept in memory with the session and written only for the questions saved. */
  media: ReadonlyMap<string, Uint8Array>;
  /** Set once the session has been saved, so that saving twice does not add every question twice. */
  savedTo?: { bank: string; added: number };
}

export interface QuestionSummary {
  index: number;
  id: string;
  title: string;
  type: Question["type"];
  snippet: string;
  points: number;
  status: Question["metadata"]["status"];
  verdict: "parsed" | "needsReview" | "failed";
  tags: string[];
  errors: number;
  warnings: number;
  version: number;
  skipped?: boolean;
}

export function snippetOf(text: string, length = 110): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 3).trimEnd()}...` : line;
}

export function summarise(q: Question, index: number): QuestionSummary {
  const live = liveFindings(q.findings);
  return {
    index,
    id: q.id,
    title: q.title,
    type: q.type,
    snippet: snippetOf(richTextToPlain(q.stem)),
    points: q.points,
    status: q.metadata.status,
    verdict: verdictOf(q),
    tags: q.metadata.tags,
    errors: live.filter((f) => f.severity === "error").length,
    warnings: live.filter((f) => f.severity === "warn").length,
    version: q.version,
  };
}

export class Sessions {
  private readonly all = new Map<string, ImportSession>();

  create(result: ImportResult, source: readonly string[], at: string = new Date().toISOString()): ImportSession {
    const session: ImportSession = {
      id: randomBytes(9).toString("base64url"),
      file: result.file,
      profile: result.profile,
      at,
      questions: [...result.questions],
      skipped: result.questions.map(() => false),
      orphans: result.orphans.map((o) => ({ ...o, made: false })),
      fileFindings: [...result.fileFindings],
      source: source.slice(0, MAX_SOURCE_LINES),
      sourceTruncated: source.length > MAX_SOURCE_LINES,
      media: result.media ?? new Map(),
    };
    this.all.set(session.id, session);
    // A person who imports a dozen files in a sitting does not need the first one back. The oldest goes first.
    while (this.all.size > MAX_SESSIONS) {
      const oldest = this.all.keys().next().value as string;
      this.all.delete(oldest);
    }
    return session;
  }

  get(id: string): ImportSession {
    const session = this.all.get(id);
    if (!session) throw notFound("That import is no longer open. Import the file again.");
    return session;
  }

  /** What the screen needs to show a session, with every question as a summary. */
  view(session: ImportSession): Record<string, unknown> {
    const kept = session.questions.filter((_, i) => !session.skipped[i]);
    return {
      id: session.id,
      file: session.file,
      profile: session.profile,
      counts: { ...countVerdicts(kept, session.orphans.length), skipped: session.skipped.filter(Boolean).length, total: session.questions.length },
      fileFindings: liveFindings(session.fileFindings),
      orphans: session.orphans.map((o, index) => ({ index, text: o.text, reason: o.reason, firstBlock: o.source.firstBlock, lastBlock: o.source.lastBlock, made: o.made })),
      source: session.source,
      sourceTruncated: session.sourceTruncated,
      questions: session.questions.map((q, i) => ({ ...summarise(q, i), skipped: session.skipped[i] === true })),
      ...(session.savedTo ? { savedTo: session.savedTo } : {}),
    };
  }
}
