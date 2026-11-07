/**
 * Brightspace (D2L) Question Library CSV, read in.
 *
 * Each question is a run of rows with a keyword in the first cell. `NewQuestion` and its type (MC, TF, MS, SA, M, O, WR) start one;
 * `QuestionText`, `Title`, `Points`, `Feedback` and the rows of the type follow (`Option` with its weight, `TRUE` and `FALSE`,
 * `Answer`, `Choice` and `Match` joined by a number, `Item` in order). The cell after a text says `HTML` when the text is markup. This
 * is the shape Brightspace documents, and the shape this program's own exporter writes (`export/d2l-csv.ts`), so what is exported
 * and read again is what was exported.
 *
 * The rules of the project apply, and are the ones the Moodle XML and QTI readers keep. A key is what the file states in a shape
 * the reader knows: a multiple choice option is right where its weight is the whole of the points, a multiselect option where it
 * says 1, a true or false where one of the two is worth the whole. A weight that is part of the points is never a key. A question
 * with no right answer stated has none and says so. A weight that is not a number, a matching choice with no match or two, and a
 * kind this does not read (a fill in the blank, an arithmetic question) are said, and the question is kept as an essay with all its
 * words and fails, so that nothing in it is lost and nothing is guessed. A row that is not understood, a hint, an image the file does
 * not carry, an answer box's size, are said and not kept.
 *
 * Only the keywords the format documents are read. A line that begins with two slashes is a comment.
 */

import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding, type Severity } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import type { Question, QuestionBody } from "../model/question.ts";
import { isEmptyRichText, plainToRich, rich, richTextToPlain, sanitizeRichText, type RichText } from "../model/richtext.ts";
import { unreadObjectFindings } from "../model/unread-objects.ts";
import { PictureKeeper } from "./html-pictures.ts";
import { decodeTableText, parseDelimited } from "./table-csv.ts";
import { MAX_ROWS, type TableRow } from "./table.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const D2L_CSV_PROFILE_ID = "d2l-csv";

/** The weight that means the whole of the points, allowing for a file that writes 99.99. */
const WHOLE = 99.99;

const SHORT = 120;
const quoted = (s: string): string => (s.length > SHORT ? `${s.slice(0, SHORT - 1)}...` : s).replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const BLOCK = /<(p|ul|ol|table|pre|blockquote)[\s>/]/i;
const modelTags = (html: string): string => html.replace(/<(\/?)b(?=[\s>/])/gi, "<$1strong").replace(/<(\/?)i(?=[\s>/])/gi, "<$1em");

/** The keyword of a row, as the format spells it, without regard to case. */
const keywordOf = (row: TableRow): string => (row.cells[0] ?? "").trim().toLowerCase();
const isComment = (row: TableRow): boolean => (row.cells[0] ?? "").trim().startsWith("//");

/** Whether the start of a file is a Brightspace question library CSV: its first row that is not a comment begins a question. */
export function looksLikeD2lCsv(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = decodeTableText(bytes.subarray(0, 400_000)).text;
  } catch {
    return false;
  }
  const { rows } = parseDelimited(text, 40, ",");
  const first = rows.find((r) => !isComment(r));
  return first !== undefined && keywordOf(first) === "newquestion" && (first.cells[1] ?? "").trim() !== "";
}

interface Ctx {
  file: string;
  at: string;
  author: string;
  profile: string;
  defaultPoints: number;
  /** Rows of a kind that sets how Brightspace shows a question and that this does not keep, counted for one note about the file. */
  unkept: Map<string, number>;
  withDifficulty: number;
}

/** The state of one question while it is read: what it says about itself, the markup taken out, the pictures it named. */
class Reader {
  readonly findings: Finding[] = [];
  readonly removed = new Set<string>();
  private readonly pictures = new PictureKeeper(new Map());

  note(code: string, severity: Severity, message: string): void {
    this.findings.push(finding(code, severity, message));
  }

  dropped(what: string, value: string): void {
    this.note(FindingCode.UnreadContent, "warn", `${what} was not read: "${quoted(value)}".`);
  }

  /** A cell's words as rich text, markup when the cell after it says HTML; undefined for nothing. */
  rich(value: string | undefined, flag: string | undefined): RichText | undefined {
    const raw = (value ?? "").trim();
    if (raw === "") return undefined;
    if ((flag ?? "").trim().toLowerCase() !== "html") {
      // Brightspace reads anything but HTML in this cell as plain text, so the text is plain. What is there is said, because an author
      // who put feedback or a note in the cell would otherwise lose it without a word.
      const stray = (flag ?? "").trim();
      if (stray !== "") this.note(FindingCode.UnreadContent, "info", `The cell after a text is where the word HTML goes, and it holds "${quoted(stray)}", which is not read. The text before it is plain text.`);
      return plainToRich(raw);
    }
    // A picture of a CSV file is named by a path in the file's own folder, which the file does not carry.
    const html = modelTags(this.pictures.replaceImages(raw, (src) => ({ label: src, why: "a CSV file does not carry pictures, and this one names a file beside it" })));
    for (const tag of sanitizeRichText(html).removedTags) if (tag !== "div" && tag !== "span") this.removed.add(tag);
    const text = rich(BLOCK.test(html) ? html : `<p>${html}</p>`);
    return isEmptyRichText(text) ? undefined : text;
  }

  /** A cell's words with no markup, for the places that hold none (the right side of a pair). */
  plain(value: string | undefined, flag: string | undefined): string {
    const text = this.rich(value, flag);
    return text ? richTextToPlain(text).replace(/\s+/g, " ").trim() : "";
  }

  finish(): Finding[] {
    const out = [...this.findings];
    const lost = this.pictures.lostMessage();
    if (lost) out.push(finding(FindingCode.UnreadContent, "warn", lost));
    if (this.removed.size > 0) {
      out.push(finding(FindingCode.MarkupRemoved, "info", `Some markup in the text is not one OpenAssess keeps, and was taken out, leaving its words: ${[...this.removed].sort().map((t) => `<${t}>`).join(" ")}.`));
    }
    return out;
  }
}

/** The kinds of scoring Brightspace has for a multiselect, as its importer is reported to spell them and as its pages label them. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

/** The rows of a question that carry its answers, which a question this does not read is kept with. */
const ANSWER_KEYWORDS = new Set(["option", "answer", "true", "false", "choice", "match", "item"]);

interface Built {
  question?: Question;
  orphan?: Orphan;
}

function build(block: TableRow[], first: number, last: number, ctx: Ctx, file: string): Built {
  const source = { file, firstBlock: first, lastBlock: last };
  const r = new Reader();
  const head = block[0] as TableRow;
  const type = (head.cells[1] ?? "").trim().toUpperCase();
  const rows = block.slice(1);
  const cell = (row: TableRow, i: number): string => (row.cells[i] ?? "").trim();
  const ofKind = (keyword: string): TableRow[] => rows.filter((row) => keywordOf(row) === keyword);
  const one = (keyword: string): TableRow | undefined => ofKind(keyword)[0];

  const metadata: { status: "draft"; tags: string[]; custom?: Record<string, string> } = { status: "draft", tags: [] };
  const custom: Record<string, string> = {};

  const id = one("id");
  if (id && cell(id, 1) !== "") custom["Question ID"] = cell(id, 1);
  const difficulty = one("difficulty");
  if (difficulty && cell(difficulty, 1) !== "") {
    // Brightspace's difficulty is a number from 1 to 5, which is not the three levels a bank has, and turning one into the other
    // would be a guess, so it is kept as written.
    custom["Difficulty"] = cell(difficulty, 1);
    ctx.withDifficulty++;
  }
  if (Object.keys(custom).length > 0) metadata.custom = custom;

  const titleRow = one("title");
  const title = titleRow ? cell(titleRow, 1).replace(/\s+/g, " ") : "";
  const textRow = one("questiontext");
  const stemText = textRow ? r.rich(cell(textRow, 1), cell(textRow, 2)) : undefined;

  let points = ctx.defaultPoints;
  const pointsRow = one("points");
  if (pointsRow && cell(pointsRow, 1) !== "") {
    const n = Number(cell(pointsRow, 1));
    if (Number.isFinite(n) && n > 0) points = n;
    else r.note(FindingCode.PointsAssumed, "warn", `The Points cell says "${cell(pointsRow, 1)}", which is not a number above 0, so ${ctx.defaultPoints} point was used.`);
  }

  // What the file says about a question that is not kept, once each.
  for (const row of ofKind("image")) if (cell(row, 1) !== "") r.dropped("An image", cell(row, 1));
  for (const row of ofKind("hint")) {
    const hint = r.plain(cell(row, 1), cell(row, 2));
    if (hint !== "") r.dropped("A hint", hint);
  }
  for (const row of ofKind("initialtext")) if (cell(row, 1) !== "") r.dropped("The text to start the answer box with", cell(row, 1));
  if (ofKind("inputbox").length > 0) ctx.unkept.set("InputBox", (ctx.unkept.get("InputBox") ?? 0) + 1);
  const KNOWN = new Set(["id", "title", "questiontext", "points", "difficulty", "image", "hint", "feedback", "scoring", "option", "answer", "true", "false", "choice", "match", "item", "inputbox", "initialtext", "answerkey"]);
  // A row with no keyword is a row too, and is said: its words are not read.
  const unknown = [...new Set(rows.filter((row) => !KNOWN.has(keywordOf(row))).map((row) => (cell(row, 0) === "" ? `(no keyword) ${row.cells.filter((c) => c !== "").join(", ")}` : cell(row, 0))))];
  if (unknown.length > 0) r.dropped(unknown.length === 1 ? "A row" : "Some rows", unknown.join("; "));
  // A row that a question has one of, given twice: the first is read, and the second is said and not read.
  for (const keyword of ["id", "title", "questiontext", "points", "difficulty", "scoring", "feedback", "answerkey", "initialtext"]) {
    const again = ofKind(keyword)[1];
    if (again) r.dropped(`A second ${cell(again, 0)} row`, cell(again, 1));
  }

  const feedback: { general?: RichText; correct?: RichText; incorrect?: RichText } = {};
  const feedbackRow = one("feedback");
  const general = feedbackRow ? r.rich(cell(feedbackRow, 1), cell(feedbackRow, 2)) : undefined;
  if (general) feedback.general = general;

  const make = (kind: Question["type"], body: QuestionBody, extra: Finding[] = []): Built => {
    const made = createQuestion({
      type: kind,
      stem: stemText ?? plainToRich("(no question text in the source)"),
      body,
      feedback,
      ...(title !== "" ? { title } : {}),
      points,
      by: ctx.author,
      at: ctx.at,
      metadata,
      origin: { kind: "import", source, profile: ctx.profile, at: ctx.at },
      findings: [...extra, ...r.finish()],
    });
    return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
  };

  // A kind this importer does not read, or a question it cannot read the key of: the whole of what it says is kept as an essay, and
  // it fails so that someone looks.
  const unsupported = (why: string): Built => {
    const asked = stemText ?? plainToRich(title !== "" ? title : "(no question text in the source)");
    const words = rows
      .filter((row) => ANSWER_KEYWORDS.has(keywordOf(row)))
      .map((row) => (["true", "false"].includes(keywordOf(row)) ? cell(row, 0) : keywordOf(row) === "item" ? cell(row, 1) : cell(row, 2)))
      .filter((w) => w !== "");
    const kept =
      words.length > 0 ? rich(`${asked.content}<p>${words.map((w) => w.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("</p><p>")}</p>`) : asked;
    const made = createQuestion({
      type: "essay",
      stem: kept,
      body: {},
      ...(title !== "" ? { title } : {}),
      points,
      by: ctx.author,
      at: ctx.at,
      metadata,
      origin: { kind: "import", source, profile: ctx.profile, at: ctx.at },
      findings: [...r.finish(), finding(FindingCode.UnsupportedType, "error", `${why} The question's text is kept, as an essay, so that nothing in it is lost.`)],
    });
    return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
  };

  const weightOf = (row: TableRow): number | undefined => {
    const raw = cell(row, 1);
    const n = raw === "" ? 0 : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  if (type === "MC") {
    const options = ofKind("option");
    if (options.length < 2) return unsupported("A multiple choice question needs at least two options.");
    const weights = options.map(weightOf);
    const badAt = weights.findIndex((w) => w === undefined);
    if (badAt !== -1) return unsupported(`An option has the weight "${quoted(cell(options[badAt] as TableRow, 1))}", which is not a number.`);
    const built = options.map((row, i) => {
      const read = r.rich(cell(row, 2), cell(row, 3));
      const fb = r.rich(cell(row, 4), cell(row, 5));
      return { weight: weights[i] as number, empty: read === undefined, option: { id: localId("o", i), content: read ?? plainToRich("(missing)"), correct: false, ...(fb ? { feedback: fb } : {}) } };
    });
    if (built.some((o) => o.empty)) r.note(FindingCode.EmptyOption, "error", "An option has no text. It is kept as (missing), and the question needs fixing.");
    const whole = built.filter((o) => o.weight >= WHOLE);
    for (const o of whole) o.option.correct = true;
    if (whole.length === 0) r.note(FindingCode.UnreadContent, "warn", "No option is worth the whole of the points, so no option is read as the key. Nothing was guessed.");
    else if (whole.length > 1) r.note(FindingCode.MoreThanOneRight, "warn", `${whole.length} options are each worth the whole of the points, and a multiple choice question has one right answer. Every one is marked right as the file has it, and the question needs fixing.`);
    if (built.some((o) => o.weight > 0 && o.weight < WHOLE)) r.note(FindingCode.WeightsNotKept, "warn", "Some options are worth part of the points. Partial credit for a multiple choice question is not kept: those options are read as wrong.");
    if (built.some((o) => o.weight < 0)) r.note(FindingCode.WeightsNotKept, "warn", "Some options take points away. That is not kept.");
    return make("multipleChoice", { shuffle: true, options: built.map((o) => o.option) });
  }

  if (type === "MS") {
    const options = ofKind("option");
    if (options.length < 2) return unsupported("A multiselect question needs at least two options.");
    const weights = options.map(weightOf);
    // A multiselect option is 1 for a right answer and 0 for a wrong one. Any other number is not a shape this knows, and is not
    // turned into a key.
    const oddAt = weights.findIndex((w) => w === undefined || (w !== 0 && w !== 1));
    if (oddAt !== -1) return unsupported(`An option has the weight "${quoted(cell(options[oddAt] as TableRow, 1))}", and a multiselect option is 1 for a right answer and 0 for a wrong one.`);
    const built = options.map((row, i) => {
      const read = r.rich(cell(row, 2), cell(row, 3));
      const fb = r.rich(cell(row, 4), cell(row, 5));
      return { empty: read === undefined, option: { id: localId("o", i), content: read ?? plainToRich("(missing)"), correct: weights[i] === 1, ...(fb ? { feedback: fb } : {}) } };
    });
    if (built.some((o) => o.empty)) r.note(FindingCode.EmptyOption, "error", "An option has no text. It is kept as (missing), and the question needs fixing.");
    if (!built.some((o) => o.option.correct)) r.note(FindingCode.UnreadContent, "warn", "No option is marked 1, so no option is read as the key. Nothing was guessed.");
    const scoring = one("scoring") ? cell(one("scoring") as TableRow, 1) : "";
    const name = squash(scoring);
    let partialCredit = false;
    if (name === "" || name === "allornothing") partialCredit = false;
    else if (name === "rightminuswrong") partialCredit = true;
    else if (name === "rightanswers" || name === "correctselections" || name === "correctanswerslimitedselections" || name === "equallyweighted") {
      partialCredit = true;
      r.note(FindingCode.WeightsNotKept, "info", `The scoring "${scoring}" gives credit for each right answer chosen. It is kept as partial credit, which is the nearest a question here has to it.`);
    } else r.note(FindingCode.WeightsNotKept, "warn", `The scoring "${quoted(scoring)}" is not one this knows, so the question is all or nothing, which is what Brightspace does when none is given.`);
    return make("multipleResponse", { shuffle: true, partialCredit, options: built.map((o) => o.option) });
  }

  if (type === "TF") {
    const yes = one("true");
    const no = one("false");
    if (!yes || !no || ofKind("true").length !== 1 || ofKind("false").length !== 1) return unsupported("A true or false question has one TRUE row and one FALSE row.");
    const wy = weightOf(yes);
    const wn = weightOf(no);
    if (wy === undefined || wn === undefined) return unsupported(`A true or false row has the weight "${quoted(cell(wy === undefined ? yes : no, 1))}", which is not a number.`);
    const bothWhole = wy >= WHOLE && wn >= WHOLE;
    const rightIs = wy >= WHOLE ? true : wn >= WHOLE ? false : undefined;
    if (bothWhole) r.note(FindingCode.MoreThanOneRight, "warn", "Both TRUE and FALSE are worth the whole of the points. Neither is read as the key.");
    else if (rightIs === undefined) r.note(FindingCode.UnreadContent, "warn", "Neither TRUE nor FALSE is worth the whole of the points, so neither is read as the key. Nothing was guessed.");
    const fbOf = (row: TableRow): RichText | undefined => r.rich(cell(row, 2), cell(row, 3));
    if (rightIs !== undefined && !bothWhole) {
      const rf = fbOf(rightIs ? yes : no);
      const of = fbOf(rightIs ? no : yes);
      if (rf) feedback.correct = rf;
      if (of) feedback.incorrect = of;
    } else {
      for (const row of [yes, no]) {
        const f = fbOf(row);
        if (f) r.dropped("The feedback on an answer", richTextToPlain(f));
      }
    }
    return make("trueFalse", rightIs !== undefined && !bothWhole ? { correct: rightIs } : {});
  }

  if (type === "SA") {
    const accepted: string[] = [];
    let mode = "";
    for (const row of ofKind("answer")) {
      const text = cell(row, 2);
      const how = cell(row, 3).toLowerCase();
      if (how !== "") mode = how;
      // Brightspace says the weight of an answer row is no longer used, and may be left blank. A weight that is there and is not the
      // whole of the points is a sign that the author meant this answer to be worth less or nothing, so it is not read as an accepted
      // answer, and is said: nothing is guessed about it.
      const weight = cell(row, 1);
      if (weight !== "") {
        const n = Number(weight);
        if (!Number.isFinite(n) || n < WHOLE) {
          r.note(FindingCode.UnreadContent, "warn", `The answer "${quoted(text)}" has the weight "${quoted(weight)}", which is not the whole of the points. It was not read as an accepted answer, and nothing was guessed about it.`);
          continue;
        }
      }
      if (how === "regexp") {
        r.note(FindingCode.UnreadContent, "warn", `The answer "${quoted(text)}" is a regular expression, which a short answer here cannot hold. It was not read as an accepted answer.`);
        continue;
      }
      if (text !== "" && !accepted.includes(text)) accepted.push(text);
    }
    return make("shortAnswer", { caseSensitive: mode === "sensitive", accepted });
  }

  if (type === "M") {
    const choices = ofKind("choice");
    const matches = ofKind("match");
    const numberOf = (row: TableRow): number | undefined => (/^\d+$/.test(cell(row, 1)) ? Number(cell(row, 1)) : undefined);
    if (choices.some((c) => numberOf(c) === undefined) || matches.some((m) => numberOf(m) === undefined)) return unsupported("A choice or a match has a number that is not a whole number, so the pairs cannot be joined.");
    const numbers = choices.map((c) => numberOf(c) as number);
    if (new Set(numbers).size !== numbers.length) return unsupported("Two choices have the same number, so the pairs cannot be joined.");
    if (choices.length < 2) return unsupported("A matching question needs at least two choices, each with a match.");
    const pairs: Array<{ left: RichText; right: string }> = [];
    // The matches by their number, made once: a long matching question would otherwise search every match for every choice.
    const matchesByNumber = new Map<number, TableRow[]>();
    for (const m of matches) {
      const key = numberOf(m) as number;
      const list = matchesByNumber.get(key);
      if (list) list.push(m);
      else matchesByNumber.set(key, [m]);
    }
    const choiceNumbers = new Set(numbers);
    for (const choice of choices) {
      const mine = matchesByNumber.get(numberOf(choice) as number) ?? [];
      if (mine.length !== 1) {
        return unsupported(
          mine.length === 0
            ? `The choice "${quoted(cell(choice, 2))}" has no match, and nothing is guessed to fill it.`
            : `The choice "${quoted(cell(choice, 2))}" has ${mine.length} matches, and nothing says which is the right one.`,
        );
      }
      const left = r.rich(cell(choice, 2), cell(choice, 3));
      const right = r.plain(cell(mine[0] as TableRow, 2), cell(mine[0] as TableRow, 3));
      if (!left || right === "") return unsupported("A pair has nothing on one side, and nothing is guessed to fill it.");
      pairs.push({ left, right });
    }
    // A match that belongs to no choice is a spare answer, which a question here can hold, and it is said.
    const spare = matches.filter((m) => !choiceNumbers.has(numberOf(m) as number)).map((m) => r.plain(cell(m, 2), cell(m, 3))).filter((t) => t !== "");
    if (spare.length > 0) r.note(FindingCode.UnreadContent, "warn", `${plural(spare.length, "match has", "matches have")} a number that no choice has, so ${spare.length === 1 ? "it was" : "they were"} read as spare ${spare.length === 1 ? "answer" : "answers"}: ${spare.map(quoted).join("; ")}.`);
    return make("matching", { shuffle: true, distractors: spare, pairs: pairs.map((p, i) => ({ id: localId("p", i), left: p.left, right: p.right })) });
  }

  if (type === "O") {
    const items = ofKind("item");
    if (items.length < 2) return unsupported("An ordering question needs at least two items.");
    const read = items.map((row) => ({ row, content: r.rich(cell(row, 1), cell(row, 2)) }));
    if (read.some((i) => i.content === undefined)) return unsupported("An item has no text, and nothing is guessed to fill it.");
    for (const { row } of read) {
      const fb = r.plain(cell(row, 3), cell(row, 4));
      if (fb !== "") r.dropped("The feedback on an item", fb);
    }
    return make("ordering", { items: read.map((i, n) => ({ id: localId("i", n), content: i.content as RichText, position: n + 1 })) });
  }

  if (type === "WR") {
    const key = one("answerkey");
    const modelAnswer = key ? r.rich(cell(key, 1), cell(key, 2)) : undefined;
    return make("essay", modelAnswer ? { modelAnswer } : {});
  }

  const known: Record<string, string> = {
    FIB: "A fill in the blank question is not read: the file does not say where in the text each blank is.",
    MSA: "A multiple short answer question is not read.",
    ARITH: "An arithmetic question is not read.",
    SIG: "A significant figures question is not read.",
  };
  return unsupported(known[type] ?? `A question of the type "${quoted(type)}" is not one this reads.`);
}

function lineOf(row: TableRow): string {
  return `Row ${row.number}: ${row.cells.filter((c) => c !== "").map((c) => c.replace(/\n/g, " ↵ ")).join(" | ")}`;
}

function parseD2l(bytes: Uint8Array, options: ImportOptions): ImportResult {
  const ctx: Ctx = {
    file: options.file ?? "questions.csv",
    at: options.at ?? new Date().toISOString(),
    author: options.author ?? "import",
    profile: options.profile ?? D2L_CSV_PROFILE_ID,
    defaultPoints: options.defaultPoints ?? DEFAULT_POINTS,
    unkept: new Map(),
    withDifficulty: 0,
  };
  const { text, encoding } = decodeTableText(bytes);
  const fileFindings: Finding[] = [];
  const say = (severity: Severity, message: string): void => void fileFindings.push(finding(FindingCode.UnreadContent, severity, message));
  if (encoding) say("info", `The file was read as ${encoding}.`);
  const { rows, truncated } = parseDelimited(text, MAX_ROWS, ",");
  if (truncated) say("warn", `Only the first ${MAX_ROWS} rows were read.`);

  const lines = rows.map(lineOf);
  const questions: Question[] = [];
  const orphans: Orphan[] = [];
  let comments = 0;
  let current: { rows: TableRow[]; first: number } | undefined;
  const flush = (last: number): void => {
    if (!current) return;
    const built = build(current.rows, current.first, last, ctx, ctx.file);
    if (built.question) questions.push(built.question);
    if (built.orphan) orphans.push(built.orphan);
    current = undefined;
  };
  rows.forEach((row, i) => {
    if (isComment(row)) {
      comments++;
      return;
    }
    if (keywordOf(row) === "newquestion") {
      flush(i - 1);
      current = { rows: [row], first: i };
      return;
    }
    if (current) {
      current.rows.push(row);
      return;
    }
    orphans.push({ source: { file: ctx.file, firstBlock: i, lastBlock: i }, text: row.cells.filter((c) => c !== "").join(" | "), reason: "This row is before the first NewQuestion row, so it belongs to no question." });
  });
  flush(rows.length - 1);

  if (comments > 0) say("info", `${plural(comments, "row is a comment (it begins with //) and was", "rows are comments (they begin with //) and were")} not read.`);
  const inputBoxes = ctx.unkept.get("InputBox") ?? 0;
  if (ctx.withDifficulty > 0) say("info", `${plural(ctx.withDifficulty, "question has", "questions have")} a Difficulty from 1 to 5, which is not the three levels a bank has, so it is kept as written under Difficulty in the question's notes.`);
  if (inputBoxes > 0) say("info", `${plural(inputBoxes, "question sets", "questions set")} the size of the answer box (InputBox), which is not kept.`);
  if (questions.length === 0 && orphans.length === 0) say("warn", "No question was found in this file. A Brightspace question library file has a NewQuestion row for each question.");

  return { profile: ctx.profile, file: ctx.file, questions, orphans, counts: countVerdicts(questions, orphans.length), fileFindings, sourceLines: lines };
}

export const d2lCsvImporter: Importer = {
  id: D2L_CSV_PROFILE_ID,
  label: "Brightspace question library (CSV)",
  // A .csv is chosen by what is in it (see the registry), so the extension is not claimed here and a plain table is still a table.
  extensions: [],
  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = typeof input === "string" ? input : input.map((b) => b.text).join("\n");
    return parseD2l(new Uint8Array(Buffer.from(text, "utf8")), options);
  },
  parseBytes: parseD2l,
};
