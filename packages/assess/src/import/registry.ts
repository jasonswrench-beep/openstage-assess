/**
 * The importers, and choosing one for a file.
 *
 * The harness and the command line both need to turn a file name into an importer
 * and a file's bytes into a result, and they must do it the same way, or a file
 * would score one way and import another. So it is done here, once.
 */

import { aikenImporter, looksLikeAiken } from "./aiken.ts";
import { giftImporter, looksLikeGift } from "./gift.ts";
import { looksLikePdf, pdfImporter } from "./pdf.ts";
import { looksLikeQuestionTable, spreadsheetImporter } from "./spreadsheet.ts";
import { standardTextImporter } from "./standard-text.ts";
import type { Importer, ImportOptions, ImportResult } from "./types.ts";
import { wordImporter } from "./word.ts";

export const IMPORTERS: Importer[] = [standardTextImporter, wordImporter, aikenImporter, giftImporter, spreadsheetImporter, pdfImporter];

/** The importer that reads files with this name's extension, if there is one. */
export function importerFor(file: string): Importer | undefined {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return undefined;
  const extension = file.slice(dot).toLowerCase();
  return IMPORTERS.find((importer) => importer.extensions.includes(extension));
}

/** How much of a text file is looked at to tell which format it is in. More than enough to see a pattern, and bounded. */
const SNIFF_BYTES = 400_000;

/**
 * The importer for a file, from its name and then, for a plain text file, from what is in it. A file called .txt may be the
 * Standard Format, Aiken or GIFT, and each is told by its shape: GIFT has answers in braces, Aiken has unnumbered questions
 * with an ANSWER line, and anything else is the Standard Format, which is what a .txt file was always read as. A name that
 * names a format (.docx, .aiken, .gift, .xlsx, .csv) is believed. A text file whose first row names a Question column and the
 * answers is a question table, which is what a spreadsheet's "Unicode Text" is.
 */
export function importerForContent(file: string, bytes: Uint8Array): Importer {
  const named = importerFor(file);
  if (named && named !== standardTextImporter) return named;
  // A PDF is told by what it begins with, whatever it was named.
  if (looksLikePdf(bytes)) return pdfImporter;
  if (looksLikeQuestionTable(bytes)) return spreadsheetImporter;
  const text = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("utf8");
  if (looksLikeGift(text)) return giftImporter;
  if (looksLikeAiken(text)) return aikenImporter;
  return standardTextImporter;
}

/**
 * Run an importer on a file's bytes. A format that is not text is handed the
 * bytes; the others are decoded as UTF-8, keeping a byte order mark if there is
 * one, which is what reading the file as text always did.
 */
export function runImporter(importer: Importer, bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  if (importer.parseBytes) return importer.parseBytes(bytes, options);
  return importer.parse(Buffer.from(bytes).toString("utf8"), options);
}
