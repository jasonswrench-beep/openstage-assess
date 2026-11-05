@echo off
setlocal
cd /d "%~dp0"

echo ================================================================
echo  OpenAssess engine check
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or Windows cannot find it.
  echo.
  echo Install the LTS version from https://nodejs.org, then run this again.
  echo Nothing else needs installing: the engine has no dependencies.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODEVER=%%v
echo Using Node %NODEVER%
echo.

set ENGINE=packages\assess
set RUN=node --experimental-strip-types --no-warnings

echo ----------------------------------------------------------------
echo  1 of 5  Engine tests
echo ----------------------------------------------------------------
%RUN% --test "%ENGINE%\test\model.test.ts" "%ENGINE%\test\bank.test.ts" "%ENGINE%\test\read-contract.test.ts" "%ENGINE%\test\import.test.ts" "%ENGINE%\test\answer-key.test.ts" "%ENGINE%\test\harness.test.ts" "%ENGINE%\test\richtext-enforcement.test.ts" "%ENGINE%\test\store-resilience.test.ts" "%ENGINE%\test\standard-text-scanner.test.ts" "%ENGINE%\test\export-openstage-spreadsheet.test.ts" "%ENGINE%\test\export-d2l-csv.test.ts" "%ENGINE%\test\export-qti12.test.ts" "%ENGINE%\test\export-common-cartridge.test.ts" "%ENGINE%\test\export-blackboard-upload.test.ts" "%ENGINE%\test\test-record.test.ts" "%ENGINE%\test\sheet-code.test.ts" "%ENGINE%\test\sheet-print.test.ts" "%ENGINE%\test\sheet-image.test.ts" "%ENGINE%\test\sheet-raster.test.ts" "%ENGINE%\test\sheet-locate.test.ts" "%ENGINE%\test\sheet-decide.test.ts" "%ENGINE%\test\sheet-measure.test.ts" "%ENGINE%\test\sheet-read.test.ts" "%ENGINE%\test\sheet-gate.test.ts" "%ENGINE%\test\sheet-cli.test.ts" "%ENGINE%\test\sheet-pdf.test.ts" "%ENGINE%\test\sheet-intake.test.ts" "%ENGINE%\test\sheet-batch.test.ts" "%ENGINE%\test\sheet-score.test.ts" "%ENGINE%\test\sheet-results.test.ts" "%ENGINE%\test\sheet-crop.test.ts" "%ENGINE%\test\sheet-paper.test.ts" "%ENGINE%\test\quality-items.test.ts" "%ENGINE%\test\quality-bank.test.ts" "%ENGINE%\test\quality-cli.test.ts" "%ENGINE%\test\search-fold.test.ts" "%ENGINE%\test\small-defects.test.ts" "%ENGINE%\test\check-cmd.test.ts" "%ENGINE%\test\coverage.test.ts" "%ENGINE%\test\pick.test.ts" "%ENGINE%\test\zip-names.test.ts" "%ENGINE%\test\docx-xml.test.ts" "%ENGINE%\test\docx-package.test.ts" "%ENGINE%\test\docx-document.test.ts" "%ENGINE%\test\word-lists.test.ts" "%ENGINE%\test\docx-formatting.test.ts" "%ENGINE%\test\word-answer-marks.test.ts" "%ENGINE%\test\question-labels.test.ts" "%ENGINE%\test\word-tables.test.ts" "%ENGINE%\test\word-authored.test.ts" "%ENGINE%\test\word-publisher-layout.test.ts" "%ENGINE%\test\star-after-letter.test.ts" "%ENGINE%\test\instructor-layouts.test.ts" "%ENGINE%\test\blind-layouts.test.ts" "%ENGINE%\test\type-line-layout.test.ts" "%ENGINE%\test\type-from-evidence.test.ts" "%ENGINE%\test\generated-bank-check.test.ts" "%ENGINE%\test\end-marks.test.ts" "%ENGINE%\test\key-lists.test.ts" "%ENGINE%\test\question-starts.test.ts" "%ENGINE%\test\shared-line-options.test.ts" "%ENGINE%\test\type-from-answers.test.ts" "%ENGINE%\test\unlabelled-groups-step.test.ts" "%ENGINE%\test\unlabelled-groups.test.ts" "%ENGINE%\test\bulleted-options.test.ts" "%ENGINE%\test\statement-answers.test.ts" "%ENGINE%\test\hidden-text.test.ts" "%ENGINE%\test\review-html.test.ts" "%ENGINE%\test\ids-order.test.ts" "%ENGINE%\test\cheap-formats.test.ts" "%ENGINE%\test\print.test.ts" "%ENGINE%\test\spreadsheet.test.ts" "%ENGINE%\test\answer-line-words.test.ts" "%ENGINE%\test\answer-by-hand.test.ts" "%ENGINE%\test\placeholder-repair.test.ts" "%ENGINE%\test\pdf-publisher.test.ts" "%ENGINE%\test\pdf.test.ts" "%ENGINE%\test\word-import.test.ts"
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  2 of 5  App tests
echo ----------------------------------------------------------------
%RUN% --test "packages\app\test\editor.test.ts" "packages\app\test\samples.test.ts" "packages\app\test\server.test.ts" "packages\app\test\sheets.test.ts" "packages\app\test\quality.test.ts" "packages\app\test\coverage.test.ts" "packages\app\test\pick.test.ts"
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  3 of 5  Import accuracy against the fixture corpus
echo ----------------------------------------------------------------
%RUN% "%ENGINE%\src\cli\index.ts" score fixtures\standard-format
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  4 of 5  Answer sheet reading: no answer read wrong without a flag
echo ----------------------------------------------------------------
%RUN% "%ENGINE%\src\cli\index.ts" sheets gate --sheets 40
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  5 of 5  Speed on a 500-question bank
echo ----------------------------------------------------------------
%RUN% "%ENGINE%\src\cli\index.ts" perf --count 500
if errorlevel 1 goto failed
echo.

echo ================================================================
echo  Everything passed.
echo ================================================================
echo.
pause
exit /b 0

:failed
echo.
echo ================================================================
echo  Something did not pass. The output above says what.
echo ================================================================
echo.
pause
exit /b 1
