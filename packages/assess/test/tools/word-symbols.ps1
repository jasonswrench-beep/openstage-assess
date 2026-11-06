# Has Word write documents with symbol characters in them, through its own object model.
# Used by word-symbols-check.ts. Windows with Microsoft Word installed only.
#
# $Out (a folder to write the documents into) is set by the caller, which feeds this text to PowerShell on standard input. It is not
# run as a script file because many machines have script files switched off. No setting is changed.
#
# What this is for: the tests of the symbol reader use documents from our own writer, which is not Word. Word writes a character typed
# from the Symbol font two ways (Insert Symbol, and plain letters in a run whose font is Symbol), and these are written by Word itself.
# The documents are made fresh, saved in $Out, and never opened from or saved over anything of the person's.
#
# Safety: see word-guard.ps1, which is put in front of this text. It only ever closes the one Word that automation started.
if (-not $Out) { "Out must be set first."; exit 1 }

$made = New-Object System.Collections.Generic.List[string]

function Add-Line($doc, [string]$text) {
  $doc.Content.InsertParagraphAfter()
  $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
  $paragraph.Range.InsertBefore($text)
}

# The end of the last paragraph, before its mark, as an empty range to write at.
function End-Of-Last($doc) {
  $r = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range
  $r.MoveEnd(1, -1) | Out-Null
  $r.Collapse(0)
  return $r
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

try {
  Retry { $word.Visible = $false }
  Retry { $word.DisplayAlerts = 0 }

  # Insert Symbol from the Symbol font: alpha (F061) and a plus or minus (F0B1).
  $doc = $word.Documents.Add()
  Add-Line $doc "1. Is the angle "
  $r = End-Of-Last $doc; $r.InsertSymbol(-3999, "Symbol", $true)
  $r = End-Of-Last $doc; $r.InsertAfter(" and the error ")
  $r = End-Of-Last $doc; $r.InsertSymbol(-3919, "Symbol", $true)
  $r = End-Of-Last $doc; $r.InsertAfter(" small?")
  Add-Options $doc
  Save $doc "symbols-insert"

  # Text typed while the font is Symbol: the letters a b g are shown as alpha beta gamma.
  $doc = $word.Documents.Add()
  Add-Line $doc "1. Which letters are "
  $r = End-Of-Last $doc; $r.InsertAfter("abg"); $r.Font.Name = "Symbol"
  $r = End-Of-Last $doc; $r.InsertAfter(" Greek?"); $r.Font.Name = "Arial"
  Add-Options $doc
  Save $doc "symbols-typed"

  # A character of an ordinary font by Insert Symbol (plus or minus, degrees), which is plain Unicode.
  $doc = $word.Documents.Add()
  Add-Line $doc "1. Is the error "
  $r = End-Of-Last $doc; $r.InsertSymbol(177, "Arial", $true)
  $r = End-Of-Last $doc; $r.InsertAfter(" or 30 "); $r.Font.Name = "Arial"
  $r = End-Of-Last $doc; $r.InsertSymbol(176, "Arial", $true)
  $r = End-Of-Last $doc; $r.InsertAfter(" small?"); $r.Font.Name = "Arial"
  Add-Options $doc
  Save $doc "symbols-arial"

  # A Wingdings character, which is a picture and not a letter, and cannot be read.
  $doc = $word.Documents.Add()
  Add-Line $doc "1. Is this ticked "
  $r = End-Of-Last $doc; $r.InsertSymbol(-3972, "Wingdings", $true)
  $r = End-Of-Last $doc; $r.InsertAfter("?"); $r.Font.Name = "Arial"
  Add-Options $doc
  Save $doc "symbols-wingdings"
} finally {
  Close-Word
}
"Word wrote: " + ($made -join ", ")
