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
export { replaceTables, tablesIn, readTableHtml, titleText } from "./model/table.ts";
export type { TableCell, TableView } from "./model/table.ts";
export { sniffImage, describeUnreadImage, MAX_PICTURE_BYTES } from "./model/image.ts";
export { addPicture, replacePicture, removePicture, placedPictures, PictureError, MAX_PICTURES_PER_QUESTION } from "./model/picture-edit.ts";
export type { PictureEdit } from "./model/picture-edit.ts";
export type { ImageInfo, ImageMime } from "./model/image.ts";
export * from "./model/findings.ts";
export * from "./model/question.ts";
export * from "./model/schema.ts";
export * from "./model/test.ts";
export { shuffledFor, seededRandom } from "./model/random.ts";
export { planSheet, useOf } from "./sheets/plan.ts";
export type { DrawnSlot, PlanOptions, PlanResult, SheetPlan, SlotKind, SlotUse } from "./sheets/plan.ts";
export { printSheet, sheetCode } from "./sheets/print.ts";
export type { SheetFile, SheetInput } from "./sheets/print.ts";
export { CODE_BITS, codeProblem, decodeCode, encodeCode } from "./sheets/code.ts";
export type { CodeReading, SheetCode } from "./sheets/code.ts";
export * as sheetGeometry from "./sheets/geometry.ts";
export { SheetReader, decideAll, isBilevel } from "./sheets/read.ts";
export type { QuestionReading, SheetFlag, SheetReading, SheetResult } from "./sheets/read.ts";
export type { Refusal, RefusalCause } from "./sheets/locate.ts";
export { checkPrinting } from "./sheets/check-print.ts";
export type { PrintingCheck } from "./sheets/check-print.ts";
export { FILLED, BLANK, BLANK_MULTIPLE, decideQuestion, decideVersion } from "./sheets/decide.ts";
export { readPng, writePng, imageFingerprint } from "./sheets/image.ts";
export type { GreyImage, PngReading } from "./sheets/image.ts";
export { openScans, sniffPicture, refusalFor } from "./sheets/intake.ts";
export type { Intake, IntakePage, PictureKind, Source } from "./sheets/intake.ts";
export { readPdfPictures, orient } from "./sheets/pdf-page.ts";
export type { Orientation, PagePicture, PdfPagePicture, PictureRefusalCause } from "./sheets/pdf-page.ts";
export { cropRects, CROP_DPI } from "./sheets/crop.ts";
export { printTestPaper, DEFAULT_PAPER } from "./sheets/paper.ts";
export type { PaperFile, PaperOptions, PaperResult } from "./sheets/paper.ts";
export { assembleBatch } from "./sheets/batch.ts";
export type { Batch, BatchEntry, BatchFlag, BatchSheet } from "./sheets/batch.ts";
export { adjustmentEffect, adjustmentWords, keyOf, pointsOf, scoreSheets, settleSheets } from "./sheets/score.ts";
export type { Adjustment, Decision, Outcome, QuestionScore, SettledAnswer, SettledSheet, SheetScore } from "./sheets/score.ts";
export { SMALL_GROUP, itemStatistics } from "./sheets/stats.ts";
export type { ItemStatistics, OptionCount, TestStatistics } from "./sheets/stats.ts";
export { SCORES_EXTENSION, newScoresFile, readScoresFile, restore, scoresFileName, writeScoresFile } from "./sheets/scores-file.ts";
export type { ScoresFile } from "./sheets/scores-file.ts";
export { exportResults, itemAnalysisHtml } from "./sheets/results-export.ts";
export { administrationFrom, validateAdministration } from "./model/statistics.ts";
export type { Administration, AdministrationItem } from "./model/statistics.ts";
export { runSheetGate, formatGate } from "./sheets/gate.ts";
export type { GateReport } from "./sheets/gate.ts";
export { versionKey } from "./quality/test-key.ts";
export type { VersionKeyEntry } from "./quality/test-key.ts";
export * from "./model/create.ts";
export * from "./model/migrate.ts";
export * from "./model/bank.ts";

// Container and bank
export * from "./container/zip.ts";
export * from "./container/layout.ts";
export { Bank, countMismatchMessage } from "./bank/store.ts";
export type { OpenReport, BankStats, QualityRun } from "./bank/store.ts";
export { SearchIndex, fold, tokenize, searchableText, matchesQuery } from "./bank/search.ts";
export { COVERAGE_AXES, NONE as COVERAGE_NONE, coverage, facets, isCoverageAxis, matchesFacets, valuesOn } from "./bank/coverage.ts";
export type { CoverageAxis, CoverageGrid, CoverageOptions, Facet } from "./bank/coverage.ts";
export { MOST_PICKED, pickQuestions } from "./bank/pick.ts";
export type { PickOptions, PickResult } from "./bank/pick.ts";
export { BLUEPRINT_VERSION, LONGEST_NAME, LONGEST_VALUE, MOST_RULES, describeDraw, drawBlueprint, newBlueprint, validateBlueprint } from "./bank/blueprint.ts";
export type { Blueprint, BlueprintCheck, BlueprintDraw, BlueprintRule, DrawOptions, RuleResult } from "./bank/blueprint.ts";

// Quality
export * from "./quality/answer-key.ts";
export * from "./quality/placeholders.ts";
export { checkItemQuality, withFreshQuality, QUALITY_CODES, LONG_MATCHING_LIST } from "./quality/items.ts";
export { checkBankQuality, findDuplicates, keyBalance, overusedLetter } from "./quality/bank.ts";
export type { BankQualityReport, DuplicateGroup, KeyBalance } from "./quality/bank.ts";

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
export { exportQti21, checkQti21, QTI21_ID, QTI21_LABEL, QTI21_TEST_TYPE, QTI21_ITEM_TYPE } from "./export/qti21.ts";
export type { Qti21Options } from "./export/qti21.ts";
export { exportCommonCartridge, checkCommonCartridge, COMMON_CARTRIDGE_ID, COMMON_CARTRIDGE_LABEL, CC_ASSESSMENT_TYPE } from "./export/common-cartridge.ts";
export type { CommonCartridgeOptions } from "./export/common-cartridge.ts";
export type { MoodleXmlOptions } from "./export/moodle-xml.ts";

// Printing
export { printTest, printVersions, printOptions, layoutTest, writeDocx, writePdf, PAPERS, PRINT_ID, PRINT_LABEL } from "./print/index.ts";
export type { PrintFormat, PrintOptions, PrintDocument, PrintResult, PrintedFile, VersionPrint, Layout as PrintLayout } from "./print/index.ts";

// Harness
export * from "./harness/score.ts";
export { runHarness, TARGET_SCORE } from "./harness/run.ts";
export type { HarnessRun } from "./harness/run.ts";
