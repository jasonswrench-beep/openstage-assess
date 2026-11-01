/**
 * The one place the app reaches into the engine. The engine is read from its source, next to this package, so the app
 * installs by copying, like the engine, and nothing here needs the engine to be built first.
 */

export * from "../../assess/src/index.ts";
export { checkAnswerKey } from "../../assess/src/quality/answer-key.ts";
export { DESTINATION_LABEL as OPENSTAGE_SPREADSHEET_LABEL } from "../../assess/src/export/openstage-spreadsheet.ts";
