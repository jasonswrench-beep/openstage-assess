/**
 * The GIFT importer: the plain-text question format that Moodle reads and writes.
 *
 * A GIFT file is a run of blocks. Each is an optional title between double colons, the question text, and the answers in
 * braces, which say what kind of question it is: `=` marks a right answer and `~` a wrong one, `{TRUE}` and `{FALSE}` a
 * true or false question, `->` a pair to match, `#` and a number a numeric one, and empty braces an essay. Text after the
 * braces makes a missing word.
 *
 * The rules of the project apply to it as to every importer. A key is read only where the file gives one: a question with
 * no right answer is kept with none, and says so. Nothing is dropped silently: a weight that cannot be read as a key, a
 * feedback with nowhere to go, a block with no answer in it, each is reported with its text. A block that cannot be built
 * is kept as an essay, with its text, and marked failed.
 */

import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding, type Severity } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import { plainToRich, rich, sanitizeRichText, type RichText } from "../model/richtext.ts";
import type { Question, QuestionBody } from "../model/question.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const GIFT_PROFILE_ID = "gift";

// ---------------------------------------------------------------------------
// Reading the text
// ---------------------------------------------------------------------------

/** Text with GIFT's escapes undone: \n is a line break and a backslash before anything else is that thing. */
export function giftUnescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\\" && i + 1 < text.length) {
      const next = text[i + 1] as string;
      out += next === "n" ? "\n" : next;
      i++;
    } else out += c;
  }
  return out;
}

/** Where the top-level braces are, ignoring the escaped ones. Braces inside braces are part of the outer. */
function groups(text: string): Array<{ open: number; close: number }> {
  const found: Array<{ open: number; close: number }> = [];
  let depth = 0;
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) found.push({ open, close: i });
    }
  }
  return found;
}

interface Entry {
  marker: "=" | "~";
  /** The percentage written after the marker, if one was. */
  weight?: number;
  text: string;
  feedback: string;
}

interface Parsed {
  /** What stands before the first marker: TRUE, FALSE, a number for a numeric answer, or nothing. */
  lead: string;
  entries: Entry[];
  /** The note after #### at the end, which is for the whole question. */
  general: string;
  /** Feedback written after the lead, as for TRUE#... */
  leadFeedback: string[];
}

/** The inside of a pair of braces, split into its answers, with their weights and feedback. */
function parseInside(inner: string): Parsed {
  let general = "";
  let body = inner;
  // The general note is whatever follows an unescaped ####.
  for (let i = 0; i < body.length - 3; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body.startsWith("####", i)) {
      general = body.slice(i + 4);
      body = body.slice(0, i);
      break;
    }
  }

  // Cut at every unescaped marker.
  const cuts: Array<{ at: number; marker: "=" | "~" }> = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") i++;
    else if (c === "=" || c === "~") cuts.push({ at: i, marker: c });
  }
  const lead = (cuts.length === 0 ? body : body.slice(0, (cuts[0] as { at: number }).at)).trim();
  const entries: Entry[] = cuts.map((cut, k) => {
    const end = k + 1 < cuts.length ? (cuts[k + 1] as { at: number }).at : body.length;
    let piece = body.slice(cut.at + 1, end);
    let weight: number | undefined;
    const weighted = /^\s*%(-?\d+(?:\.\d+)?)%/.exec(piece);
    if (weighted) {
      weight = Number(weighted[1]);
      piece = piece.slice(weighted[0].length);
    }
    // The answer ends at the first unescaped # and what follows it is its feedback.
    let hash = -1;
    for (let i = 0; i < piece.length; i++) {
      if (piece[i] === "\\") i++;
      else if (piece[i] === "#") {
        hash = i;
        break;
      }
    }
    const text = (hash === -1 ? piece : piece.slice(0, hash)).trim();
    const feedback = hash === -1 ? "" : piece.slice(hash + 1).trim();
    return { marker: cut.marker, ...(weight !== undefined ? { weight } : {}), text, feedback };
  });

  // Feedback written after a lead such as TRUE#, kept apart.
  const leadParts: string[] = [];
  let leadText = lead;
  let hash = -1;
  // A numeric answer begins with # itself, so feedback after it starts at the next one.
  for (let i = lead.startsWith("#") ? 1 : 0; i < lead.length; i++) {
    if (lead[i] === "\\") i++;
    else if (lead[i] === "#") {
      hash = i;
      break;
    }
  }
  if (hash !== -1) {
    leadText = lead.slice(0, hash).trim();
    // One at a time: `TRUE#f` followed by 130,000 `#a` is more arguments than a call can take.
    for (const part of lead.slice(hash + 1).split("#")) if (part.trim() !== "") leadParts.push(part.trim());
  }
  return { lead: leadText, entries, general: general.trim(), leadFeedback: leadParts };
}

// ---------------------------------------------------------------------------
// Building a question
// ---------------------------------------------------------------------------

interface Chunk {
  text: string;
  firstLine: number;
  lastLine: number;
  category?: string;
}

interface Context {
  file: string;
  at: string;
  author: string;
}

const BLANK = "_____";

// A number in a numeric answer: digits with an optional fraction and an optional exponent ("42", "-0.5", "6.67e-11", "1E+21"). The exponent
// was not read, so a numeric question that held one came back as a failed essay.
const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
/**
 * A number as the model can hold it: finite, and not zero because it was too small to tell from zero. "1e999" is infinite (a value the bank
 * refuses, read as parsed) and "1e-999" is exactly 0, which is a different answer.
 */
function held(text: string): number | null {
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (n === 0 && /[1-9]/.test(text.replace(/[eE].*$/, ""))) return null;
  return n;
}
const NUMERIC_RANGE = new RegExp(String.raw`^(${NUMBER})\s*\.\.\s*(${NUMBER})$`);
const NUMERIC_EXACT = new RegExp(String.raw`^(${NUMBER})(?:\s*:\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?$`);

/** The tags the model calls bold and italic are strong and em. GIFT's HTML is written by hand and says b and i. */
const modelTags = (html: string): string => html.replace(/<(\/?)b(?=[\s>/])/gi, "<$1strong").replace(/<(\/?)i(?=[\s>/])/gi, "<$1em");

const plainOrHtml = (text: string, format: "html" | "plain"): RichText => (format === "html" ? rich(modelTags(text)) : plainToRich(text));

/** What the model's own tag list will take out of HTML, so that it can be said and not just done. */
function markupLost(text: string): string[] {
  const { removedTags } = sanitizeRichText(modelTags(text));
  return [...new Set(removedTags)];
}

function build(chunk: Chunk, ctx: Context): { question?: Question; orphan?: Orphan } {
  const source = { file: ctx.file, firstBlock: chunk.firstLine, lastBlock: chunk.lastLine };
  let text = chunk.text;

  // The title, then the format.
  let title: string | undefined;
  const titled = /^\s*::([\s\S]*?)::\s*/.exec(text);
  if (titled) {
    title = giftUnescape(titled[1] as string).replace(/\s+/g, " ").trim();
    text = text.slice(titled[0].length);
  }
  let format: "html" | "plain" = "plain";
  const findings: Finding[] = [];
  const formatted = /^\s*\[(html|plain|markdown|moodle)\]\s*/i.exec(text);
  if (formatted) {
    const kind = (formatted[1] as string).toLowerCase();
    if (kind === "html") format = "html";
    if (kind === "markdown") {
      findings.push(finding(FindingCode.MarkupRemoved, "warn", "The text is marked as Markdown, which was not converted. It is kept as it was written."));
    }
    text = text.slice(formatted[0].length);
  }

  const braces = groups(text);
  if (braces.length === 0) {
    return {
      orphan: {
        source,
        text: giftUnescape(text).trim(),
        reason: "This has no answer in braces. In GIFT that is a description, not a question, and a bank has no place for one.",
      },
    };
  }

  const first = braces[0] as { open: number; close: number };
  const last = braces[braces.length - 1] as { open: number; close: number };
  const before = text.slice(0, first.open);
  const after = text.slice(last.close + 1);
  const middle = braces.length > 1 ? braces.slice(0, -1).map((g, i) => text.slice(g.close + 1, (braces[i + 1] as { open: number }).open)) : [];

  const unsupported = (why: string): { question: Question } => {
    // The whole block is kept as text, so that nothing in it is lost, and it fails so that someone looks.
    const raw = giftUnescape(chunk.text).trim();
    const made = createQuestion({
      type: "essay",
      stem: plainToRich(raw),
      body: {},
      ...(title ? { title } : {}),
      by: ctx.author,
      at: ctx.at,
      ...(chunk.category ? { metadata: { status: "draft" as const, tags: [chunk.category] } } : {}),
      origin: { kind: "import", source, profile: GIFT_PROFILE_ID, at: ctx.at },
      findings: [...findings, finding(FindingCode.UnsupportedType, "error", `${why} The block is kept as text, as an essay, so that nothing in it is lost.`)],
    });
    return { question: made };
  };

  // Every group is read; a text with several is a text with several blanks.
  const parsed = braces.map((g) => parseInside(text.slice(g.open + 1, g.close)));
  const stemParts = [before, ...middle, after];
  const stemText = (blank: boolean): string => (blank ? stemParts.map((p) => giftUnescape(p)).join(BLANK) : giftUnescape(before).trim());
  const missingWord = braces.length > 1 || after.trim() !== "";

  let type: Question["type"];
  let body: QuestionBody;
  let stem = stemText(missingWord);
  const feedback: { general?: RichText } = {};
  const note = (code: string, severity: Severity, message: string): void => void findings.push(finding(code, severity, message));
  const dropped = (what: string, value: string): void => note(FindingCode.UnreadContent, "warn", `${what} was not read: "${value}".`);

  const generalText = parsed.map((p) => p.general).filter((g) => g !== "").join("\n");
  if (generalText !== "") feedback.general = plainOrHtml(giftUnescape(generalText), format);

  if (braces.length > 1) {
    // Several groups: each has to be a list of accepted answers, and each is a blank.
    const blanks = parsed.map((p, i) => ({ p, i }));
    if (blanks.some(({ p }) => p.lead !== "" || p.entries.length === 0 || p.entries.some((e) => e.marker !== "=" || e.text.includes("->")))) {
      return unsupported("A question with several answer groups is read as one with several blanks, and every group has to be a list of accepted answers marked with =.");
    }
    type = "fillInBlank";
    body = {
      caseSensitive: false,
      blanks: blanks.map(({ p, i }) => ({ id: localId("b", i), accepted: p.entries.map((e) => giftUnescape(e.text).trim()).filter((a) => a !== "") })),
    };
    for (const { p } of blanks) for (const e of p.entries) if (e.feedback !== "") dropped("Feedback on an accepted answer", giftUnescape(e.feedback));
  } else {
    const p = parsed[0] as Parsed;
    const entries = p.entries;
    const lead = p.lead.toUpperCase();

    if (p.lead === "" && entries.length === 0) {
      type = "essay";
      body = {};
    } else if (entries.length === 0 && ["T", "TRUE", "F", "FALSE"].includes(lead)) {
      type = "trueFalse";
      body = { correct: lead === "T" || lead === "TRUE" };
      if (p.leadFeedback.length > 0) dropped("Feedback written after TRUE or FALSE", p.leadFeedback.map(giftUnescape).join(" | "));
    } else if (p.lead.startsWith("#") && entries.length === 0) {
      const spec = giftUnescape(p.lead.slice(1)).trim();
      const range = NUMERIC_RANGE.exec(spec);
      const exact = NUMERIC_EXACT.exec(spec);
      const parts = (range ?? exact)?.slice(1).filter((p): p is string => p !== undefined) ?? [];
      if (parts.some((p) => held(p) === null)) {
        return unsupported(`The numeric answer "${spec}" has a number too large or too small to hold, and nothing is guessed about it.`);
      }
      if (range) {
        type = "numeric";
        body = { mode: "range", min: held(range[1] as string) as number, max: held(range[2] as string) as number };
      } else if (exact) {
        type = "numeric";
        body = exact[2] !== undefined ? { mode: "tolerance", value: held(exact[1] as string) as number, tolerance: held(exact[2]) as number } : { mode: "exact", value: held(exact[1] as string) as number };
      } else return unsupported(`The numeric answer "${spec}" is not one OpenAssess can read: it takes a number, a number and a tolerance (42:0.5) or a range (1..5).`);
    } else if (p.lead.startsWith("#") && entries.length > 0) {
      return unsupported("A numeric question with several answers, or with partial credit, is not read.");
    } else if (p.lead !== "") {
      return unsupported(`The text before the first answer, "${giftUnescape(p.lead)}", is not something GIFT puts there.`);
    } else if (entries.some((e) => e.text.includes("->"))) {
      if (entries.some((e) => e.marker !== "=" || !e.text.includes("->"))) return unsupported("A matching question has a pair marked with = for every line, and this has a line that is not one.");
      const pairs = entries.map((e) => {
        const at = e.text.indexOf("->");
        return { left: giftUnescape(e.text.slice(0, at)).trim(), right: giftUnescape(e.text.slice(at + 2)).trim() };
      });
      if (pairs.length < 2 || pairs.some((x) => x.left === "" && x.right === "")) return unsupported("A matching question needs at least two pairs, each with something on a side.");
      type = "matching";
      body = {
        shuffle: true,
        distractors: [],
        pairs: pairs.map((x, i) => ({ id: localId("p", i), left: plainToRich(x.left === "" ? "(missing)" : x.left), right: x.right === "" ? "(missing)" : x.right })),
      };
      for (const e of entries) if (e.feedback !== "") dropped("Feedback on a pair", giftUnescape(e.feedback));
    } else if (entries.every((e) => e.marker === "=")) {
      // Only right answers: whatever is typed in. With a blank in the text it is a fill in the blank, and otherwise a short answer.
      const accepted: string[] = [];
      for (const e of entries) {
        const value = giftUnescape(e.text).trim();
        if (e.weight !== undefined && e.weight < 100) {
          note(FindingCode.UnreadContent, "warn", `The answer "${value}" is worth ${e.weight} percent, which is partial credit. It was not read as an accepted answer, and nothing was guessed about it.`);
          continue;
        }
        if (value !== "") accepted.push(value);
        if (e.feedback !== "") dropped("Feedback on an accepted answer", giftUnescape(e.feedback));
      }
      if (missingWord) {
        type = "fillInBlank";
        body = { caseSensitive: false, blanks: [{ id: localId("b", 0), accepted }] };
      } else {
        type = "shortAnswer";
        body = { caseSensitive: false, accepted };
      }
    } else {
      // Choices.
      const weighted = entries.some((e) => e.weight !== undefined);
      const rightByMarker = entries.filter((e) => e.marker === "=").length;
      const positive = entries.filter((e) => (e.weight ?? (e.marker === "=" ? 100 : 0)) > 0);
      let multiple = false;
      let partial = false;
      let isRight: (e: Entry) => boolean;
      if (!weighted && rightByMarker <= 1) {
        isRight = (e) => e.marker === "=";
      } else if (!weighted) {
        multiple = true;
        isRight = (e) => e.marker === "=";
        note(FindingCode.MoreThanOneRight, "warn", "More than one answer is marked with =. It is read as a multiple response, with every = answer right. Check that this is what was meant.");
      } else if (positive.length === 1 && (positive[0] as Entry).weight !== undefined && ((positive[0] as Entry).weight as number) >= 99.99) {
        isRight = (e) => e === positive[0];
      } else if (positive.length === 1 && (positive[0] as Entry).weight === undefined) {
        isRight = (e) => e === positive[0];
      } else {
        multiple = true;
        partial = true;
        isRight = (e) => (e.weight ?? (e.marker === "=" ? 100 : 0)) > 0;
        const sum = positive.reduce((total, e) => total + (e.weight ?? 100), 0);
        if (Math.abs(sum - 100) > 1) note(FindingCode.WeightsNotKept, "warn", `The right answers are worth ${Math.round(sum * 100) / 100} percent between them, not 100. They are read as the right answers, and the weights are not kept.`);
      }
      if (weighted && !multiple && entries.some((e) => e.weight !== undefined && e.weight !== 0 && e.weight !== 100 && !isRight(e))) {
        note(FindingCode.WeightsNotKept, "warn", "Some answers carry a percentage that is neither 0 nor 100. Partial credit for a single-answer question is not kept: those answers are read as wrong.");
      }
      type = multiple ? "multipleResponse" : "multipleChoice";
      const options = entries.map((e, i) => {
        const optionText = giftUnescape(e.text).trim();
        return {
          id: localId("o", i),
          content: plainToRich(optionText === "" ? "(missing)" : optionText),
          correct: isRight(e),
          ...(e.feedback !== "" ? { feedback: plainToRich(giftUnescape(e.feedback)) } : {}),
        };
      });
      if (entries.some((e) => giftUnescape(e.text).trim() === "")) note(FindingCode.EmptyOption, "error", "An answer has no text. It is kept as (missing), and the question needs fixing.");
      body = multiple ? { shuffle: true, partialCredit: partial, options } : { shuffle: true, options };
    }
  }

  if (stem.trim() === "") stem = "(no question text in the source)";
  if (format === "html") {
    const lost = markupLost(stem);
    if (lost.length > 0) note(FindingCode.MarkupRemoved, "info", `Some markup in the text is not one OpenAssess keeps, and was taken out, leaving its words: ${lost.map((t) => `<${t}>`).join(" ")}.`);
  }
  const made = createQuestion({
    type,
    stem: plainOrHtml(stem, format),
    body,
    feedback,
    ...(title ? { title } : {}),
    by: ctx.author,
    at: ctx.at,
    points: DEFAULT_POINTS,
    metadata: { status: "draft", tags: chunk.category ? [chunk.category] : [] },
    origin: { kind: "import", source, profile: GIFT_PROFILE_ID, at: ctx.at },
  });
  return { question: withRecomputedFindings(addFindings(made, findings)) };
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/**
 * A category line. The capture is trimmed by its own shape (from the first character that shows to the last) and not by `(.*?)\s*$`,
 * which read the white space after every character of a long line again: 80,000 spaces in a line took four seconds. The white space in
 * front of the capture is inside the optional part with it, since an absent capture left two runs side by side, and a line with a
 * U+2028 in it (which `.` stops at and `\s` reads) shared the run out in as many ways as it was long. Group 1 is undefined, not "",
 * when there is nothing after the colon.
 */
export const CATEGORY_LINE = /^\s*\$CATEGORY:(?:\s*(\S(?:.*\S)?))?\s*$/i;

/** Splits the file into blocks: a blank line ends one, unless a brace is still open. Comments and categories are taken out. */
function chunks(lines: readonly string[]): { chunks: Chunk[]; categories: number } {
  const out: Chunk[] = [];
  let category: string | undefined;
  let categories = 0;
  let current: string[] = [];
  let firstLine = 0;
  let depth = 0;

  const flush = (lastLine: number): void => {
    if (current.length > 0) out.push({ text: current.join("\n"), firstLine, lastLine, ...(category ? { category } : {}) });
    current = [];
    depth = 0;
  };

  lines.forEach((raw, i) => {
    const line = raw.replace(/^﻿/, "");
    if (/^\s*\/\//.test(line)) return;
    const cat = CATEGORY_LINE.exec(line);
    if (cat && current.length === 0) {
      category = (cat[1] ?? "").replace(/^\$course\$\/(?:top\/)?/i, "").trim() || undefined;
      categories++;
      return;
    }
    if (line.trim() === "" && depth === 0) {
      flush(i - 1);
      return;
    }
    if (current.length === 0) firstLine = i;
    current.push(line);
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === "\\") k++;
      else if (c === "{") depth++;
      else if (c === "}" && depth > 0) depth--;
    }
  });
  flush(lines.length - 1);
  return { chunks: out, categories };
}

/**
 * Whether text looks like a GIFT file: most of its blocks have an answer in braces that starts the way a GIFT answer does.
 * Used to choose this importer for a file that is only called .txt.
 */
export function looksLikeGift(text: string): boolean {
  const { chunks: found } = chunks(text.replace(/\r\n?/g, "\n").split("\n"));
  if (found.length < 2) return false;
  // What a GIFT answer starts with: nothing (an essay), a marker, a numeric #, or TRUE or FALSE alone.
  const startsLikeAnswer = /^\s*(?:$|[=~#]|(?:TRUE|FALSE|T|F)\s*(?:#[\s\S]*)?$)/i;
  const gift = found.filter((c) => groups(c.text).some((g) => startsLikeAnswer.test(c.text.slice(g.open + 1, g.close))));
  return gift.length >= 2 && gift.length >= 0.8 * found.length;
}

export const giftImporter: Importer = {
  id: GIFT_PROFILE_ID,
  label: "GIFT (Moodle)",
  extensions: [".gift"],

  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = typeof input === "string" ? input : input.map((b) => b.text).join("\n");
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const ctx: Context = { file: options.file ?? "input.gift", at: options.at ?? new Date().toISOString(), author: options.author ?? "import" };
    const read = chunks(lines);

    const questions: Question[] = [];
    const orphans: Orphan[] = [];
    for (const chunk of read.chunks) {
      const built = build(chunk, ctx);
      if (built.question) questions.push(built.question);
      if (built.orphan) orphans.push(built.orphan);
    }

    const fileFindings: Finding[] = [];
    if (read.categories > 0) {
      fileFindings.push(finding(FindingCode.UnreadContent, "info", `${read.categories === 1 ? "A category line" : `${read.categories} category lines`} in the file named where the questions go in Moodle. Each question keeps its category as a tag.`));
    }
    if (questions.length === 0 && orphans.length === 0) {
      fileFindings.push(finding(FindingCode.UnreadContent, "warn", "No question was found in this file. A GIFT question has its answers in braces."));
    }
    return { profile: options.profile ?? GIFT_PROFILE_ID, file: ctx.file, questions, orphans, counts: countVerdicts(questions, orphans.length), fileFindings };
  },
};
