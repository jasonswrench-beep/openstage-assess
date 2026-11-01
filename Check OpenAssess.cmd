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
echo  1 of 4  Engine tests
echo ----------------------------------------------------------------
%RUN% --test "%ENGINE%\test\model.test.ts" "%ENGINE%\test\bank.test.ts" "%ENGINE%\test\read-contract.test.ts" "%ENGINE%\test\import.test.ts" "%ENGINE%\test\answer-key.test.ts" "%ENGINE%\test\harness.test.ts" "%ENGINE%\test\richtext-enforcement.test.ts" "%ENGINE%\test\store-resilience.test.ts" "%ENGINE%\test\standard-text-scanner.test.ts" "%ENGINE%\test\export-openstage-spreadsheet.test.ts" "%ENGINE%\test\export-d2l-csv.test.ts" "%ENGINE%\test\zip-names.test.ts" "%ENGINE%\test\docx-xml.test.ts" "%ENGINE%\test\docx-package.test.ts" "%ENGINE%\test\docx-document.test.ts" "%ENGINE%\test\word-lists.test.ts" "%ENGINE%\test\docx-formatting.test.ts" "%ENGINE%\test\word-answer-marks.test.ts" "%ENGINE%\test\question-labels.test.ts" "%ENGINE%\test\word-tables.test.ts" "%ENGINE%\test\word-authored.test.ts" "%ENGINE%\test\word-publisher-layout.test.ts" "%ENGINE%\test\star-after-letter.test.ts" "%ENGINE%\test\instructor-layouts.test.ts" "%ENGINE%\test\blind-layouts.test.ts" "%ENGINE%\test\type-line-layout.test.ts" "%ENGINE%\test\type-from-evidence.test.ts" "%ENGINE%\test\generated-bank-check.test.ts" "%ENGINE%\test\end-marks.test.ts" "%ENGINE%\test\key-lists.test.ts" "%ENGINE%\test\question-starts.test.ts" "%ENGINE%\test\shared-line-options.test.ts" "%ENGINE%\test\type-from-answers.test.ts" "%ENGINE%\test\unlabelled-groups-step.test.ts" "%ENGINE%\test\unlabelled-groups.test.ts" "%ENGINE%\test\bulleted-options.test.ts" "%ENGINE%\test\statement-answers.test.ts" "%ENGINE%\test\hidden-text.test.ts" "%ENGINE%\test\review-html.test.ts" "%ENGINE%\test\ids-order.test.ts" "%ENGINE%\test\cheap-formats.test.ts" "%ENGINE%\test\print.test.ts" "%ENGINE%\test\spreadsheet.test.ts" "%ENGINE%\test\answer-line-words.test.ts" "%ENGINE%\test\answer-by-hand.test.ts" "%ENGINE%\test\pdf-publisher.test.ts" "%ENGINE%\test\pdf.test.ts" "%ENGINE%\test\word-import.test.ts"
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  2 of 4  App tests
echo ----------------------------------------------------------------
%RUN% --test "packages\app\test\editor.test.ts" "packages\app\test\samples.test.ts" "packages\app\test\server.test.ts"
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  3 of 4  Import accuracy against the fixture corpus
echo ----------------------------------------------------------------
%RUN% "%ENGINE%\src\cli\index.ts" score fixtures\standard-format
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  4 of 4  Speed on a 500-question bank
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
