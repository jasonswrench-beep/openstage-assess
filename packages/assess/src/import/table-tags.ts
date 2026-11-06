/**
 * How a data table travels from a reader to the question that keeps it.
 *
 * The scanner reads lines, and a table has no place in a line. The Word reader hands over, beside its blocks, the tables that are
 * grids and none of the question layouts, by the table's number. When the scanner meets a line of such a table where it would have
 * added a line to a question's stem, and the table is not the one the question stands in, it writes one tag, `[ tbl: "7" ]`, in the
 * stem's lines where the table stood, takes the table's other cells as read, and the question builder turns the tag into a table of
 * the question, with the cells as they were in the file.
 *
 * Held for the length of one `parse`, like the equations (`math-tags.ts`), for the same reason: the places that read lines are many.
 */

import type { ReadTable } from "./types.ts";

export const TABLE_TAG = /\[\s*tbl\s*:\s*"(\d{1,6})"\s*\]/gi;

let active: ReadonlyMap<number, ReadTable> = new Map();

/** Runs `run` with these grids to look tables up in, and puts the previous ones back after, however it ends. */
export function withTableGrids<T>(grids: ReadonlyMap<number, ReadTable> | undefined, run: () => T): T {
  const before = active;
  active = grids ?? new Map();
  try {
    return run();
  } finally {
    active = before;
  }
}

export const gridFor = (table: number): ReadTable | undefined => active.get(table);

export const tableTag = (table: number): string => `[ tbl: "${table}" ]`;
