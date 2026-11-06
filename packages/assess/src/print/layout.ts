/**
 * Questions laid out to be printed: a student copy and an answer key.
 *
 * This is the one place that decides what a printed test says. It turns questions into a list of blocks (a paragraph with
 * its marker and indent, ruled lines to write on, a page break), and the Word and PDF writers draw those blocks and decide
 * nothing, so the two files cannot disagree about what is on the page.
 *
 * Rules kept here:
 *  - The student copy shows no answer and the key shows only what the bank has. A question with no usable key is printed on
 *    the student copy, and the key says in so many words that no answer is recorded, and the report says so too. No answer is
 *    ever made up to fill a space.
 *  - Matching and ordering questions are shown to the student in a shuffled order, the same order every time for the same
 *    question, never the order of the key, and the key says how each was matched.
 *  - What cannot be printed is said, against the question: a hotspot or a calculated question is left out, and a picture, an
 *    equation or a table in the text is printed as words that say what it was.
 */

import { cleanOmml } from "../import/docx/omml.ts";
import { hasUsableKey } from "../quality/answer-key.ts";
import type { DestinationReport, ReportItem } from "../export/types.ts";
import { buildReport, hasText, plural, TYPE_NAMES } from "../export/text.ts";
import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import { shuffledFor } from "../model/random.ts";
import { escapeHtml, type RichText } from "../model/richtext.ts";
import { readTableHtml, replaceTables } from "../model/table.ts";
import { sniffImage, type ImageInfo } from "../model/image.ts";
import type { MediaRef } from "../model/question.ts";
import { deflateSync } from "node:zlib";
import { decodePng } from "./png.ts";

export const PRINT_ID = "print";
export const PRINT_LABEL = "A printed test (Word or PDF)";

export interface Paper {
  name: "letter" | "a4";
  /** Page size in points. */
  width: number;
  height: number;
  margin: number;
}

export const PAPERS: Record<Paper["name"], Paper> = {
  letter: { name: "letter", width: 612, height: 792, margin: 72 },
  a4: { name: "a4", width: 595.28, height: 841.89, margin: 72 },
};

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  mono?: boolean;
  /** A picture that stands here. The paragraph's text is printed and the picture under it; a run holding one has no text. */
  picture?: PrintedPicture;
  /**
   * An equation that stands here, as Word's own XML for it (`MathRef.omml`). A Word file carries it as an equation; every other
   * reader of the run uses its text, which is the equation written out as `[Equation: LaTeX]`.
   */
  equation?: string;
  /**
   * A table that stands here, in a Word file: a paragraph of one run that holds it is a table of the document. The run's text is the
   * table as lines, a row to a line with the cells between bars, which is what every other reader of the run uses.
   */
  table?: PrintedTable;
}

/** The cells of a table as printed in a Word file: each cell's words (a line break inside a cell is a newline), whether it is a header, and its span. */
export interface PrintedTable {
  rows: Array<Array<{ text: string; header: boolean; colspan: number }>>;
}

/** A table drawn as a table, at the size the page allows: Word files only. A PDF draws a table as lines of text. */
export interface TableBlock {
  kind: "table";
  table: PrintedTable;
  indent: number;
  before: number;
  after: number;
  keepNext?: boolean;
}

/** A picture ready to print: its bytes, what they are, its description, and for a PDF the pixels or JPEG data it is drawn from. */
export interface PrintedPicture {
  file: string;
  bytes: Uint8Array;
  info: ImageInfo;
  alt: string;
  pdf?: PdfImage;
}

export interface PdfImage {
  width: number;
  height: number;
  colorSpace: "DeviceGray" | "DeviceRGB";
  filter: "DCTDecode" | "FlateDecode";
  data: Uint8Array;
}

/** A picture on a page of its own line, at the size it is printed. */
export interface PictureBlock {
  kind: "picture";
  picture: PrintedPicture;
  /** The size on the page, in points. */
  w: number;
  h: number;
  indent: number;
  before: number;
  after: number;
  keepNext?: boolean;
}

export interface Para {
  kind: "para";
  runs: Run[];
  /** Printed at the left of the first line: a number, a letter, a line to write a match on. */
  marker?: string;
  /** Where the text starts, in points from the margin. The marker hangs in the space before it. */
  indent: number;
  /** How far before the text the marker starts, in points. */
  hang?: number;
  size: number;
  align?: "left" | "center";
  before: number;
  after: number;
  /** Stays on the page with the block after it. */
  keepNext?: boolean;
  /** The whole paragraph is bold, as in a heading. */
  bold?: boolean;
  /** A rule under the paragraph, for a heading. */
  rule?: boolean;
}

export type Block = Para | PictureBlock | TableBlock | { kind: "lines"; count: number } | { kind: "pagebreak" };

export interface PrintDocument {
  title: string;
  paper: Paper;
  /** The size of the main text, in points. */
  fontSize: number;
  blocks: Block[];
  /** Printed at the left of the foot of every page, with the page number at the right. */
  footer: string;
  /** Printed at the left of the top of every page: the version of a test that has several. */
  header?: string;
  kind: "student" | "key";
}

export interface PrintOptions {
  title: string;
  kind: "student" | "key";
  paper: Paper["name"];
  instructions?: string;
  nameLine: boolean;
  dateLine: boolean;
  showPoints: boolean;
  shortAnswerLines: number;
  essayLines: number;
  /** On the key only: feedback written for a question, under its answer. */
  includeFeedback: boolean;
  fontSize: number;
  /** The version this copy is of, for a test with several: in the title, and at the top of every page. */
  versionLabel?: string;
  /** On the student copy: says to fill in the version's bubble and to mark the answers on the answer sheet. */
  answerOnSheet?: boolean;
  /** On the key: the right letters in one line, in the order of the sheet, for scoring by hand. */
  keyStrip?: boolean;
  /** The bank's pictures by path (`Bank.media`), so that a picture in a question is printed and not named. Without it every picture is printed as words. */
  media?: ReadonlyMap<string, Uint8Array>;
  /** The file the layout is for, since what a PDF can draw is less than what a Word file can. Set by `printTest`. */
  format?: "docx" | "pdf";
}

export const DEFAULT_OPTIONS: Omit<PrintOptions, "title"> = {
  kind: "student",
  paper: "letter",
  nameLine: true,
  dateLine: true,
  showPoints: true,
  shortAnswerLines: 1,
  essayLines: 8,
  includeFeedback: false,
  fontSize: 11,
};

// The shuffle that is the same every time for the same question now lives in model/random.ts, because test versions need it too.
export { shuffledFor };

// ---------------------------------------------------------------------------
// Rich text as paragraphs
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface Losses {
  pictures: number;
  equations: number;
  tables: number;
  /** Why pictures were printed as words, when the bank's pictures were offered and one could not be drawn. */
  why?: Record<string, number>;
}

/**
 * What a picture or an equation needs to be drawn: the format being made, and for pictures the bank's files and the PDF forms already
 * worked out. A Word file carries an equation as an equation; a PDF has no fonts for one and prints its words.
 */
export interface PictureSource {
  /** The bank's files, when they were offered. Without them every picture is printed as words. */
  media: ReadonlyMap<string, Uint8Array>;
  offered: boolean;
  format: "docx" | "pdf" | undefined;
  /** What each file turned out to be for this format, worked out once: the PDF form to draw, or the reason it cannot be printed. */
  prepared: Map<string, { image?: PdfImage } | { why: string }>;
}

export function pictureSource(options: PrintOptions): PictureSource | undefined {
  if (!options.media && options.format !== "docx") return undefined;
  return { media: options.media ?? new Map(), offered: options.media !== undefined, format: options.format, prepared: new Map() };
}

/** A PNG, JPEG or GIF as the form a PDF draws, or the reason it cannot be: the Word file can hold more than a PDF writer without a decoder. */
function prepareForPdf(bytes: Uint8Array, info: ImageInfo): { image: PdfImage } | { why: string } {
  if (info.mime === "image/jpeg") {
    const components = info.jpeg?.components ?? 3;
    if (components !== 1 && components !== 3) return { why: "a CMYK JPEG cannot be drawn in a PDF here (the Word file can)" };
    return { image: { width: info.width, height: info.height, colorSpace: components === 1 ? "DeviceGray" : "DeviceRGB", filter: "DCTDecode", data: bytes } };
  }
  if (info.mime === "image/png") {
    const decoded = decodePng(bytes);
    if (!decoded.ok) return { why: `a PNG that ${decoded.reason}` };
    const { pixels } = decoded;
    return { image: { width: pixels.width, height: pixels.height, colorSpace: pixels.channels === 1 ? "DeviceGray" : "DeviceRGB", filter: "FlateDecode", data: deflateSync(pixels.data) } };
  }
  return { why: "a GIF cannot be drawn in a PDF here (the Word file can)" };
}

/**
 * A Word file takes a PNG, JPEG or GIF as it is, so the bytes are only checked: a PNG whose data does not decode would show in Word as a
 * broken picture without a word said, and is words with the reason instead. (An interlaced PNG is fine here; only the PDF refuses it.)
 */
function checkForWord(bytes: Uint8Array, info: ImageInfo): { image?: PdfImage } | { why: string } {
  if (info.mime === "image/png") {
    const decoded = decodePng(bytes);
    if (!decoded.ok && !decoded.reason.startsWith("it is interlaced")) return { why: `a PNG that ${decoded.reason}` };
  }
  return {};
}

/** The picture a question's media entry names, ready for the format being made, or why it cannot be printed as one. */
function pictureFor(media: MediaRef, source: PictureSource): { picture: PrintedPicture } | { why: string } {
  const bytes = source.media.get(media.file);
  if (bytes === undefined) return { why: "the bank does not hold its file" };
  const info = sniffImage(bytes);
  if (info === undefined) return { why: "its file is not a PNG, JPEG or GIF" };
  const picture: PrintedPicture = { file: media.file, bytes, info, alt: media.alt.trim() };
  let prepared = source.prepared.get(media.file);
  if (prepared === undefined) {
    prepared = source.format === "pdf" ? prepareForPdf(bytes, info) : checkForWord(bytes, info);
    source.prepared.set(media.file, prepared);
  }
  if ("why" in prepared) return prepared;
  if (prepared.image !== undefined) picture.pdf = prepared.image;
  return { picture };
}

/**
 * Rich text as paragraphs of runs. Bold, italics and underline are kept; a line break is a line break inside the paragraph;
 * a list becomes lines that begin with a bullet or a number; a table becomes a line for each row, the cells between bars;
 * a picture or an equation becomes the words that stand for it, and is counted.
 */
export function paragraphsOf(text: RichText, question: Question, losses: Losses, pictures?: PictureSource, tables = false): Run[][] {
  if (text.format === "plain") {
    return text.content
      .trim()
      .split(/\n{2,}/)
      .filter((p) => p.trim() !== "")
      .map((p) => [{ text: p.replace(/\r\n?/g, "\n") }]);
  }
  const paragraphs: Run[][] = [];
  let current: Run[] = [];
  const style = { bold: 0, italic: 0, underline: 0, mono: 0 };
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let row: string[] | undefined;
  let cell: Run[] | undefined;

  const flush = (): void => {
    if (current.some((r) => r.text.trim() !== "" || r.picture !== undefined)) paragraphs.push(current);
    current = [];
  };
  const add = (value: string): void => {
    if (value === "") return;
    const run: Run = {
      text: value,
      ...(style.bold > 0 ? { bold: true } : {}),
      ...(style.italic > 0 ? { italic: true } : {}),
      ...(style.underline > 0 ? { underline: true } : {}),
      ...(style.mono > 0 ? { mono: true } : {}),
    };
    (cell ?? current).push(run);
  };

  // In a Word file a table of the question is a table. It is set aside before the text is read, so that the rest is read as it always
  // was; a table that cannot be read into rows (one inside another) is left in the text and is lines of text as in a PDF.
  let content = text.content;
  const kept: PrintedTable[] = [];
  if (tables && pictures?.format === "docx") {
    content = replaceTables(content, (html) => {
      const view = readTableHtml(wordsForObjects(html, question, losses));
      if (view.rows.length === 0) return html;
      kept.push({ rows: view.rows.map((r) => r.map((c) => ({ text: c.text, header: c.header, colspan: c.colspan }))) });
      return `<oa-table n="${kept.length - 1}"></oa-table>`;
    });
  }
  const tokens = content.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      add(decode(token.replace(/\s*\n\s*/g, " ")));
      continue;
    }
    const closing = token.startsWith("</");
    const name = (/^<\/?\s*([a-zA-Z0-9-]+)/.exec(token)?.[1] ?? "").toLowerCase();
    switch (name) {
      case "strong":
      case "b":
        style.bold += closing ? -1 : 1;
        break;
      case "em":
      case "i":
        style.italic += closing ? -1 : 1;
        break;
      case "u":
        style.underline += closing ? -1 : 1;
        break;
      case "code":
      case "pre":
        style.mono += closing ? -1 : 1;
        break;
      case "br":
        add("\n");
        break;
      case "p":
      case "blockquote":
        if (closing || current.length > 0) flush();
        break;
      case "ul":
      case "ol":
        flush();
        if (closing) lists.pop();
        else lists.push({ ordered: name === "ol", n: 0 });
        break;
      case "li":
        if (closing) flush();
        else {
          flush();
          const list = lists[lists.length - 1];
          if (list) list.n++;
          add(list?.ordered ? `${list.n}. ` : "• ");
        }
        break;
      case "table":
        if (!closing) losses.tables++;
        flush();
        break;
      case "tr":
        if (closing && row) {
          paragraphs.push([{ text: row.join(" | ") }]);
          row = undefined;
        } else if (!closing) row = [];
        break;
      case "td":
      case "th":
        if (closing && cell && row) {
          row.push(cell.map((r) => r.text).join("").trim());
          cell = undefined;
        } else if (!closing) cell = [];
        break;
      case "oa-table": {
        if (closing) break;
        flush();
        const table = kept[Number(/n="(\d+)"/.exec(token)?.[1])];
        if (table) paragraphs.push([{ text: table.rows.map((r) => r.map((c) => c.text.replace(/\s*\n\s*/g, " ")).join(" | ")).join("\n"), table }]);
        break;
      }
      case "oa-media": {
        if (closing) break;
        const ref = /ref\s*=\s*"([^"]*)"/.exec(token)?.[1];
        const media = question.media.find((m) => m.id === ref);
        // A picture is printed when the bank's files were offered and this one can be drawn in this format, and not inside a table
        // cell, whose text is joined into a line. Otherwise it is words, and counted.
        if (pictures?.offered && media !== undefined && cell === undefined) {
          const choice = pictureFor(media, pictures);
          if ("picture" in choice) {
            current.push({ text: "", picture: choice.picture });
            break;
          }
          const why = (losses.why ??= {});
          why[choice.why] = (why[choice.why] ?? 0) + 1;
        }
        losses.pictures++;
        if (!media?.decorative) add(media && media.alt.trim() !== "" ? `[Picture: ${media.alt.trim()}]` : "[Picture]");
        break;
      }
      case "oa-math": {
        if (closing) break;
        const ref = /ref\s*=\s*"([^"]*)"/.exec(token)?.[1];
        const math = question.math.find((m) => m.id === ref);
        const words = math && math.latex.trim() !== "" ? `[Equation: ${math.latex.trim()}]` : "[Equation]";
        // A Word file takes the equation as Word wrote it, so it is printed as an equation and nothing is lost. Not inside a table
        // cell, whose text is joined into a line; and only an equation that came from Word has Word's copy.
        const kept = pictures?.format === "docx" && math?.omml && cell === undefined ? cleanOmml(math.omml) : undefined;
        if (kept !== undefined) {
          current.push({ text: words, equation: kept });
          break;
        }
        losses.equations++;
        add(words);
        break;
      }
      default:
        break;
    }
  }
  flush();
  return paragraphs;
}

/** A table's markup with each picture and equation in it written as the words that stand for it, and counted, since a cell holds words. */
function wordsForObjects(html: string, question: Question, losses: Losses): string {
  return html
    .replace(/<oa-media\b[^>]*\bref\s*=\s*"([^"]*)"[^>]*>\s*<\/oa-media>/gi, (_whole, ref: string) => {
      const media = question.media.find((m) => m.id === ref);
      if (media?.decorative) return " ";
      losses.pictures++;
      return media && media.alt.trim() !== "" ? ` [Picture: ${escapeHtml(media.alt.trim())}] ` : " [Picture] ";
    })
    .replace(/<oa-math\b[^>]*\bref\s*=\s*"([^"]*)"[^>]*>\s*<\/oa-math>/gi, (_whole, ref: string) => {
      losses.equations++;
      const math = question.math.find((m) => m.id === ref);
      return math && math.latex.trim() !== "" ? ` [Equation: ${escapeHtml(math.latex.trim())}] ` : " [Equation] ";
    });
}

const asText = (paragraphs: Run[][]): string => paragraphs.map((p) => p.map((r) => r.text).join("")).join(" ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

/** Where a question's text starts, which is how its first line is told from the lines under it. */
export const NUMBER_INDENT = 28;
const OPTION_INDENT = 58;

/** The most a picture may be tall on a page, in points. A figure taller than this is scaled down to fit it. */
const MAX_PICTURE_HEIGHT = 288;
/** What a pixel is on paper, in points: a picture is drawn at the size its pixels are at 96 to the inch, and never larger. */
const POINTS_PER_PIXEL = 0.75;

/**
 * A paragraph that holds a picture becomes the paragraph without it and the picture on a line under it. A picture is not placed
 * inside a line of text: two writers (Word and the PDF) would have to agree on where a line breaks around it, and a figure under the
 * words it belongs to is where a figure in a test goes. The words keep their marker, so an option that is only a picture is still
 * a lettered option with its picture under the letter.
 */
function expandPictures(blocks: Block[], paper: Paper): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.kind !== "para" || !block.runs.some((r) => r.picture !== undefined)) {
      out.push(block);
      continue;
    }
    const pictures = block.runs.flatMap((r) => (r.picture ? [r.picture] : []));
    const runs = block.runs.filter((r) => r.picture === undefined);
    const textual = runs.some((r) => r.text.trim() !== "") || block.marker !== undefined;
    if (textual) out.push({ ...block, runs, after: 2 });
    const room = paper.width - 2 * paper.margin - block.indent;
    pictures.forEach((picture, i) => {
      const scale = Math.min(1, room / (picture.info.width * POINTS_PER_PIXEL), MAX_PICTURE_HEIGHT / (picture.info.height * POINTS_PER_PIXEL));
      const last = i === pictures.length - 1;
      out.push({
        kind: "picture",
        picture,
        w: Math.max(1, picture.info.width * POINTS_PER_PIXEL * scale),
        h: Math.max(1, picture.info.height * POINTS_PER_PIXEL * scale),
        indent: block.indent,
        before: textual || i > 0 ? 2 : block.before,
        after: last ? block.after : 2,
      });
    });
  }
  return out;
}

/**
 * A table stands as a block of its own, between the words round it. The paragraph that held it keeps its number (a stem that begins
 * with a table is still question 1) and whatever words came after it, such as the points, go on a line under it.
 */
function expandTables(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.kind !== "para" || !block.runs.some((r) => r.table !== undefined)) {
      out.push(block);
      continue;
    }
    const { marker, ...rest } = block;
    let pending: Run[] = [];
    let first = true;
    const flushText = (): void => {
      const words = pending.some((r) => r.text.trim() !== "");
      if (words || (first && marker !== undefined)) {
        out.push({ ...rest, ...(first && marker !== undefined ? { marker } : {}), runs: pending, ...(first ? {} : { before: 2 }), after: 2 });
        first = false;
      }
      pending = [];
    };
    for (const run of block.runs) {
      if (run.table === undefined) {
        pending.push(run);
        continue;
      }
      flushText();
      out.push({ kind: "table", table: run.table, indent: block.indent, before: first ? block.before : 2, after: 4 });
      first = false;
    }
    flushText();
  }
  return out;
}

interface Built {
  blocks: Block[];
  notes: string[];
}

function para(runs: Run[], more: Partial<Para> & { indent: number }, size: number): Para {
  return { kind: "para", runs, size, before: 0, after: 3, ...more };
}

const has = (text: RichText | undefined): text is RichText => text !== undefined && hasText(text);

function buildQuestion(question: Question, number: number, o: PrintOptions, pictures?: PictureSource): Built | { leftOut: string } {
  const losses: Losses = { pictures: 0, equations: 0, tables: 0 };
  const notes: string[] = [];
  const size = o.fontSize;
  const key = o.kind === "key";
  const body = question.body as unknown as Record<string, unknown>;

  if (question.type === "hotspot" || question.type === "calculated") {
    const name = TYPE_NAMES[question.type];
    return { leftOut: `A ${name} question cannot be printed: it needs a screen.` };
  }

  const stem = paragraphsOf(question.stem, question, losses, pictures, true);
  if (stem.length === 0) return { leftOut: "It has no question text." };

  const usable = hasUsableKey(question);
  const out: Block[] = [];
  const points = o.showPoints ? `  (${question.points} ${question.points === 1 ? "point" : "points"})` : "";
  stem.forEach((runs, i) => {
    const last = i === stem.length - 1;
    out.push(
      para(
        [...runs, ...(last && points !== "" ? [{ text: points, italic: true }] : [])],
        { indent: NUMBER_INDENT, ...(i === 0 ? { marker: `${number}.` } : {}), before: i === 0 ? 10 : 0, keepNext: true },
        size,
      ),
    );
  });

  const option = (marker: string, runs: Run[], more: Partial<Para> = {}): Para => para(runs, { indent: OPTION_INDENT, marker, ...more }, size);
  const note = (text: string, more: Partial<Para> = {}): Para => para([{ text, italic: true }], { indent: NUMBER_INDENT, ...more }, size - 1);
  const keyLine = (label: string, value: string): Para => para([{ text: `${label} `, bold: true }, { text: value }], { indent: NUMBER_INDENT, before: 2 }, size);

  switch (question.type) {
    case "multipleChoice":
    case "multipleResponse": {
      const options = body["options"] as Array<{ content: RichText; correct: boolean }>;
      if (question.type === "multipleResponse") out.push(note("Select all that apply.", { keepNext: true }));
      options.forEach((opt, i) => {
        const runs = paragraphsOf(opt.content, question, losses, pictures).flat();
        const marker = `${String.fromCharCode(65 + (i % 26))}.`;
        if (key && usable && opt.correct) out.push(option(marker, [...runs.map((r) => ({ ...r, bold: true })), { text: "  (correct)", bold: true }]));
        else out.push(option(marker, runs));
      });
      break;
    }
    case "trueFalse": {
      if (!key) out.push(para([{ text: "(   ) True        (   ) False" }], { indent: OPTION_INDENT, before: 2 }, size));
      else if (usable) out.push(keyLine("Answer:", (body["correct"] as boolean) ? "True" : "False"));
      break;
    }
    case "fillInBlank": {
      const blanks = body["blanks"] as Array<{ accepted: string[] }>;
      if (!key) {
        if (!/_{3,}/.test(asText(stem))) out.push(para([{ text: "Answer: ______________________________" }], { indent: NUMBER_INDENT, before: 4 }, size));
      } else if (usable) {
        blanks.forEach((b, i) => out.push(keyLine(blanks.length > 1 ? `Blank ${i + 1}:` : "Accepted:", b.accepted.join("  |  "))));
      }
      break;
    }
    case "shortAnswer": {
      const accepted = body["accepted"] as string[];
      if (!key) out.push({ kind: "lines", count: o.shortAnswerLines });
      else if (usable) out.push(keyLine("Accepted answers:", accepted.join("  |  ")));
      break;
    }
    case "numeric": {
      const numeric = body as { mode: string; value?: number; min?: number; max?: number; tolerance?: number; units?: string };
      const units = numeric.units && numeric.units.trim() !== "" ? ` ${numeric.units.trim()}` : "";
      if (!key) out.push(para([{ text: `Answer: ____________________${units}` }], { indent: NUMBER_INDENT, before: 4 }, size));
      else if (usable) {
        const text =
          numeric.mode === "range"
            ? `${numeric.min} to ${numeric.max}${units}`
            : `${numeric.value}${numeric.mode === "tolerance" && typeof numeric.tolerance === "number" ? ` (give or take ${numeric.tolerance})` : ""}${units}`;
        out.push(keyLine("Answer:", text));
      }
      break;
    }
    case "essay": {
      if (!key) out.push({ kind: "lines", count: o.essayLines });
      else {
        const model = body["modelAnswer"] as RichText | undefined;
        if (has(model)) out.push(keyLine("Model answer:", asText(paragraphsOf(model, question, losses))));
        else out.push(note("Marked by a person; no model answer is recorded."));
      }
      break;
    }
    case "matching": {
      const pairs = body["pairs"] as Array<{ left: RichText; right: string }>;
      const spare = ((body["distractors"] as string[] | undefined) ?? []).filter((d) => d.trim() !== "");
      const rights = shuffledFor([...pairs.map((p) => p.right), ...spare], `${question.id}:matching`);
      const letterOf = new Map<string, number>();
      const taken = new Set<number>();
      pairs.forEach((p) => {
        const at = rights.findIndex((r, i) => r === p.right && !taken.has(i));
        taken.add(at);
        letterOf.set(`${pairs.indexOf(p)}`, at);
      });
      if (!key) {
        out.push(note("Write the letter of the match on the line.", { keepNext: true }));
        pairs.forEach((p, i) => out.push(option("______", [{ text: `${i + 1}. ` }, ...paragraphsOf(p.left, question, losses, pictures).flat()], { indent: OPTION_INDENT + 18, hang: 46, keepNext: true })));
        rights.forEach((r, i) => out.push(option(`${String.fromCharCode(65 + (i % 26))}.`, [{ text: r }], { before: i === 0 ? 4 : 0 })));
      } else if (usable) {
        pairs.forEach((p, i) => {
          const letter = String.fromCharCode(65 + ((letterOf.get(`${i}`) ?? 0) % 26));
          out.push(option(`${i + 1}.`, [...paragraphsOf(p.left, question, losses, pictures).flat(), { text: `  ${letter}. ${p.right}`, bold: true }]));
        });
      }
      break;
    }
    case "ordering": {
      const items = [...(body["items"] as Array<{ content: RichText; position: number }>)].sort((a, b) => a.position - b.position);
      if (!key) {
        out.push(note(`Number the items 1 to ${items.length} in the right order.`, { keepNext: true }));
        for (const item of shuffledFor(items, `${question.id}:ordering`)) out.push(option("____", paragraphsOf(item.content, question, losses, pictures).flat(), { indent: OPTION_INDENT - 8, hang: 36 }));
      } else if (usable) {
        items.forEach((item, i) => out.push(option(`${i + 1}.`, paragraphsOf(item.content, question, losses, pictures).flat())));
      }
      break;
    }
    default:
      return { leftOut: `A ${TYPE_NAMES[question.type]} question cannot be printed.` };
  }

  if (key && !usable && question.type !== "essay") {
    out.push(para([{ text: "No answer is recorded for this question.", bold: true }], { indent: NUMBER_INDENT, before: 2 }, size));
    notes.push("It has no usable answer key, so the answer key says so instead of giving an answer. Nothing was guessed.");
  }

  if (key && o.includeFeedback) {
    for (const [label, text] of [["Feedback:", question.feedback.general], ["If right:", question.feedback.correct], ["If wrong:", question.feedback.incorrect]] as const) {
      if (has(text)) out.push(para([{ text: `${label} `, italic: true, bold: true }, { text: asText(paragraphsOf(text, question, losses)), italic: true }], { indent: NUMBER_INDENT, before: 2 }, size - 1));
    }
  } else if (key && [question.feedback.general, question.feedback.correct, question.feedback.incorrect].some(has)) {
    notes.push("Its feedback is not printed on the key. Tick Feedback to print it.");
  }

  // A picture stands on a line of its own under the words it was in, at the size it is printed.
  out.splice(0, out.length, ...expandPictures(out, PAPERS[o.paper]));
  // A table of the question stands as a table in a Word file, between the words round it.
  out.splice(0, out.length, ...expandTables(out));

  if (!key && question.type !== "essay") {
    // The answer sheet's own spacing: a little room after each question.
    const last = out[out.length - 1];
    if (last && (last.kind === "para" || last.kind === "picture" || last.kind === "table")) last.after = 6;
  }

  // A question stays on one page when it fits on one: every part of it but the last stays with the part after it. Only the
  // wording and a few notes were tied before, so the choices of a question could be split across a page break (A and B at the
  // foot of one page, C and D at the head of the next), which Word did to 20 of 180 questions in a long test. A question taller
  // than a page is still broken, because Word and the PDF writer both give up on a chain that cannot fit. The last part is
  // never tied: a question made of its wording alone (a blank in the text and nothing to write under it) used to be tied to the
  // question after it, and a run of those would have been one chain.
  for (const block of out) if (block.kind === "para" || block.kind === "picture" || block.kind === "table") block.keepNext = true;
  const lastBlock = out.at(-1);
  if (lastBlock?.kind === "para" || lastBlock?.kind === "picture" || lastBlock?.kind === "table") delete lastBlock.keepNext;

  if (losses.pictures > 0) {
    const why = Object.entries(losses.why ?? {}).map(([reason, count]) => `${plural(count, "time", "times")}: ${reason}`);
    notes.push(`${plural(losses.pictures, "picture", "pictures")} cannot be printed${why.length > 0 ? ` (${why.join("; ")})` : ""}. Each is printed as [Picture: its alternative text], so that the question still reads; add it back by hand.`);
  }
  if (losses.equations > 0) notes.push(`${plural(losses.equations, "equation", "equations")} printed as [Equation: LaTeX]. Check how it reads.`);
  if (losses.tables > 0) notes.push(`${plural(losses.tables, "table", "tables")} printed as lines of text, a row to a line with the cells between bars.`);
  return { blocks: out, notes };
}

/**
 * The right answer of a question as the letters a student would mark, for the one-line strip on a key. A dash is a question a
 * bubble sheet cannot carry, and a question mark is one with no usable key: nothing is guessed to fill either.
 */
function stripAnswer(question: Question): string {
  if (!isChoice(question) && !isMultipleResponse(question) && !isTrueFalse(question)) return "-";
  if (!hasUsableKey(question)) return "?";
  if (isTrueFalse(question)) return question.body.correct ? "A" : "B";
  return question.body.options.flatMap((o, i) => (o.correct ? [String.fromCharCode(65 + (i % 26))] : [])).join("");
}

// ---------------------------------------------------------------------------
// The whole test
// ---------------------------------------------------------------------------

export interface Layout {
  document: PrintDocument;
  report: DestinationReport;
}

/** A test laid out, and the check of what it holds: what prints as written, what prints with a note, what cannot print. */
export function layoutTest(questions: readonly Question[], options: PrintOptions): Layout {
  const paper = PAPERS[options.paper];
  const size = options.fontSize;
  const key = options.kind === "key";
  const blocks: Block[] = [];
  const items: ReportItem[] = [];
  const body: Block[] = [];

  let number = 0;
  let total = 0;
  const strip: string[] = [];
  const source = pictureSource(options);
  questions.forEach((question, i) => {
    const base = { position: i + 1, questionId: question.id, title: question.title };
    const built = buildQuestion(question, number + 1, options, source);
    if ("leftOut" in built) {
      items.push({ ...base, outcome: "leftOut", notes: [built.leftOut] });
      return;
    }
    number++;
    total += question.points;
    if (key) strip.push(`${number}-${stripAnswer(question)}`);
    body.push(...built.blocks);
    items.push({ ...base, outcome: built.notes.length > 0 ? "exportedWithLosses" : "exported", notes: built.notes });
  });

  const version = options.versionLabel && options.versionLabel.trim() !== "" ? options.versionLabel.trim() : undefined;
  const heading = [options.title, ...(version ? [`Version ${version}`] : []), ...(key ? ["Answer key"] : [])].join("  ·  ");
  blocks.push({ kind: "para", runs: [{ text: heading }], size: size + 7, bold: true, align: "left", indent: 0, before: 0, after: 6, rule: true });
  const fields: string[] = [];
  if (!key && options.nameLine) fields.push("Name: ______________________________");
  if (!key && options.dateLine) fields.push("Date: ________________");
  if (fields.length > 0) blocks.push({ kind: "para", runs: [{ text: fields.join("        ") }], size, indent: 0, before: 6, after: 6 });
  if (options.instructions && options.instructions.trim() !== "") {
    for (const line of options.instructions.trim().split(/\n{2,}/)) blocks.push({ kind: "para", runs: [{ text: line.trim(), italic: true }], size, indent: 0, before: 0, after: 4 });
  }
  if (options.showPoints && number > 0) blocks.push({ kind: "para", runs: [{ text: `${plural(number, "question", "questions")}, ${total} ${total === 1 ? "point" : "points"} in all.` }], size: size - 1, indent: 0, before: 2, after: 4 });
  if (!key && options.answerOnSheet) {
    const text = version
      ? `Fill in bubble ${version} for your version at the top of your answer sheet, and mark your answers on the sheet, not on this booklet.`
      : "Mark your answers on your answer sheet, not on this booklet.";
    blocks.push({ kind: "para", runs: [{ text, bold: true }], size, indent: 0, before: 2, after: 4 });
  }
  blocks.push(...body);
  if (key && options.keyStrip && strip.length > 0) {
    blocks.push({ kind: "para", runs: [{ text: "Answers in order, for scoring by hand" }], size, bold: true, indent: 0, before: 14, after: 3, keepNext: true });
    // Ten to a line, so that a line can be held against a sheet. A dash on its own is a question a sheet cannot carry, and a question mark is one with no answer recorded.
    for (let at = 0; at < strip.length; at += 10) {
      blocks.push({ kind: "para", runs: [{ text: strip.slice(at, at + 10).join("   "), mono: true }], size: size - 1, indent: 0, before: 0, after: 2 });
    }
  }

  const general = [
    version
      ? `This is Version ${version}. The questions are numbered from 1 in the order this version prints them.`
      : "The questions are printed in the order the bank lists them, numbered from 1. Answers to a matching or an ordering question are shown to students in a shuffled order that is the same every time.",
    key ? "The answer key marks only what the bank records as the answer." : "The student copy shows no answer.",
  ];
  const report = buildReport(PRINT_ID, PRINT_LABEL, questions.length, items, [], general);
  return {
    document: { title: options.title, paper, fontSize: size, blocks, footer: options.title, ...(version ? { header: `Version ${version}` } : {}), kind: options.kind },
    report,
  };
}
