@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or Windows cannot find it.
  echo.
  echo Install the LTS version from https://nodejs.org, then run this again.
  echo Nothing else needs installing: OpenAssess has no dependencies.
  echo.
  pause
  exit /b 1
)

echo OpenAssess is starting. Your browser will open in a moment.
echo Close this window to stop it.
echo.
node --experimental-strip-types --no-warnings packages\app\src\main.ts --open
if errorlevel 1 (
  echo.
  echo OpenAssess could not start. The message above says why.
  echo.
  pause
  exit /b 1
)
