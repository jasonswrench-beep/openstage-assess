# Has Excel write a workbook itself, through its own object model, and say what each cell holds.
# Used by excel-authored-check.ts. Windows with Microsoft Excel installed only.
#
# $Out (a folder to write into) is set by the caller, which feeds this text to PowerShell on standard
# input after excel-guard.ps1. No setting is changed, and nothing of the person's is opened or saved.
#
# What this is for: the tests write workbooks with our own writer, which is not Excel. This is the
# XML Excel really writes: its shared strings, its cell types, the result stored beside a formula, the
# way it marks a hidden row or sheet. The workbook is saved as .xlsx, and the same first sheet as CSV
# (the Windows code page), CSV UTF-8 and Unicode text, because those are what a person saves too.
#
# excel-says.json holds, for every cell with something in it, what Excel reports: the kind of value
# (string, number, boolean, error), the value, and the text it shows.
if (-not $Out) { "Out must be set first."; exit 1 }

$problems = New-Object System.Collections.Generic.List[string]
$LF = [string][char]10

# A number set through PowerShell's own binder is refused as "cannot cast Double to String", so the value is handed to Excel as it is.
function Put($ws, [int]$r, [int]$c, $value) {
  $cell = $ws.Cells.Item($r, $c)
  [void][System.__ComObject].InvokeMember("Value2", [Reflection.BindingFlags]::SetProperty, $null, $cell, @($value))
}

try {
  $wb = $excel.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 3) { [void]$wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count)) }
  $ws = $wb.Worksheets.Item(1)
  $ws.Name = "Questions"

  # A text number is text only if its cell is formatted as text before it is typed.
  $ws.Range("B7").NumberFormat = "@"
  $ws.Range("D7").NumberFormat = "@"

  $head = "Type", "Question", "A", "B", "C", "Correct", "Points"
  for ($c = 0; $c -lt $head.Count; $c++) { Put $ws 1 ($c + 1) $head[$c] }

  # 2. text, and a number with a decimal
  Put $ws 2 1 "MC"; Put $ws 2 2 "Which planet is nearest the Sun?"; Put $ws 2 3 "Venus"; Put $ws 2 4 "Mercury"; Put $ws 2 5 "Earth"; Put $ws 2 6 "B"; Put $ws 2 7 ([double]2.5)
  # 3. a line break inside a cell, a formula that answers with text, a formula that makes 0.30000000000000004
  Put $ws 3 1 "MC"; Put $ws 3 2 ("Which letter comes first?" + $LF + "Pick one."); Put $ws 3 3 "x"; Put $ws 3 4 "y"; Put $ws 3 5 "z"
  $ws.Cells.Item(3, 6).Formula = '=IF(1=1,"C","A")'
  $ws.Cells.Item(3, 7).Formula = '=0.1+0.2'
  # 4. a typed TRUE, which Excel keeps as a boolean
  Put $ws 4 1 "TF"; Put $ws 4 2 "The Sun is a star."; Put $ws 4 6 $true; Put $ws 4 7 ([double]1)
  # 5. a typed FALSE, in a row that is then hidden
  Put $ws 5 1 "TF"; Put $ws 5 2 "The Moon is a star."; Put $ws 5 6 $false; Put $ws 5 7 ([double]1)
  # 6. text with only part of it bold, which Excel keeps as runs in its shared string
  Put $ws 6 1 "SA"; Put $ws 6 2 "Name the largest planet."; Put $ws 6 3 "Jupiter"; Put $ws 6 4 "the planet Jupiter"; Put $ws 6 7 ([double]1)
  $ws.Cells.Item(6, 2).Characters(1, 4).Font.Bold = $true
  # 7. a number kept as text (007), an error, and characters beyond ASCII
  Put $ws 7 1 "MC"; Put $ws 7 2 "007"; Put $ws 7 3 ("caf" + [char]0xE9); Put $ws 7 4 ("euro " + [char]0x20AC); Put $ws 7 5 ("u" + [char]0xFC)
  $ws.Cells.Item(7, 4).NumberFormat = "General"
  $ws.Cells.Item(7, 4).Formula = '=1/0'
  Put $ws 7 6 "A"; Put $ws 7 7 ([double]1)
  # 8. a whole number, and a negative number
  Put $ws 8 1 "ES"; Put $ws 8 2 "Discuss the orbit of Mercury."; Put $ws 8 7 ([double]10)
  Put $ws 9 1 "MC"; Put $ws 9 2 "Numbers as answers"; Put $ws 9 3 ([double]-3.5); Put $ws 9 4 ([double]42); Put $ws 9 6 "B"; Put $ws 9 7 ([double]1)
  # 4 is hidden by hand
  $ws.Rows.Item(5).Hidden = $true

  # a second sheet of notes, and a third that is hidden
  $notes = $wb.Worksheets.Item(2)
  $notes.Name = "Notes & rules"
  Put $notes 1 1 "Notes"
  Put $notes 2 1 "Question"; Put $notes 2 2 "Write the words of each question here."
  $hidden = $wb.Worksheets.Item(3)
  $hidden.Name = "Archive"
  Put $hidden 1 1 "Question"; Put $hidden 1 2 "A"; Put $hidden 1 3 "B"; Put $hidden 1 4 "Correct"
  Put $hidden 2 1 "Old question?"; Put $hidden 2 2 "yes"; Put $hidden 2 3 "no"; Put $hidden 2 4 "A"
  $hidden.Visible = 0

  # what Excel says each cell holds, before anything is saved
  $says = New-Object System.Collections.Generic.List[object]
  foreach ($sheet in $wb.Worksheets) {
    $used = $sheet.UsedRange
    for ($r = 1; $r -le ($used.Row + $used.Rows.Count - 1); $r++) {
      for ($c = 1; $c -le ($used.Column + $used.Columns.Count - 1); $c++) {
        $cell = $sheet.Cells.Item($r, $c)
        $v = $cell.Value2
        if ($null -eq $v -or ($v -is [string] -and $v -eq "")) { continue }
        $kind = if ($v -is [string]) { "string" } elseif ($v -is [bool]) { "boolean" } elseif ($v -is [double]) { "number" } else { "error" }
        $value = if ($kind -eq "number") { ([double]$v).ToString("R", [Globalization.CultureInfo]::InvariantCulture) } elseif ($kind -eq "string") { $v } elseif ($kind -eq "boolean") { "" + $v } else { "" }
        $says.Add([ordered]@{ sheet = $sheet.Name; row = $r; col = $c; kind = $kind; value = $value; text = [string]$cell.Text; hidden = [bool]$sheet.Rows.Item($r).Hidden })
      }
    }
  }
  $sheets = @($wb.Worksheets | ForEach-Object { [ordered]@{ name = $_.Name; visible = [int]$_.Visible } })
  [ordered]@{ cells = $says; sheets = $sheets } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Out "excel-says.json") -Encoding UTF8

  # saved as a workbook, and the first sheet again as the text files a person saves
  [string]$xlsx = "$Out\excel.xlsx"
  $wb.SaveAs($xlsx, 51)
  $wb.Worksheets.Item("Archive").Visible = -1
  $wb.Worksheets.Item("Questions").Activate()
  foreach ($pair in @(@("excel-code-page.csv", 6), @("excel-utf8.csv", 62), @("excel-unicode.txt", 42))) {
    [string]$path = "$Out\" + $pair[0]
    $wb.SaveAs($path, [int]$pair[1])
  }
  $wb.Close($false)

  # The other way round: workbooks our own writer made (the samples the app offers, the blank table), opened by Excel. Opened
  # read-only and without updating links, and closed without saving. Excel is asked what it finds, and anything it has to
  # repair is a problem the open itself reports.
  if ($Ours -and (Test-Path $Ours)) {
    $opened = @()
    foreach ($file in Get-ChildItem $Ours -Filter *.xlsx) {
      try {
        [string]$p = $file.FullName
        # Handed to Excel as it is, as the cells were: PowerShell's own binder refuses these arguments. (FileName, UpdateLinks 0, ReadOnly)
        $book = [System.__ComObject].InvokeMember("Open", [Reflection.BindingFlags]::InvokeMethod, $null, $excel.Workbooks, @($p, 0, $true))
        $sheetsInfo = @()
        foreach ($s in $book.Worksheets) {
          $a1 = $s.Range("A1")
          $validation = -1
          try { $validation = [int]$s.Range("A2").Validation.Type } catch { }
          $sheetsInfo += [pscustomobject]@{ name = $s.Name; a1 = [string]$a1.Text; a1bold = [bool]$a1.Font.Bold; b2 = [string]$s.Range("B2").Text; validation = $validation }
        }
        $book.Close($false)
        $opened += [pscustomobject]@{ file = $file.Name; sheets = @($sheetsInfo) }
      } catch { $problems.Add("opening " + $file.Name + ": " + $_.Exception.Message + " | in: " + $_.InvocationInfo.Line.Trim()) }
    }
    if ($opened.Count -gt 0) { ConvertTo-Json -InputObject @($opened) -Depth 6 | Set-Content -Path (Join-Path $Out "ours-says.json") -Encoding UTF8 }
  }
} catch { $problems.Add($_.Exception.Message + " | in: " + $_.InvocationInfo.Line.Trim() + " | called from line " + $_.InvocationInfo.ScriptLineNumber) }
finally { Close-Excel }
"Wrote: " + ((Get-ChildItem $Out -File | Where-Object { $_.Name -like "excel*" } | ForEach-Object { $_.Name }) -join ", ")
foreach ($p in $problems) { "PROBLEM " + $p }
