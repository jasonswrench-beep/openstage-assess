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

import { richTextToPlain, type RichText } from "./richtext.ts";

const TABLE_TAG = /<(\/?)table\b[^>]*>/gi;

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
  for (const tag of html.matchAll(TABLE_TAG)) {
    const at = tag.index as number;
    if (tag[1] === "") {
      if (depth === 0) start = at;
      depth++;
    } else if (depth > 0 && --depth === 0) {
      out += html.slice(from, start) + replace(html.slice(start, at + tag[0].length), index++);
      from = at + tag[0].length;
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

/** A table read into rows and cells, or its words only when it holds another table or has no rows. */
export function readTableHtml(table: string): TableView {
  const text = richTextToPlain(table.replace(/<\/(td|th)\s*>/gi, " | ").replace(/<\/tr\s*>/gi, "\n").replace(/\s*\|\s*(?=\n|$)/g, ""));
  const tags = [...table.matchAll(TABLE_TAG)].filter((t) => t[1] === "").length;
  if (tags !== 1) return { rows: [], text };
  const rows: TableCell[][] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells: TableCell[] = [];
    for (const cell of (row[1] as string).matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
      cells.push({
        header: (cell[1] as string).toLowerCase() === "th",
        text: richTextToPlain(cell[3] as string),
        colspan: attribute(cell[2] as string, "colspan"),
        rowspan: attribute(cell[2] as string, "rowspan"),
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
