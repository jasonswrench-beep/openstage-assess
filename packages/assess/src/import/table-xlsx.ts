/**
 * Reading an Excel workbook (.xlsx) as a table.
 *
 * A workbook is a zip of XML parts, and what a question list needs from it is small: the sheets in order, and for each row
 * the text of its cells. The text of a cell is a shared string, a string written in place, a number, a TRUE or FALSE, or the
 * stored result of a formula. Nothing else about the workbook is read, so nothing else can change what a cell says: no
 * macro is looked at, no formula is worked out, no format is applied.
 *
 * It reads a file the person did not write, so it is as strict as the Word reader is. The zip is opened by the same code
 * with the same limit on what it may expand to, the XML by the same reader (which refuses a document type declaration, the
 * way into entity expansion), and a part that is not what it says it is stops the read with a message.
 *
 * Nothing in a cell is dropped without being counted. A cell whose formula has no stored result (a file that was written by a
 * program that never calculated it) is read as empty and listed, because an empty Correct cell is a missing key and the
 * person has to know why it is empty.
 */

import { unzipSync } from "../container/zip.ts";
import { elements, parseXml, XmlError, type XmlElement } from "./docx/xml.ts";
import { MAX_COLUMNS, MAX_ROWS, TableError, type TableFile, type TableNote, type TableRow, type TableSheet } from "./table.ts";

/** Expanded size beyond which a workbook is not read. Far more than a list of questions. */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * The most characters Excel keeps in a cell. A cell of a workbook that has more was not written by Excel, and every cell that names
 * a shared string gets all of it: one string of a megabyte named by 300 cells was 300 MB read and a gigabyte once the questions were
 * built, and the first rows of a sheet are searched for the names of the columns cell by cell.
 */
const MAX_CELL_CHARS = 32_767;

/**
 * The most characters in all the cells of a workbook together, a shared string counted again for each cell that names it. A bank of
 * a thousand questions has a million or so; this is sixty times that. It is what keeps a few kilobytes of file (one string of 32,767
 * characters named by every cell of a sheet) from being many gigabytes of cells.
 */
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;

/**
 * The most places in all the rows of a workbook together. A row is kept as the list of its cells from the first column on, with an
 * empty string for each cell with nothing in it, so a row with one cell in column IV is 256 places and 2 KB: 200,000 of them are 1 MB
 * of file and 960 MB of memory. A table of questions has some twenty columns.
 */
const MAX_PLACES = 16_000_000;

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

/** A clear message for the files that are commonly taken for a .xlsx. */
function wrongKindOfFile(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return "This file is empty.";
  if (OLE_MAGIC.every((byte, i) => bytes[i] === byte)) {
    return (
      "This is an older Excel file (.xls), or an Excel file protected by a password. OpenAssess reads .xlsx and CSV. " +
      "In Excel, choose File, then Save As, pick Excel Workbook (*.xlsx) or CSV UTF-8, and make sure no password is set."
    );
  }
  if (startsWith(bytes, "%PDF")) return "This is a PDF, not an Excel workbook.";
  if (startsWith(bytes, "{\\rtf")) return "This is a Rich Text file, not an Excel workbook.";
  return undefined;
}

/** The element's name with any prefix taken off: a workbook may write `x:row` where Excel writes `row`. */
const local = (element: XmlElement): string => element.name.slice(element.name.lastIndexOf(":") + 1);

function kids(parent: XmlElement, name: string): XmlElement[] {
  return elements(parent).filter((e) => local(e) === name);
}

function kid(parent: XmlElement, name: string): XmlElement | undefined {
  return elements(parent).find((e) => local(e) === name);
}

/** The words of a string item: its text, or its runs' text, and not the phonetic guide that sits beside it. */
function stringItem(item: XmlElement | undefined): string {
  if (!item) return "";
  let out = "";
  for (const child of elements(item)) {
    const name = local(child);
    if (name === "t") out += textOf(child);
    else if (name === "r") for (const t of kids(child, "t")) out += textOf(t);
  }
  return out;
}

function textOf(element: XmlElement): string {
  return element.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

/** Column A is 0. */
function columnOf(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function tidyNumber(raw: string): string {
  const text = raw.trim();
  if (/^-?\d+$/.test(text)) return text;
  const n = Number(text);
  // A stored 0.1 + 0.2 is 0.30000000000000004, and what the cell shows is 0.3.
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : text;
}

/** What a cell says once it is cut to Excel's limit and tidied, and whether words were lost in the cut. */
interface CellText {
  text: string;
  lost: boolean;
}

const NO_TEXT: CellText = { text: "", lost: false };

/**
 * Cuts a cell's text to what Excel keeps and tidies it. Excel writes each line break inside a cell as CR LF, which is one character in
 * the cell and two in the file, so the text is cut at twice the limit first (that bounds the work whatever the string is), the line
 * ends are made plain, and only then is it cut at the limit itself: cutting at the limit before the line ends are plain took the last
 * words off a cell Excel had written at its own maximum, and said that it was over. A cut that would leave half of a character that is
 * two code units long takes the half off, and that is a loss, since the other half is not white space.
 */
function cellText(raw: string): CellText {
  let lost = false;
  let value = raw;
  if (value.length > 2 * MAX_CELL_CHARS) {
    lost = value.slice(2 * MAX_CELL_CHARS).trim() !== "";
    value = value.slice(0, 2 * MAX_CELL_CHARS);
  }
  value = value.replace(/\r\n?/g, "\n");
  if (value.length > MAX_CELL_CHARS) {
    if (!lost && value.slice(MAX_CELL_CHARS).trim() !== "") lost = true;
    const half = value.charCodeAt(MAX_CELL_CHARS - 1);
    value = value.slice(0, half >= 0xd800 && half <= 0xdbff ? MAX_CELL_CHARS - 1 : MAX_CELL_CHARS);
  }
  return { text: value.trim(), lost };
}

/** Resolves a relationship target against the folder of the part that holds it. */
function resolvePart(folder: string, target: string): string {
  const joined = target.startsWith("/") ? target.slice(1) : `${folder}${target}`;
  const out: string[] = [];
  for (const piece of joined.split("/")) {
    if (piece === "..") out.pop();
    else if (piece !== "." && piece !== "") out.push(piece);
  }
  return out.join("/");
}

interface Rels {
  byId: Map<string, string>;
  byType: Map<string, string>;
}

function readRels(part: XmlElement | undefined, folder: string): Rels {
  const rels: Rels = { byId: new Map(), byType: new Map() };
  if (!part) return rels;
  for (const rel of kids(part, "Relationship")) {
    const target = rel.attrs["Target"];
    if (target === undefined || rel.attrs["TargetMode"] === "External") continue;
    const path = resolvePart(folder, target);
    const id = rel.attrs["Id"];
    if (id !== undefined) rels.byId.set(id, path);
    const type = rel.attrs["Type"] ?? "";
    rels.byType.set(type.slice(type.lastIndexOf("/") + 1), path);
  }
  return rels;
}

export function readXlsx(bytes: Uint8Array): TableFile {
  const wrong = wrongKindOfFile(bytes);
  if (wrong) throw new TableError(wrong);

  let parts: Map<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { maxTotalBytes: MAX_BYTES });
  } catch (error) {
    throw new TableError(`This file could not be opened as an Excel workbook. ${error instanceof Error ? error.message : String(error)}`);
  }

  // Part names are compared without regard to case in this format, so two that differ only in case are one part twice.
  const byLowerCase = new Map<string, string>();
  for (const name of parts.keys()) {
    const key = name.toLowerCase();
    const earlier = byLowerCase.get(key);
    if (earlier !== undefined) throw new TableError(`This workbook holds "${earlier}" and "${name}", which are the same part under the format's rules, so which one is real cannot be known.`);
    byLowerCase.set(key, name);
  }
  const xml = (name: string): XmlElement | undefined => {
    const stored = byLowerCase.get(name.toLowerCase());
    const data = stored === undefined ? undefined : parts.get(stored);
    if (data === undefined) return undefined;
    try {
      // The XML parts are UTF-8 in practice, and a byte order mark at the front is allowed.
      return parseXml(Buffer.from(data).toString("utf8").replace(/^﻿/, ""));
    } catch (error) {
      if (error instanceof XmlError) {
        // A part that is only too big is not damaged, and is not called that: a person who is told a good file is invalid has nothing to do.
        if (error.tooLarge) throw new TableError(`The part "${name}" of this workbook is more than this reader takes, though it may be nothing wrong with the file. ${error.message}. Split the questions into two or more workbooks and import each.`);
        throw new TableError(`The part "${name}" of this workbook is not valid XML. ${error.message}`);
      }
      throw error;
    }
  };

  const root = readRels(xml("_rels/.rels"), "");
  const workbookPart = root.byType.get("officeDocument") ?? "xl/workbook.xml";
  const workbook = xml(workbookPart);
  if (!workbook || local(workbook) !== "workbook") {
    throw new TableError("This is a zip file, but not an Excel workbook: it has no workbook in it. If it is a Word file, import it as a Word file.");
  }
  const folder = workbookPart.includes("/") ? workbookPart.slice(0, workbookPart.lastIndexOf("/") + 1) : "";
  const rels = readRels(xml(`${folder}_rels/${workbookPart.slice(workbookPart.lastIndexOf("/") + 1)}.rels`), folder);

  const sharedPart = rels.byType.get("sharedStrings") ?? `${folder}sharedStrings.xml`;
  const sharedRoot = xml(sharedPart);
  const shared: string[] = sharedRoot ? kids(sharedRoot, "si").map((si) => stringItem(si)) : [];

  const notes: TableNote[] = [];
  const sheets: TableSheet[] = [];
  const noValue: string[] = [];
  const errors: string[] = [];
  let beyond = 0;
  /** Cells that had more than Excel allows in a cell, and were cut: how many, and the first few by name. */
  let cutCount = 0;
  const cut: string[] = [];
  let totalChars = 0;
  let places = 0;
  /** The text of each shared string as a cell shows it, made the first time a cell names it. */
  const sharedText = new Map<number, CellText>();

  const sheetList = kid(workbook, "sheets");
  const entries = sheetList ? kids(sheetList, "sheet") : [];
  // A part is read once for each sheet that names it, and keeps its rows once for each as well: sixty bytes of `<sheet>` was another
  // 570 MB. Excel does not write two sheets that are one part, and which of them the cells belong to is not something to guess.
  const taken = new Map<string, string>();
  for (const entry of entries) {
    const relId = entry.attrs["r:id"];
    const path = relId === undefined ? undefined : rels.byId.get(relId);
    if (path === undefined || !byLowerCase.has(path.toLowerCase())) continue;
    const name = entry.attrs["name"] ?? "";
    const earlier = taken.get(path.toLowerCase());
    if (earlier !== undefined) {
      throw new TableError(
        `This workbook lists the sheets "${earlier}" and "${name}", and both are the one part "${path}" of the file, so its cells would be read twice. Excel does not write that. Open the file in Excel and save it as a new workbook, with one sheet for each.`,
      );
    }
    taken.set(path.toLowerCase(), name);
  }

  for (const entry of entries) {
    const name = entry.attrs["name"] ?? "";
    const relId = entry.attrs["r:id"];
    const path = relId === undefined ? undefined : rels.byId.get(relId);
    const sheetXml = path === undefined ? undefined : xml(path);
    // A chart sheet, or a part the workbook names and does not hold, has no cells.
    if (!sheetXml || local(sheetXml) !== "worksheet") continue;
    const data = kid(sheetXml, "sheetData");
    const rows: TableRow[] = [];
    let hiddenRows = 0;
    let truncated = false;
    let last = 0;
    for (const row of data ? kids(data, "row") : []) {
      const given = Number(row.attrs["r"]);
      const number = Number.isInteger(given) && given > 0 ? given : last + 1;
      last = number;
      const cells: string[] = [];
      let next = 0;
      let any = false;
      for (const c of kids(row, "c")) {
        const ref = /^([A-Za-z]+)(\d+)$/.exec(c.attrs["r"] ?? "");
        const column = ref ? columnOf((ref[1] as string).toUpperCase()) : next;
        next = column + 1;
        const type = c.attrs["t"] ?? "n";
        const v = kid(c, "v");
        const raw = v ? textOf(v) : "";
        let value: string;
        let tidy: CellText | undefined;
        if (type === "s") {
          // A shared string is cut and tidied once however many cells name it: a string of 32,767 spaces named by 800,000 cells took 35
          // seconds when each cell did it again (1.9 MB of file).
          const at = Number(raw);
          const given = shared[at];
          // A number that names no string is an empty cell and is not kept, so a column of made-up numbers cannot fill the table.
          if (given === undefined) tidy = NO_TEXT;
          else {
            tidy = sharedText.get(at);
            if (tidy === undefined) {
              tidy = cellText(given);
              sharedText.set(at, tidy);
            }
          }
          value = tidy.text;
        } else if (type === "inlineStr") value = stringItem(kid(c, "is"));
        else if (type === "b") value = raw.trim() === "1" || raw.trim().toLowerCase() === "true" ? "TRUE" : "FALSE";
        else if (type === "e") {
          value = "";
          if (errors.length < 5) errors.push(`${name}!${c.attrs["r"] ?? ""} (${raw})`);
        } else if (type === "str" || type === "d") value = raw;
        else value = raw === "" ? "" : tidyNumber(raw);
        // A formula whose result was never stored: the cell would read as empty, so it is named.
        if (kid(c, "f") && raw === "" && type !== "inlineStr" && noValue.length < 5) noValue.push(`${name}!${c.attrs["r"] ?? ""}`);
        // White space after the cut is not a loss and is not reported as one.
        tidy ??= cellText(value);
        if (tidy.lost) {
          cutCount++;
          if (cut.length < 5) cut.push(`${name}!${c.attrs["r"] ?? ""}`);
        }
        value = tidy.text;
        if (value === "") continue;
        totalChars += value.length;
        if (totalChars > MAX_TOTAL_CHARS) {
          throw new TableError(
            `This workbook has more text in its cells than a table of questions has: over ${MAX_TOTAL_CHARS / (1024 * 1024)} million characters, counting a piece of text again for each cell that holds it. ` +
              "A bank of a thousand questions has about a million. Split the questions into smaller workbooks, or check that a cell is not filled down a whole column.",
          );
        }
        any = true;
        if (column >= MAX_COLUMNS) {
          beyond++;
          continue;
        }
        while (cells.length < column) cells.push("");
        cells[column] = value;
      }
      if (!any) continue;
      const hidden = row.attrs["hidden"] === "1" || row.attrs["hidden"] === "true";
      if (hidden) hiddenRows++;
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        continue;
      }
      places += cells.length;
      if (places > MAX_PLACES) {
        throw new TableError(
          `This workbook has more cells than a table of questions has: over ${MAX_PLACES / 1_000_000} million places in its rows, where a row counts every column up to its last cell with something in it, empty ones included. ` +
            "A table of questions is a few thousand rows of some twenty columns. Look for a stray cell far to the right, or far below, and clear the columns and rows beyond the table.",
        );
      }
      rows.push({ number, cells });
    }
    if (truncated) notes.push({ severity: "warn", message: `Only the first ${MAX_ROWS} rows of the sheet "${name}" were read.` });
    const state = entry.attrs["state"];
    sheets.push({ name, rows, hiddenRows, ...(state === "hidden" || state === "veryHidden" ? { hidden: true } : {}) });
  }

  if (sheets.length === 0) throw new TableError("This workbook has no sheet with anything in it to read.");
  if (noValue.length > 0) notes.push({ severity: "warn", message: `A cell holds a formula with no stored result, and was read as empty: ${noValue.join(", ")}. Open the file in Excel and save it again, and the results are stored.` });
  if (errors.length > 0) notes.push({ severity: "warn", message: `A cell shows an error, and was read as empty: ${errors.join(", ")}.` });
  if (beyond > 0) notes.push({ severity: "warn", message: `${beyond} cells beyond column ${MAX_COLUMNS} were not read.` });
  if (cutCount > 0) {
    notes.push({
      severity: "warn",
      message: `${cutCount === 1 ? "A cell holds" : `${cutCount} cells hold`} more than the 32,767 characters that Excel keeps in a cell, and ${cutCount === 1 ? "was" : "were"} cut to that: ${cut.join(", ")}${cutCount > cut.length ? " and others" : ""}. The words after the cut are not in the question.`,
    });
  }
  return { kind: "xlsx", sheets, notes };
}
