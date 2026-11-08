# Sends a real Ctrl-Break (or, with -CtrlC, a real Ctrl-C) to a run of tools\release\mutate.mjs while a fault is planted, and says whether the
# run ended at once with 130, put its file back, left no folder of originals and left no process of its own.
# Windows only. packages/assess/test/mutate-runner.test.ts cannot send a key: Node has no way to send a signal to another process on
# Windows, so the test reaches the same function through a hook (OA_MUTATE_TEST_SIGNAL). This is the check of the real key; run it after any
# change to how mutate.mjs handles a signal.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\check-ctrl-break.ps1 [-CtrlC]
# It works in a folder of its own under the temporary folder, with a copy of mutate.mjs, and does not touch this repository.
param([switch]$CtrlC, [int]$SendTo = 0)

$key = if ($CtrlC) { 0 } else { 1 }
$keyName = if ($CtrlC) { "Ctrl-C" } else { "Ctrl-Break" }

if ($SendTo -ne 0) {
  # The sender is a process of its own: it gives up its console and joins the runner's, and a key sent from there reaches every process
  # that shares that console (the runner and the test run it started), as the key on a keyboard does.
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ConsoleKeys {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
}
"@
  [void][ConsoleKeys]::FreeConsole()
  if (-not [ConsoleKeys]::AttachConsole([uint32]$SendTo)) { Write-Output "could not join the console of process $SendTo"; exit 2 }
  [void][ConsoleKeys]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)  # so that the key does not end this process as well
  $sent = [ConsoleKeys]::GenerateConsoleCtrlEvent([uint32]$key, 0)
  Start-Sleep -Milliseconds 500
  [void][ConsoleKeys]::FreeConsole()
  Write-Output "sent $keyName to the console of process ${SendTo}: $sent"
  exit 0
}

$ErrorActionPreference = "Stop"
$work = Join-Path ([IO.Path]::GetTempPath()) ("oa-ctrl-break-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
foreach ($folder in @("tools\release", "src", "test", "tmp")) { New-Item -ItemType Directory -Force (Join-Path $work $folder) | Out-Null }
Copy-Item (Join-Path $PSScriptRoot "mutate.mjs") (Join-Path $work "tools\release\mutate.mjs")
$file = Join-Path $work "src\a.txt"
Set-Content -Path $file -Value "line ALPHA" -Encoding ascii
# With ALPHA in the file the test passes at once (the baseline). With a fault in, it holds on for 20 seconds, as a long test run does.
Set-Content -Path (Join-Path $work "test\t.test.mjs") -Encoding ascii -Value @'
import { test } from "node:test";
import { readFileSync } from "node:fs";
const text = readFileSync(new URL("../src/a.txt", import.meta.url), "utf8");
test("a.txt holds ALPHA", async () => {
  if (!text.includes("ALPHA")) await new Promise((resolve) => setTimeout(resolve, 20000));
});
'@
$faults = foreach ($to in @("BETA", "GAMMA", "DELTA")) { [ordered]@{ label = "ALPHA becomes $to"; file = "src/a.txt"; from = "ALPHA"; to = $to; tests = @("test/t.test.mjs") } }
Set-Content -Path (Join-Path $work "spec.json") -Encoding ascii -Value (ConvertTo-Json -InputObject @($faults))

function Read-File { try { (Get-Content $file -Raw).Trim() } catch { "" } }
$failed = 0
function Check([bool]$ok, [string]$text) {
  if ($ok) { Write-Output "ok   $text" } else { Write-Output "FAIL $text"; $script:failed++ }
}

$env:TEMP = Join-Path $work "tmp"   # so that the runner's folder of originals is not the real one
$env:TMP = $env:TEMP
$out = Join-Path $work "out.txt"
$err = Join-Path $work "err.txt"
$runner = Start-Process -FilePath "node" -ArgumentList "tools/release/mutate.mjs", "spec.json" -WorkingDirectory $work -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$null = $runner.Handle  # keep the exit code readable after the process has ended
try {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($clock.Elapsed.TotalSeconds -lt 90 -and (Read-File) -notmatch "BETA") { Start-Sleep -Milliseconds 200 }
  Check ((Read-File) -match "BETA") "the first fault was planted ($(Read-File))"
  Start-Sleep -Seconds 2  # the tests are running with it in
  if ($CtrlC) { $sender = powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -SendTo $runner.Id -CtrlC }
  else { $sender = powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -SendTo $runner.Id }
  Write-Output ($sender -join " ")
  $ended = $runner.WaitForExit(30000)
  if (-not $ended) { $runner.Kill() }
  Check $ended "$keyName ended the runner within 30 seconds"
  Check ($runner.ExitCode -eq 130) "the exit code is 130 (it is $($runner.ExitCode))"
  Check ((Read-File) -eq "line ALPHA") "the file is back as it was (it reads: $(Read-File))"
  $said = (Get-Content $out -Raw) + (Get-Content $err -Raw)
  Check ($said -match "STOPPED") "the runner said STOPPED"
  Check ($said -notmatch "GAMMA|DELTA") "and did not go on to plant the rest of the list"
  Start-Sleep -Seconds 2
  $left = @(Get-ChildItem (Join-Path $work "tmp\openassess-mutate-originals") -ErrorAction SilentlyContinue)
  Check ($left.Count -eq 0) "no folder of originals is left ($($left.Count))"
  $alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$work*" })
  Check ($alive.Count -eq 0) "no node process of the run is left ($($alive.Count))"
  Write-Output "--- what the runner printed ---"
  Write-Output $said
} finally {
  foreach ($left in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$work*" })) { Stop-Process -Id $left.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($failed -gt 0) { Write-Output "$failed check(s) failed"; exit 1 }
Write-Output "all checks passed"
