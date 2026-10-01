@echo off
rem Starts the app on Windows and opens it in your browser.
rem Double-click it, or run:  run_dashboard.bat
rem
rem It runs `npm run dev`, which serves the shop at http://localhost:3000 with
rem the merchant dashboard at /merchant. Run setup.bat once first. Press Ctrl+C
rem in this window to stop the app.

setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Run setup.bat first - it tells you what to install.
  goto :failed
)

if not exist "node_modules\next\package.json" (
  echo The project is not set up yet. Run setup.bat first, then run this again.
  goto :failed
)

echo Starting the app at http://localhost:3000
echo The merchant dashboard is at http://localhost:3000/merchant
echo Press Ctrl+C to stop.
echo.

rem Open the browser a few seconds after the server starts, without blocking it.
start "" /b cmd /c "ping -n 7 127.0.0.1 >nul & start "" http://localhost:3000"

call npm run dev
exit /b %errorlevel%

:failed
echo.
if not defined CI pause
exit /b 1
