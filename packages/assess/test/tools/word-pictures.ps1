# Has Word write documents with pictures in them, through its own object model.
# Used by word-pictures-check.ts. Windows with Microsoft Word installed only.
#
# $Out (a folder to write the documents into) and $Pic (a PNG file to put in them) are set by the caller, which feeds this
# text to PowerShell on standard input. It is not run as a script file because many machines have script files switched off.
# No setting is changed.
#
# What this is for: the tests of the picture reader use documents written by our own writer, which is not Word. These are
# written by Word, so the drawing XML is whatever Word really writes: its description attribute, the crop, the turn, the
# floating form. The documents are made fresh, saved in $Out, and never opened from or saved over anything of the person's.
#
# Safety: see word-guard.ps1, which is put in front of this text. It only ever closes the one Word that automation started.
if (-not $Out -or -not $Pic) { "Out and Pic must be set first."; exit 1 }

$made = New-Object System.Collections.Generic.List[string]

function Add-Line($doc, [string]$text) {
  $doc.Content.InsertParagraphAfter()
  $paragraph = $doc.Paragraphs.Item($doc.Paragraphs.Count)
  $paragraph.Range.InsertBefore($text)
}

# A paragraph of its own holding an inline picture with the description given (nothing given leaves it empty).
function Add-Picture($doc, [string]$alt, [int]$cropLeft = 0) {
  $doc.Content.InsertParagraphAfter()
  $range = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range
  $shape = $doc.InlineShapes.AddPicture($Pic, $false, $true, $range)
  $shape.AlternativeText = $alt
  if ($cropLeft -gt 0) { $shape.PictureFormat.CropLeft = $cropLeft }
}

function Save($doc, [string]$name) {
  [string]$path = "$Out\$name.docx"
  $format = 16
  $doc.SaveAs([ref]$path, [ref]$format)
  $none = 0
  $doc.Close([ref]$none)
  $made.Add($name)
}

function New-Question($doc, [string]$number) {
  Add-Line $doc "$number. Look at the figure. Which colour is it?"
}
function Add-Options($doc, [string]$answer) {
  Add-Line $doc "a) Blue"
  Add-Line $doc "b) Red"
  Add-Line $doc "Answer: $answer"
}

try {
  Retry { $word.Visible = $false }
  Retry { $word.DisplayAlerts = 0 }

  # Placed pictures: one with a description, one with none, and the same picture again.
  $doc = $word.Documents.Add()
  New-Question $doc "1"; Add-Picture $doc "A solid blue rectangle"; Add-Options $doc "a"
  New-Question $doc "2"; Add-Picture $doc ""; Add-Options $doc "a"
  New-Question $doc "3"; Add-Picture $doc "A solid blue rectangle"; Add-Options $doc "a"
  Save $doc "pictures-placed"

  # A picture cropped in Word: the file holds the whole picture and the page shows part of it.
  $doc = $word.Documents.Add()
  New-Question $doc "1"; Add-Picture $doc "A cropped picture" 12; Add-Options $doc "a"
  Save $doc "pictures-cropped"

  # Floating pictures: one as it is, and one flipped. (Word will not turn a picture through its automation interface here, so a turned one is not written; the turn is checked with our own writer.)
  $doc = $word.Documents.Add()
  New-Question $doc "1"
  $anchor = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range; $anchor.Collapse(1)
  $floating = $doc.Shapes.AddPicture($Pic, $false, $true, 100, 100, 60, 40, $anchor)
  $floating.AlternativeText = "A floating picture"
  Add-Options $doc "a"
  New-Question $doc "2"
  $anchor = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range; $anchor.Collapse(1)
  $flipped = $doc.Shapes.AddPicture($Pic, $false, $true, 100, 200, 60, 40, $anchor)
  $flipped.AlternativeText = "A flipped picture"
  $flipped.Flip(0)
  Add-Options $doc "a"
  Save $doc "pictures-floating"

  # A text box, which is text and not a picture.
  $doc = $word.Documents.Add()
  New-Question $doc "1"
  $anchor = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range; $anchor.Collapse(1)
  $box = $doc.Shapes.AddTextbox(1, 100, 100, 120, 40, $anchor)
  $box.TextFrame.TextRange.Text = "A label in a box"
  Add-Options $doc "a"
  Save $doc "pictures-text-box"
} finally {
  Close-Word
}
"Word wrote: " + ($made -join ", ")
