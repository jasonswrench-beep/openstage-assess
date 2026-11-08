/**
 * A table in the text of a question.
 *
 * Rich text can hold a table (`table`, `thead`, `tbody`, `tr`, `th` and `td` are in the subset), and a data table in a stem is
 * common: scores to find the mean of, a schedule, the results of an experiment. A Word file's table that is none of the question
 * layouts used to be read cell by cell into lines of text, so its rows and columns were lost. It is now kept as a table of the
 * question when it is a grid, and the editor shows it as a token in the text, `[table 2]`, moved or removed like words.
 *
 * This module is what both ends share: finding the tables in a piece of markup, replacing each, and reading one into rows and cells
 * for a screen that draws it from a list and not from the markup. The markup is always the engine's own (sanitized, from the
 * subset), but a bank can be edited by hand, so nothing here trusts its shape: a table nested in a table is found as one table, and
 * a table that cannot be read into rows says so and is shown as its words.
 */

import { findElements, findTags } from "./markup-scan.ts";
import { richTextToPlain, type RichText } from "./richtext.ts";

// The tags are found by `markup-scan.ts` and not by the pattern `<(\/?)table\b[^>]*>`, which reads to the end of the text from every
// `<table` that has no `>` after it (a stem of 40,000 of them took each exporter seconds).
const TABLE_START = /<\/?table\b/gi;

/**
 * The markup with each top-level table replaced by what `replace` makes of it. A table inside a table is part of the outer one.
 * A table that is never closed runs to the end of the text, so none is dropped without being seen.
 */
export function replaceTables(html: string, replace: (table: string, index: number) => string): string {
  let out = "";
  let from = 0;
  let depth = 0;
  let start = -1;
  let index = 0;
  for (const tag of findTags(html, TABLE_START)) {
    const at = tag.index;
    if (!tag.text.startsWith("</")) {
      if (depth === 0) start = at;
      depth++;
    } else if (depth > 0 && --depth === 0) {
      out += html.slice(from, start) + replace(html.slice(start, at + tag.text.length), index++);
      from = at + tag.text.length;
    }
  }
  if (depth > 0) {
    out += html.slice(from, start) + replace(html.slice(start), index++);
    from = html.length;
  }
  return out + html.slice(from);
}

/** The top-level tables of a piece of markup, as markup, in order. */
export function tablesIn(html: string): string[] {
  const found: string[] = [];
  replaceTables(html, (table) => {
    found.push(table);
    return "";
  });
  return found;
}

export interface TableCell {
  header: boolean;
  text: string;
  colspan: number;
  rowspan: number;
}

export interface TableView {
  rows: TableCell[][];
  /** The table's words, a row to a line and the cells of a row between bars. Always there, for a table that cannot be read into rows. */
  text: string;
}

const attribute = (tag: string, name: string): number => {
  const value = Number(new RegExp(`\\b${name}\\s*=\\s*"?(\\d{1,3})"?`, "i").exec(tag)?.[1]);
  return Number.isInteger(value) && value >= 1 ? value : 1;
};

/**
 * The text with the bar that ends a row taken out, and the white space round it: what `text.replace(/\s*\|\s*(?=\n|$)/g, "")` does. A
 * bar counts when what follows it is white space up to a line break or to the end of the text; the white space round it goes with it, up
 * to the last line break of the run after it, which stays.
 *
 * It looks at each bar and reads the white space on either side of it once. The pattern begins with `\s*`, so every place in a long run
 * of white space was a start that read to the end of the run (a cell of 200,000 tabs took half a minute); putting `(?<!\s)` in front of
 * it would stop that, but would also stop a second bar from ending a row when the first match had ended in the middle of a run.
 */
function withoutRowEndBars(text: string): string {
  const white = /\s/;
  const n = text.length;
  let out = "";
  let copied = 0;
  let bar = text.indexOf("|");
  while (bar !== -1) {
    // How far the white space after the bar goes, and where the last line break in it is.
    let after = bar + 1;
    let lastBreak = -1;
    while (after < n && white.test(text.charAt(after))) {
      if (text.charAt(after) === "\n") lastBreak = after;
      after++;
    }
    // At the end of the text the match takes all of the run, and otherwise it takes it up to the last line break.
    const end = after === n ? n : lastBreak;
    if (end === -1) {
      bar = text.indexOf("|", bar + 1);
      continue;
    }
    let begin = bar;
    while (begin > copied && white.test(text.charAt(begin - 1))) begin--;
    out += text.slice(copied, begin);
    copied = end;
    bar = text.indexOf("|", end);
  }
  return out + text.slice(copied);
}

/** A table read into rows and cells, or its words only when it holds another table or has no rows. */
export function readTableHtml(table: string): TableView {
  const text = richTextToPlain(withoutRowEndBars(table.replace(/<\/(td|th)\s*>/gi, " | ").replace(/<\/tr\s*>/gi, "\n")));
  const tags = findTags(table, TABLE_START).filter((t) => !t.text.startsWith("</")).length;
  if (tags !== 1) return { rows: [], text };
  const rows: TableCell[][] = [];
  for (const row of findElements(table, ["tr"])) {
    const cells: TableCell[] = [];
    for (const cell of findElements(row.inner, ["td", "th"])) {
      // The attributes are what lies between the name and the `>` of the opening tag.
      const attributes = cell.open.slice(1 + cell.name.length, -1);
      cells.push({
        header: cell.name.toLowerCase() === "th",
        text: richTextToPlain(cell.inner),
        colspan: attribute(attributes, "colspan"),
        rowspan: attribute(attributes, "rowspan"),
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return { rows, text };
}

/**
 * The words a title is made from: the words of a text that are outside its tables, or all of its words when it is only a table. A
 * stem that says "Use the table below" and then holds a table is titled by the sentence and not by the first row.
 */
export function titleText(value: RichText): string {
  const outside = richTextToPlain({ ...value, content: replaceTables(value.content, () => "\n") });
  return outside !== "" ? outside : richTextToPlain(value);
}
