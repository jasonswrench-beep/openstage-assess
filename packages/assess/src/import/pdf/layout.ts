/**
 * From runs of text to lines of text.
 *
 * A PDF puts text on a page piece by piece, and a line of what a person reads may be a dozen pieces: a letter set apart for
 * kerning, a bold word, an option's letter and then its words. A page has no lines in it. They are made here, by the one thing
 * a page does have, which is where each piece is.
 *
 *  - Pieces whose baselines are about the same height are one line, whatever order the file drew them in.
 *  - Along a line, a gap between two pieces is a space if it is wider than a fraction of the letter size, and a tab if it is
 *    several letters wide, which is how a table or a hanging indent shows in a page of text.
 *  - A line keeps where it starts and how large its letters are, because a paragraph, an option and a heading are told apart
 *    by indent, spacing and size, and the reader of the lines needs all three.
 *
 * What this does not do is read columns: a page set in two columns is read across, line by line, and so it comes out wrong.
 * The reader (reader.ts) says when a page looks like that, instead of passing the result off as text.
 */

import type { TextRun } from "./content.ts";

export interface LineSegment {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface PdfLine {
  page: number;
  text: string;
  /** Where the first letter starts, and where the last ends, along the page. */
  x: number;
  x1: number;
  /** The baseline, with the page's own y axis (up). */
  y: number;
  size: number;
  /** Runs of the line's text that share a weight and a slant, for the formatting that marks an answer. */
  segments: LineSegment[];
}

/** A gap wider than this many times the letter size is a space; narrower is kerning. */
const SPACE_GAP = 0.2;
/** A gap this many times the letter size or wider is a tab: a column of a table, or the indent after a label. */
const TAB_GAP = 3;
/** Baselines closer than this fraction of the letter size are one line. */
const SAME_LINE = 0.45;
/** A run this much smaller than its neighbour, and off its baseline by up to this fraction of the larger size, is a script. */
const SCRIPT_RATIO = 0.85;
const SCRIPT_OFFSET = 0.65;

export function layoutLines(runs: readonly TextRun[], page: number): { lines: PdfLine[]; turned: number } {
  const upright = runs.filter((r) => r.upright && r.text !== "");
  const turned = runs.length - upright.length;
  const sorted = [...upright].sort((a, b) => b.y - a.y || a.x0 - b.x0);

  const groups: TextRun[][] = [];
  for (const run of sorted) {
    const group = groups[groups.length - 1];
    if (group) {
      const head = group[0] as TextRun;
      const dy = Math.abs(head.y - run.y);
      const small = Math.min(head.size, run.size);
      const large = Math.max(head.size, run.size);
      // Letters of about one size are one line if their baselines are about level. A subscript or a superscript is much smaller
      // and sits off the baseline by up to half the larger size, and it belongs to the line it hangs from.
      // A picture is a line of its own, whatever stands beside it.
      if (!run.picture && !head.picture && (dy <= SAME_LINE * small || (small <= SCRIPT_RATIO * large && dy <= SCRIPT_OFFSET * large))) {
        group.push(run);
        continue;
      }
    }
    groups.push([run]);
  }

  const lines: PdfLine[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.x0 - b.x0);
    const segments: LineSegment[] = [];
    let text = "";
    let end = Number.NEGATIVE_INFINITY;
    let sizeSum = 0;
    let weight = 0;
    const add = (piece: string, run: TextRun): void => {
      text += piece;
      const last = segments[segments.length - 1];
      if (last && last.bold === run.bold && last.italic === run.italic) last.text += piece;
      else segments.push({ text: piece, bold: run.bold, italic: run.italic });
    };
    for (const run of group) {
      if (text !== "") {
        const gap = run.x0 - end;
        const spaced = /\s$/.test(text) || /^\s/.test(run.text);
        if (gap >= TAB_GAP * run.size && !/\t$/.test(text)) add(spaced ? "" : "\t", run);
        else if (gap > SPACE_GAP * run.size && !spaced) add(" ", run);
      }
      add(run.text, run);
      end = Math.max(end, run.x1);
      sizeSum += run.size * run.text.length;
      weight += run.text.length;
    }
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed.trim() === "") continue;
    // The spaces at the front and the end go from the segments too, so that they say what the text says.
    let lead = text.length - text.trimStart().length;
    while (lead > 0 && segments.length > 0) {
      const head = segments[0] as LineSegment;
      const cut = Math.min(lead, head.text.length);
      head.text = head.text.slice(cut);
      lead -= cut;
      if (head.text === "") segments.shift();
    }
    let excess = text.trimStart().length - trimmed.length;
    while (excess > 0 && segments.length > 0) {
      const last = segments[segments.length - 1] as LineSegment;
      const cut = Math.min(excess, last.text.length);
      last.text = last.text.slice(0, last.text.length - cut);
      excess -= cut;
      if (last.text === "") segments.pop();
    }
    const first = group[0] as TextRun;
    // The baseline of a line is the baseline of its largest letters, not of a subscript that happens to start it.
    const main = group.reduce((a, b) => (b.size > a.size + 0.01 ? b : a), first);
    lines.push({ page, text: trimmed, x: first.x0, x1: end, y: main.y, size: weight > 0 ? sizeSum / weight : first.size, segments });
  }
  return { lines, turned };
}
