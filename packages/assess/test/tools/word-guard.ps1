# Starts a separate, hidden Word for a check, and makes sure that only that one is ever closed.
# The checks in this folder put this text in front of their own, so $word, $mine, Close-Word
# and Retry are there for them. Windows with Microsoft Word installed only.
#
# Why it is careful: the person may have Word open with their own work in it, and a
# check must never touch that. Word that automation starts has "-Embedding" on its
# command line, and Word that a person opens does not, so the process this script holds
# is the one new process that has it. If that cannot be told, nothing is closed.
# Word is asked to quit, which leaves nothing unsaved because the documents opened are
# read-only or new and are closed without saving, and the process is stopped only if it
# is still there afterwards and is that one.

$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
Start-Sleep -Seconds 2
$new = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $before -notcontains $_ })
if ($new.Count -eq 0) {
  "COM returned an existing Word; stopping without touching it."
  exit 2
}
$mine = @($new | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue).CommandLine -match '-Embedding' })
if ($mine.Count -ne 1) {
  "Could not tell which new Word process is this script's ($($new -join ', ')); stopping without closing anything."
  exit 2
}
"Started a separate Word process: $($mine -join ', ')"

function Close-Word {
  try { $save = 0; $word.Quit([ref]$save) } catch { }
  Start-Sleep -Seconds 2
  foreach ($id in $mine) {
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -ErrorAction SilentlyContinue }
  }
}

# Word answers "call rejected" while it is busy, and asks again a moment later.
function Retry([scriptblock]$what) {
  for ($try = 1; $try -le 20; $try++) {
    try { & $what; return } catch { if ($try -eq 20) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
