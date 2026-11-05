/**
 * An assembled test: the questions as they were when it was made, a seed, and the versions that come from it.
 *
 * Editing a question in the bank must never change a test that has been given, so the record holds a copy of every question as it
 * was used. The versions (up to four, A to D) are worked out once from the stored seed and kept: version A is the test as it was
 * assembled, and each of the others puts the questions in another order and the answers of each question in another order, so a
 * copy handed to a neighbour is not the same test. Reprinting from the record gives the same versions, because nothing here is
 * made again from chance.
 *
 * What a student marks is a letter, and a letter means something only in one version. So the record can say which of the bank's own
 * answers a letter stands for in a given version, and which letter a bank answer has in it. That mapping is what lets the results
 * of all the versions be added up per question and per answer.
 *
 * The rules kept here:
 *  - True or false is never reordered: its two places are always True then False.
 *  - A question whose answers depend on their place (None of the above, both A and B) keeps them in order in every version, and
 *    the record says why, so the check can say it.
 *  - The record carries a 20-bit fingerprint of what it is, which is printed on the answer sheet so that a sheet from another test
 *    is refused. A record whose fingerprint does not match what it holds is not accepted.
 */

import { randomBytes } from "node:crypto";

import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "./question.ts";
import { shuffledFor } from "./random.ts";
import { richTextToPlain } from "./richtext.ts";
import { validateQuestion, type Issue } from "./schema.ts";
import { isId, newTestId } from "./ids.ts";

export const TEST_RECORD_VERSION = 1;
export const VERSION_LABELS = ["A", "B", "C", "D"] as const;
export type VersionLabel = (typeof VERSION_LABELS)[number];
export const MAX_VERSIONS = VERSION_LABELS.length;
export const FINGERPRINT_BITS = 20;

export interface TestSection {
  title: string;
  /** The ids of the questions in this section, in the order they were assembled. */
  questionIds: string[];
}

export interface TestVersion {
  label: VersionLabel;
  /** Every question id, in the order this version prints them. */
  order: string[];
  /** For each choice question, its option ids in the order this version prints them. */
  options: Record<string, string[]>;
}

export interface TestRecord {
  recordVersion: typeof TEST_RECORD_VERSION;
  id: string;
  name: string;
  created: string;
  seed: string;
  /** Whether versions B to D put the questions in another order within each section, or keep them as assembled. */
  questionOrder: "kept" | "shuffled";
  sections: TestSection[];
  /** A copy of every question as it was used, in the order assembled. */
  questions: Question[];
  /** The questions whose answers keep their order in every version, and why. */
  keptInOrder: Record<string, string>;
  versions: TestVersion[];
  /** 20 bits, from the id, the seed, the number of versions and the question ids. */
  fingerprint: number;
}

// ---------------------------------------------------------------------------
// Which questions keep their answers in order
// ---------------------------------------------------------------------------

const DEPENDS_ON_PLACE: RegExp[] = [
  /\b(?:all|none|neither|both)\b[^.]{0,20}\b(?:above|these|them)\b/i,
  /\b(?:both|either)\s+(?:option\s+|choice\s+|answers?\s+)?[A-H]\s+(?:and|or)\s+[A-H]\b/i,
  /\b(?:options?|choices?|answers?)\s+[A-H]\s*(?:and|or|&)\s*[A-H]\b/i,
  /^\s*[A-H]\s+(?:and|or)\s+[A-H]\s*\.?\s*$/,
];

/** Why a question keeps its answers in order, or undefined when they may be shuffled. */
export function keepsOrder(question: Question): string | undefined {
  if (!isChoice(question) && !isMultipleResponse(question)) return undefined;
  if (!question.body.shuffle) return "the question is marked to keep its answers in order";
  const options = question.body.options;
  if (options.some((o) => o.fixedPosition)) return "an answer is fixed in place, so the answers keep their order";
  if (options.some((o) => DEPENDS_ON_PLACE.some((pattern) => pattern.test(richTextToPlain(o.content))))) {
    return "an answer depends on its place (such as None of the above, or Both A and B), so the answers keep their order";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

function fingerprintOf(id: string, seed: string, versions: number, questionIds: readonly string[]): number {
  const text = `${id}|${seed}|${versions}|${questionIds.join(",")}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) >>> (32 - FINGERPRINT_BITS);
}

/** The fingerprint a record ought to carry, worked out from what it holds. */
export function testFingerprint(record: Pick<TestRecord, "id" | "seed" | "versions" | "questions">): number {
  return fingerprintOf(record.id, record.seed, record.versions.length, record.questions.map((q) => q.id));
}

// ---------------------------------------------------------------------------
// Making a record
// ---------------------------------------------------------------------------

export interface CreateTestInput {
  name: string;
  /** The questions, in the order they are assembled. Ignored in favour of the sections' order when sections are given. */
  questions: readonly Question[];
  sections?: ReadonlyArray<{ title: string; questionIds: readonly string[] }>;
  /** How many versions, 1 to 4. Defaults to 1. */
  versions?: number;
  /** A seed to make the versions from again. A new one is made when none is given. */
  seed?: string;
  /** Default "kept": versions B to D reorder the answers of a question and leave the questions where they were. */
  questionOrder?: "kept" | "shuffled";
  at?: string;
  id?: string;
}

function newSeed(): string {
  return randomBytes(6).toString("hex");
}

export function createTest(input: CreateTestInput): TestRecord {
  const name = input.name.trim();
  if (name === "") throw new Error("A test needs a name.");
  const count = input.versions ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_VERSIONS) throw new Error(`A test has 1 to ${MAX_VERSIONS} versions, not ${String(input.versions)}.`);
  if (input.questions.length === 0) throw new Error("A test needs at least one question.");

  const byId = new Map<string, Question>();
  for (const q of input.questions) {
    if (byId.has(q.id)) throw new Error(`The question ${q.id} is in this test twice.`);
    byId.set(q.id, q);
  }

  const sections: TestSection[] = (input.sections ?? [{ title: "", questionIds: input.questions.map((q) => q.id) }]).map((s) => ({ title: s.title, questionIds: [...s.questionIds] }));
  const seen = new Set<string>();
  for (const section of sections) {
    for (const id of section.questionIds) {
      if (!byId.has(id)) throw new Error(`The section "${section.title}" names the question ${id}, which is not in this test.`);
      if (seen.has(id)) throw new Error(`The question ${id} is in two sections.`);
      seen.add(id);
    }
  }
  if (seen.size !== byId.size) throw new Error("Every question has to be in a section.");

  const assembled = sections.flatMap((s) => s.questionIds);
  const questions = assembled.map((id) => structuredClone(byId.get(id) as Question));
  const keptInOrder: Record<string, string> = {};
  for (const q of questions) {
    const why = keepsOrder(q);
    if (why !== undefined) keptInOrder[q.id] = why;
  }

  const id = input.id ?? newTestId();
  const seed = input.seed ?? newSeed();
  const questionOrder = input.questionOrder ?? "kept";
  const versions = buildVersions(questions, sections, count, seed, questionOrder, keptInOrder);
  return {
    recordVersion: TEST_RECORD_VERSION,
    id,
    name,
    created: input.at ?? new Date().toISOString(),
    seed,
    questionOrder,
    sections,
    questions,
    keptInOrder,
    versions,
    fingerprint: fingerprintOf(id, seed, count, assembled),
  };
}

function buildVersions(
  questions: readonly Question[],
  sections: readonly TestSection[],
  count: number,
  seed: string,
  questionOrder: "kept" | "shuffled",
  keptInOrder: Readonly<Record<string, string>>,
): TestVersion[] {
  const versions: TestVersion[] = [];
  for (let v = 0; v < count; v++) {
    const label = VERSION_LABELS[v] as VersionLabel;
    // Version A is the test as it was assembled.
    const order =
      v === 0 || questionOrder === "kept"
        ? sections.flatMap((s) => s.questionIds)
        : sections.flatMap((s, i) => shuffledFor(s.questionIds, `${seed}:${label}:order:${i}`));
    const options: Record<string, string[]> = {};
    for (const q of questions) {
      if (!isChoice(q) && !isMultipleResponse(q)) continue;
      const ids = q.body.options.map((o) => o.id);
      options[q.id] = v === 0 || keptInOrder[q.id] !== undefined ? ids : shuffledFor(ids, `${seed}:${label}:options:${q.id}`);
    }
    versions.push({ label, order, options });
  }
  return versions;
}

// ---------------------------------------------------------------------------
// Reading a version
// ---------------------------------------------------------------------------

export function versionOf(record: TestRecord, label: VersionLabel): TestVersion | undefined {
  return record.versions.find((v) => v.label === label);
}

/** The letter of the place with this index: A, B, C and on. */
export const placeLetter = (index: number): string => String.fromCharCode(65 + index);

/** The index of the place a letter names, or undefined when it is not a letter A to Z. */
export function placeIndex(letter: string): number | undefined {
  if (!/^[A-Z]$/.test(letter)) return undefined;
  return letter.charCodeAt(0) - 65;
}

/**
 * What a letter stands for in one version: the id of the bank's own option for a choice question, or "true" or "false" for a true
 * or false one, whose first two places are always True and False. Undefined when the letter names no place.
 */
export function answerAt(record: TestRecord, label: VersionLabel, questionId: string, letter: string): string | undefined {
  const question = record.questions.find((q) => q.id === questionId);
  const at = placeIndex(letter);
  if (!question || at === undefined) return undefined;
  if (isTrueFalse(question)) return at === 0 ? "true" : at === 1 ? "false" : undefined;
  const order = versionOf(record, label)?.options[questionId];
  return order?.[at];
}

/** The letter a bank answer has in one version: the inverse of `answerAt`. */
export function letterFor(record: TestRecord, label: VersionLabel, questionId: string, answer: string): string | undefined {
  const question = record.questions.find((q) => q.id === questionId);
  if (!question) return undefined;
  if (isTrueFalse(question)) return answer === "true" ? "A" : answer === "false" ? "B" : undefined;
  const at = versionOf(record, label)?.options[questionId]?.indexOf(answer);
  return at === undefined || at < 0 ? undefined : placeLetter(at);
}

/**
 * The questions of one version as they print: in that version's order, each with its answers in that version's order. These are
 * copies, so the record's own are never touched, and every id is the bank's own.
 */
export function versionQuestions(record: TestRecord, label: VersionLabel): Question[] {
  const version = versionOf(record, label);
  if (!version) throw new Error(`This test has no version ${label}.`);
  const byId = new Map(record.questions.map((q) => [q.id, q] as const));
  return version.order.map((id) => {
    const copy = structuredClone(byId.get(id) as Question);
    const order = version.options[id];
    if (order && (isChoice(copy) || isMultipleResponse(copy))) {
      const options = new Map(copy.body.options.map((o) => [o.id, o] as const));
      copy.body.options = order.map((oid) => options.get(oid) as (typeof copy.body.options)[number]);
    }
    return copy;
  });
}

// ---------------------------------------------------------------------------
// Checking a record that was read from a file
// ---------------------------------------------------------------------------

export type TestCheck = { ok: true; test: TestRecord } | { ok: false; issues: Issue[] };

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
// Both sides are checked for repeats: with the same length and every member of one in the other, a list that repeats an id and
// leaves another out would still pass if only one side were counted.
const isPermutation = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && b.every((x) => a.includes(x));

/** A record is accepted only when it holds together: the questions are questions, the versions are orders of the same questions and answers, and the fingerprint is what it should be. */
export function validateTest(value: unknown): TestCheck {
  const issues: Issue[] = [];
  const bad = (path: string, message: string): void => void issues.push({ path, message });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, issues: [{ path: "", message: "A test record is an object." }] };
  const r = value as Record<string, unknown>;

  if (r["recordVersion"] !== TEST_RECORD_VERSION) bad("recordVersion", `This record is version ${String(r["recordVersion"])}, and this program reads version ${TEST_RECORD_VERSION}.`);
  if (!isId(r["id"], "t")) bad("id", "The id is not a test id.");
  if (typeof r["name"] !== "string" || r["name"].trim() === "") bad("name", "A test needs a name.");
  if (typeof r["created"] !== "string") bad("created", "A test needs the time it was made.");
  if (typeof r["seed"] !== "string" || r["seed"] === "") bad("seed", "A test needs its seed.");
  if (r["questionOrder"] !== "kept" && r["questionOrder"] !== "shuffled") bad("questionOrder", 'The question order is "kept" or "shuffled".');
  if (!Number.isInteger(r["fingerprint"]) || (r["fingerprint"] as number) < 0 || (r["fingerprint"] as number) >= 2 ** FINGERPRINT_BITS) bad("fingerprint", `The fingerprint is a whole number of ${FINGERPRINT_BITS} bits.`);

  const questions = r["questions"];
  if (!Array.isArray(questions) || questions.length === 0) bad("questions", "A test needs at least one question.");
  const ids: string[] = [];
  // Only a question that passed is looked into below: a record with a damaged question must be refused, never crash the reader.
  const sound: Question[] = [];
  if (Array.isArray(questions)) {
    questions.forEach((q, i) => {
      const check = validateQuestion(q);
      if (!check.ok) for (const issue of check.issues) bad(`questions.${i}${issue.path ? `.${issue.path}` : ""}`, issue.message);
      else {
        ids.push((q as Question).id);
        sound.push(q as Question);
      }
    });
    if (new Set(ids).size !== ids.length) bad("questions", "A question is in this test twice.");
  }

  const sections = r["sections"];
  if (!Array.isArray(sections) || sections.length === 0) bad("sections", "A test has at least one section.");
  else {
    const listed = sections.flatMap((s) => ((s as { questionIds?: unknown })?.questionIds && isStringArray((s as { questionIds: unknown }).questionIds) ? (s as { questionIds: string[] }).questionIds : []));
    if (!isPermutation(ids, listed)) bad("sections", "The sections do not hold each question once.");
    else if (listed.some((id, i) => id !== ids[i])) bad("questions", "The questions are not in the order of the sections.");
  }

  const versions = r["versions"];
  if (!Array.isArray(versions) || versions.length < 1 || versions.length > MAX_VERSIONS) bad("versions", `A test has 1 to ${MAX_VERSIONS} versions.`);
  else {
    versions.forEach((v, i) => {
      const version = v as Partial<TestVersion> | null;
      if (!version || version.label !== VERSION_LABELS[i]) return bad(`versions.${i}.label`, `Version ${i + 1} is ${VERSION_LABELS[i]}.`);
      if (!isStringArray(version.order) || !isPermutation(ids, version.order)) bad(`versions.${i}.order`, "A version prints every question once.");
      const options = version.options;
      if (options === null || typeof options !== "object") return bad(`versions.${i}.options`, "A version names the order of each question's answers.");
      for (const q of sound) {
        if (!isChoice(q) && !isMultipleResponse(q)) continue;
        const order = (options as Record<string, unknown>)[q.id];
        if (!isStringArray(order) || !isPermutation(q.body.options.map((o) => o.id), order)) bad(`versions.${i}.options.${q.id}`, "A version prints each answer of a question once.");
      }
    });
  }

  if (issues.length === 0) {
    const record = r as unknown as TestRecord;
    if (record.fingerprint !== testFingerprint(record)) bad("fingerprint", "The fingerprint is not the one this record's contents give, so the record was changed or damaged.");
  }
  return issues.length === 0 ? { ok: true, test: r as unknown as TestRecord } : { ok: false, issues };
}
