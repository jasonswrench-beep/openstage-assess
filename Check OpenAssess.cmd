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
echo  1 of 3  Tests
echo ----------------------------------------------------------------
%RUN% --test "%ENGINE%\test\model.test.ts" "%ENGINE%\test\bank.test.ts" "%ENGINE%\test\read-contract.test.ts" "%ENGINE%\test\import.test.ts" "%ENGINE%\test\answer-key.test.ts" "%ENGINE%\test\harness.test.ts" "%ENGINE%\test\richtext-enforcement.test.ts" "%ENGINE%\test\store-resilience.test.ts" "%ENGINE%\test\standard-text-scanner.test.ts" "%ENGINE%\test\export-openstage-spreadsheet.test.ts"
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  2 of 3  Import accuracy against the fixture corpus
echo ----------------------------------------------------------------
%RUN% "%ENGINE%\src\cli\index.ts" score fixtures\standard-format
if errorlevel 1 goto failed
echo.

echo ----------------------------------------------------------------
echo  3 of 3  Speed on a 500-question bank
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
