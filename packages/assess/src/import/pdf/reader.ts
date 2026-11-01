/**
 * A PDF as pages of lines of text, and what had to be said about reading it.
 *
 * This is the whole of reading a PDF for its words: open it, read each page's content for runs of text, make lines of them, and
 * take away what is on every page and is not part of the text (a running title, a page number). Nothing about questions is in
 * it. A page that cannot be read is said, with its number, and the others are read; a PDF with no text at all (a scan) is
 * refused with the reason and the way round, since there is nothing here that could be made into a question without guessing.
 */

import { PICTURE_MARK, readPageRuns } from "./content.ts";
import { PdfDocument } from "./document.ts";
import { layoutLines, type PdfLine } from "./layout.ts";
import { LABEL_START } from "./paragraphs.ts";
import { PdfError, type PdfObject } from "./objects.ts";
import type { PdfFont } from "./fonts.ts";

export interface PdfPageText {
  number: number;
  /** The page's own height, which is what "near the top or bottom" is measured against. */
  height: number;
  lines: PdfLine[];
}

export interface PdfNote {
  severity: "info" | "warn";
  message: string;
}

export interface PdfText {
  pages: PdfPageText[];
  notes: PdfNote[];
}

/** A piece of a line this long (in characters) is prose, not a cell of a table; and this many such lines make a page of columns. */
const LONG_PART = 25;
const COLUMN_LINES = 3;

const quote = (text: string): string => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

/** What a line says with its numbers taken out, so that "479 Instructor's Manual" and "481 Instructor's Manual" are the same line. */
const shape = (text: string): string => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** A page number on its own: digits, or a Roman numeral, with nothing else but punctuation round it. */
const PAGE_NUMBER = /^\W*(?:\d{1,4}|[ivxlc]{1,6})\W*$/i;

/**
 * Takes the running titles and page numbers off the pages. A line at the very top or bottom of a page is one if it is only a page
 * number, or if the same line (numbers aside) is at the edge of another page. A line that begins like a question or an option is
 * never one: the last option of two different pages can read the same, and it is not furniture. Every line taken away is counted
 * and the first is quoted, so that it is said, not lost.
 */
function removeFurniture(pages: PdfPageText[]): PdfNote[] {
  const edgeCount = new Map<string, number>();
  const edges = (page: PdfPageText): { top: PdfLine[]; bottom: PdfLine[] } => {
    const h = page.height;
    return {
      top: page.lines.slice(0, 3).filter((l) => l.y > 0.88 * h),
      bottom: page.lines.slice(-3).filter((l) => l.y < 0.12 * h),
    };
  };
  for (const page of pages) {
    const { top, bottom } = edges(page);
    const keys = new Set([...top, ...bottom].filter((l) => !LABEL_START.test(l.text)).map((l) => shape(l.text)));
    for (const k of keys) edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  }
  const removed: string[] = [];
  const isFurniture = (l: PdfLine): boolean => !LABEL_START.test(l.text) && (PAGE_NUMBER.test(l.text) || (edgeCount.get(shape(l.text)) ?? 0) >= 2);
  for (const page of pages) {
    // Peel from each edge while the line there is furniture, up to three lines deep.
    for (let k = 0; k < 3; k++) {
      const last = page.lines[page.lines.length - 1];
      if (last && last.y < 0.12 * page.height && isFurniture(last)) {
        removed.push(page.lines.pop()?.text ?? "");
        continue;
      }
      break;
    }
    for (let k = 0; k < 3; k++) {
      const head = page.lines[0];
      if (head && head.y > 0.88 * page.height && isFurniture(head)) {
        removed.push(page.lines.shift()?.text ?? "");
        continue;
      }
      break;
    }
  }
  if (removed.length === 0) return [];
  // Two different examples, so that a page number and a running title are both seen, not only whichever came first.
  const examples: string[] = [];
  for (const text of removed) if (examples.length < 2 && !examples.some((e) => shape(e) === shape(text))) examples.push(text);
  return [
    {
      severity: "info",
      message: `${removed.length === 1 ? "One line" : `${removed.length} lines`} at the top or bottom of the pages (page numbers and running titles, such as ${examples.map(quote).join(" and ")}) ${removed.length === 1 ? "was" : "were"} left out.`,
    },
  ];
}

export function readPdfText(bytes: Uint8Array): PdfText {
  const doc = new PdfDocument(bytes);
  const notes: PdfNote[] = doc.notes.map((message) => ({ severity: "warn" as const, message }));
  const fonts = new Map<PdfObject, PdfFont>();
  const pages: PdfPageText[] = [];
  const unreadable: number[] = [];
  const turned: number[] = [];
  const failed: string[] = [];
  const pictures: number[] = [];
  const columns: number[] = [];

  for (const page of doc.pages()) {
    try {
      const runs = readPageRuns(doc, doc.pageContent(page), page.resources, fonts);
      for (const n of runs.notes) notes.push({ severity: "warn", message: `Page ${page.number}: ${n}` });
      const { lines, turned: t } = layoutLines(runs.runs, page.number);
      for (const run of runs.runs) if (run.picture) pictures.push(page.number);
      // Text set in columns is read across, a line of the left column and then a line of the right as one line. A table has a
      // wide gap too, but between short cells; it is long text on both sides of the gap, several times over, that gives it away.
      const across = lines.filter((l) => l.text.split("\t").filter((part) => part.trim().length >= LONG_PART).length >= 2).length;
      if (across >= COLUMN_LINES) columns.push(page.number);
      if (runs.unreadable > 0) unreadable.push(page.number);
      if (t > 0) turned.push(page.number);
      pages.push({ number: page.number, height: page.mediaBox[3] - page.mediaBox[1] || 792, lines: lines.map((l) => ({ ...l, y: l.y - page.mediaBox[1] })) });
    } catch (error) {
      failed.push(`${page.number} (${(error as Error).message})`);
      pages.push({ number: page.number, height: 792, lines: [] });
    }
  }

  if (!pages.some((p) => p.lines.length > 0)) {
    throw new PdfError(
      pages.length === 0
        ? "This PDF has no pages."
        : "This PDF has no text that can be read in it. It is probably a scan, which is a picture of a page and not its words. OpenAssess does not read pictures of text. If you have the original document, bring that in; otherwise a PDF program can recognize the text and save a copy, and that copy can be read.",
    );
  }
  if (failed.length > 0) notes.push({ severity: "warn", message: `${failed.length === 1 ? "A page" : `${failed.length} pages`} could not be read, and what is on ${failed.length === 1 ? "it" : "them"} is not in the result: page ${failed.join("; page ")}.` });
  if (unreadable.length > 0) {
    notes.push({
      severity: "warn",
      message: `Some letters on page${unreadable.length === 1 ? "" : "s"} ${unreadable.join(", ")} could not be read, because the file does not say what its font's characters are. They show as the replacement character.`,
    });
  }
  if (pictures.length > 0) {
    const where = [...new Set(pictures)];
    notes.push({ severity: "warn", message: `${pictures.length === 1 ? "A picture" : `${pictures.length} pictures`} on page${where.length === 1 ? "" : "s"} ${where.join(", ")} cannot be read as text. ${PICTURE_MARK} stands where ${pictures.length === 1 ? "it was" : "each was"}, so a question that depends on one (a figure, a table, an equation) is easy to find.` });
  }
  if (columns.length > 0) {
    notes.push({
      severity: "warn",
      message: `Page${columns.length === 1 ? "" : "s"} ${columns.join(", ")} look${columns.length === 1 ? "s" : ""} as if set in columns. A line of one column and a line of the next were read as one line, so the questions on ${columns.length === 1 ? "it" : "them"} may be mixed together. Check them against the PDF.`,
    });
  }
  if (turned.length > 0) notes.push({ severity: "warn", message: `Text that is turned or upside down on page${turned.length === 1 ? "" : "s"} ${turned.join(", ")} was not read.` });
  notes.push(...removeFurniture(pages));
  return { pages, notes };
}
