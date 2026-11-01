/**
 * Making and changing questions.
 *
 * The version, history and status rules live here, not in the user interface,
 * so a question edited by the editor, by an importer, by the command-line tool
 * or by the MCP server all behave the same way.
 */

import { newQuestionId } from "./ids.ts";
import type { Finding } from "./findings.ts";
import { checkAnswerKey, replaceFileKeyProblems } from "../quality/answer-key.ts";
import { replacePlaceholderProblems } from "../quality/placeholders.ts";
import { collectRefs, plainToRich, richTextToPlain, sanitizeDeep, type RichText } from "./richtext.ts";
import {
  MAX_TITLE_LENGTH,
  titleFromStem,
  type Feedback,
  type Metadata,
  type Question,
  type QuestionBody,
  type QuestionType,
} from "./question.ts";
import { FindingCode, finding } from "./findings.ts";

export interface CreateQuestionInput {
  type: QuestionType;
  stem: RichText | string;
  body: QuestionBody;
  id?: string;
  title?: string;
  points?: number;
  feedback?: Feedback;
  metadata?: Partial<Metadata>;
  media?: Question["media"];
  math?: Question["math"];
  findings?: Finding[];
  origin?: Question["origin"];
  by?: string;
  at?: string;
}

export const DEFAULT_POINTS = 1;

export function emptyMetadata(): Metadata {
  return { tags: [], status: "draft" };
}

export function createQuestion(input: CreateQuestionInput): Question {
  const rawStem = typeof input.stem === "string" ? plainToRich(input.stem) : input.stem;

  // Everything that can carry markup goes through the sanitizer here, which is
  // the only moment it is guaranteed to happen. The title is derived after the
  // stem has been cleaned, so a tag in the source cannot reach it either.
  const clean = sanitizeDeep({
    stem: rawStem,
    body: input.body,
    feedback: input.feedback ?? {},
  });

  const at = input.at ?? new Date().toISOString();
  const by = input.by ?? "unknown";
  const title = (input.title ?? titleFromStem(richTextToPlain(clean.value.stem))).slice(0, MAX_TITLE_LENGTH);

  return {
    id: input.id ?? newQuestionId(),
    version: 1,
    type: input.type,
    title: title.length > 0 ? title : "Untitled question",
    stem: clean.value.stem,
    points: input.points ?? DEFAULT_POINTS,
    body: clean.value.body,
    feedback: clean.value.feedback,
    metadata: { ...emptyMetadata(), ...input.metadata },
    media: input.media ?? [],
    math: input.math ?? [],
    findings: input.findings ?? [],
    history: [{ at, by, change: "created", toVersion: 1 }],
    ...(input.origin ? { origin: input.origin } : {}),
  };
}

/** Fields a caller may change. Everything else is managed by the engine. */
export type QuestionEdit = Partial<
  Pick<Question, "type" | "title" | "stem" | "points" | "body" | "feedback" | "metadata" | "media" | "math">
>;

export interface EditOptions {
  by?: string;
  at?: string;
  /** A short description for the history entry. */
  change?: string;
  /**
   * Set when the edit IS the status change, so that setting a question to
   * "reviewed" does not immediately knock it back to "draft".
   */
  statusChangeOnly?: boolean;
}

/**
 * Apply an edit: bump the version, write a history entry, and return a
 * reviewed or approved question to draft.
 *
 * The demotion rule is the specification's: a reviewed question that is later
 * edited returns to draft. It is implemented once, here.
 */
export function editQuestion(question: Question, rawEdit: QuestionEdit, opts: EditOptions = {}): Question {
  const at = opts.at ?? new Date().toISOString();
  const by = opts.by ?? "unknown";
  const fromVersion = question.version;

  // Same enforcement as on creation: an edit is a write path too.
  const edit = sanitizeDeep(rawEdit).value;

  const changedFields = Object.keys(edit).filter((key) => {
    const next = (edit as Record<string, unknown>)[key];
    return next !== undefined;
  });
  if (changedFields.length === 0) return question;

  const metadata: Metadata = edit.metadata
    ? { ...question.metadata, ...edit.metadata }
    : { ...question.metadata };

  const substantive = changedFields.some((f) => f !== "metadata");
  const metadataSubstantive =
    edit.metadata !== undefined &&
    Object.keys(edit.metadata).some((k) => k !== "status");

  if (!opts.statusChangeOnly && (substantive || metadataSubstantive)) {
    if (metadata.status === "reviewed" || metadata.status === "approved") {
      metadata.status = "draft";
    }
  }

  const next: Question = {
    ...question,
    ...edit,
    metadata,
    version: fromVersion + 1,
    history: [
      ...question.history,
      {
        at,
        by,
        change: opts.change ?? `edited: ${changedFields.join(", ")}`,
        fromVersion,
        toVersion: fromVersion + 1,
      },
    ],
  };

  if (!substantive) return next;
  const recomputed = withRecomputedFindings(next, question.findings);
  // An answer chosen here replaces what the file's key said, and words written where the importer had to put a placeholder
  // replace what it said about that, and the history says so.
  const keyed = replaceFileKeyProblems(question, recomputed, by, at);
  const written = replacePlaceholderProblems(question, keyed.question, by, at);
  const said: string[] = [];
  if (keyed.replaced.length > 0) said.push(`the answer was chosen, so what the file's key said no longer applies (${keyed.replaced.map((f) => f.code).join(", ")})`);
  if (written.replaced.length > 0) said.push(`the missing words were written, so the placeholder no longer applies (${written.replaced.map((f) => f.code).join(", ")})`);
  if (said.length === 0) return written.question;
  const entries = written.question.history.slice();
  const last = entries.pop();
  if (last) entries.push({ ...last, change: `${last.change}; ${said.join("; ")}` });
  return { ...written.question, history: entries };
}

/** The finding codes this engine can re-derive from a question on its own. */
const DERIVED_CODES: ReadonlySet<string> = new Set<string>([
  FindingCode.NoAnswerKey,
  FindingCode.MultipleKeysOnSingleAnswer,
  FindingCode.DanglingMediaRef,
  FindingCode.DanglingMathRef,
]);

/**
 * Re-run the checks that can be re-run, and drop their stale results.
 *
 * Findings used to be written once and never revisited, so an author who
 * supplied the missing answer key still had the error afterwards: the question
 * stayed "failed", the error filter still matched it, and every feature built
 * on findings inherited the staleness. Only codes this engine can re-derive are
 * replaced. A finding that records something about the source file, which no
 * longer exists, is left alone because nothing here could reproduce it.
 *
 * A dismissal is a decision about the item, not about one evaluation of it, so
 * it survives the recomputation and is reapplied to the fresh finding.
 */
export function withRecomputedFindings(question: Question, previous: readonly Finding[] = question.findings): Question {
  const dismissals = new Map<string, Finding>();
  for (const f of previous) {
    if (f.dismissed) dismissals.set(`${f.code}|${f.field ?? ""}`, f);
  }

  const kept = question.findings.filter((f) => !DERIVED_CODES.has(f.code));
  const fresh = [...checkAnswerKey(question), ...checkReferences(question)].map((f) => {
    const dismissal = dismissals.get(`${f.code}|${f.field ?? ""}`);
    return dismissal
      ? {
          ...f,
          dismissed: true,
          ...(dismissal.dismissedBy ? { dismissedBy: dismissal.dismissedBy } : {}),
          ...(dismissal.dismissedAt ? { dismissedAt: dismissal.dismissedAt } : {}),
        }
      : f;
  });

  return { ...question, findings: [...kept, ...fresh] };
}

export function setStatus(question: Question, status: Metadata["status"], opts: EditOptions = {}): Question {
  return editQuestion(
    question,
    { metadata: { ...question.metadata, status } },
    { ...opts, statusChangeOnly: true, change: opts.change ?? `status ${status}` },
  );
}

/** Mark a finding as intentional. The flag stays quiet for this question. */
export function dismissFinding(question: Question, code: string, by: string, at?: string): Question {
  const stamp = at ?? new Date().toISOString();
  return {
    ...question,
    findings: question.findings.map((f) =>
      f.code === code && !f.dismissed
        ? { ...f, dismissed: true, dismissedBy: by, dismissedAt: stamp }
        : f,
    ),
  };
}

export function addFindings(question: Question, findings: readonly Finding[]): Question {
  if (findings.length === 0) return question;
  const seen = new Set(question.findings.map((f) => `${f.code}|${f.field ?? ""}`));
  const added = findings.filter((f) => !seen.has(`${f.code}|${f.field ?? ""}`));
  if (added.length === 0) return question;
  return { ...question, findings: [...question.findings, ...added] };
}

/**
 * Every media and math placeholder in the text must point at a sidecar that
 * exists, and every sidecar should be pointed at. A dangling reference means
 * an image that will not render after export.
 */
export function checkReferences(question: Question): Finding[] {
  const found: Finding[] = [];
  const mediaIds = new Set(question.media.map((m) => m.id));
  const mathIds = new Set(question.math.map((m) => m.id));

  const texts: Array<[string, RichText | undefined]> = [
    ["stem", question.stem],
    ["feedback.general", question.feedback.general],
    ["feedback.correct", question.feedback.correct],
    ["feedback.incorrect", question.feedback.incorrect],
  ];
  const body = question.body as Record<string, unknown>;
  if (Array.isArray(body["options"])) {
    (body["options"] as Array<{ content?: RichText }>).forEach((o, i) =>
      texts.push([`body.options.${i}.content`, o.content]),
    );
  }

  for (const [field, text] of texts) {
    if (!text) continue;
    const refs = collectRefs(text);
    for (const ref of refs.media) {
      if (!mediaIds.has(ref)) {
        found.push(
          finding(FindingCode.DanglingMediaRef, "error", `references media ${ref}, which is not in this question`, { field }),
        );
      }
    }
    for (const ref of refs.math) {
      if (!mathIds.has(ref)) {
        found.push(
          finding(FindingCode.DanglingMathRef, "error", `references equation ${ref}, which is not in this question`, { field }),
        );
      }
    }
  }
  return found;
}
