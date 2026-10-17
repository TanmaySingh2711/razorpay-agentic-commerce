# Runs the app for run_dashboard.bat: centres this window, starts the dev
# server, opens the browser once a page is actually being served, and stops
# everything when Esc is pressed.
#
# Started by run_dashboard.bat with -ExecutionPolicy Bypass, so it works on a
# machine where running PowerShell scripts is otherwise turned off. ASCII only:
# Windows PowerShell 5.1 reads a file without a BOM in the local code page.

$ErrorActionPreference = "Stop"
$Url = "http://localhost:3000"
$Port = 3000

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DashboardWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Move-ToCentre {
    # Centres the console window on the primary screen's work area (the
    # screen minus the taskbar). Does nothing in a terminal that does not own
    # a real window, such as Windows Terminal - run_dashboard.bat opens a
    # classic console window precisely so this works.
    try {
        $handle = [DashboardWindow]::GetConsoleWindow()
        if ($handle -eq [IntPtr]::Zero) { return }
        $rect = New-Object DashboardWindow+Rect
        if (-not [DashboardWindow]::GetWindowRect($handle, [ref]$rect)) { return }
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $x = $area.Left + [Math]::Max(0, [int](($area.Width - $width) / 2))
        $y = $area.Top + [Math]::Max(0, [int](($area.Height - $height) / 2))
        [void][DashboardWindow]::MoveWindow($handle, $x, $y, $width, $height, $true)
        [void][DashboardWindow]::SetForegroundWindow($handle)
    } catch {
        # A window that cannot be moved is not a reason to stop the app.
    }
}

function Test-PortInUse {
    # Reads the listening ports instead of trying to connect: on Windows a
    # connection to a closed port takes two seconds to fail (four through
    # localhost, which tries IPv6 first), and this takes a few milliseconds.
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return [bool]($listeners | Where-Object { $_.Port -eq $Port })
}

function Test-Serving {
    # True once the app answers with a real page. The request also makes the
    # dev server compile the page, so the browser does not wait on it. Nothing
    # is requested before the port is open, for the reason given above.
    if (-not (Test-PortInUse)) { return $false }
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 90
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-EscapePressed {
    while ([Console]::KeyAvailable) {
        if ([Console]::ReadKey($true).Key -eq [ConsoleKey]::Escape) { return $true }
    }
    return $false
}

function Stop-Server($process) {
    if ($null -ne $process -and -not $process.HasExited) {
        # Next.js starts worker processes of its own: stop the whole tree, or
        # the port stays taken by an orphan the next run would trip over.
        & taskkill.exe /PID $process.Id /T /F *> $null
    }
}

function Start-Node([string[]]$arguments) {
    return Start-Process -FilePath "node.exe" -ArgumentList $arguments -NoNewWindow -PassThru
}

# Pages compiled in the background once the browser is open, so the first
# click on each is as quick as the second. The purchase address names a
# purchase that does not exist: the answer is "not found", but the page a real
# purchase opens is compiled by then all the same.
$NoSuchPurchase = "/shop/00000000-0000-4000-8000-000000000000"
$WarmPages = @("/shop", "/how-it-works", "/history", "/merchant", $NoSuchPurchase)

$Host.UI.RawUI.WindowTitle = "Razorpay Agentic Commerce - press Esc to stop"
Move-ToCentre

if (Test-PortInUse) {
    Write-Host ""
    Write-Host "Something is already running on port $Port." -ForegroundColor Yellow
    Write-Host "If it is this app from an earlier run, close that window first."
    Write-Host "Opening $Url anyway. Press Esc to close this window."
    Start-Process $Url
    while (-not (Test-EscapePressed)) { Start-Sleep -Milliseconds 150 }
    exit 0
}

Write-Host ""
Write-Host "  Razorpay Agentic Commerce" -ForegroundColor Red
Write-Host "  Starting the app at $Url and checking the database alongside it."
Write-Host "  The browser opens by itself as soon as the first page is ready."
Write-Host "  Press Esc to stop the app and close this window."
Write-Host ""

# Started side by side rather than one after the other (which is what
# `npm run dev` does through `predev`). The overview needs no database, so the
# browser can open while the database check - or Docker starting, after a
# reboot - is still running. Both are called through node directly: going
# through npm costs about a second for nothing.
$database = Start-Node @("node_modules/tsx/dist/cli.mjs", "scripts/start-database.ts")
$server = Start-Node @("node_modules/next/dist/bin/next", "dev")
$opened = $false
$stopped = $false
$started = Get-Date

try {
    while (-not $server.HasExited) {
        if (Test-EscapePressed) { $stopped = $true; break }

        if (-not $opened) {
            if (Test-Serving) {
                Start-Process $Url
                $opened = $true
                Write-Host ""
                Write-Host "  Opened $Url  (Esc stops the app)" -ForegroundColor Green
                Write-Host ""
                foreach ($page in $WarmPages) {
                    if (Test-EscapePressed) { $stopped = $true; break }
                    try { [void](Invoke-WebRequest -Uri "$Url$page" -UseBasicParsing -TimeoutSec 60) } catch { }
                }
                if ($stopped) { break }
            } elseif (((Get-Date) - $started).TotalSeconds -gt 600) {
                # Generous on purpose: the first step starts Docker and lets
                # PostgreSQL recover if it was shut down uncleanly.
                Write-Host "  The app has not answered after 10 minutes. Check the messages above." -ForegroundColor Yellow
                $opened = $true
            } else {
                Start-Sleep -Milliseconds 100
            }
        } else {
            Start-Sleep -Milliseconds 150
        }
    }
} finally {
    Stop-Server $server
    Stop-Server $database
}

if ($stopped) { exit 0 }

# The server stopped on its own, which means something went wrong. Keep the
# window open so its last messages can be read.
Write-Host ""
Write-Host "The app stopped. Read the messages above, then press any key to close." -ForegroundColor Yellow
[void][Console]::ReadKey($true)
exit 1
