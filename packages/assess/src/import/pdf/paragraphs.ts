/**
 * From lines to paragraphs.
 *
 * A page breaks a paragraph wherever the line runs out, so a stem of two sentences is three lines and an option that is long is
 * two. The scanner that reads a question wants the paragraph, as a Word file or a text file gives it. A line is the start of a
 * new paragraph if it begins with a label (a question number, an option letter, the word Answer), or if the space above it is
 * more than a line's worth; otherwise it goes on from the line above, across a page too.
 *
 * A bigger gap than a paragraph's usual is a blank line in the text, which is how the scanner is told that a question is over,
 * so the paragraphs are given the blank lines the page shows, except above an option, which sits under its stem on purpose.
 *
 * A word broken at the end of a line has a hyphen there, and it cannot be told from a hyphen that belongs to the word ("self-"
 * and "concept") by looking at the page: a typesetter sets both the same way. So the hyphen is kept, with no space after it,
 * unless the document spells the word whole somewhere else and never with the hyphen. A word that was broken is then shown
 * broken ("writ-ten"), where it can be seen and mended, and is never run together into a different word.
 */

import { PICTURE_MARK } from "./content.ts";
import type { PdfLine } from "./layout.ts";

/**
 * What starts a paragraph whatever the spacing: a question number, an option letter, or a word that a key or a field starts with.
 * The words are only labels with a capital at the front and a colon after, because a line that wraps may begin with "reference:"
 * and must not be taken for something new.
 */
export const LABEL_START =
  /^\s*(?:\*\s*)?(?:(?:\(?\d{1,4}\s*[.)]{1,2}|\(?[A-Za-z]\s*[.)]|[A-Za-z]{1,2}\)|Q\.?\s*\d+|Questions?\s+\d+)(?:\s|$|\t)|(?:Answers?|ANSWERS?|Ans|ANS|Key|KEY|Correct|CORRECT|Type|TYPE|Title|TITLE|Points?|POINTS?|Feedback|Rationale|Explanation|Difficulty|Objective|Matching)\b\s*[:.\-])/;

/** An option's letter: (*)a. or a) or (a), up to h. */
const OPTION_LABEL = /^\s*(?:\*\s*)?\(?[a-hA-H]\s*[.)]\s/;

export interface Paragraph {
  page: number;
  text: string;
}

/** A gap bigger than this many letter heights, from the line above, is the end of a paragraph even with no label. */
const PARAGRAPH_GAP = 1.45;
/** A gap bigger than this many times the usual line spacing is a blank line. */
const BLANK_GAP = 1.4;
/**
 * A line that fills its width runs on into the next one, however far apart a list is spaced; a gap up to this many letter heights
 * is still the same paragraph after one. A line that stops short of the right margin is the end of its paragraph.
 */
const WRAPPED_GAP = 2.3;
/** How far short of the right margin, in letter heights, a line may stop and still be a full one. */
const FULL_LINE = 2.5;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

const WORD = /[A-Za-zÀ-ɏ]+(?:-[A-Za-zÀ-ɏ]+)*/g;

/** Every word the document spells whole, lower case, not counting the pieces of words that a line break cut in two. */
function vocabularyOf(pages: ReadonlyArray<{ lines: readonly PdfLine[] }>): Set<string> {
  const vocab = new Set<string>();
  for (const p of pages) {
    p.lines.forEach((line, i) => {
      let text = line.text;
      // The last word of a line that ends in a hyphen is half of one, and so is the first of the next.
      // Both patterns begin where a word begins and not at any letter: a line of 80,000 letters, a space and a hyphen took 2 seconds to
      // try from each letter in turn, and 400,000 of them would take a minute.
      if (/-$/.test(text)) text = text.replace(/(?<!\S)\S+$/, " ");
      if (i > 0 && /-$/.test((p.lines[i - 1] as PdfLine).text)) text = text.replace(/^\s*\S+/, " ");
      for (const m of text.matchAll(WORD)) vocab.add(m[0].toLowerCase());
    });
  }
  return vocab;
}

/** What a broken word is joined as: whole, if the document spells it whole and not hyphenated; otherwise with its hyphen kept. */
function joinBroken(before: string, after: string, vocab: ReadonlySet<string>): string {
  const left = /(?<![A-Za-zÀ-ɏ])([A-Za-zÀ-ɏ]+)-$/.exec(before);
  const right = /^([A-Za-zÀ-ɏ]+)/.exec(after);
  if (!left || !right) return `${before} ${after}`;
  const whole = `${left[1]}${right[1]}`.toLowerCase();
  const hyphenated = `${left[1]}-${right[1]}`.toLowerCase();
  if (vocab.has(whole) && !vocab.has(hyphenated)) return `${before.slice(0, -1)}${after}`;
  return `${before}${after}`;
}

export function assembleParagraphs(pages: ReadonlyArray<{ number: number; lines: readonly PdfLine[] }>): { paragraphs: Paragraph[] } {
  // The usual step from one line to the next, over the whole document: what a blank line has to be bigger than.
  const steps: number[] = [];
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const gap = (p.lines[i - 1] as PdfLine).y - (p.lines[i] as PdfLine).y;
      const size = (p.lines[i] as PdfLine).size;
      if (gap > 0 && gap < 2.5 * size) steps.push(gap);
    }
  }
  const usual = median(steps);
  const vocab = vocabularyOf(pages);
  let bodySize = median(pages.flatMap((p) => p.lines.map((l) => l.size)));
  if (!(bodySize > 0)) bodySize = 12;

  const out: Paragraph[] = [];
  let current: Paragraph | undefined;
  let previous: PdfLine | undefined;
  const flush = (): void => {
    if (current) out.push(current);
    current = undefined;
  };

  for (const page of pages) {
    let first = true;
    // The right margin of the page: where the longest lines end (a few stray ones are not it).
    const ends = page.lines.map((l) => l.x1).sort((a, b) => a - b);
    const margin = ends.length > 0 ? (ends[Math.floor(ends.length * 0.9)] as number) : 0;
    for (const line of page.lines) {
      const label = LABEL_START.test(line.text);
      const gap = previous && !first ? previous.y - line.y : 0;
      const bigLetters = line.size >= 1.2 * bodySize;
      const bold = line.segments.length > 0 && line.segments.every((s) => s.bold) && line.text.length <= 60 && !label;
      const heading = bigLetters || (bold && (first || gap >= PARAGRAPH_GAP * line.size));
      const previousWasHeading = previous !== undefined && previous.size >= 1.2 * bodySize;
      const isPicture = line.text === PICTURE_MARK;
      const previousWasPicture = previous?.text === PICTURE_MARK;
      const fullAbove = previous !== undefined && previous.x1 >= margin - FULL_LINE * previous.size && previous.text !== PICTURE_MARK;
      const apart = !first && gap > (fullAbove ? WRAPPED_GAP : PARAGRAPH_GAP) * line.size;
      const startsParagraph = current === undefined || label || heading || previousWasHeading || isPicture || previousWasPicture || apart;

      if (startsParagraph) {
        // An option sits under its stem with more room above it than between two options, and it is still the stem's: only
        // what is not an option can be set apart from what came before by a blank line.
        // A picture is set apart on both sides, so that it is never read as the end of an option or the start of a stem.
        const spaced = current !== undefined && !first && usual > 0 && gap > BLANK_GAP * usual && !OPTION_LABEL.test(line.text);
        const blank = current !== undefined && (spaced || isPicture || previousWasPicture);
        flush();
        if (blank) out.push({ page: page.number, text: "" });
        current = { page: page.number, text: line.text };
      } else if (current) {
        current.text = joinBroken(current.text, line.text, vocab);
      }
      previous = line;
      first = false;
    }
  }
  flush();
  return { paragraphs: out };
}
