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

// Import
export * from "./import/types.ts";
export { standardTextImporter, PROFILE_ID as STANDARD_TEXT_PROFILE } from "./import/standard-text.ts";
export { wordImporter, docxToBlocks, WORD_PROFILE_ID } from "./import/word.ts";
export { DocxError, openDocx } from "./import/docx/package.ts";
export { IMPORTERS, importerFor, runImporter } from "./import/registry.ts";

// Export
export * from "./export/types.ts";
export {
  exportOpenStageSpreadsheet,
  checkOpenStageSpreadsheet,
  DESTINATION_ID as OPENSTAGE_SPREADSHEET,
  MAX_QUESTIONS_PER_FILE as OPENSTAGE_SPREADSHEET_MAX_QUESTIONS,
} from "./export/openstage-spreadsheet.ts";
export type { SpreadsheetOptions } from "./export/openstage-spreadsheet.ts";

// Harness
export * from "./harness/score.ts";
export { runHarness, TARGET_SCORE } from "./harness/run.ts";
export type { HarnessRun } from "./harness/run.ts";
