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
# Safety: see word-guard.ps1, which is put in front of this text. It only ever closes the
# one Word that automation started, and never one the person opened.
if (-not $Dir -or -not $Out) { "Dir and Out must be set first."; exit 1 }


$result = [ordered]@{}
try {
  Retry { $word.Visible = $false }
  Retry { $word.DisplayAlerts = 0 }
  foreach ($f in (Get-ChildItem -Path $Dir -Filter *.docx | Sort-Object Name)) {
    try {
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles
      $doc = $word.Documents.Open($f.FullName, $false, $true, $false)
      $labels = New-Object System.Collections.Generic.List[string]
      $count = $doc.Paragraphs.Count
      if ($What -eq 'pages') { $doc.Repaginate() }
      for ($i = 1; $i -le $count; $i++) {
        $paragraph = $doc.Paragraphs.Item($i)
        if ($What -eq 'pages') {
          # The page Word puts the start of the paragraph on, and the page it ends on: wdActiveEndPageNumber, 3. A paragraph
          # that Word breaks across a page has two different numbers.
          $first = $doc.Range($paragraph.Range.Start, $paragraph.Range.Start)
          $last = $doc.Range([Math]::Max($paragraph.Range.Start, $paragraph.Range.End - 1), [Math]::Max($paragraph.Range.Start, $paragraph.Range.End - 1))
          $labels.Add(("{0}:{1}" -f $first.Information(3), $last.Information(3)))
        } elseif ($What -eq 'format') {
          # The text of the paragraph without its mark, as bold|italic|underline|colour|highlight|hidden.
          $range = $doc.Range($paragraph.Range.Start, [Math]::Max($paragraph.Range.Start, $paragraph.Range.End - 1))
          $labels.Add(("{0}|{1}|{2}|{3}|{4}|{5}" -f $range.Font.Bold, $range.Font.Italic, $range.Font.Underline, $range.Font.Color, $range.HighlightColorIndex, $range.Font.Hidden))
        } elseif ($What -eq 'text') {
          # The text of the paragraph as Word holds it, without the paragraph mark.
          $labels.Add([string]$paragraph.Range.Text.TrimEnd([char]13, [char]7))
        } else {
          $labels.Add([string]$paragraph.Range.ListFormat.ListString)
        }
      }
      if ($What -eq 'text') { $labels.Add("PAGES:" + $doc.ComputeStatistics(2)) }
      $result[$f.BaseName] = $labels.ToArray()
      $doc.Close($false)
    } catch {
      $result[$f.BaseName] = @("ERROR: " + $_.Exception.Message)
    }
  }
} finally {
  Close-Word
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $Out
"Wrote $($result.Count) documents to $Out"
