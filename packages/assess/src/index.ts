/**
 * @openstage/assess
 *
 * The OpenAssess engine. Nothing in here touches the filesystem except the
 * bank's own open and save, nothing touches a window, and nothing depends on
 * Tauri, so the same code runs in the desktop application, in the command-line
 * tool, in a test, and inside OpenStage Author and OpenStage Scroll.
 *
 * Consumers that only need to read a bank should import "@openstage/assess/read"
 * instead. That entry point is frozen; this one is not.
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

// Harness
export * from "./harness/score.ts";
export { runHarness, IMPORTERS, TARGET_SCORE } from "./harness/run.ts";
export type { HarnessRun } from "./harness/run.ts";
