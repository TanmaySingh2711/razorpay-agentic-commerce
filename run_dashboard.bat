@echo off
rem Starts the app on Windows and opens it in your browser.
rem Double-click it, or run:  run_dashboard.bat
rem
rem The window opens in the centre of the screen. The browser opens at
rem http://localhost:3000 once the app is actually serving pages. Press Esc in
rem this window to stop the app and close the window. Run setup.bat once first.

setlocal
cd /d "%~dp0"

rem Windows 11 opens batch files in Windows Terminal, whose window a script
rem cannot place. Reopen once in a classic console window, which can be
rem centred and closed with Esc. Skipped where conhost does not exist.
if /i not "%~1"=="--here" if exist "%SystemRoot%\System32\conhost.exe" (
  start "" "%SystemRoot%\System32\conhost.exe" cmd.exe /c ""%~f0" --here"
  exit /b 0
)

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Run setup.bat first - it tells you what to install.
  goto :failed
)

if not exist "node_modules\next\package.json" (
  echo The project is not set up yet. Run setup.bat first, then run this again.
  goto :failed
)

rem The launcher keeps its own window open on an error, so its exit code is
rem passed straight through rather than pausing a second time.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-dashboard.ps1"
exit /b %errorlevel%

:failed
echo.
if not defined CI pause
exit /b 1
