/**
 * A table read from a spreadsheet file, before anything is made of it.
 *
 * Two readers fill it (`table-csv.ts` and `table-xlsx.ts`) and one importer (`spreadsheet.ts`) reads it, so the file kind
 * stops mattering once the cells are out. A row keeps the number the person sees in their spreadsheet program, so that a
 * problem can be reported as "row 14" and found there.
 */

export interface TableRow {
  /** The row's number as a spreadsheet shows it, counting from 1 and counting the empty rows. */
  number: number;
  /** The cells from the first column on, trimmed, with an empty string for a cell with nothing in it. */
  cells: string[];
}

export interface TableSheet {
  name: string;
  /** Only the rows with something in them. */
  rows: TableRow[];
  /** Rows the file marks as hidden (a filter or a person hid them). They are read all the same, and counted. */
  hiddenRows: number;
  /** The sheet is hidden in the workbook. It is read all the same, and counted. */
  hidden?: boolean;
}

export interface TableNote {
  severity: "info" | "warn";
  message: string;
}

export interface TableFile {
  kind: "csv" | "xlsx";
  sheets: TableSheet[];
  /** Things the reader has to say about the file as a whole, in words. */
  notes: TableNote[];
}

/** A file that cannot be read as a table. The message says why, and what to do. */
export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableError";
  }
}

/** Most columns read from a row. A sheet is not a database; what lies beyond is reported, not read. */
export const MAX_COLUMNS = 256;

/** Most rows read from one sheet. */
export const MAX_ROWS = 200_000;
