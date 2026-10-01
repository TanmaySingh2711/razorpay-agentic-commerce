@echo off
rem One-click setup for Windows. Double-click it, or run:  setup.bat
rem
rem A thin front door for `npm run setup` (scripts\setup.ts), which does the
rem real work: installs the locked dependencies, creates .env.local, makes sure
rem a local PostgreSQL is running (Docker Desktop, or one already listening on
rem localhost:5432), and prepares the test and development databases. This file
rem only checks that Node.js is present and the right version first, so a
rem missing prerequisite is one clear sentence instead of a stack trace.

setlocal
cd /d "%~dp0"

set /p WANTED=<.nvmrc
set "WANTED=%WANTED: =%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js %WANTED% from https://nodejs.org and run this again.
  goto :failed
)

for /f "tokens=1 delims=." %%v in ('node --version') do set "ACTUAL=%%v"
set "ACTUAL=%ACTUAL:v=%"
if not "%ACTUAL%"=="%WANTED%" (
  echo This project needs Node.js %WANTED%; you have version %ACTUAL%. Install Node.js %WANTED% from https://nodejs.org and run this again.
  goto :failed
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. It ships with Node.js - reinstall Node.js %WANTED% from https://nodejs.org.
  goto :failed
)

call npm run setup
if errorlevel 1 goto :failed

echo.
echo Next: run_dashboard.bat starts the app and opens it in your browser.
if not defined CI pause
exit /b 0

:failed
echo.
echo Setup did not finish. Fix the message above and run setup.bat again.
if not defined CI pause
exit /b 1
