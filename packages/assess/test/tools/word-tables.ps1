# Has Word write documents with a data table inside a question's text, through its own object model, and says what Word reports for
# each table (its rows, the text of each cell, whether a row is marked as a header). Used by word-tables-check.ts. Windows with
# Microsoft Word installed only.
#
# $Out (a folder to write the documents into) is set by the caller, which feeds this text to PowerShell on standard input. It is not
# run as a script file because many machines have script files switched off. No setting is changed.
#
# What this is for: the tests of the table reader use documents from our own writer, which is not Word. Word writes the cell widths,
# the header mark and a merged cell its own way, and what the reader keeps as a table of the question has to agree with what Word says
# the table is. The documents are made fresh, saved in $Out, and never opened from or saved over anything of the person's.
#
# Safety: see word-guard.ps1, which is put in front of this text. It only ever closes the one Word that automation started.
if (-not $Out) { "Out must be set first."; exit 1 }

$made = New-Object System.Collections.Generic.List[string]
$reported = [ordered]@{}

function Add-Line($doc, [string]$text) {
  $doc.Content.InsertParagraphAfter()
  $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
  $paragraph.Range.InsertBefore($text)
}

# A table of the given cells (an array of arrays of text) at the end of the document.
function Add-Table($doc, $rows) {
  $doc.Content.InsertParagraphAfter()
  $range = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range
  $columns = ($rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
  $table = $doc.Tables.Add($range, $rows.Count, $columns)
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt $rows[$r].Count; $c++) {
      $table.Cell($r + 1, $c + 1).Range.Text = $rows[$r][$c]
    }
  }
  return $table
}

# What Word says the table is: for each row, the text of each cell it has and whether the row repeats as a header.
function Report($table) {
  $cellMark = [string][char]13 + [string][char]7
  $rows = @()
  foreach ($row in $table.Rows) {
    $cells = @()
    foreach ($cell in $row.Cells) { $cells += $cell.Range.Text.Replace($cellMark, "").Trim() }
    $rows += , @{ header = [bool]$row.HeadingFormat; cells = $cells }
  }
  return $rows
}

function Save($doc, [string]$name, $table) {
  $reported[$name] = Report $table
  [string]$path = "$Out\$name.docx"
  $format = 16
  $doc.SaveAs([ref]$path, [ref]$format)
  $none = 0
  $doc.Close([ref]$none)
  $made.Add($name)
}

function Add-Options($doc) {
  Add-Line $doc "a) 80"
  Add-Line $doc "b) 85"
  Add-Line $doc "c) 90"
  Add-Line $doc "Answer: b"
}

try {
  Retry { $word.Visible = $false }
  Retry { $word.DisplayAlerts = 0 }

  # A table of scores, three rows of two cells, in the text of a question, with another question after it.
  $doc = $word.Documents.Add()
  $doc.Content.InsertAfter("1. Use the table to find the mean of the scores.")
  $table = Add-Table $doc @(@("Student", "Score"), @("Ana", "80"), @("Ben", "90"))
  Add-Options $doc
  Add-Line $doc "2. What is two plus two?"
  Add-Line $doc "a) Three"
  Add-Line $doc "b) Four"
  Add-Line $doc "Answer: b"
  Save $doc "tables-data" $table

  # The same, with the first row marked to repeat as a header row, which is what Word writes as a header.
  $doc = $word.Documents.Add()
  $doc.Content.InsertAfter("1. Use the table to find the mean of the scores.")
  $table = Add-Table $doc @(@("Student", "Score"), @("Ana", "80"), @("Ben", "90"))
  $table.Rows.Item(1).HeadingFormat = $true
  Add-Options $doc
  Save $doc "tables-header" $table

  # A title row across the top: two cells joined into one.
  $doc = $word.Documents.Add()
  $doc.Content.InsertAfter("1. Use the table to find the mean of the scores.")
  $table = Add-Table $doc @(@("Results", ""), @("Ana", "80"), @("Ben", "90"))
  $table.Cell(1, 1).Merge($table.Cell(1, 2))
  Add-Options $doc
  Save $doc "tables-merged" $table

  # A cell with two paragraphs in it.
  $doc = $word.Documents.Add()
  $doc.Content.InsertAfter("1. Use the table to find the mean of the scores.")
  $table = Add-Table $doc @(@("Student", "Score"), @("Ana", "80"), @("Ben", "90"))
  $table.Cell(2, 1).Range.Text = "Ana" + [string][char]13 + "(first)"
  Add-Options $doc
  Save $doc "tables-cell-paragraphs" $table

  # One column: not a grid, so it is not kept as a table.
  $doc = $word.Documents.Add()
  $doc.Content.InsertAfter("1. Use the list to find the mean of the scores.")
  $table = Add-Table $doc @(@("Ana 80"), @("Ben 90"), @("Cy 70"))
  Add-Options $doc
  Save $doc "tables-one-column" $table
} finally {
  Close-Word
}
"Word wrote: " + ($made -join ", ")
"TABLES: " + ($reported | ConvertTo-Json -Depth 6 -Compress)
