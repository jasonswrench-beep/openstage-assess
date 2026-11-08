/**
 * The importers, and choosing one for a file.
 *
 * The harness and the command line both need to turn a file name into an importer
 * and a file's bytes into a result, and they must do it the same way, or a file
 * would score one way and import another. So it is done here, once.
 */

import { aikenImporter, looksLikeAiken } from "./aiken.ts";
import { blackboardUploadImporter, looksLikeBlackboardUpload } from "./blackboard-upload.ts";
import { d2lCsvImporter, looksLikeD2lCsv } from "./d2l-csv.ts";
import { giftImporter, looksLikeGift } from "./gift.ts";
import { looksLikeMoodleXml, moodleXmlImporter } from "./moodle-xml.ts";
import { looksLikeQtiXml, qtiImporter } from "./qti.ts";
import { looksLikePdf, pdfImporter } from "./pdf.ts";
import { looksLikeQuestionTable, spreadsheetImporter } from "./spreadsheet.ts";
import { standardTextImporter } from "./standard-text.ts";
import type { Importer, ImportOptions, ImportResult } from "./types.ts";
import { wordImporter } from "./word.ts";

export const IMPORTERS: Importer[] = [standardTextImporter, wordImporter, aikenImporter, giftImporter, moodleXmlImporter, qtiImporter, spreadsheetImporter, d2lCsvImporter, blackboardUploadImporter, pdfImporter];

/** The importer that reads files with this name's extension, if there is one. */
export function importerFor(file: string): Importer | undefined {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return undefined;
  const extension = file.slice(dot).toLowerCase();
  return IMPORTERS.find((importer) => importer.extensions.includes(extension));
}

/** True for a file that begins `{\rtf`, which is what every Rich Text file begins with. */
function startsWithRtf(bytes: Uint8Array): boolean {
  const mark = "{\\rtf";
  return bytes.length >= mark.length && [...mark].every((c, i) => bytes[i] === c.charCodeAt(0));
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
  // A Rich Text file is not text: read as text its control words come in as stray lines of a question. It is sent to the Word
  // importer, which does not read it and says what to do instead (save it from Word as a .docx), by name or by what it begins with.
  if (file.toLowerCase().endsWith(".rtf") || startsWithRtf(bytes)) return wordImporter;
  const named = importerFor(file);
  // An .xml file is Moodle XML or QTI, told by its first element; a .zip is read as a QTI package and says so if it holds none.
  if (named === moodleXmlImporter && looksLikeQtiXml(Buffer.from(bytes.subarray(0, 4000)).toString("utf8"))) return qtiImporter;
  // A .csv whose first row is a NewQuestion row is a Brightspace question library, and not a table, whatever it was named.
  if ((named === spreadsheetImporter && /.csv$/i.test(file)) || !named || named === standardTextImporter) {
    if (looksLikeD2lCsv(bytes)) return d2lCsvImporter;
  }
  // A text file whose every row begins with a Blackboard question type and a tab, with the words correct, incorrect, true or false where the
  // format puts them, is Blackboard's upload file and not a table, whatever it was named (.txt or .tsv).
  if ((named === spreadsheetImporter && /.(csv|tsv)$/i.test(file)) || !named || named === standardTextImporter) {
    if (looksLikeBlackboardUpload(bytes)) return blackboardUploadImporter;
  }
  if (named && named !== standardTextImporter) return named;
  // A PDF is told by what it begins with, whatever it was named.
  if (looksLikePdf(bytes)) return pdfImporter;
  if (looksLikeQuestionTable(bytes)) return spreadsheetImporter;
  const text = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("utf8");
  if (looksLikeMoodleXml(text)) return moodleXmlImporter;
  if (looksLikeQtiXml(text)) return qtiImporter;
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
