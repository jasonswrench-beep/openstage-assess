/**
 * Reading a CSV, TSV or tab-separated text file as a table.
 *
 * A spreadsheet program saves a table in three ways that matter here. The separator is a comma, or a semicolon where the
 * decimal mark is a comma, or a tab ("Unicode Text"). The text is UTF-8, or UTF-16 (also "Unicode Text"), or the Windows
 * Western code page that plain "CSV (Comma delimited)" uses. This reads all of them, says which it found when it is not the
 * usual one, and never guesses a character it cannot read: a file that is neither UTF-8 nor a code page text is refused.
 */

import { MAX_COLUMNS, MAX_ROWS, TableError, type TableFile, type TableNote, type TableRow } from "./table.ts";

export interface DecodedText {
  text: string;
  /** What the file was read as, in words, when that is worth saying. Absent for plain UTF-8. */
  encoding?: string;
}

/** The text of a file, whatever a spreadsheet program saved it as. */
export function decodeTableText(bytes: Uint8Array): DecodedText {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString("utf16le"), encoding: "UTF-16 (Unicode text)" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = buffer.subarray(2);
    return { text: Buffer.from(body.subarray(0, body.length - (body.length % 2))).swap16().toString("utf16le"), encoding: "UTF-16 (Unicode text)" };
  }
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start)) };
  } catch {
    // Not UTF-8. Excel's plain CSV is the Windows Western code page, and it is what a table with an accent in it usually is.
    return { text: new TextDecoder("windows-1252").decode(buffer.subarray(start)), encoding: "the Windows Western code page that Excel's plain CSV uses" };
  }
}

/** The character that separates the cells: the one used most in the first line, outside quotes. */
export function delimiterOf(text: string): "," | ";" | "\t" {
  const count = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in count) count[ch as keyof typeof count]++;
  }
  if (count["\t"] > count[","] && count["\t"] >= count[";"]) return "\t";
  return count[";"] > count[","] ? ";" : ",";
}

/**
 * Split text into records. A quote holds a separator or a line break inside a cell, and two quotes in a row are one. The
 * records keep their number, and an empty record is left out of the result but still counted, so a row is where the
 * spreadsheet program shows it.
 */
export function parseDelimited(raw: string, limit: number = MAX_ROWS, separator?: "," | ";" | "\t"): { rows: TableRow[]; truncated: boolean } {
  const text = raw.replace(/^﻿/, "");
  const sep = separator ?? delimiterOf(text);
  const rows: TableRow[] = [];
  let row: string[] = [];
  let cell = "";
  // Whether the cell holds nothing but white space so far, which is where a quotation mark opens a quoted part. It was asked of the cell
  // itself (`cell.trim() === ""`) at every quotation mark, and that copies the whole cell each time: a cell of 200,000 quotation marks took
  // ten seconds, and every .txt file is read once as a table to see whether it is one.
  let blank = true;
  let quoted = false;
  let number = 1;
  let truncated = false;
  const add = (text: string): void => {
    cell += text;
    if (blank && !/^\s*$/.test(text)) blank = false;
  };
  const endCell = (): void => {
    row.push(cell.trim());
    cell = "";
    blank = true;
  };
  const endRow = (): void => {
    endCell();
    if (row.some((c) => c !== "")) {
      if (rows.length < limit) rows.push({ number, cells: row.slice(0, MAX_COLUMNS) });
      else truncated = true;
    }
    row = [];
    number++;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          add('"');
          i++;
        } else quoted = false;
      } else add(ch);
    } else if (ch === '"' && blank) quoted = true;
    else if (ch === sep) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else add(ch);
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, truncated };
}

/** A text file a spreadsheet program saved, as a table of one sheet. */
export function readCsv(bytes: Uint8Array): TableFile {
  const { text, encoding } = decodeTableText(bytes);
  if (text.includes("\u0000")) {
    throw new TableError("This file has characters in it that a text file does not, so it is not a CSV. If it is an Excel file, save it as .xlsx or as CSV.");
  }
  const { rows, truncated } = parseDelimited(text);
  const notes: TableNote[] = [];
  if (encoding) notes.push({ severity: "info", message: `The file was read as ${encoding}.` });
  if (truncated) notes.push({ severity: "warn", message: `Only the first ${MAX_ROWS} rows were read.` });
  return { kind: "csv", sheets: [{ name: "", rows, hiddenRows: 0 }], notes };
}
