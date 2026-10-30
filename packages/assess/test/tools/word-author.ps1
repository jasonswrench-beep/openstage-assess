# Has Word write some test documents itself, through its own object model.
# Used by word-authored-check.ts. Windows with Microsoft Word installed only.
#
# $Out (a folder to write the documents into) is set by the caller, which feeds this
# text to PowerShell on standard input. It is not run as a script file because many
# machines have script files switched off. No setting is changed.
#
# What this is for: the other tests use documents written by our own writer, which is
# not Word. These are written by Word, so the XML is whatever Word really writes: its
# table grids, merged cells, list definitions, styles and bookkeeping. They are made
# fresh, saved in $Out, and never opened from or saved over anything of the person's.
#
# Safety: see word-guard.ps1, which is put in front of this text. It only ever closes the
# one Word that automation started, and never one the person opened.
if (-not $Out) { "Out must be set first."; exit 1 }


$made = New-Object System.Collections.Generic.List[string]
$problems = New-Object System.Collections.Generic.List[string]

# A note of how far it got, in case Word stops to wait for something nobody can see.
function Step([string]$message) { Add-Content -Path (Join-Path $Out "progress.txt") -Value $message }

function Add-Line($doc, [string]$text, [bool]$bold = $false) {
  $range = $doc.Content
  $range.InsertParagraphAfter()
  $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
  $paragraph.Range.InsertBefore($text)
  $paragraph.Range.Font.Bold = [int]$bold * -1
}

function New-Table($doc, $rows, $columns) {
  $doc.Content.InsertParagraphAfter()
  $range = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range
  return $doc.Tables.Add($range, $rows, $columns)
}

function Save($doc, [string]$name) {
  Step "$name is being saved"
  # A plain string: what Join-Path returns is wrapped in a way that a by-reference call refuses.
  [string]$path = "$Out\$name.docx"
  # By reference: the plain call is one Word waits on forever, with nothing to see.
  $format = 16
  $doc.SaveAs([ref]$path, [ref]$format)
  $none = 0
  $doc.Close([ref]$none)
  Step "$name is saved"
  $made.Add($name)
}

# A question as a publisher's bank lays it out: a table of its own, with the number (and
# the page it comes from) in one cell, and in the next the question and then a table for
# each option, inside the cell. The right option's letter is bold and underlined, and the
# letters of the others are grey. This is the first time the reader meets a table inside a
# table that Word wrote.
function New-NestedQuestion($doc, [string]$number, [string]$page, [string]$stem, $options, [int]$correct) {
  $outer = New-Table $doc 1 2
  $outer.Cell(1, 1).Range.Text = $number + "`r" + $page
  $outer.Cell(1, 1).Range.Paragraphs.Item(2).Range.Font.Italic = -1
  $cell = $outer.Cell(1, 2)
  # The stem, then a place for each table with an empty paragraph after it (two tables with
  # nothing between them become one), which is also how Word keeps a paragraph after a table
  # in a cell. The tables are put in from the last place to the first, so that putting one in
  # does not move the places of the ones still to come.
  $count = $options.Count
  $cell.Range.Text = $stem + ("`r" * (2 * $count))
  for ($k = $count; $k -ge 1; $k--) {
    $i = $k - 1
    $spot = $cell.Range.Paragraphs.Item(2 * $k).Range
    $spot.Collapse(1)
    $nested = $cell.Tables.Add($spot, 1, 2)
    $nested.Cell(1, 1).Range.Text = ("abcde".Substring($i, 1)) + ". "
    $nested.Cell(1, 2).Range.Text = $options[$i]
    $letter = $nested.Cell(1, 1).Range
    if ($i -eq $correct) { $letter.Font.Bold = -1; $letter.Font.Underline = 1 } else { $letter.Font.Color = 8421504 }
  }
}

try {
  Retry { $word.Visible = $false }
  Retry { $word.DisplayAlerts = 0 }

  # A. a question to a table, with a check mark beside the right option
  try {
    Step "A begins"
    $doc = $word.Documents.Add()
    Step "A has a document"
    $t = New-Table $doc 4 3
    $rows = @(@("1.", "Which of these is a planet?", ""), @("a.", "Sirius", ""), @("b.", "Mars", [string][char]0x2713), @("c.", "The Sun", ""))
    for ($r = 0; $r -lt 4; $r++) { for ($c = 0; $c -lt 3; $c++) { $t.Cell($r + 1, $c + 1).Range.Text = $rows[$r][$c] } }
    Save $doc "A-question-per-table"
  } catch { $problems.Add("A: " + $_.Exception.Message) }

  # B. a grid with a header row, one question to a row
  try {
    Step "B begins"
    $doc = $word.Documents.Add()
    Step "B has a document"
    $t = New-Table $doc 3 7
    $grid = @(
      @("No.", "Question", "A", "B", "C", "D", "Answer"),
      @("1", "Which of these is a planet?", "Sirius", "Mars", "The Sun", "Vega", "B"),
      @("2", "Which of these is a star?", "Venus", "Earth", "Sirius", "Mars", "C")
    )
    for ($r = 0; $r -lt 3; $r++) { for ($c = 0; $c -lt 7; $c++) { $t.Cell($r + 1, $c + 1).Range.Text = $grid[$r][$c] } }
    $t.Rows.Item(1).Range.Font.Bold = -1
    Save $doc "B-grid"
  } catch { $problems.Add("B: " + $_.Exception.Message) }

  # C. questions as paragraphs, and an answer key in a table with a header row
  try {
    Step "C begins"
    $doc = $word.Documents.Add()
    Step "C has a document"
    $doc.Content.Text = "1. Which of these is a planet?"
    foreach ($line in @("a. Sirius", "b. Mars", "c. The Sun", "", "2. Which of these is a star?", "a. Venus", "b. Earth", "c. Sirius", "")) { Add-Line $doc $line }
    $t = New-Table $doc 3 2
    $key = @(@("Question", "Answer"), @("1", "B"), @("2", "C"))
    for ($r = 0; $r -lt 3; $r++) { for ($c = 0; $c -lt 2; $c++) { $t.Cell($r + 1, $c + 1).Range.Text = $key[$r][$c] } }
    Save $doc "C-answer-key-table"
  } catch { $problems.Add("C: " + $_.Exception.Message) }

  # D. an outline list: questions at level 1, options at level 2, the right option in bold
  try {
    Step "D begins"
    $doc = $word.Documents.Add()
    Step "D has a document"
    $doc.Content.Text = "Which of these is a planet?"
    foreach ($line in @("Sirius", "Mars", "The Sun", "Which of these is a star?", "Venus", "Earth", "Sirius")) { Add-Line $doc $line }
    $template = $word.ListGalleries.Item(3).ListTemplates.Item(1)
    $doc.Content.ListFormat.ApplyListTemplate($template, $false, 0)
    for ($i = 1; $i -le 8; $i++) {
      $level = if ($i -eq 1 -or $i -eq 5) { 1 } else { 2 }
      $doc.Paragraphs.Item($i).Range.ListFormat.ListLevelNumber = $level
    }
    $doc.Paragraphs.Item(3).Range.Font.Bold = -1
    $doc.Paragraphs.Item(8).Range.Font.Bold = -1
    Save $doc "D-outline-list-bold-key"
  } catch { $problems.Add("D: " + $_.Exception.Message) }

  # E. a title row merged across a table of labelled rows
  try {
    Step "E begins"
    $doc = $word.Documents.Add()
    Step "E has a document"
    $t = New-Table $doc 5 2
    $t.Cell(1, 1).Range.Text = "Question 1 of the sampling quiz"
    $t.Cell(1, 1).Merge($t.Cell(1, 2))
    $rows = @(@("1.", "Which of these is a planet?"), @("a.", "Sirius"), @("*b.", "Mars"), @("c.", "The Sun"))
    for ($r = 0; $r -lt 4; $r++) { for ($c = 0; $c -lt 2; $c++) { $t.Cell($r + 2, $c + 1).Range.Text = $rows[$r][$c] } }
    Save $doc "E-merged-title-row"
  } catch { $problems.Add("E: " + $_.Exception.Message) }

  # F. typed labels, the right option bold, and an Answer line
  try {
    Step "F begins"
    $doc = $word.Documents.Add()
    Step "F has a document"
    $doc.Content.Text = "1. Which of these is a planet?"
    Add-Line $doc "a. Sirius"
    Add-Line $doc "b. Mars" $true
    Add-Line $doc "c. The Sun"
    Add-Line $doc "Answer: B"
    Save $doc "F-typed-bold-and-answer-line"
  } catch { $problems.Add("F: " + $_.Exception.Message) }

  # G. a simple numbered list for the questions and a lettered list for the options
  try {
    Step "G begins"
    $doc = $word.Documents.Add()
    Step "G has a document"
    $doc.Content.Text = "Which of these is a planet?"
    foreach ($line in @("Sirius", "Mars", "The Sun", "Which of these is a star?", "Venus", "Earth", "Sirius", "", "Answers:", "1. B", "2. C")) { Add-Line $doc $line }
    # The numbered and the lettered list among the ones Word offers, by what they count in and not by their place.
    $numbered = $null
    $lettered = $null
    foreach ($candidate in $word.ListGalleries.Item(2).ListTemplates) {
      $style = $candidate.ListLevels.Item(1).NumberStyle
      if ($null -eq $numbered -and $style -eq 0) { $numbered = $candidate }
      if ($null -eq $lettered -and $style -eq 4) { $lettered = $candidate }
    }
    if ($null -eq $numbered -or $null -eq $lettered) { throw "Word offers no numbered or lettered list here" }
    # ContinuePreviousList is false for the first of each group, so that the options start again at a.
    $doc.Paragraphs.Item(1).Range.ListFormat.ApplyListTemplate($numbered, $false, 0)
    $doc.Paragraphs.Item(5).Range.ListFormat.ApplyListTemplate($numbered, $true, 0)
    $doc.Paragraphs.Item(2).Range.ListFormat.ApplyListTemplate($lettered, $false, 0)
    foreach ($i in 3, 4) { $doc.Paragraphs.Item($i).Range.ListFormat.ApplyListTemplate($lettered, $true, 0) }
    $doc.Paragraphs.Item(6).Range.ListFormat.ApplyListTemplate($lettered, $false, 0)
    foreach ($i in 7, 8) { $doc.Paragraphs.Item($i).Range.ListFormat.ApplyListTemplate($lettered, $true, 0) }
    Save $doc "G-numbered-and-lettered-lists"
  } catch { $problems.Add("G: " + $_.Exception.Message) }

  # H. a publisher's layout: a table for each question, a table inside it for each option
  try {
    Step "H begins"
    $doc = $word.Documents.Add()
    Step "H has a document"
    New-NestedQuestion $doc "1." "(p. 12)" "Which of these is a planet?" @("Sirius", "Mars", "The Sun") 1
    New-NestedQuestion $doc "2." "(p. 13)" "Which of these is a star?" @("Venus", "Earth", "Sirius") 2
    Save $doc "H-nested-option-tables"
  } catch { $problems.Add("H: " + $_.Exception.Message) }
} finally {
  Close-Word
}
"Wrote: " + ($made -join ", ")
foreach ($p in $problems) { "PROBLEM " + $p }
