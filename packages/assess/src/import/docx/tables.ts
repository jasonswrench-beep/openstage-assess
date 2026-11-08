/**
 * Questions laid out in a Word table.
 *
 * Test banks put questions in tables in a few recognisable ways, and read cell by
 * cell, in order, none of them makes sense: a row that holds a question number, the
 * question and four options becomes six unrelated lines. This turns a table that
 * has one of these layouts into the lines the Standard Format scanner reads, so the
 * same scanner, builder and accuracy gate do the rest. A table that has none of
 * them is not touched and is read cell by cell as before, and the file says how
 * many were.
 *
 * The layouts, each with conditions strict enough that an ordinary table of data is
 * not mistaken for one:
 *
 *   Grid.        A header row names the columns and each later row is a question:
 *                a number, the question, an option in each of several columns
 *                headed A, B, C and so on, and optionally the answer, a type, the
 *                points, feedback and the labels publishers use. A column the
 *                profile does not know is not dropped: its words follow the
 *                question as a line the scanner reports as stray text.
 *   Labelled rows. Each row is a line of a question: a label ("1." or "b.") in the
 *                first cell and the text in the next. A question per table, or
 *                several questions in one. A last cell holding a check mark marks
 *                the option correct.
 *   Answer key.  Two columns, a question number and its answer, with or without a
 *                header. It becomes an Answers list.
 *   Numbered cells. Two columns: the number, and in the other cell everything else of
 *                the question, which may include a table for each option.
 *
 * Cells merged down are never read as a layout, and a grid or an answer key with a
 * cell merged across is not either: what a merged cell means is not knowable here.
 * Labelled rows allow a cell spread across a whole row, which is how Word writes a
 * line of text in a table of two columns. A table with another table inside a cell is
 * read only as numbered cells, the one layout whose second cell is meant to hold one;
 * the others would have read the nested lines under the wrong column.
 */

import { KEY_VALUE, METADATA_LABELS, NOTE_LABELS, GENERAL_FEEDBACK_LABELS } from "../standard-text-scan.ts";
import type { SourceBlock } from "../types.ts";

/** A line of a cell, before it has a place in the document. */
export type Line = Omit<SourceBlock, "index">;

export interface Cell {
  lines: Line[];
  /** The cell spans more than one column. */
  merged?: boolean;
  /**
   * The cell holds a table of its own, whose lines are among this cell's lines. Only
   * the layout built for that (a question's options in tables inside the question's
   * cell) reads such a cell. The others never did, and a cell read under the wrong
   * column is a wrong answer, so they still refuse it.
   */
  nested?: boolean;
}

export type Layout = "grid" | "labelled rows" | "answer key" | "numbered cells" | "matching rows";

export interface TableReading {
  layout?: Layout;
  /** The lines the table stands for, in order. Empty when the layout is not recognised. */
  lines: Line[];
}

interface Context {
  /** Whether blocks carry formatting runs, which a line made from several cells has to keep. */
  runs: boolean;
  /** The text of the block before the table, to tell whether an Answers heading is already there. */
  previous: string;
}

const textOf = (line: Line): string => (line.listLabel ? `${line.listLabel} ${line.text}` : line.text);
const cellText = (cell: Cell | undefined): string => (cell ? cell.lines.map(textOf).join(" ").replace(/\s+/g, " ").trim() : "");
const isEmpty = (cell: Cell | undefined): boolean => cellText(cell) === "";

/** Where a made-up line came from, so a preview can find it. */
const placeOf = (cell: Cell | undefined): Pick<Line, "table"> => {
  const table = cell?.lines.find((l) => l.table)?.table;
  return table ? { table } : {};
};

/** A line of words that were not in any cell, such as "Type: MC". */
function made(context: Context, text: string, from: Cell | undefined): Line {
  return { text, ...(context.runs ? { runs: text === "" ? [] : [{ text }] } : {}), ...placeOf(from) };
}

/** A part of a line with its list label written into the text, as a label that is not first has to be. */
function baked(line: Line): { text: string; runs?: NonNullable<Line["runs"]> } {
  if (!line.listLabel) return { text: line.text, ...(line.runs ? { runs: line.runs } : {}) };
  return {
    text: `${line.listLabel} ${line.text}`,
    ...(line.runs ? { runs: [{ text: `${line.listLabel} ` }, ...line.runs] } : {}),
  };
}

/** Several parts as one line, with a space between them. The first keeps its list label. */
function join(parts: Line[], from: Cell | undefined): Line {
  const first = parts[0] as Line;
  let text = first.text;
  let runs = first.runs ? [...first.runs] : undefined;
  for (const next of parts.slice(1)) {
    const part = baked(next);
    text += ` ${part.text}`;
    if (runs && part.runs) runs.push({ text: " " }, ...part.runs);
    else runs = undefined;
  }
  return {
    text,
    ...(runs ? { runs } : {}),
    ...(first.listLabel ? { kind: "listItem" as const, listLabel: first.listLabel } : {}),
    ...placeOf(from),
  };
}

/** The cell's first line, then the lines that carry on from it. */
const first = (cell: Cell | undefined): Line | undefined => cell?.lines.find((l) => textOf(l).trim() !== "");
const rest = (cell: Cell | undefined): Line[] => {
  const lines = (cell?.lines ?? []).filter((l) => textOf(l).trim() !== "");
  return lines.slice(1);
};

const normalise = (text: string): string =>
  text.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9# ]+/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

type Role =
  | { role: "number" | "question" | "key" | "type" | "points" | "title" | "correctFeedback" | "incorrectFeedback" }
  | { role: "option"; letter: string }
  | { role: "labelled"; label: string }
  | { role: "other" };

const NUMBER = /^(no|number|num|q|q no|q#|#|item|item no|question no|question number|question #)$/;
const QUESTION = /^(question|questions|stem|question text|item text|prompt)$/;
const OPTION = /^(?:(?:option|choice|alternative|response|answer)\s+)?([a-t])$/;
const KEY = /^(answer|answers|correct|correct answer|correct option|correct choice|key|answer key|ans|right answer)$/;
const TYPE = /^(type|question type)$/;
const POINTS = /^(points|point|pts|marks|score)$/;
const TITLE = /^(title|question title)$/;
const CORRECT_FEEDBACK = /^(correct feedback|feedback correct|right feedback|feedback for correct)$/;
const INCORRECT_FEEDBACK = /^(incorrect feedback|feedback incorrect|wrong feedback|feedback for incorrect)$/;

function classify(header: string): Role {
  const name = normalise(header);
  if (NUMBER.test(name)) return { role: "number" };
  if (QUESTION.test(name)) return { role: "question" };
  if (KEY.test(name)) return { role: "key" };
  const option = OPTION.exec(name);
  if (option) return { role: "option", letter: option[1] as string };
  if (TYPE.test(name)) return { role: "type" };
  if (POINTS.test(name)) return { role: "points" };
  if (TITLE.test(name)) return { role: "title" };
  if (CORRECT_FEEDBACK.test(name)) return { role: "correctFeedback" };
  if (INCORRECT_FEEDBACK.test(name)) return { role: "incorrectFeedback" };
  if (METADATA_LABELS[name] || GENERAL_FEEDBACK_LABELS.has(name) || NOTE_LABELS.has(name)) return { role: "labelled", label: header.trim() };
  return { role: "other" };
}

function readGrid(rows: Cell[][], context: Context): Line[] | undefined {
  const head = rows[0];
  if (!head || rows.length < 2) return undefined;
  const headers = head.map(cellText);
  const roles = headers.map(classify);

  const count = (role: Role["role"]) => roles.filter((r) => r.role === role).length;
  const optionLetters = roles.flatMap((r) => (r.role === "option" ? [r.letter] : []));
  if (count("question") !== 1 || optionLetters.length < 2 || new Set(optionLetters).size !== optionLetters.length) return undefined;
  for (const single of ["number", "key", "type", "points", "title"] as const) if (count(single) > 1) return undefined;
  // Every row has to line up with the header, or a cell could be read under the wrong column.
  if (rows.some((row) => row.length !== head.length || row.some((c) => c.merged))) return undefined;

  const headerKey = headers.map(normalise).join("|");
  const lines: Line[] = [];
  let question = 0;
  for (const row of rows.slice(1)) {
    if (row.every(isEmpty)) continue;
    // A header repeated at the top of a new page is not a question.
    if (row.map(cellText).map(normalise).join("|") === headerKey) continue;
    question++;

    const at = (role: Role["role"]): Cell | undefined => row[roles.findIndex((r) => r.role === role)];
    const where = row[0];

    const title = cellText(at("title"));
    if (title) lines.push(made(context, `Title: ${title}`, at("title")));

    const strays: Line[] = [];
    const stray = (header: string, cell: Cell | undefined): void => {
      strays.push(made(context, `Column: ${header}: ${cellText(cell)}`, cell));
    };

    // Directives are only directives when they read as one. Anything else is kept
    // as words after the question, where the scanner reports it.
    const type = cellText(at("type"));
    if (type) {
      if (/^[A-Za-z]{1,3}$/.test(type)) lines.push(made(context, `Type: ${type.toUpperCase()}`, at("type")));
      else stray(headers[roles.findIndex((r) => r.role === "type")] as string, at("type"));
    }
    const points = cellText(at("points"));
    if (points) {
      if (/^\d+(?:\.\d+)?$/.test(points)) lines.push(made(context, `Points: ${points}`, at("points")));
      else stray(headers[roles.findIndex((r) => r.role === "points")] as string, at("points"));
    }

    // The question, numbered from its own cell if that holds a number, and otherwise by its place.
    const numberCell = cellText(at("number"));
    const given = /^[A-Za-z#.\s]*(\d{1,4})[.)\s]*$/.exec(numberCell);
    const number = given ? given[1] : String(question);
    const stem = at("question");
    const stemLine = first(stem);
    const label: Line = made(context, `${number}.`, at("number") ?? stem);
    lines.push(stemLine ? join([label, stemLine], stem) : made(context, `${number}. `, stem));
    lines.push(...rest(stem));

    roles.forEach((role, i) => {
      if (role.role !== "option") return;
      const cell = row[i];
      const line = first(cell);
      if (!line) return;
      lines.push(join([made(context, `${role.letter}.`, cell), line], cell), ...rest(cell));
    });

    roles.forEach((role, i) => {
      const cell = row[i];
      if (isEmpty(cell)) return;
      const header = (headers[i] as string).trim();
      if (role.role === "labelled") lines.push(...labelledLines(context, role.label, cell));
      else if (role.role === "correctFeedback") lines.push(made(context, `~ ${cellText(cell)}`, cell));
      else if (role.role === "incorrectFeedback") lines.push(made(context, `@ ${cellText(cell)}`, cell));
      else if (role.role === "other") stray(header, cell);
    });
    lines.push(...strays);

    const key = at("key");
    if (!isEmpty(key)) lines.push(made(context, `Answer: ${cellText(key)}`, key));
    lines.push(made(context, "", where));
  }
  return lines.length > 0 ? lines : undefined;
}

/** A column that holds a labelled line ("Difficulty: Easy"), one line for each paragraph of the cell. */
function labelledLines(context: Context, label: string, cell: Cell | undefined): Line[] {
  return [made(context, `${label}: ${cellText(cell)}`, cell)];
}

// ---------------------------------------------------------------------------
// Labelled rows
// ---------------------------------------------------------------------------

const LABEL = /^\*?\s*(?:\d{1,4}|[a-tA-T])\s*[.)]$/;
/** A check mark in the last cell of an option's row. Only marks that cannot be an option's own words. */
const MARK = /^(?:✓|✔|☑|✅|\*|correct|right)$/i;

function readLabelled(rows: Cell[][], context: Context): Line[] | undefined {
  const lines: Line[] = [];
  let labelled = 0;
  for (const row of rows) {
    const filled = row.filter((c) => !isEmpty(c));
    if (row.length > 1 && row.some((c) => c.merged)) return undefined;
    if (filled.length === 0) {
      lines.push(made(context, "", row[0]));
      continue;
    }
    if (filled.length === 1) {
      const only = filled[0] as Cell;
      const shown = only.lines.filter((l) => textOf(l).trim() !== "");
      // A label with nothing beside it is an option with no text, which is written "b. ".
      const alone = shown.length === 1 && row.length > 1 && !shown[0]?.listLabel && LABEL.test((shown[0] as Line).text.trim());
      if (alone) {
        lines.push({ ...(shown[0] as Line), text: `${(shown[0] as Line).text.trim()} `, ...(shown[0]?.runs ? { runs: [...shown[0].runs, { text: " " }] } : {}) });
        labelled++;
      } else lines.push(...shown);
      continue;
    }
    const labelCell = filled[0] as Cell;
    const label = first(labelCell);
    if (!label || label.listLabel || !LABEL.test(label.text.trim()) || rest(labelCell).length > 0) return undefined;
    labelled++;

    let cells = filled;
    const last = cells[cells.length - 1] as Cell;
    let mark = false;
    if (cells.length >= 3 && MARK.test(cellText(last)) && /^[a-tA-T]\s*[.)]$/.test(label.text.trim().replace(/^\*/, ""))) {
      mark = true;
      cells = cells.slice(0, -1);
    }

    const parts = cells.map((c) => first(c) as Line);
    if (mark && !parts[0]?.text.trim().startsWith("*")) {
      const marked = parts[0] as Line;
      parts[0] = { ...marked, text: `*${marked.text.trim()}`, ...(marked.runs ? { runs: [{ text: "*" }, ...marked.runs] } : {}) };
    }
    lines.push(join(parts, labelCell));
    for (const c of cells) lines.push(...rest(c));
  }
  return labelled > 0 ? lines : undefined;
}

// ---------------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------------

const KEY_NUMBER = /^[A-Za-z#]*\s*(\d{1,4}(?:\.\d{1,3})?)\s*[.)]?$/;
const KEY_HEAD_NUMBER = /^(q|no|number|question|question no|question number|#|item)$/;
const KEY_HEAD_ANSWER = /^(answer|answers|key|ans|correct|correct answer|answer key)$/;

function readKey(rows: Cell[][], context: Context): Line[] | undefined {
  if (rows.some((r) => r.length !== 2 || r.some((c) => c.merged))) return undefined;
  const headed = rows.length >= 2 && KEY_HEAD_NUMBER.test(normalise(cellText(rows[0]?.[0]))) && KEY_HEAD_ANSWER.test(normalise(cellText(rows[0]?.[1])));
  const body = headed ? rows.slice(1) : rows;
  if (body.length < 1) return undefined;

  const entries: Line[] = [];
  for (const row of body) {
    const number = KEY_NUMBER.exec(cellText(row[0]));
    const value = cellText(row[1]);
    if (!number) return undefined;
    // Without a header, a second column of anything but letters or True and False is not clearly a key.
    if (!headed && !(value !== "" && KEY_VALUE.test(value))) return undefined;
    entries.push(made(context, `${number[1]}. ${value}`, row[0]));
  }

  const lines: Line[] = [];
  if (!/^answers\s*:\s*$/i.test(context.previous.trim())) {
    lines.push(made(context, "Answers:", rows[0]?.[0]));
  }
  lines.push(...entries);
  return lines;
}

// ---------------------------------------------------------------------------
// Numbered cells
// ---------------------------------------------------------------------------

const NUMBER_CELL = /^\d{1,4}\s*[.)]$/;
/** "(p. 230)", "(p. 238, 239)", "pp. 12-14", "page 12": where in the book a question comes from. */
const PAGE_REF = /^\(?\s*(?:pp?|pages?)\.?\s*(\d+(?:\s*[-–—,&]\s*\d+)*)\s*\)?$/i;

/**
 * Each row is a question: its number in the first cell, and in the second everything
 * else, in order. This is how publishers' test banks are laid out when each question is
 * a table of its own, and each option is a table of its own inside the second cell, so
 * that the letter stays with the words. What is in the second cell is already the lines
 * of a question, blank lines included, because the blank lines are what end an option,
 * so it is passed on as it stands.
 *
 * A line below the number in the first cell that says where in the book the question
 * is, "(p. 230)", becomes a Page line, which the scanner reads like any other label.
 * Any other line there is kept after the question, where the scanner reports what it
 * finds. The labelled-rows layout refuses a number cell with anything under the number,
 * and refuses a cell with a table in it, which is why this one exists.
 */
function readNumbered(rows: Cell[][], context: Context): Line[] | undefined {
  if (rows.length === 0) return undefined;
  const lines: Line[] = [];
  for (const row of rows) {
    if (row.length !== 2 || row.some((c) => c.merged)) return undefined;
    const [numberCell, contentCell] = row as [Cell, Cell];
    if (numberCell.nested) return undefined;

    const shown = numberCell.lines.filter((l) => textOf(l).trim() !== "");
    const label = shown[0];
    if (!label || !NUMBER_CELL.test(textOf(label).trim())) return undefined;

    // Blank lines inside the content are structure and stay. Those before the first
    // words, and after the last, are padding a cell has and are not.
    const content = [...contentCell.lines];
    while (content.length > 0 && textOf(content[0] as Line).trim() === "") content.shift();
    while (content.length > 0 && textOf(content[content.length - 1] as Line).trim() === "") content.pop();
    const stem = content[0];
    if (!stem) return undefined;

    const number = /\d+/.exec(textOf(label)) as RegExpExecArray;
    lines.push(join([made(context, `${number[0]}.`, numberCell), stem], contentCell));
    lines.push(...content.slice(1));

    const pages: string[] = [];
    const extras: Line[] = [];
    for (const line of shown.slice(1)) {
      const page = PAGE_REF.exec(textOf(line).trim());
      if (page) pages.push((page[1] as string).replace(/\s+/g, " "));
      else extras.push(line);
    }
    if (pages.length > 0) lines.push(made(context, `Page: ${pages.join("; ")}`, numberCell));
    // Whatever else was under the number is not part of the question, and a blank line
    // before it keeps it from being read as more of the stem or the last option.
    if (extras.length > 0) lines.push(made(context, "", numberCell), ...extras);
    lines.push(made(context, "", numberCell));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Matching rows
// ---------------------------------------------------------------------------

/** The page a cell of words ends with, in brackets: "... context. (Page 4)". */
const PAGE_AT_END = /(?<!\s)\s*\(\s*(?:pp?|pages?)\.?\s*(\d+(?:\s*[-–—,&]\s*\d+)*)\s*\)\s*$/i;

/**
 * A matching exercise: a number, a term and its definition in each row, the cells between
 * them left empty for space. Read as numbered questions, each row was a question of its
 * own with nothing to answer, which is ten failures for one exercise. It is one question,
 * a pair to each row, written as the Standard Format writes a pair ("a. term = definition").
 * The pairs are the whole of it: the table has no text of its own, and the scanner uses the
 * heading above it, and says so.
 *
 * The conditions are strict because a table of three columns is common: every row starts
 * with a number, the numbers count up from the first row's by one, there are exactly two
 * cells with words after the number cell, and there are at least three rows and no more
 * than the twenty letters an option can have. A page at the end of a definition is taken
 * off it and kept as the question's Page.
 */
function readMatching(rows: Cell[][], context: Context): Line[] | undefined {
  if (rows.length < 3 || rows.length > 20) return undefined;
  const pairs: Array<{ term: string; definition: string; row: Cell[] }> = [];
  const pages: string[] = [];
  let previous: number | undefined;
  for (const row of rows) {
    // Exactly two cells of words after the number cell means three or more cells in all.
    if (row.some((c) => c.merged || c.nested)) return undefined;
    const [numberCell, ...others] = row as [Cell, ...Cell[]];
    const number = NUMBER_CELL.test(cellText(numberCell)) ? Number(/\d+/.exec(cellText(numberCell))?.[0]) : undefined;
    if (number === undefined || (previous !== undefined && number !== previous + 1)) return undefined;
    previous = number;
    const filled = others.filter((c) => !isEmpty(c));
    if (filled.length !== 2) return undefined;

    let definition = cellText(filled[1]);
    const page = PAGE_AT_END.exec(definition);
    if (page && page.index > 0) {
      const value = (page[1] as string).replace(/\s+/g, " ");
      if (!pages.includes(value)) pages.push(value);
      definition = definition.slice(0, page.index).trimEnd();
    }
    pairs.push({ term: cellText(filled[0]), definition, row });
  }

  const first = rows[0]?.[0];
  const lines: Line[] = [made(context, "1.", first)];
  pairs.forEach((pair, i) => lines.push(made(context, `${"abcdefghijklmnopqrst"[i]}. ${pair.term} = ${pair.definition}`, pair.row[0])));
  if (pages.length > 0) lines.push(made(context, `Page: ${pages.join("; ")}`, first));
  lines.push(made(context, "", first));
  return lines;
}

// ---------------------------------------------------------------------------

/** Read a table as one of the layouts, or say that it is none of them. */
export function readTable(rows: Cell[][], context: Context): TableReading {
  const nested = rows.some((row) => row.some((c) => c.nested));
  const attempts: Array<[Layout, (rows: Cell[][], context: Context) => Line[] | undefined]> = nested
    ? [["numbered cells", readNumbered]]
    : [
        ["grid", readGrid],
        ["answer key", readKey],
        ["matching rows", readMatching],
        ["labelled rows", readLabelled],
        ["numbered cells", readNumbered],
      ];
  for (const [layout, read] of attempts) {
    const lines = read(rows, context);
    if (lines) return { layout, lines };
  }
  return { lines: [] };
}
