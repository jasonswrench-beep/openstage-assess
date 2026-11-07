/**
 * Quality checks that look at more than one question: the same question written twice, and answers that sit in one place too often.
 *
 * Unlike the checks in `items.ts`, what these find is not stored on a question. A duplicate is a fact about two questions, and a note
 * stored on one of them goes stale the moment the other is edited or removed, which is the way findings used to go wrong (they were
 * written once and never recomputed). So this is worked out from the questions every time it is asked for, and a report is a
 * report: it has no dismissals to keep. The price is that "this is on purpose" cannot be remembered; two questions that are meant
 * to be alike are shown each time.
 *
 * Both rules are written to be silent when unsure. Questions with pictures are not compared (a picture is not read here, and
 * the same words over two different pictures are two different questions), a numeric difference makes two questions different
 * (12 times 7 and 12 times 8), and the spread of right answers is judged only when there are enough of them to say anything and
 * only when a pattern would be a surprise by chance.
 */

import { isChoice, optionsOf, type Question } from "../model/question.ts";
import { richTextToPlain, type RichText } from "../model/richtext.ts";
import { placeLetter, VERSION_LABELS, versionOf, versionQuestions, type TestRecord } from "../model/test.ts";
import { hasUsableKey } from "./answer-key.ts";
import { normalForm, wordTokens } from "./items.ts";
import { isPlaceholderOption } from "./placeholders.ts";
import { versionKey } from "./test-key.ts";

/** Two questions are "alike" when this share of the words of one are the words of the other. */
export const ALIKE_AT = 0.85;
/** Fewer words than this and a question is not compared for being alike: a short one is only the same as another when it is the same. */
export const ALIKE_MIN_WORDS = 6;
/**
 * English words that a stem can lose or swap without asking anything different. Two stems that differ only in these ("Which one of the
 * following gases" and "Which of the following gases", "a country in Oceania" and "a country of Oceania") are one stem for deciding
 * whether a different right answer makes two questions parallel and not copies. A word that changes the question (before, not, half,
 * alpha) is never in it. Another language has no list, and its stems are compared as they are.
 */
const SMALL_WORDS: ReadonlySet<string> = new Set(["a", "an", "the", "of", "in", "on", "at", "to", "for", "by", "with", "and", "or", "one", "is", "are", "was", "were", "be", "which", "what", "that", "this", "these", "those"]);

/** The fewest answers that are judged for how they are spread. Below it, a run of one letter is as likely as not. */
export const BALANCE_MIN_ANSWERS = 20;
/** How surprising a spread has to be, before it is said. Divided by the number of letters tried, so that trying four is no easier than one. */
export const BALANCE_SURPRISE = 0.01;

export interface DuplicateGroup {
  /** "same" is the same wording and the same answers. "alike" is almost the same words with a few changed. */
  kind: "same" | "alike";
  /** The finding code that names this, so that the kinds of note are named the same everywhere. */
  code: string;
  questionIds: string[];
  titles: string[];
  message: string;
}

export interface KeyBalance {
  scope: "bank" | "test";
  /** What was counted: the questions that keep their order, or "Version B of <test>". */
  label: string;
  letter: string;
  count: number;
  of: number;
  message: string;
}

export interface BankQualityReport {
  duplicates: DuplicateGroup[];
  keyBalance: KeyBalance[];
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/** The text of a rich value with each equation written in as its LaTeX, since an equation is not in the text itself. */
function textWithMath(question: Question, value: RichText): string {
  const content = value.content;
  const latex = new Map(question.math.map((m) => [m.id, m.latex] as const));
  const written = content.replace(/<oa-math\s[^>]*ref\s*=\s*"([^"]*)"[^>]*>\s*<\/oa-math>/gi, (_whole, ref: string) => ` ${latex.get(ref) ?? ref} `);
  return richTextToPlain(written);
}

interface Compared {
  question: Question;
  /** The same for two questions that are the same question. */
  same: string;
  /** The stem alone, in its comparison form: two questions that are alike and whose stems read the same are one question asked twice. */
  stem: string;
  /** The stem's words without the small ones that carry no question ("one", "of", "in", "the"): stems that read the same by this differ in no word that matters. */
  stemKey: string;
  /** What makes an answer right: the right options of a choice question, and for the other types the whole of the key. Empty for an essay. */
  answer: string;
  words: string[];
  /** Every number and sign in what a student reads, in order of the sort, with repeats. Two questions that differ in it are different. */
  signs: string;
}

/** What of a question is compared, or undefined for a question that is left out. */
function compared(question: Question): Compared | undefined {
  if (question.metadata.status === "retired" || question.media.length > 0) return undefined;
  const stemText = textWithMath(question, question.stem);
  const stem = normalForm(stemText);
  // `parts` is everything that makes two questions the same question, the answer among it. `wording` is what a student reads, as
  // written (the words are taken from it by `wordTokens`): the stem and the options, and not the answer, so that the same question
  // with a different answer marked is alike and not unrelated.
  const parts: string[] = [];
  const wording: string[] = [stemText];
  const body = question.body as unknown as Record<string, unknown>;
  switch (question.type) {
    case "multipleChoice":
    case "multipleResponse": {
      const options = optionsOf(question).filter((o) => !isPlaceholderOption(o));
      const raw = options.map((o) => textWithMath(question, o.content));
      const texts = raw.map(normalForm);
      // Right or wrong, with the words: the same options with a different one marked right are two questions.
      parts.push(...options.map((o, i) => `${o.correct ? "+" : "-"}${texts[i]}`).sort());
      wording.push(...raw);
      break;
    }
    case "trueFalse":
      parts.push(String(body["correct"] ?? "none"));
      break;
    case "fillInBlank":
      parts.push(...((body["blanks"] ?? []) as Array<{ accepted: string[] }>).map((b) => b.accepted.map(normalForm).sort().join("/")));
      break;
    case "shortAnswer":
      parts.push(...((body["accepted"] ?? []) as string[]).map(normalForm).sort());
      break;
    case "matching": {
      const rawPairs = ((body["pairs"] ?? []) as Array<{ left: RichText; right: string }>).map((p) => [textWithMath(question, p.left), p.right] as const);
      const rawExtras = (body["distractors"] ?? []) as string[];
      const pairs = rawPairs.map(([l, r]) => [normalForm(l), normalForm(r)] as const);
      const extras = rawExtras.map(normalForm);
      parts.push(...pairs.map(([l, r]) => `${l}=${r}`).sort(), ...extras.map((e) => `?${e}`).sort());
      wording.push(...rawPairs.flat(), ...rawExtras);
      break;
    }
    case "ordering": {
      // A copy is sorted: sorting the question's own list would reorder it.
      const raw = [...((body["items"] ?? []) as Array<{ content: RichText; position: number }>)].sort((a, b) => a.position - b.position).map((i) => textWithMath(question, i.content));
      parts.push(...raw.map(normalForm));
      wording.push(...raw);
      break;
    }
    case "numeric":
      parts.push(JSON.stringify(body));
      break;
    default:
      // An essay, a hotspot, a calculated question: the stem is all there is to compare, and nothing is said about the others.
      if (question.type !== "essay") return undefined;
  }
  if (stem === "") return undefined;
  const tokens = wording.flatMap(wordTokens);
  const words = [...new Set(tokens)];
  // The numbers and signs, counted and not only listed: "x > 3" against "x < 3" has the same two signs among its options either way
  // round, and what tells the questions apart is how many times each sign is used.
  const signs = tokens.filter((w) => /\d/.test(w) || /^\p{S}+$/u.test(w)).sort().join(" ");
  const answer = (question.type === "multipleChoice" || question.type === "multipleResponse" ? parts.filter((p) => p.startsWith("+")) : parts).join("\u0001");
  const stemKey = wordTokens(stemText).filter((w) => !SMALL_WORDS.has(w)).join(" ");
  return { question, same: [question.type, stem, ...parts].join("\u0001"), stem, stemKey, answer, words, signs };
}

/** Disjoint sets, for putting questions that are alike in pairs into groups of any size. */
function groupsOf(count: number, pairs: Array<[number, number]>): number[][] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[i] !== root) {
      const next = parent[i] as number;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  for (const [a, b] of pairs) parent[find(a)] = find(b);
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < count; i++) byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), i]);
  return [...byRoot.values()].filter((g) => g.length > 1);
}

/** Pairs of the compared questions whose words overlap by `ALIKE_AT`, found without comparing every pair (prefix filtering over the rarest words). */
function alikePairs(items: Compared[]): Array<[number, number]> {
  const frequency = new Map<string, number>();
  for (const item of items) for (const w of item.words) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  const ordered = items.map((item) => [...item.words].sort((a, b) => (frequency.get(a) as number) - (frequency.get(b) as number) || (a < b ? -1 : 1)));
  const sets = items.map((item) => new Set(item.words));
  // A number is a difference that makes two questions different, and so is a sign: "x > 3" and "x < 3" are not one question.
  const numbers = items.map((item) => item.signs);
  // Two questions whose stems differ AND whose right answers differ are not a question asked twice: "the ripple frequency of a full-wave
  // supply" (120 Hz) and "of a half-wave supply" (60 Hz) share every option and all but one word of the stem. A bank of real questions
  // (549 multiple choice, one exam's) had 23 groups of that kind and almost none that were copies, so they are left alone. A stem that
  // reads the same with another answer marked is still said (a conflict between two copies), and so is a pair that agrees on the answer.
  const stems = items.map((item) => item.stemKey);
  const answers = items.map((item) => item.answer);
  const index = new Map<string, number[]>();
  const found: Array<[number, number]> = [];

  items.forEach((_item, at) => {
    const words = ordered[at] as string[];
    if (words.length < ALIKE_MIN_WORDS) return;
    const prefix = words.slice(0, words.length - Math.ceil(ALIKE_AT * words.length) + 1);
    const candidates = new Set<number>();
    for (const w of prefix) for (const other of index.get(w) ?? []) candidates.add(other);
    for (const other of candidates) {
      const a = sets[at] as Set<string>;
      const b = sets[other] as Set<string>;
      if (Math.min(a.size, b.size) < ALIKE_AT * Math.max(a.size, b.size)) continue;
      if (numbers[at] !== numbers[other]) continue;
      if (stems[at] !== stems[other] && answers[at] !== answers[other]) continue;
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      if (shared / (a.size + b.size - shared) >= ALIKE_AT) found.push([other, at]);
    }
    for (const w of prefix) index.set(w, [...(index.get(w) ?? []), at]);
  });
  return found;
}

function quoted(titles: string[]): string {
  const shown = titles.slice(0, 3).map((t) => `"${t.length > 50 ? `${t.slice(0, 49).trimEnd()}...` : t}"`);
  const extra = titles.length - shown.length;
  return `${shown.join(", ")}${extra > 0 ? ` and ${extra} more` : ""}`;
}

export function findDuplicates(questions: readonly Question[]): DuplicateGroup[] {
  const kept = questions.flatMap((q) => {
    const c = compared(q);
    return c ? [c] : [];
  });
  kept.sort((a, b) => a.question.id.localeCompare(b.question.id));

  const bySame = new Map<string, Compared[]>();
  for (const c of kept) bySame.set(c.same, [...(bySame.get(c.same) ?? []), c]);
  // One of each kind of question stands for its copies when looking for the alike.
  const representatives = [...bySame.values()].map((g) => g[0] as Compared);
  const alike = groupsOf(representatives.length, alikePairs(representatives));

  const out: DuplicateGroup[] = [];
  const inAlike = new Set<string>();
  for (const group of alike) {
    const members = group.flatMap((i) => bySame.get((representatives[i] as Compared).same) as Compared[]);
    for (const m of members) inAlike.add(m.question.id);
    members.sort((a, b) => a.question.id.localeCompare(b.question.id));
    const titles = members.map((m) => m.question.title);
    out.push({
      kind: "alike",
      code: "quality.near-duplicate-question",
      questionIds: members.map((m) => m.question.id),
      titles,
      message: `${members.length} questions are very much alike, with only a few words changed: ${quoted(titles)}. If they are meant to test the same thing, keep one.`,
    });
  }
  for (const group of bySame.values()) {
    if (group.length < 2 || group.some((m) => inAlike.has(m.question.id))) continue;
    const titles = group.map((m) => m.question.title);
    out.push({
      kind: "same",
      code: "quality.duplicate-question",
      questionIds: group.map((m) => m.question.id),
      titles,
      message: `${group.length === 2 ? "Two questions are" : `${group.length} questions are`} the same, with the same wording and the same answers: ${quoted(titles)}. Keep one.`,
    });
  }
  return out.sort((a, b) => (a.questionIds[0] as string).localeCompare(b.questionIds[0] as string));
}

// ---------------------------------------------------------------------------
// How the right answers are spread
// ---------------------------------------------------------------------------

/** The chance of `c` or more of `n` things, each one in `1 / k`. Worked in logarithms so that a long test cannot underflow. */
export function binomialTail(n: number, c: number, p: number): number {
  let logPmf = n * Math.log1p(-p);
  const step = Math.log(p) - Math.log1p(-p);
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= c) sum += Math.exp(logPmf);
    logPmf += Math.log(n - i) - Math.log(i + 1) + step;
  }
  return Math.min(1, sum);
}

/** The letter that comes up more often than chance would let it, among single right answers; undefined when none does or there are too few to say. */
export function overusedLetter(letters: readonly string[], optionCount: number): { letter: string; count: number } | undefined {
  if (letters.length < BALANCE_MIN_ANSWERS || optionCount < 2) return undefined;
  const counts = new Map<string, number>();
  for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  let best: { letter: string; count: number; chance: number } | undefined;
  for (const [letter, count] of counts) {
    const chance = binomialTail(letters.length, count, 1 / optionCount);
    if (chance < BALANCE_SURPRISE / optionCount && (!best || chance < best.chance)) best = { letter, count, chance };
  }
  return best ? { letter: best.letter, count: best.count } : undefined;
}

/** The option count most of these have, so that a few five-option questions in a list of four-option ones do not move the expected spread. */
function usualCount(counts: readonly number[]): number {
  const tally = new Map<number, number>();
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}

function balanceNote(scope: KeyBalance["scope"], label: string, letters: string[], counts: number[]): KeyBalance | undefined {
  const over = overusedLetter(letters, usualCount(counts));
  if (!over) return undefined;
  const percent = Math.round((100 * over.count) / letters.length);
  return {
    scope,
    label,
    letter: over.letter,
    count: over.count,
    of: letters.length,
    message: `${label}: ${over.count} of ${letters.length} right answers are ${over.letter}. A student who marks ${over.letter} for every question would get about ${percent} percent without reading any of them.`,
  };
}

/**
 * Where the single right answers sit. A bank that shuffles its options has no place for an answer to sit, so only the questions that
 * keep their order are counted; for each version of a test the letters are the ones the student marks, which is what counts.
 */
export function keyBalance(questions: readonly Question[], tests: readonly TestRecord[] = []): KeyBalance[] {
  const out: KeyBalance[] = [];

  const fixed = questions.filter((q) => q.metadata.status !== "retired" && isChoice(q) && !q.body.shuffle && hasUsableKey(q));
  const letters: string[] = [];
  const counts: number[] = [];
  for (const q of fixed) {
    const options = optionsOf(q);
    const right = options.flatMap((o, i) => (o.correct ? [i] : []));
    if (right.length !== 1 || options.some(isPlaceholderOption)) continue;
    letters.push(placeLetter(right[0] as number));
    counts.push(options.length);
  }
  const bank = balanceNote("bank", "In the questions that keep their option order", letters, counts);
  if (bank) out.push(bank);

  for (const record of tests) {
    for (const label of VERSION_LABELS) {
      if (!versionOf(record, label)) continue;
      const key = versionKey(record, label);
      const asked = versionQuestions(record, label);
      const marked: string[] = [];
      const optionCounts: number[] = [];
      key.forEach((entry, i) => {
        const q = asked[i];
        if (!q || entry.type !== "multipleChoice" || entry.letters?.length !== 1) return;
        marked.push(entry.letters[0] as string);
        optionCounts.push(optionsOf(q).length);
      });
      const note = balanceNote("test", `Version ${label} of "${record.name}"`, marked, optionCounts);
      if (note) out.push(note);
    }
  }
  return out;
}

export function checkBankQuality(questions: readonly Question[], tests: readonly TestRecord[] = []): BankQualityReport {
  return { duplicates: findDuplicates(questions), keyBalance: keyBalance(questions, tests) };
}
