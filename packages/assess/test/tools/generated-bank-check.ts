/**
 * Holds a generated test bank to its assignment before the importer is ever run on it.
 *
 * It reads each .docx for itself, from word/document.xml and shares nothing with the importer but the zip reader,
 * and checks that:
 *   - the expected file is well formed, its questions are in the document in the order given, and each stem and
 *     each option is there word for word;
 *   - the file looks the way it was assigned to look (how questions begin, how options are labelled), counted
 *     question by question, with room for the lapses it was asked to have;
 *   - the right answer, read out of the document by the assigned mark (a star, bold, an Answer line, a key at the
 *     end ...), is the one the expected file says, and a question the expected file calls failed really has no
 *     single mark;
 *   - the hard case it was assigned is there;
 *   - no stem is in two files, and the files are the size asked for.
 *
 * What it cannot check, it says. A pass here means the files are what was asked for, not that they are good.
 *
 *   node --experimental-strip-types --no-warnings test/tools/generated-bank-check.ts check <folder> [--piece N]
 *   node --experimental-strip-types --no-warnings test/tools/generated-bank-check.ts prompt <piece>
 *   node --experimental-strip-types --no-warnings test/tools/generated-bank-check.ts plan
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { unzipSync } from "../../src/container/zip.ts";
import { BLIND_PIECES, PIECES, PLAN, pieceText, type PlanEntry } from "./generated-bank-plan.ts";

// ---------------------------------------------------------------------------
// Reading a document
// ---------------------------------------------------------------------------

export interface Run {
  text: string;
  bold: boolean;
  underline: boolean;
  highlight: boolean;
  colour: boolean;
}

export interface Line {
  text: string;
  runs: Run[];
  /** The paragraph it came from. A line break inside a paragraph makes two lines of one. */
  para: number;
  /** Word's own list numbering, from the paragraph or its style. */
  list?: "bullet" | "number";
  cell?: { table: number; row: number; col: number };
}

export interface Doc {
  lines: Line[];
  /** Paragraphs with a line break inside them and text on both sides of it. */
  paragraphsWithBreaks: number;
  tables: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_m, dec?: string, hex?: string, name?: string) =>
    dec !== undefined ? String.fromCodePoint(Number(dec)) : hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : (ENTITIES[name as string] as string),
  );

interface ListRef {
  numId: string;
  ilvl: string;
}

interface Numbering {
  formatOf(ref: ListRef): string | undefined;
  styleList(styleId: string): ListRef | undefined;
}

function listRefIn(xml: string): ListRef | undefined {
  const numId = /<w:numId\s+w:val="(\d+)"/.exec(xml)?.[1];
  if (numId === undefined) return undefined;
  return { numId, ilvl: /<w:ilvl\s+w:val="(\d+)"/.exec(xml)?.[1] ?? "0" };
}

function readNumbering(numberingXml: string | undefined, stylesXml: string | undefined): Numbering {
  const abstracts = new Map<string, Map<string, string>>();
  const nums = new Map<string, string>();
  for (const m of (numberingXml ?? "").matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map<string, string>();
    for (const l of (m[2] as string).matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const format = /<w:numFmt\s+w:val="([^"]*)"/.exec(l[2] as string)?.[1];
      if (format !== undefined) levels.set(l[1] as string, format);
    }
    abstracts.set(m[1] as string, levels);
  }
  for (const m of (numberingXml ?? "").matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abstractId = /<w:abstractNumId\s+w:val="(\d+)"/.exec(m[2] as string)?.[1];
    if (abstractId !== undefined) nums.set(m[1] as string, abstractId);
  }

  const styles = new Map<string, { basedOn?: string; list?: ListRef }>();
  for (const m of (stylesXml ?? "").matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const body = m[2] as string;
    const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(body)?.[1];
    const basedOn = /<w:basedOn\s+w:val="([^"]*)"/.exec(body)?.[1];
    const list = numPr ? listRefIn(numPr) : undefined;
    styles.set(m[1] as string, { ...(basedOn ? { basedOn } : {}), ...(list ? { list } : {}) });
  }

  return {
    formatOf: (ref) => abstracts.get(nums.get(ref.numId) ?? "")?.get(ref.ilvl),
    styleList: (styleId) => {
      let id: string | undefined = styleId;
      for (let depth = 0; id !== undefined && depth < 8; depth++) {
        const style = styles.get(id);
        if (style?.list) return style.list;
        id = style?.basedOn;
      }
      return undefined;
    },
  };
}

const flag = (re: RegExp, xml: string): boolean => {
  const m = re.exec(xml);
  return m !== null && (m[1] === undefined || !/^(0|false|off|none)$/i.test(m[1]));
};

function runProperties(rPr: string): Omit<Run, "text"> {
  const colour = /<w:color\s+w:val="([0-9A-Fa-f]{6}|auto)"/.exec(rPr)?.[1];
  const fill = /<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6}|auto)"/.exec(rPr)?.[1];
  return {
    bold: flag(/<w:b(?:\s+w:val="([^"]*)")?\s*\/>/, rPr),
    underline: flag(/<w:u(?:\s+w:val="([^"]*)")?[^>]*\/>/, rPr),
    highlight: flag(/<w:highlight\s+w:val="([^"]*)"/, rPr) || (fill !== undefined && !/^(auto|FFFFFF)$/i.test(fill)),
    colour: colour !== undefined && !/^(auto|000000|FFFFFF)$/i.test(colour),
  };
}

function paragraphLines(xml: string, para: number, numbering: Numbering): { lines: Line[]; broke: boolean } {
  const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)?.[1] ?? "";
  const direct = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(pPr)?.[1];
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(pPr)?.[1];
  const ref = direct !== undefined ? listRefIn(direct) : style !== undefined ? numbering.styleList(style) : undefined;
  const list: Line["list"] = ref && ref.numId !== "0" ? (numbering.formatOf(ref) === "bullet" ? "bullet" : "number") : undefined;

  const lines: Line[] = [];
  let runs: Run[] = [];
  const finish = (): void => {
    lines.push({ text: runs.map((r) => r.text).join(""), runs, para, ...(list ? { list } : {}) });
    runs = [];
  };
  for (const r of xml.matchAll(/<w:r(?:\s[^>]*)?\/>|<w:r[\s>][\s\S]*?<\/w:r>/g)) {
    const props = runProperties(/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r[0])?.[1] ?? "");
    for (const t of r[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>/g)) {
      if (t[0].startsWith("<w:br") || t[0] === "<w:cr/>") {
        // A page or column break is not a line break.
        if (/w:type="(?:page|column)"/.test(t[0])) continue;
        finish();
      } else {
        runs.push({ ...props, text: t[1] === undefined ? "\t" : decode(t[1]) });
      }
    }
  }
  finish();
  return { lines, broke: lines.length > 1 && lines.filter((l) => l.text.trim() !== "").length > 1 };
}

export function readDocx(bytes: Uint8Array): Doc {
  const parts = unzipSync(bytes, { maxTotalBytes: 256 * 1024 * 1024 });
  const text = (name: string): string | undefined => {
    const part = parts.get(name);
    return part ? Buffer.from(part).toString("utf8") : undefined;
  };
  const body = text("word/document.xml");
  if (body === undefined) throw new Error("There is no word/document.xml in this file, so it is not a Word document.");
  const numbering = readNumbering(text("word/numbering.xml"), text("word/styles.xml"));

  const lines: Line[] = [];
  let para = 0;
  let tables = 0;
  let table = -1;
  let depth = 0;
  let row = -1;
  let col = -1;
  let paragraphsWithBreaks = 0;
  // Word writes an empty paragraph as <w:p w14:paraId="..."/>, with attributes, so that form comes before the one that
  // runs on to the next </w:p>, or it would swallow the table that follows.
  const tokens = /<w:tbl>|<w:tbl\s[^>]*>|<\/w:tbl>|<w:tr[\s>]|<w:tc[\s>]|<w:p(?:\s[^>]*)?\/>|<w:p[\s>][\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(tokens)) {
    const token = m[0];
    if (token.startsWith("<w:tbl")) {
      depth++;
      if (depth === 1) {
        table = tables++;
        row = -1;
      }
    } else if (token === "</w:tbl>") {
      depth--;
    } else if (token.startsWith("<w:tr")) {
      if (depth === 1) {
        row++;
        col = -1;
      }
    } else if (token.startsWith("<w:tc")) {
      if (depth === 1) col++;
    } else {
      const made = paragraphLines(token, para++, numbering);
      if (made.broke) paragraphsWithBreaks++;
      for (const line of made.lines) lines.push(depth > 0 ? { ...line, cell: { table, row, col } } : line);
    }
  }
  return { lines, paragraphsWithBreaks, tables };
}

// ---------------------------------------------------------------------------
// Matching text in a document
// ---------------------------------------------------------------------------

/** One for one in length, so that a place in the folded text is the same place in the line. */
const fold = (s: string): string =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s/g, " ");
export const norm = (s: string): string => fold(s).replace(/ +/g, " ").trim();

interface Pos {
  line: number;
  col: number;
}

/** `expected` (already normalised) read from here on. A space in it is any whitespace, or the end of a line. */
function matchFrom(folded: readonly string[], at: Pos, expected: string): Pos | undefined {
  let { line, col } = at;
  for (let k = 0; k < expected.length; k++) {
    const ch = expected[k] as string;
    if (ch === " ") {
      let moved = false;
      for (;;) {
        const t = folded[line] as string;
        if (col < t.length && t[col] === " ") {
          col++;
          moved = true;
        } else if (col >= t.length && line + 1 < folded.length) {
          line++;
          col = 0;
          moved = true;
        } else break;
      }
      if (!moved) return undefined;
    } else {
      const t = folded[line] as string;
      if (col >= t.length || t[col] !== ch) return undefined;
      col++;
    }
  }
  return { line, col };
}

function findText(folded: readonly string[], from: Pos, expected: string): { start: Pos; end: Pos } | undefined {
  for (let line = from.line; line < folded.length; line++) {
    const t = folded[line] as string;
    for (let col = line === from.line ? from.col : 0; col < t.length; col++) {
      if (t[col] !== expected[0]) continue;
      const end = matchFrom(folded, { line, col }, expected);
      if (end) return { start: { line, col }, end };
    }
  }
  return undefined;
}

// What may come before an option's words on its line: a bullet, a star, a label such as A. (A) a) A:
const LEAD_LABEL = /^(\s*(?:[•·▪○\-–]\s*)?\*?\s*)([([]?([A-Za-z0-9]{1,2})[)\].:])(\s*\*?\s*)/;
const LEAD_PLAIN = /^(\s*(?:[•·▪○\-–]\s*)?\*?\s*)/;

interface Placed {
  line: number;
  col: number;
  end: Pos;
  /** Everything between the end of the last thing and these words: the label, a star, a bullet. */
  lead: string;
  /** The label as written, such as "A." or "(B)". Empty when the option has none. */
  labelText: string;
  /** Its letter, upper case, when it has one. */
  letter?: string;
  /** What follows the words on their line. */
  rest: string;
}

/** The next option: the words, after what may lead them, within the next few lines. */
function placeOption(doc: Doc, folded: readonly string[], cursor: Pos, limit: number, expected: string): Placed | undefined {
  for (let line = cursor.line; line < Math.min(folded.length, cursor.line + 14, limit); line++) {
    const from = line === cursor.line ? cursor.col : 0;
    const t = folded[line] as string;
    const tail = t.slice(from);
    const candidates: Array<{ skip: number; labelText: string; letter?: string }> = [];
    const labelled = LEAD_LABEL.exec(tail);
    if (labelled) candidates.push({ skip: labelled[0].length, labelText: labelled[2] as string, letter: (labelled[3] as string).toUpperCase() });
    candidates.push({ skip: (LEAD_PLAIN.exec(tail) as RegExpExecArray)[0].length, labelText: "" });
    for (const c of candidates) {
      const start = { line, col: from + c.skip };
      const end = matchFrom(folded, start, expected);
      if (end) {
        const raw = (doc.lines[end.line] as Line).text;
        return {
          line,
          col: start.col,
          end,
          lead: (doc.lines[line] as Line).text.slice(from, start.col),
          labelText: c.labelText,
          ...(c.letter ? { letter: c.letter } : {}),
          rest: raw.slice(end.col),
        };
      }
    }
  }
  return undefined;
}

/** The share of an option's characters, spaces apart, that carry a property. */
function markedShare(line: Line, from: number, to: number, key: "bold" | "underline" | "highlight" | "colour"): number {
  let seen = 0;
  let marked = 0;
  let at = 0;
  for (const run of line.runs) {
    for (let i = 0; i < run.text.length; i++, at++) {
      if (at < from || at >= to || /\s/.test(run.text[i] as string)) continue;
      seen++;
      if (run[key]) marked++;
    }
  }
  return seen === 0 ? 0 : marked / seen;
}

const LETTER_LIST = /^[A-Za-z](?:\s*(?:,|&|\/|\band\b)\s*[A-Za-z]|\s+[A-Za-z])*$/;
function parseLetters(value: string): string[] | undefined {
  const v = value.trim().replace(/[.)]$/, "").trim();
  if (!LETTER_LIST.test(v)) return undefined;
  return v.split(/\s*(?:,|&|\/|\band\b)\s*|\s+/).filter((s) => s !== "").map((s) => s.toUpperCase());
}

const ANSWER_LINE = /^\s*(Answer|ANS|Correct|Ans)\s*[:.]\s*(.*?)\s*$/;

// ---------------------------------------------------------------------------
// The expected file
// ---------------------------------------------------------------------------

export interface ExpectedQuestion {
  type: string;
  stem: string;
  options?: string[];
  correct?: number[];
  correctBoolean?: boolean;
  form?: string;
  accepted?: string[];
  pairs?: string[];
  verdict?: string;
}

const TYPES = ["multipleChoice", "multipleResponse", "trueFalse", "fillInBlank", "shortAnswer", "essay", "matching"];
const TF_FORMS = ["options", "inline", "answerLine"];

export function validateExpected(raw: unknown, name: string): { questions: ExpectedQuestion[]; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { questions?: unknown }).questions)) {
    return { questions: [], problems: ["The expected file is not an object with a questions list."] };
  }
  const object = raw as { file?: unknown; questions: unknown[]; orphans?: unknown };
  if (object.file !== name) problems.push(`The expected file says it is for "${String(object.file)}", not "${name}".`);
  if (object.orphans !== undefined) problems.push(`The expected file has an orphans field, which the brief says to leave out.`);
  const questions: ExpectedQuestion[] = [];
  object.questions.forEach((q, i) => {
    const at = `question ${i + 1}`;
    const x = q as Record<string, unknown>;
    if (typeof q !== "object" || q === null || !TYPES.includes(x["type"] as string)) return void problems.push(`${at}: the type "${String(x?.["type"])}" is not one of ${TYPES.join(", ")}.`);
    if (typeof x["stem"] !== "string" || norm(x["stem"]) === "") return void problems.push(`${at}: it has no stem.`);
    const type = x["type"] as string;
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && norm(s) !== "");
    const failed = x["verdict"] === "failed";
    if ((type === "multipleChoice" || type === "multipleResponse")) {
      if (!strings(x["options"]) || (x["options"] as string[]).length < 2) return void problems.push(`${at}: ${type} needs a list of at least two options.`);
      const count = (x["options"] as string[]).length;
      if (!failed) {
        const c = x["correct"];
        if (!Array.isArray(c) || c.length === 0 || !c.every((n) => Number.isInteger(n) && n >= 0 && n < count)) return void problems.push(`${at}: correct has to be a list of positions in options.`);
        if (type === "multipleChoice" && c.length !== 1) return void problems.push(`${at}: a multipleChoice question has one correct option; a question with two marked is failed.`);
        if (type === "multipleResponse" && c.length < 2) return void problems.push(`${at}: a multipleResponse question has at least two correct options.`);
      }
    }
    if (type === "trueFalse") {
      if (typeof x["correctBoolean"] !== "boolean") return void problems.push(`${at}: a trueFalse question needs correctBoolean.`);
      if (!TF_FORMS.includes(x["form"] as string)) return void problems.push(`${at}: a trueFalse question needs "form": one of ${TF_FORMS.join(", ")}.`);
    }
    if ((type === "fillInBlank" || type === "shortAnswer") && !strings(x["accepted"])) return void problems.push(`${at}: ${type} needs a list of accepted answers.`);
    if (type === "matching" && !(strings(x["pairs"]) && (x["pairs"] as string[]).length >= 2 && (x["pairs"] as string[]).every((p) => p.includes(" = ")))) {
      return void problems.push(`${at}: matching needs pairs written "left = right".`);
    }
    questions.push(q as ExpectedQuestion);
  });
  return { questions, problems };
}

// ---------------------------------------------------------------------------
// Checking one file
// ---------------------------------------------------------------------------

const BEGIN_PREFIX: Record<string, RegExp> = {
  B1: /^\s*\d{1,3}\.\s*$/,
  B2: /^\s*\d{1,3}\)\s*$/,
  B3: /^\s*\(\d{1,3}\)\s*$/,
  B4: /^\s*Q\s?\d{1,3}\.\s*$/,
  B5: /^\s*Question\s+\d{1,3}\s*:\s*$/i,
  B7: /^\s*\d{1,2}\.\d{1,3}[.)]?\s*$/,
};

const OPTION_LABEL: Record<string, RegExp> = {
  O1: /^[A-Z]\.$/,
  O2: /^[A-Z]\)$/,
  O3: /^\([A-Z]\)$/,
  O4: /^[a-z]\.$/,
  O5: /^[A-Z]:$/,
  O7: /^[A-Z]\.$/,
};

/** The share of questions, or of options, that must look as assigned. The rest are the lapses. */
const SHARE = 0.7;

export interface FileCheck {
  problems: string[];
  /** Things that were checked and found as assigned, for the report. */
  facts: string[];
  stems: string[];
}

export interface CheckLimits {
  minQuestions: number;
  maxQuestions: number;
  minChoice: number;
}

export const LIMITS: CheckLimits = { minQuestions: 12, maxQuestions: 30, minChoice: 8 };

const short = (s: string): string => (norm(s).length > 48 ? `${norm(s).slice(0, 45)}...` : norm(s));

export function checkFile(entry: PlanEntry, doc: Doc, expectedRaw: unknown, limits: CheckLimits = LIMITS): FileCheck {
  const { questions, problems: shape } = validateExpected(expectedRaw, `${entry.name}.docx`);
  const problems = [...shape];
  const facts: string[] = [];
  const stems = questions.map((q) => q.stem);
  if (shape.length > 0) return { problems, facts, stems };

  if (questions.length < limits.minQuestions || questions.length > limits.maxQuestions) {
    problems.push(`It has ${questions.length} questions; ${limits.minQuestions} to ${limits.maxQuestions} were asked for.`);
  }
  const choice = questions.filter((q) => q.type === "multipleChoice").length;
  if (choice < limits.minChoice) problems.push(`Only ${choice} questions are single-answer multiple choice; at least ${limits.minChoice} were asked for.`);
  const wantedTypes: Record<string, string[]> = {
    TFo: ["trueFalse"], TFp: ["trueFalse"], TFa: ["trueFalse"], FIB: ["fillInBlank"], SA: ["shortAnswer"], ESS: ["essay"],
    MR: ["multipleResponse"], MTt: ["matching"], MTl: ["matching"],
  };
  for (const extra of entry.extras) {
    const forms = extra === "TFo" ? "options" : extra === "TFp" ? "inline" : extra === "TFa" ? "answerLine" : undefined;
    const have = questions.filter((q) => (wantedTypes[extra] as string[]).includes(q.type) && (forms === undefined || q.form === forms)).length;
    if (have === 0) problems.push(`It was asked to include ${extra}, and the expected file has no such question.`);
  }

  const folded = doc.lines.map((l) => fold(l.text));
  const marked = entry.mark;

  // --- pass one: where each question's stem is -------------------------------------------------------
  interface Located {
    index: number;
    q: ExpectedQuestion;
    start: Pos;
    end: Pos;
  }
  const located: Located[] = [];
  let cursor: Pos = { line: 0, col: 0 };
  questions.forEach((q, index) => {
    const found = findText(folded, cursor, norm(q.stem));
    if (!found) {
      problems.push(`question ${index + 1}: the stem "${short(q.stem)}" is not in the document after question ${index} (missing, reworded, or out of order).`);
      return;
    }
    located.push({ index, q, start: found.start, end: found.end });
    cursor = found.end;
  });

  const nextStart = (k: number): number => (located[k + 1] ? (located[k + 1] as Located).start.line : doc.lines.length);

  // --- how questions begin ----------------------------------------------------------------------------
  let beginOk = 0;
  const labels: Array<string | undefined> = [];
  located.forEach((l) => {
    const line = doc.lines[l.start.line] as Line;
    const prefix = line.text.slice(0, l.start.col);
    // A key that goes by number goes by the number the file shows, or by the place in the file when there is none.
    labels[l.index] = /(\d{1,2}(?:\.\d{1,3})?)/.exec(prefix)?.[1] ?? (entry.begin === "B6" || entry.begin === "B8" ? String(l.index + 1) : undefined);
    const blankBefore = l.start.line === 0 || (doc.lines[l.start.line - 1] as Line).text.trim() === "";
    const ok =
      entry.begin === "B6" ? line.list === "number" && prefix.trim() === ""
      : entry.begin === "B8" ? prefix.trim() === "" && line.list === undefined && blankBefore
      : (BEGIN_PREFIX[entry.begin] as RegExp).test(prefix);
    if (ok) beginOk++;
  });
  if (located.length > 0) {
    const share = beginOk / located.length;
    if (share < SHARE) problems.push(`Questions were to begin as ${entry.begin}, and only ${beginOk} of ${located.length} do.`);
    else facts.push(`${beginOk} of ${located.length} questions begin as ${entry.begin}`);
  }

  // --- pass two: options, marks and the other types -----------------------------------------------------
  interface Group {
    index: number;
    q: ExpectedQuestion;
    placed: Placed[];
    last: number;
    stem: Located;
  }
  const groups: Group[] = [];
  const marksOf = new Map<number, Set<number>>();
  let optionsSeen = 0;
  let optionsLabelled = 0;
  let multiPerLine = 0;
  let withOptions = 0;

  located.forEach((l, k) => {
    const n = l.index + 1;
    const q = l.q;
    const limit = nextStart(k);
    const wantsOptions = q.type === "multipleChoice" || q.type === "multipleResponse" || (q.type === "trueFalse" && q.form === "options");
    if (!wantsOptions) return;

    const texts = q.type === "trueFalse" ? undefined : (q.options as string[]).map(norm);
    let placed: Placed[] = [];
    if (texts) {
      let at = l.end;
      for (let j = 0; j < texts.length; j++) {
        const p = placeOption(doc, folded, at, limit, texts[j] as string);
        if (!p) {
          problems.push(`question ${n}: option ${j + 1} "${short(texts[j] as string)}" is not under its stem.`);
          return;
        }
        placed.push(p);
        at = p.end;
      }
    } else {
      for (const order of [["True", "False"], ["False", "True"]]) {
        const tries: Placed[] = [];
        let at = l.end;
        for (const word of order) {
          const p = placeOption(doc, folded, at, limit, word as string);
          if (!p) break;
          tries.push(p);
          at = p.end;
        }
        if (tries.length === 2) {
          placed = tries;
          break;
        }
      }
      if (placed.length !== 2) {
        problems.push(`question ${n}: the True and False options are not under the statement.`);
        return;
      }
    }
    withOptions++;
    for (const p of placed) {
      optionsSeen++;
      const label = p.labelText.replace(/\*/g, "").trim();
      const line = doc.lines[p.line] as Line;
      const fits =
        entry.options === "O6" ? label === "" && line.list === undefined
        : entry.options === "O8" ? line.list === "bullet" || /^[•·▪○\-–]/.test(p.lead.trim())
        : (OPTION_LABEL[entry.options] as RegExp).test(label);
      if (fits) optionsLabelled++;
    }
    if (entry.options === "O7" && new Set(placed.map((p) => p.line)).size < placed.length) multiPerLine++;
    const lines = placed.map((p) => p.line);
    groups.push({ index: l.index, q, placed, last: Math.max(l.end.line, ...lines), stem: l });
  });

  if (optionsSeen > 0) {
    const share = optionsLabelled / optionsSeen;
    if (share < SHARE) problems.push(`Options were to be labelled as ${entry.options}, and only ${optionsLabelled} of ${optionsSeen} are.`);
    else facts.push(`${optionsLabelled} of ${optionsSeen} options are labelled as ${entry.options}`);
  }
  if (entry.options === "O7" && withOptions > 0 && multiPerLine / withOptions < 0.5) {
    problems.push(`Several options were to share a paragraph, and that is so for only ${multiPerLine} of ${withOptions} questions.`);
  }

  // The rest of the content: answers, accepted answers, pairs. Each has to be there, and be the one said.
  let contentEnd = 0;
  located.forEach((l, k) => {
    const n = l.index + 1;
    const q = l.q;
    const limit = nextStart(k);
    const lines = doc.lines.slice(l.end.line, limit);
    let last = l.end.line;
    const group = groups.find((g) => g.index === l.index);
    if (group) last = Math.max(last, group.last);

    if (q.type === "fillInBlank" || q.type === "shortAnswer") {
      const answer = lines.map((x) => ANSWER_LINE.exec(x.text)).find((m) => m && norm(m[2] as string) === norm((q.accepted as string[])[0] as string));
      if (!answer) problems.push(`question ${n}: no Answer line under "${short(q.stem)}" gives "${short((q.accepted as string[])[0] as string)}".`);
      last = Math.max(last, l.end.line + lines.findIndex((x) => ANSWER_LINE.test(x.text)));
    } else if (q.type === "matching") {
      const tableLines = lines.filter((x) => x.cell);
      for (const pair of q.pairs as string[]) {
        const [left, right] = pair.split(" = ").map(norm) as [string, string];
        const together = entry.extras.includes("MTt")
          ? [...new Set(tableLines.map((x) => `${x.cell?.table}:${x.cell?.row}`))].some((key) => {
              const row = tableLines.filter((x) => `${x.cell?.table}:${x.cell?.row}` === key);
              return row.some((x) => norm(x.text) === left) && row.some((x) => norm(x.text) === right);
            })
          : lines.some((x) => norm(x.text).includes(`${left} = ${right}`));
        if (!together) problems.push(`question ${n}: the pair "${short(left)} = ${short(right)}" is not ${entry.extras.includes("MTt") ? "on one row of a table" : 'on one line as "term = definition"'}.`);
      }
      // The last line of the exercise, so that a key after it is looked for after it.
      lines.forEach((x, at) => {
        if (x.cell ? entry.extras.includes("MTt") : x.text.includes(" = ")) last = Math.max(last, l.end.line + at);
      });
    } else if (q.type === "trueFalse" && q.form === "inline") {
      const rest = (doc.lines[l.end.line] as Line).text.slice(l.end.col);
      const m = /^\s*[([]\s*([TtFf])\s*[)\]]/.exec(rest);
      if (!m) problems.push(`question ${n}: the statement "${short(q.stem)}" does not end with (T) or (F).`);
      else if ((m[1] as string).toUpperCase() === "T" !== q.correctBoolean) problems.push(`question ${n}: the statement ends with (${m[1]}) but the expected file says ${String(q.correctBoolean)}.`);
    } else if (q.type === "trueFalse" && q.form === "answerLine") {
      const m = lines.map((x) => ANSWER_LINE.exec(x.text)).find((x) => x !== null && /^(true|false|t|f)\.?$/i.test(x[2] as string));
      if (!m) problems.push(`question ${n}: no Answer: True or Answer: False line under "${short(q.stem)}".`);
      else if (/^t/i.test(m[2] as string) !== q.correctBoolean) problems.push(`question ${n}: the file says ${m[2]} but the expected file says ${String(q.correctBoolean)}.`);
      last = Math.max(last, l.end.line + lines.findIndex((x) => ANSWER_LINE.test(x.text)));
    }
    contentEnd = Math.max(contentEnd, last);
  });

  // --- the marks ----------------------------------------------------------------------------------------
  const keyFrom = contentEnd + 1;
  const keyByLabel = new Map<string, string[]>();
  if (marked === "K9") {
    for (const line of doc.lines.slice(keyFrom)) {
      if (line.cell) continue;
      for (const m of line.text.matchAll(/(\d{1,2}(?:\.\d{1,3})?)\s*[.):\-]\s*([A-Za-z](?:\s*(?:,|&|\/|\band\b)\s*[A-Za-z])*)(?![A-Za-z0-9])/g)) {
        const letters = parseLetters(m[2] as string);
        if (letters) keyByLabel.set(m[1] as string, letters);
      }
    }
  } else if (marked === "K10") {
    const rows = new Map<string, string[]>();
    for (const line of doc.lines.slice(keyFrom)) {
      if (!line.cell) continue;
      const key = `${line.cell.table}:${line.cell.row}`;
      const cells = rows.get(key) ?? [];
      cells[line.cell.col] = `${cells[line.cell.col] ?? ""} ${line.text}`.trim();
      rows.set(key, cells);
    }
    for (const cells of rows.values()) {
      const label = /^\s*(\d{1,2}(?:\.\d{1,3})?)\s*[.):]?\s*$/.exec(cells[0] ?? "")?.[1];
      const letters = parseLetters(cells[1] ?? "");
      if (label !== undefined && letters) keyByLabel.set(label, letters);
    }
  }
  if ((marked === "K9" || marked === "K10") && keyByLabel.size === 0) {
    problems.push(`The answers were to be in a ${marked === "K9" ? "list" : "table"} at the end, after the last question, and none was found there.`);
  }

  let marksFound = 0;
  let marksChecked = 0;
  const wordsUsed: string[] = [];
  for (const g of groups) {
    const n = g.index + 1;
    const q = g.q;
    const lettered = g.placed.every((p) => p.letter !== undefined);
    const indexOfLetters = (letters: string[]): Set<number> | undefined => {
      const out = new Set<number>();
      for (const L of letters) {
        const at = g.placed.findIndex((p) => p.letter === L);
        if (at === -1) return undefined;
        out.add(at);
      }
      return out;
    };
    let marks: Set<number> | undefined;
    const optionLines = g.placed.map((p) => doc.lines[p.line] as Line);
    const share = (key: "bold" | "underline" | "highlight" | "colour"): Set<number> =>
      new Set(g.placed.flatMap((p, j) => (markedShare(optionLines[j] as Line, p.col, p.end.line === p.line ? p.end.col : (optionLines[j] as Line).text.length, key) >= 0.9 ? [j] : [])));

    switch (marked) {
      case "K1": marks = new Set(g.placed.flatMap((p, j) => (p.lead.includes("*") ? [j] : []))); break;
      case "K2": marks = new Set(g.placed.flatMap((p, j) => (/^\s*\*/.test(p.rest) ? [j] : []))); break;
      case "K3": marks = share("bold"); break;
      case "K4": marks = share("underline"); break;
      case "K5": marks = share("highlight"); break;
      case "K6": marks = share("colour"); break;
      case "K7": marks = new Set(g.placed.flatMap((p, j) => (/^\s*[([]\s*correct\s*[)\]]|^\s*[✓✔]/i.test(p.rest) ? [j] : []))); break;
      case "K8": {
        const from = g.last + 1;
        const next = (located[located.findIndex((x) => x.index === g.index) + 1]?.start.line ?? doc.lines.length);
        const found = doc.lines.slice(from, next).map((x) => ANSWER_LINE.exec(x.text)).find((m) => m !== null);
        if (found) {
          wordsUsed.push(found[1] as string);
          const letters = parseLetters(found[2] as string);
          marks = letters && lettered ? indexOfLetters(letters) : undefined;
          if (!marks) problems.push(`question ${n}: the Answer line "${short(found[0])}" does not name options that have letters.`);
        } else marks = new Set();
        break;
      }
      case "K11": {
        const lastLine = (doc.lines[Math.max(...g.placed.map((p) => p.line))] as Line).text;
        const m = /(?:^|\s)(Answer|ANS|Correct|Ans)\s*[:.]\s*([A-Za-z](?:\s*(?:,|&|\/|\band\b)\s*[A-Za-z])*)\s*$/.exec(lastLine.trimEnd());
        if (m) {
          wordsUsed.push(m[1] as string);
          const letters = parseLetters(m[2] as string);
          marks = letters && lettered ? indexOfLetters(letters) : undefined;
          if (!marks) problems.push(`question ${n}: the answer at the end of the options does not name options that have letters.`);
        } else marks = new Set();
        break;
      }
      default: {
        const label = labels[g.index];
        const letters = label !== undefined ? keyByLabel.get(label) : undefined;
        if (letters && lettered) marks = indexOfLetters(letters);
        else marks = new Set();
      }
    }
    if (!marks) continue;
    marksOf.set(g.index, marks);

    if (q.verdict === "failed") {
      if (q.type === "multipleChoice" && marks.size === 1) problems.push(`question ${n}: the expected file calls it failed, but the document marks one option.`);
      continue;
    }
    marksChecked++;
    const want = q.type === "trueFalse"
      ? new Set(g.placed.flatMap((p, j) => ((doc.lines[p.line] as Line).text.slice(p.col).toLowerCase().startsWith(q.correctBoolean ? "true" : "false") ? [j] : [])))
      : new Set(q.correct);
    const same = marks.size === want.size && [...marks].every((j) => want.has(j));
    if (same) marksFound++;
    else {
      const name = (set: Set<number>): string => [...set].sort((a, b) => a - b).map((j) => (g.placed[j]?.letter ?? String(j + 1))).join(", ") || "nothing";
      problems.push(`question ${n}: the document marks ${name(marks)} (by ${marked}), but the expected file says ${name(want)}.`);
    }
  }
  if (marksChecked > 0) facts.push(`${marksFound} of ${marksChecked} keys read from the document by ${marked} agree with the expected file`);
  if ((marked === "K8" || marked === "K11") && entry.word) {
    const wrong = wordsUsed.filter((w) => w !== entry.word).length;
    if (wordsUsed.length > 0 && wrong / wordsUsed.length > 1 - SHARE) problems.push(`The answer was to be introduced by "${entry.word}:", and ${wrong} of ${wordsUsed.length} use another word.`);
  }

  // --- the hard case it was assigned ----------------------------------------------------------------------
  const all = questions.flatMap((q) => [q.stem, ...(q.options ?? [])]);
  const trap = entry.trap;
  const failedQuestions = questions.map((q, i) => ({ q, i })).filter((x) => x.q.verdict === "failed" && x.q.type === "multipleChoice");
  const trapProblem =
    trap === "T0" ? (questions.some((q) => q.verdict === "failed") ? `A clean file was asked for, and the expected file has a failed question.` : undefined)
    : trap === "T1" ? (questions.some((q) => /(?:^|\s)1[.)]\s.*\s2[.)]\s/s.test(norm(q.stem))) ? undefined : `T1: no stem has a numbered list (1. 2. ...) inside it.`)
    : trap === "T2" ? (questions.some((q) => (q.options ?? []).some((o) => /^[A-Za-z][.)]\s|^\d+[.)]?\s/.test(norm(o)))) ? undefined : `T2: no option begins with a letter and a full stop, or a number, in its own words.`)
    : trap === "T3" ? (all.some((s) => /Answer\s*:|\*/.test(s)) ? undefined : `T3: no stem or option contains "Answer:" or an asterisk in its words.`)
    : trap === "T4" ? (located.some((l) => (doc.lines[l.start.line] as Line).para !== (doc.lines[l.end.line] as Line).para) ? undefined : `T4: no stem runs over two paragraphs.`)
    : trap === "T5" ? (doc.paragraphsWithBreaks > 0 ? undefined : `T5: no paragraph has a line break inside it with text on both sides.`)
    : trap === "T6" ? (failedQuestions.some((x) => marksOf.get(x.i)?.size === 0) ? undefined : `T6: no multiple choice question is both failed in the expected file and unmarked in the document.`)
    : failedQuestions.some((x) => (marksOf.get(x.i)?.size ?? 0) >= 2) ? undefined : `T7: no multiple choice question is both failed in the expected file and marked twice in the document.`;
  if (trapProblem) problems.push(trapProblem);
  else facts.push(`${trap} is there`);

  if (doc.lines.length < questions.length * 2) problems.push(`The document is too short for ${questions.length} questions with options.`);
  return { problems, facts, stems };
}

// ---------------------------------------------------------------------------
// A folder of files
// ---------------------------------------------------------------------------

export interface BatchReport {
  files: Array<{ name: string; problems: string[]; facts: string[] }>;
  problems: string[];
  checked: number;
}

/** Letters and digits only, so that case and punctuation cannot hide a repeat, and a different number cannot make one. */
const stemKey = (s: string): string => norm(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export function checkFolder(folder: string, pieces?: number[], plan: readonly PlanEntry[] = PLAN, limits: CheckLimits = LIMITS): BatchReport {
  const wanted = plan.filter((e) => pieces === undefined || pieces.includes(e.piece));
  const report: BatchReport = { files: [], problems: [], checked: 0 };
  const seen = new Map<string, string>();
  const present = new Set(readdirSync(folder));

  for (const entry of wanted) {
    const docxName = `${entry.name}.docx`;
    const result = { name: docxName, problems: [] as string[], facts: [] as string[] };
    report.files.push(result);
    if (!present.has(docxName) || !present.has(`${docxName}.expected.json`)) {
      result.problems.push(`${!present.has(docxName) ? docxName : `${docxName}.expected.json`} is missing.`);
      continue;
    }
    let doc: Doc;
    let expected: unknown;
    try {
      doc = readDocx(new Uint8Array(readFileSync(join(folder, docxName))));
    } catch (error) {
      result.problems.push(`It could not be read as a Word document: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      expected = JSON.parse(readFileSync(join(folder, `${docxName}.expected.json`), "utf8"));
    } catch (error) {
      result.problems.push(`The expected file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    report.checked++;
    const checked = checkFile(entry, doc, expected, limits);
    result.problems.push(...checked.problems);
    result.facts.push(...checked.facts);
    for (const stem of checked.stems) {
      const key = stemKey(stem);
      const other = seen.get(key);
      if (other !== undefined && other !== docxName) result.problems.push(`The stem "${short(stem)}" is also in ${other}.`);
      else seen.set(key, docxName);
    }
  }
  const planned = new Set(plan.flatMap((e) => [`${e.name}.docx`, `${e.name}.docx.expected.json`]));
  for (const name of present) {
    if (/^c-\d+/.test(name) && !planned.has(name)) report.problems.push(`${name} is not a file in the plan.`);
  }
  return report;
}

export function print(report: BatchReport): number {
  let total = report.problems.length;
  for (const file of report.files) {
    if (file.problems.length === 0) console.log(`ok       ${file.name}   ${file.facts.join("; ")}`);
    else {
      console.log(`FAILED   ${file.name}`);
      for (const p of file.problems.slice(0, 14)) console.log(`           ${p}`);
      if (file.problems.length > 14) console.log(`           ... and ${file.problems.length - 14} more`);
      total += file.problems.length;
    }
  }
  for (const p of report.problems) console.log(`FAILED   ${p}`);
  console.log("");
  console.log(total === 0 ? `PASSED: ${report.checked} files are what was asked for.` : `FAILED: ${total} problems. Send the list back to the model that wrote the files; do not run the importer on them yet.`);
  console.log("");
  console.log("Not checked: that the questions are good or read like a real instructor's; the keys of fill in the blank, short answer and");
  console.log("matching beyond the Answer line and the pair being in the document; that the lapses asked for are there; and the formatting");
  console.log("of anything but the options. Read three files yourself.");
  return total;
}

// ---------------------------------------------------------------------------
// The brief and the command line
// ---------------------------------------------------------------------------

function briefText(): string {
  const path = new URL("../../../../docs/synthetic-bank-spec.md", import.meta.url);
  const spec = readFileSync(path, "utf8");
  const start = spec.indexOf("<!-- brief:start -->");
  const end = spec.indexOf("<!-- brief:end -->");
  if (start === -1 || end === -1) throw new Error("docs/synthetic-bank-spec.md has no brief markers.");
  return spec.slice(start + "<!-- brief:start -->".length, end).trim();
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "plan") {
    for (const e of PLAN) console.log(`${e.name}  piece ${e.piece}${BLIND_PIECES.includes(e.piece) ? " (blind)" : " (may be fitted)"}  ${e.begin} ${e.options} ${e.mark}${e.word ? `:${e.word}` : ""}  ${e.extras.join("+")}  ${e.trap}  ${e.questions}q  ${e.subject}`);
    return 0;
  }
  if (command === "prompt") {
    const piece = Number(rest[0]);
    if (!PIECES.includes(piece)) {
      console.error(`Give a piece number: ${PIECES.join(", ")}.`);
      return 2;
    }
    console.log(briefText());
    console.log("\n---\n");
    console.log(pieceText(piece));
    return 0;
  }
  if (command === "check") {
    const folder = rest[0];
    if (!folder || !existsSync(folder)) {
      console.error("Give the folder that holds the files.");
      return 2;
    }
    const at = rest.indexOf("--piece");
    const pieces = at === -1 ? undefined : rest.slice(at + 1).map(Number).filter((n) => PIECES.includes(n));
    return print(checkFolder(folder, pieces)) === 0 ? 0 : 1;
  }
  console.error("check <folder> [--piece N ...]  |  prompt <piece>  |  plan");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
