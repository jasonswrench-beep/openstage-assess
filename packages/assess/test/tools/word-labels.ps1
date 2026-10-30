# Asks Word itself about each paragraph of some .docx files: the list label it shows
# ($What is 'labels') or the formatting it reports ($What is 'format').
# Used by ask-word.ts. Windows with Microsoft Word installed only.
#
# $Dir (a folder of .docx files), $Out (a JSON file to write) and $What are set by the caller,
# which feeds this text to PowerShell on standard input. It is not run as a script file
# because many machines have script files switched off. No setting is changed.
#
# Read-only: documents are opened read-only and closed without saving.
#
# Safety: it only goes on if automation started a NEW Word process, and it only ever
# closes that process. If COM hands back a Word that was already running (the person's
# own session), it stops without touching anything.
if (-not $Dir -or -not $Out) { "Dir and Out must be set first."; exit 1 }

$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
Start-Sleep -Seconds 2
$after = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$mine = @($after | Where-Object { $before -notcontains $_ })
if ($mine.Count -eq 0) {
  "COM returned an existing Word; stopping without touching it."
  exit 2
}
"Started a separate Word process: $($mine -join ', ')"

$result = [ordered]@{}
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  foreach ($f in (Get-ChildItem -Path $Dir -Filter *.docx | Sort-Object Name)) {
    try {
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles
      $doc = $word.Documents.Open($f.FullName, $false, $true, $false)
      $labels = New-Object System.Collections.Generic.List[string]
      $count = $doc.Paragraphs.Count
      for ($i = 1; $i -le $count; $i++) {
        $paragraph = $doc.Paragraphs.Item($i)
        if ($What -eq 'format') {
          # The text of the paragraph without its mark, as bold|italic|underline|colour|highlight.
          $range = $doc.Range($paragraph.Range.Start, [Math]::Max($paragraph.Range.Start, $paragraph.Range.End - 1))
          $labels.Add(("{0}|{1}|{2}|{3}|{4}" -f $range.Font.Bold, $range.Font.Italic, $range.Font.Underline, $range.Font.Color, $range.HighlightColorIndex))
        } else {
          $labels.Add([string]$paragraph.Range.ListFormat.ListString)
        }
      }
      $result[$f.BaseName] = $labels.ToArray()
      $doc.Close($false)
    } catch {
      $result[$f.BaseName] = @("ERROR: " + $_.Exception.Message)
    }
  }
} finally {
  try { $word.Quit($false) } catch { }
  Start-Sleep -Seconds 1
  foreach ($id in $mine) { Stop-Process -Id $id -ErrorAction SilentlyContinue }
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $Out
"Wrote $($result.Count) documents to $Out"
