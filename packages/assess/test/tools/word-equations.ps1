# Has Word write documents with equations in them, through its own object model.
# Used by word-equations-check.ts. Windows with Microsoft Word installed only.
#
# $Out (a folder to write the documents into) is set by the caller, which feeds this text to PowerShell on standard input. It is not
# run as a script file because many machines have script files switched off. No setting is changed.
#
# What this is for: the tests of the equation reader use XML written by hand, which is only as good as what its author believes Word
# writes. Here Word builds each kind of equation itself (a fraction, a root, a sum, a matrix and so on), so the XML the reader meets is the
# XML Word writes. One question holds one equation. The documents are made fresh, saved in $Out, and never opened from or saved over
# anything of the person's.
#
# Safety: see word-guard.ps1, which is put in front of this text. It only ever closes the one Word that automation started.
if (-not $Out) { "Out must be set first."; exit 1 }

$made = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]

function Add-Line($doc, [string]$text) {
  $doc.Content.InsertParagraphAfter()
  $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
  $paragraph.Range.InsertBefore($text)
}

function Save($doc, [string]$name) {
  [string]$path = "$Out\$name.docx"
  $format = 16
  $doc.SaveAs([ref]$path, [ref]$format)
  $none = 0
  $doc.Close([ref]$none)
  $made.Add($name)
}

function Add-Options($doc) {
  Add-Line $doc "a) Yes"
  Add-Line $doc "b) No"
  Add-Line $doc "Answer: a"
}

# One inline equation inside the stem of a question: the word QQQ is turned into an equation, and then (when a type is given) into the
# function of that type, whose parts the caller fills in. A type of 0 leaves the equation as the text it was given.
function Add-Question($doc, [string]$name, [int]$type, [scriptblock]$fill, [string]$typed) {
  try {
    Add-Line $doc "$($global:number). Check the $name equation QQQ and answer."
    $global:number++
    $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
    $r = $paragraph.Range
    $found = $r.Find.Execute("QQQ")
    if (-not $found) { throw "could not find the place for the equation" }
    $doc.OMaths.Add($r) | Out-Null
    $om = $doc.OMaths.Item($doc.OMaths.Count)
    if ($type -gt 0) {
      $om.Functions.Add($om.Range, $type) | Out-Null
      $f = $om.Functions.Item(1)
      & $fill $f
    } else {
      $om.Range.Text = $typed
    }
    Add-Options $doc
  } catch {
    $failed.Add("$name : " + $_.Exception.Message)
  }
}

try {
  Retry { $word.Visible = $false }
  Retry { $word.DisplayAlerts = 0 }

  # One question for each kind of equation Word can build, in a fixed order that word-equations-check.ts reads back.
  $doc = $word.Documents.Add()
  $global:number = 1
  Add-Question $doc "fraction" 7 { param($f) $f.Frac.Num.Range.Text = "a"; $f.Frac.Den.Range.Text = "b+1" }
  # A root with no degree has its degree emptied; left alone, Word puts the placeholder text it replaced into the degree.
  Add-Question $doc "root" 16 { param($f) $f.Rad.E.Range.Text = "x+1"; $f.Rad.Deg.Range.Text = "" }
  Add-Question $doc "cube root" 16 { param($f) $f.Rad.E.Range.Text = "x"; $f.Rad.Deg.Range.Text = "3" }
  Add-Question $doc "superscript" 19 { param($f) $f.ScrSup.E.Range.Text = "x"; $f.ScrSup.Sup.Range.Text = "2" }
  Add-Question $doc "subscript" 17 { param($f) $f.ScrSub.E.Range.Text = "x"; $f.ScrSub.Sub.Range.Text = "i" }
  Add-Question $doc "subscript and superscript" 18 { param($f) $f.ScrSubSup.E.Range.Text = "x"; $f.ScrSubSup.Sub.Range.Text = "i"; $f.ScrSubSup.Sup.Range.Text = "2" }
  Add-Question $doc "sum" 13 { param($f) $f.Nary.Char = 8721; $f.Nary.Sub.Range.Text = "i=1"; $f.Nary.Sup.Range.Text = "n"; $f.Nary.E.Range.Text = "i" }
  Add-Question $doc "integral" 13 { param($f) $f.Nary.Char = 8747; $f.Nary.Sub.Range.Text = "0"; $f.Nary.Sup.Range.Text = "1"; $f.Nary.E.Range.Text = "x" }
  Add-Question $doc "function" 8 { param($f) $f.Func.FName.Range.Text = "sin"; $f.Func.E.Range.Text = "x" }
  Add-Question $doc "accent" 1 { param($f) $f.Acc.E.Range.Text = "a" }
  Add-Question $doc "bar" 2 { param($f) $f.Bar.E.Range.Text = "x" }
  Add-Question $doc "limit" 10 { param($f) $f.LimLow.E.Range.Text = "lim"; $f.LimLow.Lim.Range.Text = "x" + [char]0x2192 + "0" }
  Add-Question $doc "upper limit" 11 { param($f) $f.LimUpp.E.Range.Text = "x"; $f.LimUpp.Lim.Range.Text = "y" }
  Add-Question $doc "bracket" 5 { param($f) $f.Delim.E.Item(1).Range.Text = "a" }
  Add-Question $doc "array" 6 { param($f) $f.EqArray.E.Item(1).Range.Text = "x=1" }
  Add-Question $doc "brace" 9 { param($f) $f.GroupChar.E.Range.Text = "x+y" }
  Add-Question $doc "prescript" 15 { param($f) $f.ScrPre.E.Range.Text = "C"; $f.ScrPre.Sub.Range.Text = "6"; $f.ScrPre.Sup.Range.Text = "12" }
  Add-Question $doc "box" 4 { param($f) $f.BorderBox.E.Range.Text = "x" }
  Add-Question $doc "matrix" 12 { param($f) $f.Mat.Cell(1, 1).Range.Text = "1" }
  # Greek letters are written by code, because this text reaches PowerShell on standard input in the console's code page.
  Add-Question $doc "typed" 0 $null ("x=" + [char]0x3b1 + "+" + [char]0x3c0)
  Save $doc "equations-constructs"

  # A display equation: a paragraph of its own, between the stem and the options.
  $doc = $word.Documents.Add()
  Add-Line $doc "1. Solve the equation below for x."
  Add-Line $doc "DISPLAY"
  $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
  $r = $paragraph.Range
  $r.MoveEnd(1, -1) | Out-Null
  $doc.OMaths.Add($r) | Out-Null
  $om = $doc.OMaths.Item($doc.OMaths.Count)
  $om.Functions.Add($om.Range, 7) | Out-Null
  $f = $om.Functions.Item(1)
  $f.Frac.Num.Range.Text = "x"
  $f.Frac.Den.Range.Text = "2"
  Add-Options $doc
  Save $doc "equations-display"
} finally {
  Close-Word
}
"Word wrote: " + ($made -join ", ")
if ($failed.Count -gt 0) { "Word could not build: " + ($failed -join "; ") }
