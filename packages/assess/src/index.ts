/**
 * @openstage/assess
 *
 * The OpenAssess engine. Nothing in here touches the filesystem except the
 * bank's own open and save, nothing touches a window, and nothing depends on
 * Tauri, so the same code runs in the desktop application, in the command-line
 * tool and in a test.
 *
 * "@openstage/assess/read" is a smaller entry point built for other OpenStage
 * tools. Nothing uses it, and it may be removed (see docs/design-plan.md).
 */

export * from "./naming.ts";

// Model
export * from "./model/ids.ts";
export * from "./model/richtext.ts";
export * from "./model/findings.ts";
export * from "./model/question.ts";
export * from "./model/schema.ts";
export * from "./model/create.ts";
export * from "./model/migrate.ts";
export * from "./model/bank.ts";

// Container and bank
export * from "./container/zip.ts";
export * from "./container/layout.ts";
export { Bank } from "./bank/store.ts";
export type { OpenReport, BankStats } from "./bank/store.ts";
export { SearchIndex, tokenize, searchableText, matchesQuery } from "./bank/search.ts";

// Quality
export * from "./quality/answer-key.ts";
export * from "./quality/placeholders.ts";

// Import
export * from "./import/types.ts";
export { standardTextImporter, PROFILE_ID as STANDARD_TEXT_PROFILE } from "./import/standard-text.ts";
export { wordImporter, docxToBlocks, WORD_PROFILE_ID } from "./import/word.ts";
export { DocxError, openDocx } from "./import/docx/package.ts";
export { IMPORTERS, importerFor, importerForContent, runImporter } from "./import/registry.ts";
export { aikenImporter, AIKEN_PROFILE_ID, looksLikeAiken } from "./import/aiken.ts";
export { giftImporter, GIFT_PROFILE_ID, looksLikeGift, giftUnescape } from "./import/gift.ts";
export { spreadsheetImporter, SPREADSHEET_PROFILE_ID, looksLikeQuestionTable } from "./import/spreadsheet.ts";
export { pdfImporter, PDF_PROFILE_ID, looksLikePdf, pdfToBlocks } from "./import/pdf.ts";
export { PdfError } from "./import/pdf/objects.ts";
export { readXlsx } from "./import/table-xlsx.ts";
export { readCsv } from "./import/table-csv.ts";
export { TableError } from "./import/table.ts";
export type { TableFile, TableSheet, TableRow } from "./import/table.ts";

// Export
export * from "./export/types.ts";
export {
  exportOpenStageSpreadsheet,
  checkOpenStageSpreadsheet,
  DESTINATION_ID as OPENSTAGE_SPREADSHEET,
  MAX_QUESTIONS_PER_FILE as OPENSTAGE_SPREADSHEET_MAX_QUESTIONS,
} from "./export/openstage-spreadsheet.ts";
export type { SpreadsheetOptions } from "./export/openstage-spreadsheet.ts";
export { exportGift, checkGift, giftEscape, GIFT_ID, GIFT_LABEL } from "./export/gift.ts";
export type { GiftOptions } from "./export/gift.ts";
export { exportMoodleXml, checkMoodleXml, MOODLE_XML_ID, MOODLE_XML_LABEL } from "./export/moodle-xml.ts";
export { exportD2lCsv, checkD2lCsv, D2L_CSV_ID, D2L_CSV_LABEL } from "./export/d2l-csv.ts";
export type { D2lCsvOptions } from "./export/d2l-csv.ts";
export { exportBlackboardUpload, checkBlackboardUpload, BLACKBOARD_UPLOAD_ID, BLACKBOARD_UPLOAD_LABEL } from "./export/blackboard-upload.ts";
export type { BlackboardUploadOptions } from "./export/blackboard-upload.ts";
export { exportQti12, checkQti12, QTI12_ID, QTI12_LABEL, QTI12_RESOURCE_TYPE } from "./export/qti12.ts";
export type { Qti12Options } from "./export/qti12.ts";
export type { MoodleXmlOptions } from "./export/moodle-xml.ts";

// Printing
export { printTest, printOptions, layoutTest, writeDocx, writePdf, PAPERS, PRINT_ID, PRINT_LABEL } from "./print/index.ts";
export type { PrintFormat, PrintOptions, PrintDocument, PrintResult, PrintedFile, Layout as PrintLayout } from "./print/index.ts";

// Harness
export * from "./harness/score.ts";
export { runHarness, TARGET_SCORE } from "./harness/run.ts";
export type { HarnessRun } from "./harness/run.ts";
