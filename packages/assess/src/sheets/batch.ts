/**
 * A batch of pages as a class of sheets: which pages belong together, and what is wrong with the order they came in.
 *
 * Pages arrive in the order they were scanned. A test of one page of answer sheet has a page for each student; a test of two pages has
 * a page 1 and then its page 2. Checks run after every page is read: the same picture twice is flagged and the second is not counted (it
 * would be scored twice); a page 2 with no page 1 before it, a page 1 with no page 2 after it, and pages that came in the wrong order are
 * flagged; and the pages of one student's sheet must name the same version. Nothing is moved or dropped to make a batch tidy: the flag
 * says what was seen, and a person settles it.
 *
 * A sheet's number is its place in the batch. It is the only name a sheet has: no name, no student number, and no file name is kept.
 */

import type { SheetResult } from "./read.ts";

export interface BatchEntry {
  /** Where the picture came from, for showing to the person: a label and a page. Never kept past the session. */
  source: { file: string; page: number };
  /** The picture's fingerprint (imageFingerprint), to tell the same picture from another. */
  fingerprint: string;
  result: SheetResult;
}

export interface BatchPage {
  /** The entry (a place in the batch's list of entries) and the page of the sheet it was taken to be, from 1. */
  entry: number;
  page: number;
  /** True when the picture was refused, and is only held as the place its page would have been. */
  refused: boolean;
}

export interface BatchSheet {
  /** Its place in the batch, from 1. */
  number: number;
  /** By page of the sheet, from the first. A page that never came is undefined. */
  pages: Array<BatchPage | undefined>;
  /** The version the pages name, when they name one. */
  version?: number;
}

export type BatchFlagKind = "duplicate" | "page-order" | "missing-page" | "version-mismatch" | "refused";

export interface BatchFlag {
  kind: BatchFlagKind;
  /** The entries the flag is about. */
  entries: number[];
  /** The sheet it is about, when there is one. */
  sheet?: number;
  reason: string;
}

export interface Batch {
  sheets: BatchSheet[];
  flags: BatchFlag[];
  /** The entries that are the same picture as an earlier one, and so are not on any sheet. */
  duplicates: number[];
}

const label = (e: BatchEntry): string => `${e.source.file}, page ${e.source.page}`;

export function assembleBatch(entries: readonly BatchEntry[], pagesPerSheet: number): Batch {
  if (!Number.isInteger(pagesPerSheet) || pagesPerSheet < 1) throw new Error("A sheet has at least one page.");
  const sheets: BatchSheet[] = [];
  const flags: BatchFlag[] = [];
  const duplicates: number[] = [];
  const seen = new Map<string, number>();
  let current: BatchSheet | undefined;

  const missingOf = (sheet: BatchSheet): number[] => sheet.pages.map((p, i) => (p ? 0 : i + 1)).filter((n) => n > 0);
  const closeSheet = (sheet: BatchSheet): void => {
    const missing = missingOf(sheet);
    if (missing.length > 0) {
      const there = sheet.pages.filter((p): p is BatchPage => p !== undefined);
      flags.push({
        kind: "missing-page",
        entries: there.map((p) => p.entry),
        sheet: sheet.number,
        reason: `Sheet ${sheet.number} has ${there.length} of its ${pagesPerSheet} pages: page${missing.length === 1 ? "" : "s"} ${missing.join(" and ")} did not come. Scan the missing page${missing.length === 1 ? "" : "s"} again, or check that the pages are in order.`,
      });
    }
    const versions = new Set<number>();
    for (const p of sheet.pages) {
      const r = p ? (entries[p.entry] as BatchEntry).result : undefined;
      if (r?.ok && r.version !== undefined) versions.add(r.version);
    }
    if (versions.size > 1) {
      flags.push({ kind: "version-mismatch", entries: sheet.pages.filter((p): p is BatchPage => p !== undefined).map((p) => p.entry), sheet: sheet.number, reason: `The pages of sheet ${sheet.number} do not name the same version (${[...versions].sort().map((v) => String.fromCharCode(64 + v)).join(" and ")}). They may be from two different students' sheets.` });
    }
    const first = [...versions][0];
    if (first !== undefined && versions.size === 1) sheet.version = first;
  };
  const start = (): BatchSheet => {
    if (current) closeSheet(current);
    current = { number: sheets.length + 1, pages: Array.from({ length: pagesPerSheet }, () => undefined) };
    sheets.push(current);
    return current;
  };

  entries.forEach((entry, index) => {
    const twin = seen.get(entry.fingerprint);
    if (twin !== undefined) {
      duplicates.push(index);
      flags.push({ kind: "duplicate", entries: [twin, index], reason: `${label(entry)} is the same picture as ${label(entries[twin] as BatchEntry)}. It was not counted again, so the sheet is not scored twice. If they are two different sheets that look alike, scan them again.` });
      return;
    }
    seen.set(entry.fingerprint, index);

    const incomplete = current && missingOf(current).length > 0 ? current : undefined;
    if (!entry.result.ok) {
      // A page that could not be read is held where it would have been: the next page the sheet in hand is waiting for, or the first of a new one.
      const sheet = incomplete ?? start();
      const slot = sheet.pages.findIndex((p) => p === undefined);
      sheet.pages[slot] = { entry: index, page: slot + 1, refused: true };
      flags.push({ kind: "refused", entries: [index], sheet: sheet.number, reason: `${label(entry)} was not read (${entry.result.reason}) and is held as page ${slot + 1} of sheet ${sheet.number}.` });
      return;
    }
    const page = entry.result.code.page;
    if (incomplete) {
      const expected = incomplete.pages.findIndex((p) => p === undefined) + 1;
      if (page === expected) {
        incomplete.pages[page - 1] = { entry: index, page, refused: false };
        return;
      }
      if (page > 1 && incomplete.pages[page - 1] === undefined) {
        incomplete.pages[page - 1] = { entry: index, page, refused: false };
        flags.push({ kind: "page-order", entries: [index], sheet: incomplete.number, reason: `${label(entry)} is page ${page} of sheet ${incomplete.number}, and came before page ${expected}. The pages are not in order.` });
        return;
      }
    }
    const sheet = start();
    sheet.pages[page - 1] = { entry: index, page, refused: false };
    if (page > 1) {
      flags.push({ kind: "page-order", entries: [index], sheet: sheet.number, reason: `${label(entry)} is page ${page} and there is no page ${page - 1} before it. If its earlier page comes later, the two are put together; if not, the sheet is missing a page.` });
    }
  });
  if (current) closeSheet(current);
  return { sheets, flags, duplicates };
}
