# Things only a person can check

Everything that a program can check is checked by the tests (`npm test`), the accuracy gate, the real-file score and the
mutation runs, and is not listed here. This is what is left: what needs Word on screen, a person's eye, or a decision. Each
item says what has been run and what has not. Items are removed when done, with the date.

## Needs Word, on a Windows machine

- [ ] **Run `Check OpenAssess.cmd` by double-click, once, and look at the window.** The whole file was run through `cmd.exe` on
  5 November 2026 with a key press piped in for the pause at the end: all five steps ran and it said "Everything passed" (2135
  engine tests, 191 app tests, the accuracy gate, the answer sheet gate, the speed check), and a test (`check-cmd.test.ts`) holds
  it to naming every test file. What is left is only what a double-click adds: the window opening, staying open at the end, and
  how it reads on screen.
- [ ] **Open a few of the generated documents in Word and look.** The checker reads the XML, and only Word can say what Word
  shows. Worth opening: `c-06` (Word's own numbering), `c-11` (bullets and `(Correct)`), `c-16` (highlight), `c-21` (bullets
  and underline), `c-10` (font colour). They are in the session's scratch folder under `generated/` and in the zips you sent.
- [ ] **Run `npm run check:word-authored`, `check:word` and `check:word-formatting`** after any change to
  `import/docx/numbering.ts`, `formatting.ts` or how tables are read. Stage 4h changed none of them. The hidden text change
  (stage 5) touched `formatting.ts`, so `check:word-formatting` and `check:word` were run on 1 November 2026, each with
  hidden text added, and found no disagreement with Word. `check:word-authored` is not due.
- [ ] **Import a real Word test bank that has figures in it, and look at every figure.** Pictures are read from a Word file now
  (they used to be the word [picture]). They were checked against Word's own files for placed, floating, cropped and flipped
  pictures and a text box (`npm run check:word-pictures`, 6 November 2026), and none of the real banks kept here holds a picture,
  so how a real chapter's figures come through is not known. Open Check quality's partner, the bank, and look: is each figure
  there, in the right question, with a description? A figure that was cropped, turned, drawn on or grouped in Word is not kept and
  says why (the file's findings); tell me which of those your figures are, since cropping a screenshot is common.
- [ ] **Add a picture to a question by hand, and put back one an import refused.** The editor has Add a picture, Replace and Remove,
  and a cropped picture that an import will not keep can be saved from Word as a picture and added in the review. The buttons were
  clicked in the built-in browser with a picture standing in for the computer's file chooser, which was not opened. Try the real
  chooser, a large photograph, and a picture that is not a PNG, JPEG or GIF.
- [ ] **Print a test with figures, as Word and as PDF, and look.** Word opened the printed test without repair and reported each
  picture's size and description (`check:word-print`); the PDF was taken apart (`print-pictures.test.ts`) and, on 7 November 2026,
  drawn by Windows' own PDF renderer for the "placed" sample (a small picture in each of three questions: under the words of its
  question, in its place, not cut), and not looked at in a desktop PDF program. Are the figures the right size, under the right words, not split from their question across a page? A GIF, a CMYK
  JPEG and an interlaced PNG cannot be drawn in the PDF here and are printed as words, with the reason against the question.
- [ ] **Import the Moodle XML of a bank with figures into a Moodle course.** A picture in the text of a question is written as
  Moodle documents it (an image tag and the file in base64). Not tried in a Moodle. A picture in an answer, in feedback or in a
  matching question is written as words, and so is a picture in every other format.
- [ ] **Import a real Word test bank that has equations in it, and read every one against the Word file.** Equations are read now
  (they used to be the word [equation]): `npm run check:word-equations` has Word build twenty kinds and the reader found what it
  was given in all of them (6 November 2026), and none of the real banks kept here holds an equation, so how a real chapter's
  come through is not known. An equation with a part the reader does not know stays `[equation]` and the file says why; one that
  is read is shown drawn, with its LaTeX under it. Look for a wrong one: that is the bad case, and the reader is built to
  refuse before it guesses.
- [ ] **Look at the equations panel in the app's own window, with a screen reader if you use one.** The equation is drawn from MathML the
  engine wrote, by the window's own engine. In the built-in browser all twenty equations that real Word built were turned into
  MathML elements and nine hostile strings were refused (6 November 2026), but the pane was not on screen, so how an equation
  looks (a fraction stacked, a sum with its limits) was not seen, and the Tauri window was not tried at all. Its LaTeX is
  written under it as text. Does it look like the equation, and is it read aloud sensibly, or only the LaTeX under it?
- [ ] **Print a test with equations as Word and as PDF, and look.** Word opened the printed test without repair and reported three
  inline equations of the right kinds (`check:word-print`); the equations are Word's own XML as the import kept it, drawn in
  Word's math font at the size of the paragraph. The PDF has no font for one and prints `[Equation: LaTeX]` with a note. Does the
  Word equation sit on the line and size you expect?
- [ ] **Import the Moodle XML of a bank with equations into a Moodle course.** An equation is written as `\(LaTeX\)`, which shows as
  an equation only if the site's MathJax filter is on. Not tried in a Moodle. Every other format writes `[Equation: LaTeX]`.
- [ ] **Put a Greek letter and a sign in a Word question by Insert Symbol, and by typing with the Symbol font on, and import it.**
  Checked against Word's own files (`check:word-symbols`); the table holds only codes it is sure of, so a rare sign may come in as
  the letter it is written with. The file says how many it was unsure of.
- [ ] **Import a Word bank with a figure that cannot be kept (a cropped screenshot, say) and look at that question in the review.** It
  should read as needing a look, with a note of its own that says how many pictures, equations or symbols are missing and where
  the marker stands in the text (6 November 2026; before that only the file's own warnings said so and the question read as
  parsed). Write the figure in words or add the picture in the editor and take the marker out: the note should go by itself.
  Tried on invented files only.
- [ ] **Import a Word bank with a table of data inside a question (scores, a schedule) and look at the question.** A table that is a
  grid of two or more rows and columns is kept as a table of the question: it shows in the question's own panel, drawn, and as
  `[table 1]` in the text. Is it the table you wrote, with its rows and columns, a title row across the top if you had one, and
  the right row as a header if you marked one to repeat? A table that is not a grid (one column, one row), or has cells joined down,
  is read cell by cell and the question says so. A question that sits wholly in a table (a test item file with a question to a
  cell) must carry neither: one real file of that kind (375 questions) read the same before and after. Word wrote the five test
  tables and agreed (`check:word-tables`); no real bank with data tables inside questions has been seen.
- [ ] **Look at the table panel in the app's own window, and move and remove a table with its words.** The panel was built and
  checked in the built-in browser by what it makes (header cells, a spanning cell, a hostile cell shown as words), and not by
  looking, since the pane was not on screen. Change the words round `[table 1]`, move the token to another place, take it out and
  save: the table should follow the token, and be gone with it. A table cannot be changed there.
- [ ] **Print a test with a table in a question, as Word and as PDF, and look.** The Word file draws the table of the stem as a
  table (a thin grey rule round every cell, equal columns, the header row in bold and repeating); Word opened it without repair
  and showed three tables with the rows and cell text laid out (`check:word-print`), but nobody has looked at how it reads on a
  page. The PDF draws it as lines, a row to a line with the cells between bars, and says so against the question; so does a
  table in an option. Does the Word table sit well under its words, and does a row to a line read well enough in the PDF?
- [ ] **Import the Moodle XML, GIFT or Brightspace CSV of a question with a table into a course.** They carry the table as markup
  (`table`, `thead`, `tbody`, `tr`, `th`, `td`). Not tried in any learning system. The other formats write its words.
- [ ] **Hide a whole numbered paragraph in Word and look at the numbers.** Triple-click one item of a numbered list, press
  Ctrl+Shift+H, and make sure Word is not set to show hidden text. Word's object model counted the hidden item (the item after
  it kept its number), and the reader does the same. What the page shows on screen is not something the check can see.
- [ ] **Put a question in a Word text box and import it.** `check:word-pictures` has Word write a text box beside a question and the
  reader leaves it unread and says so (6 November 2026). Expected for a question that is itself in a box: the question is
  missing, and the file says so and quotes the start of the box.

## Needs a person's eye

- [ ] **Go through the whole app with a screen reader and with the keyboard alone.** What a program could check was checked in the
  built-in browser on 7 November 2026: on the home, import review, bank (with the editor open), export, print and answer sheets
  screens, every button, link, field and select has a name, no image lacks a description, each screen has one main heading and one main
  area, no id is used twice, the language is set, a focus ring shows, and the dark and reduced-motion settings are honoured. The one
  fault found was that the question dialog had no name (a screen reader said only "dialog"); it is named by its heading now, and
  Escape closes it and puts focus back on the button that opened it. A second pass the same day looked at the score review screen
  too (a sitting of three drawn sheets, with a faint mark, a blank row and a doubled mark) and at names that repeat. It found: a tick
  box or round button whose label held a paragraph of explanation, so its name was the paragraph (seven of them; the words name it now
  and the explanation describes it); the Open, Export and Print links of every bank, the Try it and Save a copy buttons of every
  sample and the Look button of every sheet, each the same words with nothing to say which one (each names its bank, sample or
  sheet now); the confirmation after a keystroke in the score review ("Recorded A for sheet 2, question 2. 1 to go") was in a live
  region built with its words already in it, which a screen reader often does not read, and is now said from one that stays in the
  page; after the last question of the review was settled, focus was left on a card that had gone, and now moves to the review's
  heading; and the message line was hidden until it had a message, so it is kept in the page and drawn only when it has words. All of
  it was read from the browser's accessibility tree and not heard. Listen for: the confirmation and the message line (are they read,
  once, and not twice?), whether the question editor, which sits inside a polite live region on the bank and import screens, is read
  out whole each time another question is chosen (it may be too much), and the order of reading in the editor. Windows high-contrast
  mode: the stylesheet had nothing for it, so the chosen filter, the question or sheet being looked at, a ticked bubble and the place a
  file is dragged to, each shown by a background colour alone, would have looked like everything else. A `forced-colors` block gives
  each the system's highlight colours or an outline. It was written from the specification and checked only to parse and to change
  nothing outside the mode (the built-in browser cannot switch the mode on): turn on a contrast theme (Settings, Accessibility,
  Contrast themes) and look at the import review, the bank list, the Review of a scored class and the home screen's drop area.
  A third pass walked the home screen with real Tab presses in the browser pane. The two hidden file choosers were stops that showed
  nothing (focus went to an invisible control and no ring appeared), and the "Choose a file" and "Open a bank file" labels that opened
  them were not stops at all, so a person using only the keyboard could not choose a file. Both are real buttons now with a focus ring,
  and the hidden inputs are out of the keyboard order and hidden from a screen reader. The other screens were not walked key by key;
  do that with the keyboard alone, and listen to the file buttons with a screen reader.
  A fourth pass (8 November 2026, in the browser pane, with real key presses) found the skip link sending the page to "There is nothing
  here" and, once fixed, that the first Tab went past it because the first screen was given focus. On a fresh load the first Tab now
  lands on the link and Enter keeps the address and the page and moves focus to the main area. Three fields of the Save dialog that
  had no name are named (checked by opening the dialog and reading the page's listing). Not done: the dialogs that open later were
  not all opened and read; the interface review of 8 November (`docs/review-findings.md`) lists the rest, among them focus lost when a
  control is rebuilt, result counts that are never announced, a page title that never changes, and input borders and left-out rows
  below the contrast WCAG asks of them (worked out from the colours, not looked at). Listen to the Save dialog with a screen reader.
- [ ] **Look at the review page.** `npm run assess -- review <a .docx or .txt file> --out review.html`, then open the page. It is
  the first thing you can see, so it is the first thing to judge: is it the right information in the right order, and what would
  you want to change a question into, by hand, from it? It has no script and cannot change anything yet. Try it on a real bank
  if you have one. It was looked at in the browser pane at desktop width and at phone width, and in its dark colours on 7 November 2026
(the status chips, the marked answer, the check box and the source line all read clearly).

- [ ] **Print a test from a real bank with curly quotes and dashes in it, as Word and as PDF, and look.** Since 6 November 2026
  the quotes, the en and em dashes and the ellipses you typed are kept (they used to come out as straight quotes and `--`). The
  tests take both files apart and find the characters; looking at the printed page, in the font you would use, is not done. Also
  import a file with an em dash into an LMS and see that it arrives as a dash.
- [ ] **Read three generated files as an instructor would.** Do they look like banks a person made? The checker cannot say. This
  is step 6 of "Doing a piece" in `docs/synthetic-bank-spec.md`, not done for pieces 2 to 6.
- [ ] **Open one real bank with no numbers and no letters, if you have one, and look at the first five questions it reads.**
  The step that reads those is judged only on invented banks. The warning on the file says where to look.
- [ ] **Make a Word list with bullets, type a question under a numbered item with three bulleted options, and import it.** The
  tests write the bullets with their own writer, which Word has not read: `npm run check:word-authored` has Word write
  documents, and does not yet write a bulleted one.
- [ ] **Read the review messages as a person who has never seen the code.** What the importer says about a question it flagged
  (`import.option-letter-gap`, `import.type-from-evidence`, `import.pair-left-out`, `import.accepted-answers-split`) has been
  tested for what it says, not for whether it is clear.
- [ ] **Three real chapters the rules were not fitted to.** The acceptance criterion for the Word importer is 95 percent on three
  real chapters. None exists yet: the real files are all fitted, and the generated ones say nothing about real banks.

## Excel, CSV and the samples

- [ ] **Bring in your own Excel list of questions.** Use the columns of the blank table (Type, Question, A to H, Correct,
  Points, feedback, Category), or just add a first row that names yours. The first thing to look at is the file's notes at the
  top of the review: which columns were not used, which sheets were not read, how many rows were hidden. It reads a workbook
  that Excel wrote correctly (`check:excel-authored`, run on 1 November 2026: 246 comparisons with what Excel says, none
  differing) and has not read one of yours.
- [ ] **Bring in a table that puts the right answer first** (columns such as Question, Correct answer, Incorrect answer 1, 2, 3, in
  Excel or as CSV or text, `;` or `,` between the cells). The file's notes say the answers were mixed and how many; open a few
  questions and check that the one marked right is the one the file gave as right, and that a table of yours with two languages
  was read in the language that comes first. It was written from one real file (an amateur radio bank, 549 questions, held to a plain
  split of its own lines when it is in `fixtures/publisher/tables`), and has not been tried on a table from a spreadsheet you made.
  Decide too whether you want the answers mixed at import (they are, because version A of a printed test keeps the bank's order and
  the key would have been A throughout) or left in the file's order with a switch.
- [ ] **Open the blank table and the Excel sample in Excel** (use Save a copy… on the first screen) and look at them: the bold first row, the
  drop-down on Type, the "How to fill it in" sheet. Excel opened them without repair when asked by the check, and nothing
  can say how they look.
- [ ] **Try a workbook from Google Sheets and one from LibreOffice** (File, Download, Microsoft Excel). Only Excel's own files
  have been read; the others write the same format with their own habits.
- [ ] **Read a CSV this writes in Author** and a CSV Author's template gives in OpenAssess. The second is tested (the template
  reads here as five questions with their keys); the first needs Author running, and the exporter is unchanged.
- [ ] **Bring in PDFs from other programs, and look at what comes out.** Only five PDFs, all from one typesetting program
  (a page-layout program), have been read. Word's own "Save as PDF", a desktop PDF program, Google Docs and a publisher's tools each set their text another way,
  and none has been tried. Put two or three in `fixtures/publisher/pdf/` with an `.expected.json` written from the document, and
  the question of how they read stops being a guess. `npm run assess -- score fixtures/publisher/pdf` measures them.
- [ ] **Look at the PDF review screen on a PDF of yours.** Each question's source shows its page. Check the answers against the
  PDF, as the file's first warning says to: that is what a PDF costs.
- [ ] **A PDF set in two columns, a PDF with a table of questions, and a scanned PDF.** The first is read across and said to be, the
  second as lines of text, and the third is refused. Which of these you meet is the question; none was in the five.
- [ ] **Decide about text recognition for scans.** It would be a service or a model, which is a dependency and the first one the
  engine would have. Refusing a scan with the way round (an original document, or text recognition done in a PDF program) is what
  it does now.

## QTI in (a package or a file from another learning system)

Built on 7 November 2026. The Canvas and standard shapes were written from memory of them, not read from a real export. The
Brightspace shape was read from one real question library (80 multiple choice questions, found on this machine the same day; it read none
until the reader was fixed, then all, held to a second reading of its XML), so a Brightspace question library should come in; its true or
false, multi-select, matching and other types have not been seen.

- [ ] **Export a quiz from Canvas (Quizzes, Export Course Content, Quiz as QTI) and import the zip here.** Check each question's right
  answer against Canvas's, the points, the feedback, and a picture. Say what came in wrongly, flagged for no reason, or read as text.
- [ ] **Export the question library from Brightspace (Question Library, Export) and import the zip.** A library of multiple choice
  questions is the shape that has been read from a real file; try one with true or false, multi-select, matching, ordering and
  short answer questions, which have not been seen. Say which kinds arrived as text or without a key, and send the zip if anything is
  wrong, as the shapes are the point. Then a quiz exported the other way (Import/Export/Copy Components), and say whether it was 1.2 or 2.x.
- [ ] **Export a whole Canvas course (Settings, Export Course Content) and import the `.imscc` here.** It is read as a package. Say
  whether the quizzes came in once each, with the right answers, and what the file says about files that end in `.qti` (Canvas is said
  to keep its question banks in them; they are counted and not read, so a bank that only lives there comes in empty and says so).
- [ ] **A test bank from a publisher as a QTI package.** The same checks. A key that is missing or wrong is the one failure that matters.
- [ ] **A multiple answer question with partial credit.** In 1.2 the shares that are added are read as credit for part; in 2.1 a response
  map is. Check that the weights you set in the other system are what come in as right answers.

## Moodle XML in

Built on 6 November 2026. The sample in `fixtures/moodle-xml` was written from Moodle's documented format, not exported from a Moodle.

- [ ] **Export a question bank from a real Moodle (Question bank, Export, Moodle XML) and import it here.** Check each question's
  right answer against Moodle's, the points, a picture, and a question with feedback. Say what came in wrongly or flagged for no
  reason; a cloze, a drag and drop and a calculated question are expected to come in as text that fails.
- [ ] **A multiple answer question with partial credit in Moodle.** It is read as right answers earning a share each, with a wrong
  answer taking one away. If the weights in your Moodle are not equal shares, the import says they were not kept; look at what it did.
- [ ] **Moodle in a language other than English.** The standard feedback sentences are recognised in English only, so another
  language's sentences come in as feedback on every question. Say which language, and send what the sentences are.

## Brightspace

- [ ] **Bring in a Brightspace question library CSV that you did not get from this program** (one you wrote from Brightspace's own
  template, or one a publisher supplies). It is read by the keyword in each row, and what this program exports comes back as it was
  written (every fixture, and the 21 real Word banks, tested on 7 November 2026), but no file Brightspace itself wrote has been read, so
  how it reads one is unknown. Look at the file's notes first (a hint, an image, an answer box's size and a 1 to 5 difficulty are said and
  not kept), then at a multiselect (is its scoring right?) and a matching question. A question it cannot read is kept as an essay with
  its words and marked failed.
- [ ] **A multiselect's scoring in Brightspace.** On 7 November 2026 the file began to write `AllOrNothing` where it wrote `All or nothing`,
  and `RightMinusWrong` is unchanged. Import a multiselect each way and open it: is the scoring Brightspace shows the one the bank says?
- [ ] **Import a file with every type into a Brightspace course.** Quizzes, Question Library, Import, Upload a File. One file
  has been (1 November 2026, seen in a recording): 13 multiple choice, 10 true or false and 5 written response questions arrived
  as 28 questions of those types, 1 point each, and the one true or false opened showed the right answer. Still to look at:
  the right answer marked on each multiple choice question, and a multiselect with its scoring, a short answer, a matching
  question, an ordering, a question with bold, and accented letters. Use `Brightspace (D2L) Question Library, CSV` in the app's
  export screen on a bank with one question of each type, and look at every question in the library afterwards.
  A second file, the twelve question test bank made on 1 November 2026 (all seven types, with accents, bold, a half point and
  a spare matching answer), was imported and the person who did it said it worked fine. Nobody wrote down what each question
  looked like, so this stays open for the right answer on each question, a multiselect's scoring, bold, accents and the
  matching question, until someone looks and says.
- [ ] **Download Brightspace's own template CSV and put the two side by side.** The article gives the rows but its template file
  was not available here. Look at how many cells wide its rows are (these are three), whether it has a header or comment line,
  and whether its Points and Scoring rows sit where these do.
- [ ] **Check the three values that are easy to get wrong.** A multiple choice's right answer is `100`, a multiselect's is `1`,
  and a true or false has a `TRUE` row and a `FALSE` row. These are from the article; a question that imports with the wrong
  answer marked is the failure to look for.
- [ ] **Import a question with an accent, a quotation mark and a line break in it.** The file is UTF-8 with no byte order
  mark, as the article does not ask for one. If Brightspace shows accented letters wrongly, the mark is the first thing to try
  (it is one line in `d2l-csv.ts`).
- [ ] **A question with bold in its wording.** It is written as HTML with `HTML` in the third cell, which the article shows for
  the question text only. Check that it arrives bold and not as visible tags.
- [ ] **Course Import's QTI 3.x subset is not built (QTI 2.1 is: its own section below).** Brightspace's Quizzes tool takes QTI up to 1.2 (built, below) and
  Course Import takes a subset of 2.x and 3.x. Which one matters depends on how you move content.

## QTI 1.2 package (Brightspace and Canvas)

Built on 1 November 2026 from help pages and the QTI standard. The package is held to a second reading of the standard and to a
response processor that scores every possible answer (see `docs/design-plan.md`), which shows the package follows the standard
and carries the key, and nothing about what either tool accepts. Use `QTI 1.2 package (Brightspace and Canvas)` in the app's
export screen on a bank with one question of each type, and look at every question afterwards.

**The first try, 1 November 2026, in Brightspace:** the person who tried it said the zip "just uploaded as a zip", and that the
structure of the file may be at fault. Which screen they used was not said. The note in the app at the time sent them to the
Quizzes tool's Import or the Question Library's Import. D2L's own Question Library article names a CSV file, not QTI, so the
route was probably wrong; that is now corrected in the app. The package itself has not been shown to be at fault, and it has
not been shown to be right.

**The second try, the same day, by the Course Admin route a published import guide documents:** "It still does not like the format". No message
was recorded. That makes two tries not accepted, so the bare QTI zip is now the less likely of the two Brightspace packages to
work, and the Common Cartridge package (next section) was built for that reason.

- [ ] **If you try the QTI zip again, copy any message Brightspace gives, word for word.** Neither try recorded one, and "No
  quizzes or sections can be found" would say something different from "not a recognised package". It is still the file to try in
  Canvas (Settings, Import Course Content, QTI .zip file), where the Common Cartridge file has not been tried either.
- [ ] **Try the Quizzes tool's own Import as well** (Quizzes, then its Import). A D2L staff reply says it reads QTI up to 1.2,
  and D2L's help does not describe it. Say which route worked.
- [ ] **A multiple answer question, a matching question, a short answer and an essay.** A multiple answer should have its right
  set marked and score nothing for any other set. A matching question is the least certain: it is written the way Canvas writes
  one (a response for each left side, each offering every right side), and Brightspace may read it differently or not at all.
  Look at where the spare answers went.
- [ ] **Points of 2 and of half a point.** They are written into the metadata Canvas reads and into the score, as the same number.
  See what Brightspace shows.
- [ ] **A question with an accent, a quotation mark, an ampersand and a less-than sign.** All are escaped in the XML.
- [ ] **A question with bold in its wording.** The question text is written as HTML and an answer is HTML only when it has
  formatting. Check that bold arrives bold and not as visible tags.
- [ ] **Import it into Canvas** (Settings, Import Course Content, content type QTI .zip file, and try Create new question bank).
  The guide that was read is for Classic Quizzes. Say which types arrive and which do not, and whether New Quizzes took it.
  If you have no Canvas course, say so and this stays open.

## QTI 2.1 package (Canvas, and Brightspace's Course Import)

Built on 6 November 2026 from the standard and the vendors' help pages. It is held to a second reading of QTI 2.1 and to a response
processor that scores every possible answer (see `docs/design-plan.md`), which shows it follows the standard and carries the key,
and nothing about what either tool accepts. Nobody has imported it anywhere. Use `QTI 2.1 package (Canvas and Brightspace Course
Import)` on the export screen, on a bank with one question of each type, one with a picture and one with an equation.

- [ ] **Canvas: Settings, Import Course Content, QTI .zip file.** Canvas's guides say Classic Quizzes reads QTI 1.2 and 2.1 and New
  Quizzes 1.2 and 2.x. Say which quiz engine you used, copy any message word for word, and look at every question after.
- [ ] **Brightspace: Import/Export/Copy Components.** Campus guides list QTI 2.1 there as partly read. Say which question types
  arrived and which did not.
- [ ] **The score of each question.** Answer each one right and wrong and see the points. A multiple answer question with partial
  credit is scored by a mapping (each right answer a share, each wrong one a share taken away), and a tool may use only the correct
  answer and score it all or nothing. If so, say.
- [ ] **A picture and an equation.** The picture is a file in the zip that the question points at, with its description; the
  equation is MathML. See whether each arrives, and whether the description is read.
- [ ] **The manifest's schema line.** It says `QTIv2.1 Package` 1.0.0, written from memory of IMS's examples. If a tool refuses the
  package at once, compare with a QTI 2.1 package that tool wrote itself, and send that file.

## Common Cartridge package (Brightspace)

Built on 1 November 2026 after the QTI zip was not accepted twice, in the form that a tool which builds Brightspace quizzes writes
(Brightspacosaurus 0.35.0, source read that day), and held to a second reading of the format and a response processor, as the QTI
zip is. Nothing here has been imported anywhere. Use `Common Cartridge 1.3 package (Brightspace)` in the app's export screen, or
the file in `Downloads\OpenAssess LMS test`.

- [ ] **Import it into Brightspace:** Course tools, Import/Export/Copy Components, Import Components, from a course package, Start;
  drag in the `.imscc` file; Import All Components; wait for the green checks. Then look in Quizzes (and in Content, where a topic
  for it should also appear). Say whether it made a quiz, how many questions it holds (ten of the twelve in the test bank: matching
  and ordering cannot go in this format), and copy any message word for word. Importing twice makes two quizzes; delete the first.
- [ ] **Open each question.** The right answer marked, the points (a weighting, so 2, 0.5 and 1), the bold, the accents and the
  quotation marks. The true or false and the essay follow the format's description and were not seen in a package Brightspace took,
  so those two are the ones to look at first.
- [ ] **How the short answer and the fill in the blank arrive.** Both are written as Common Cartridge's fill in the blank, and what
  Brightspace makes of that is its to say. Type each accepted answer, in the other case, and a wrong one.
- [ ] **The attempts.** The quiz is made with no limit on attempts, since the format asks for a number. Check what Brightspace shows.
- [ ] **Import it into Canvas, too, if you have a course** (Import Course Content, content type Common Cartridge 1.x Package).
  Not tried, and the Canvas guide that was read does not cover it.

## Blackboard

Built on 1 November 2026 from Blackboard's help pages for Upload questions and the sample file they link to. Nothing here has
been tried in Blackboard. Use `Blackboard, Upload questions (text file)` in the app's export screen.

- [ ] **Upload the file in Ultra** (the plus sign in a test, Upload questions from file) **and in Original** (Upload Questions) if
  you have both. Set the points first, or every question arrives worth zero. Look at each type, and which rows Blackboard
  refuses and with what words.
- [ ] **The ordering row in Ultra.** Blackboard's Ultra page lists eight types and ordering is not one of them. The check says an
  Ultra course may refuse it; see whether it does.
- [ ] **A short answer written as a fill in the blank.** Type each accepted answer, in the other case, and a wrong one, and see
  what Blackboard marks right. If it does not behave like a short answer, the other choice is Blackboard's own short answer, which
  is marked by hand and keeps only a sample answer.
- [ ] **A question with a double quote at the start of the text, and one with an accent.** Blackboard does not say how a quote
  is treated, and the file is written as UTF-8 with no byte order mark. Its own sample has a quote at the start of a question and
  nothing around it.
- [ ] **A numeric question.** It is left out because the page does not say what the tolerance means. If you know, or can try
  one, say what the third field does.
- [ ] **Import a file that Blackboard itself wrote, or one a colleague wrote for it.** The reader (`blackboard-upload.ts`, added on
  7 November 2026) was built from the page and from this program's own file, and every row of the exporter's file reads back. It has not
  met a real one. Look for: a row that begins with a type it does not know (it is kept as an essay and fails, with the words), a field
  that is quoted or holds HTML (read as plain text, with the marks in it), a points or feedback column (not part of the documented
  file, so it would be read as another answer), and a multiple answer question, whose partial credit the file cannot say (read as all
  or nothing). A pool or test exported from Blackboard as a package (a zip with an `imsmanifest.xml` and `.dat` files) is named as
  Blackboard's own form and not read, since none has been seen here: if you have one, keep it, because its `.dat` files are what a
  reader would be written from.

## Answer sheets

Planned in `docs/paper-tests-spec.md`. These are the parts that need people, paper and machines. Everything a program can check is
in the tests and in `assess sheets gate`.

- [ ] **Scan a test page on the department copier, and with two phones, and look at what each PDF holds.** In grey, in colour and in
  black and white on the copier; one scan each from the iPhone and the Android document scanners. For each PDF: the image format
  (JPEG, fax, JBIG2 or something else), how many images are on a page, and the page rotation. The build reads JPEG, Flate and
  uncompressed images only, so this says whether a fax decoder or pdf.js is needed. Decided on 4 November 2026 to build without it.
  The reader is built now (`assess sheets read <bank> <scan.pdf>`), and these scans are its first test on files it did not write:
  its PDFs in the tests were written from the format's description, not from any scanner. Look for what it refuses and why, whether a
  phone's PDF has one picture to a page, and whether a copier's "compact" setting is what it names. Page rotation and mirroring are
  done from how the picture is drawn; a scan that comes out sideways or mirrored in the reader and fine in a PDF viewer is a bug.
- [ ] **Read a JPEG, from a phone, in the window.** A JPEG, and a JPEG inside a PDF, are decoded by the window (`createImageBitmap`,
  with the camera's own turn applied, laid on white and made grey) and not by the engine, so nothing in `npm test` reads one. The
  Score screen does it and was run in the built-in browser (a canvas-made JPEG of a drawn sheet read at version A, 150 dots to the
  inch, and the keyboard review settled a faint mark, a blank row and a doubled mark), but not in the Tauri window (WebView2) and not
  with real photos. Look at an iPhone's, with its turn flag (a photo taken sideways must come out upright), and an Android phone's,
  and at a JPEG page inside a phone's scanned PDF. Also in the Tauri window: choosing several files at once, and dropping files on
  the Scans panel (the window may take a drop for itself).
- [ ] **Review with a screen reader and with the keyboard alone, on a real class.** The keys are built (a letter or a digit chooses
  the bubble, 0 is blank, Enter records several, the arrows move, Z takes the last back) and announce what they did. Real key
  presses were tried in the built-in browser on 7 November 2026 on a sitting of three drawn sheets: B recorded the answer and said
  "Recorded B for sheet 2, question 2. 2 to go." with focus on the next question, Z said "Took back the last decision. 3 to go." and
  put focus back, and the right arrow moved to the next question and cleared the message. Nobody who uses a screen reader has tried
  them. Also look at how long a class of 100 sheets takes to settle by key, and whether the piece of
  picture is large enough on a laptop screen to tell a faint mark from an erasure.
- [ ] **A real-sheet corpus.** Volunteers fill in printed sheets by hand to a written answer list; scan them on the department
  copier (feeder, 200 and 300 dpi, grey and black and white), on a flatbed, and photograph them on an iPhone and an Android phone in
  office light. The expected answers come from the volunteer's list, never from the reader. Tune thresholds on half and report on the
  other half. The targets are in the spec's success criteria.
- [ ] **Print the sheet on the department printer and photocopy it.** Check my printing should read a scan of one blank photocopy:
  corner marks, code strip, no blank bubble read as filled, and the scale within 2 percent. (`assess sheets check <bank> <picture.png>`
  does this on a PNG now; it says the printed size only when the picture says how many dots to the inch it was scanned at.)
- [ ] **Set the lines for a filled bubble and an empty one on real pencil.** They are provisional: 0.5 and 0.1 (0.06 for a question with
  several answers), chosen on drawn sheets where a firm mark reads 0.65 to 0.85 and a hurried scribble 0.4 to 0.6. Real graphite on a
  real scanner may read lighter, and then firm marks will be flagged more than they should be. Fill in sheets with a #2 pencil, a
  ballpoint and a felt pen, lightly and firmly, and look at the fills in `assess sheets read <bank> <picture.png> --json`.
- [ ] **A black and white scan of pencil marks.** The reader knows a black and white picture when it sees one (hardly any grey) and reads
  no question with several answers from it, because pale pencil can vanish and a smudge can come out solid, and no program can tell
  which. Scan the real sheets in black and white and see how much of a class this flags. If instructors scan in black and white by
  habit, the flag is a nuisance and a fax decoder is not the point: the point is to tell them to scan in grey.
- [ ] **Look at what a photograph does that the drawn photographs do not.** Lens distortion, a curled page, a shadow of the phone, a
  creased corner. The drawn ones lean and are lit from one side but are flat and sharp over the page, and a curled page can put a
  row more than a millimetre from where the corner marks say, which flags that row ("registration") and does not read it.
- [ ] **The 5 percent and 1 percent targets are for real paper.** On drawn sheets 0 of 1,600 pages gave an answer read wrong without a
  flag, and firm marks on clean scans were flagged 0 times in 100. That says the rules hold. It does not say how many answers a real
  class will have flagged; only the real-sheet corpus does.

## Check quality (the notes about writing and accessibility)

Planned in `docs/design-plan.md` (phase 7, first set). Everything a program can check is in `quality-items`, `quality-bank`,
`quality-cli` and the app's `quality` tests and in the mutation run. What is left is whether the notes are right about real questions.

- [ ] **Check a real bank and read every note as the author of the questions.** Press Check quality on a bank you wrote, or run
  `npm run assess -- check <bank>`. For each kind of note ask whether it was right to speak, and which you would switch off. The
  rules are written to be silent when unsure, and they have only been tried on invented questions. Likely to be wrong: the right
  answer being the longest (a real question can have a long right answer for a good reason), the stem that ends in "a" or "an",
  and NOT or EXCEPT in a stem that is already clear.
- [ ] **Look at the copies on a bank that has some.** The same question twice, and a few words changed. Is "very much alike" the
  right line (0.85 of the words, the same numbers), and is a question with the same wording and a different answer marked worth
  being called alike? Questions with pictures are not compared at all. Measured on 7 November 2026 on real questions: a bank of 549
  (one exam's) and the 1421 of the real Word banks had 26 alike groups between them and every one was a deliberate parallel (a
  full-wave and a half-wave supply, series and parallel circuits), none a copy, so a pair whose stems differ and whose right answers
  differ is no longer called alike (2 groups remain, which agree on the answer). Neither source had a real copy, so what a bank with
  copies looks like is still unseen: copy some questions of your own and look.
- [ ] **Look at where the right answers sit on a real test.** Assemble a test and check the bank. A version whose key is mostly one
  letter should be said; one that is not should not. The test is a binomial test at 20 answers or more, divided by the letters tried.
- [ ] **Use the Check quality panel and the notes in the editor with a screen reader and with the keyboard alone.** The panel opens
  in the pane where a question would be and takes focus; each question in a group of copies is a button; each note can be dismissed
  in the editor. Looked at in the built-in browser at desktop and phone width, not with a screen reader.
- [ ] **Read the note about a typed answer with a curly quote in it.** A short answer or fill in the blank whose accepted answer
  has a curly apostrophe or quotation mark, a dash or an ellipsis is noted, with the plain form to add (`typedAnswerTypography`).
  Is it right to speak? A phone can curl an apostrophe by itself, so a student may type either form, and the note asks for both.
  Check an LMS too: type the plain form against an accepted curly one and see whether it is marked wrong.
- [ ] **Decide the lines.** A matching list is long above 8 pairs; the right answer is noted when it is 1.5 times and 20 characters
  longer than the longest wrong one; two questions are alike at 0.85 of their words; a spread is judged at 20 answers. All are
  named constants (`LONG_MATCHING_LIST`, `LONGEST_RATIO`, `LONGEST_MARGIN`, `ALIKE_AT`, `BALANCE_MIN_ANSWERS`), chosen to be quiet.

## A bank that opens with something wrong

- [ ] **Damage a bank in a shared folder the way a sync does, and open it.** Copy a bank, open it as a zip, empty one question file
  (or delete one), and put it back in the library folder. The bank screen should say, in an amber box above the list, that it held
  more questions than could be read and which file could not be read, and the damaged file should still be in the bank after you
  change a question. Looked at in the built-in browser; the wording ("an earlier copy") assumes the person has one, which a person
  with no backup does not.

## Coverage and narrowing a list

Everything a program can check is in `coverage.test.ts` (engine and app). What is left needs a real bank and a person.

- [ ] **Use Coverage on a bank whose questions have objectives, chapters and Bloom levels from a real course.** Do the grid and its
  labels make sense when the values are your own words, and are the objectives in the order you expect? They are put in order by
  name with numbers counted as numbers (1.2 before 1.10), which is right for "1.2 Explain" and may not be for objectives with no
  numbers. Whether a question with nothing set should be counted under "Not set" or kept out of the grid is a choice (here it is
  counted, so the gaps show); it is one place in `bank/coverage.ts`.
- [ ] **Use the grid with a screen reader and with the keyboard alone.** It is a table with a caption and header cells, each count
  above nothing is a button whose name says what it shows ("2 questions: Chapter 2, easy. Show them."), and focus moves to the
  heading when the grid opens. Looked at in the built-in browser at desktop and phone width (the table scrolls inside its own box
  at phone width), not with a screen reader.
- [ ] **Use Pick for me to build a real test.** On Make a test, pick five from one chapter, then five from the next, and look at
  what it chose and what it says it left out. It is random and keeps nothing (a stored recipe is a blueprint, next). It leaves out a
  question with no usable answer key, which a person can still choose by hand, and a copy of a question already in the test (the
  same words, or 0.85 alike with the same numbers).
- [ ] **Write a blueprint for a real test and use it.** In Answer sheets, open "Write or change a blueprint" above Make a test, write
  "5 from chapter 1, 3 from chapter 2" with the chapters of a bank of your own, save it, and press Use. Look at what it chose and at
  what it says when a chapter has fewer than you asked for. Press Use again for another draw, take a question out and put another in
  by hand, and make the test. Then change a question in the bank, or retire it, and use the blueprint again to see that nothing in
  it went stale. A rule can ask for two or more things together ("chapter 2 and the apply level": press "Also ask for another value"
  in the rule), so write one with the chapters and levels of a real test plan, one rule to a cell of the grid, and see what it says
  when a cell has fewer than you asked for. A limit ("at most 2 hard") is not built, and whether you would rather the blueprint kept
  a seed so that a draw can be repeated is yours to decide. Looked at in the built-in browser at desktop and phone width and driven by script (create, use, change, delete, a name
  made of markup shown as text), not with a screen reader and not with a bank of real questions.
- [ ] **Try the three states the window can be left in.** Open a cell of the grid on a bank with a retired question and see that
  the list has the number the cell showed (the retired are left out), and that Clear filters brings them back. Start changing a
  question, press Check quality, and see that the pane you are typing in is left alone and the notice says why. Narrow the list
  to a chapter, change the last question of that chapter to another, and see that the select still says the chapter (with 0)
  and not "Any chapter". These are in the window's script and are not reached by the server tests.
- [ ] **Look at the narrowing selects on a bank with a lot of tags.** A select is made for each of objective, chapter, section,
  tag, Bloom level, difficulty and status that the bank has values for, so a bank with hundreds of tags has a long list in one
  select. If that is too long, a search box in place of the select for tags is the likely change.

## Folders

Everything a program can check is in `folders.test.ts` (engine and app), the fuzz of damaged requests, and a look at the screens in the
built-in browser at desktop and phone width. What is left needs a real bank and a person.

- [ ] **Sort a real bank into folders by chapter and see whether it feels right.** Make a folder per chapter, put questions in from
  the choice beside each one, or narrow the list (by chapter, say) and use "File these N in…" to file everything shown at once, and
  see whether that is bearable for a few hundred questions. Filing several at once was built on 6 November 2026 and looked at in
  the built-in browser, not on a real bank. An import can also be saved into a folder named for the file: try that with a real
  chapter first.
- [ ] **Delete a folder that has questions and folders in it, and read the words.** The box says the questions stay in the bank in
  no folder and the folders inside move up one level. Is that what you expected from Delete, and is "Delete" the right word for
  something that keeps everything?
- [ ] **Use the Folders panel with a screen reader and with the keyboard alone.** Each folder is a row with buttons named for it
  ("Rename the folder Chapter 1"), a choice for where it goes ("Put the folder Chapter 1 inside"), and a Delete that asks first;
  focus goes back to the control used after a change, and to the heading after a delete. Looked at in the built-in browser, not
  with a screen reader.

## The suite's look (2026-11-11)

Built and checked by tests (`packages/app/test/suite-look.test.ts`) and in a real browser by a script (62 checks: the menus by
keyboard and pointer, the bank's "...", the command search, the keys list, the dialogs' Close button, 375 and 320 pixels wide, dark
colours, a high-contrast theme, and OpenStage Author's accessibility audit on the navy bar, the menus and every open dialog and menu,
which found nothing there). Pictures as it was are in `D:\Claude Audio Test\revamp-screens\assess-before`, and after in
`assess-a1`. Not tried by a person.

- [ ] Open the app and use it for a while: is every command where you would look for it? Write down anything you would move.
- [ ] F10, then the arrows through the menus; Enter on an item; Escape back. Ctrl+K and type "print" or "check"; Ctrl+/.
- [ ] On a bank: the "..." beside its name (Rename, Folders, Coverage, Check quality, Remove), and Print, Answer sheets and Export on
      the navy bar.
- [ ] File > New bank… while on another screen: it goes to your banks and asks for the name there. File > Open a bank file… does the
      same and opens Windows' own file chooser: in the window, check that the chooser still opens after the move (a browser lets a
      page open one only soon after a click).
- [ ] With Narrator, and with NVDA (only when you are away from the computer: NVDA logs everything it speaks): a menu's name ("File,
      menu item, collapsed" or similar), an item that cannot be used now ("Rename…, unavailable"), the command search (the chosen
      command should be read as Up and Down move while the keyboard stays in the box), and a dialog's Close button.
- [ ] Windows' high-contrast themes in the window: an open menu's item and the chosen command are filled in the system's highlight colour.
- [ ] The accessibility audit also listed older things on the screens' own parts, which this change did not touch and did not fix:
      tick boxes and round buttons are 18 pixels (a target should be 24, unless the words beside them count as part of it, as they do
      here), a link in a sentence (Show this folder), the select boxes of a bank's tools, and on the import review a heading that
      skips a level (Pictures). Say whether to work on them.

## The app and its window

Everything below was run by tests (`npm test` in `packages/app`, 96 of them, through a real HTTP client) and looked at in
the browser pane and in the built window at desktop width. None of it has been used by a person, and none of it has been
run on a machine other than the one it was built on.

- [x] **Repair a question whose Answer line disagreed with its option, in the window, and tick the right answer.** The error about
  the file's key should turn into "Replaced by your answer" (with its words), the other error should go, the question should
  read Parsed, and the save should say that your answer replaces what the file's key said. Then put it into a bank with the
  others: it should be kept as an ordinary question, and export. Done in the window on 1 November 2026, seen in a recording
  with `repair-practice.docx`: all six faulty questions repaired, each save saying so, the file's error listed as "Replaced by
  your answer", 10 of 10 Parsed, put into a bank and exported as it was. The rule's edges are under Decisions below.
- [x] **In the window, press Save a copy… on a sample on the first screen.** It should open the same Save dialog with the
  sample's own name (`solar-system-test-bank.docx` and so on) and nothing should be written into the Exports folder: before this
  the button wrote the file there without asking and opened the folder. Done: reported as a pop up where you decide where to
  save, on 1 November 2026. The blank table's button is "Save a copy to fill in…".
- [x] **In the window, press Save a copy… on an exported or printed file.** Windows' own Save dialog should open, titled "Save a
  copy", with the file's name filled in and its type chosen; saving writes the file where you chose, and closing the dialog
  writes nothing. Done in the window on 1 November 2026, seen in a recording: the dialog opens in front of the window with the
  name and "PDF file" filled in, in the Documents folder (the person chose Downloads, and the file is there). Not yet tried: a
  name that already exists (Windows should ask before replacing it), and pressing Save a copy… twice quickly. In a browser the
  link does whatever the browser does with a download.
- [x] **Press Show in folder on a file with spaces in its name** (most have them: a bank titled with two words, or the suffix on a Brightspace file). It should open the
  Exports folder with the file selected. Before this was fixed it opened Documents and showed nothing. Done in the window on
  1 November 2026, seen in recordings: it opens the Exports folder with the file selected.
- [ ] **Double-click `Open OpenAssess.cmd`, make a bank, import a real Word bank, repair a question, export, print.** The
  whole loop as a person would walk it. Write down the first place you hesitate; that is where the screen is wrong.
- [ ] **Open a bank or an import of more than 1000 questions and use the end of the list.** The list draws its first 1000 rows, then a
  line that says how many are not drawn, with Show 1000 more and Show all. Looked at in the built-in browser on 7 November 2026 with
  5000 and 20,000 questions (timings are in `docs/review-findings.md`). With real key presses in that browser (a 2500-question
  import): Enter on Show 1,000 more drew the next 1000 and put focus on the first new row, two arrow-downs moved it two rows, and Enter
  chose that question with focus staying on the row. Not with a screen reader. Try: that the line is read as part of the list; that
  searching or choosing a filter starts again from the first thousand. Show all is offered only up to 5000 questions, so past that
  a person asks for a thousand more at a time: is that enough, or would you want to jump to the end?
- [ ] **Run the window** (`packages/app/shell/src-tauri/target/release/openassess-shell.exe` after `npm run build:exe` in
  `packages/app/shell`) and close it. Check Task Manager afterwards: there should be no `node.exe` left. It was checked
  here by closing the window and listing processes; the force-quit case (End task on the window) was checked by killing it.
- [ ] **Run the installer on a machine that is not this one**, if you want to hand the tool to anyone. It was built, and
  its layout was started from a copy in a temporary folder; it was not installed, because installing changes your machine.
  Expect Windows to say the publisher is unknown (the installer is unsigned) and, on a machine without the Edge WebView2
  runtime, to fetch Microsoft's bootstrapper.
- [ ] **Open the printed Word copies in Word and look.** `check:word-print` asks Word what the paragraphs, numbers and page
  count are (4 documents, 148 paragraphs, no disagreement), and what page each question of a long test starts and ends on (180
  questions, none split across a page; before the fix Word split 20 of them). It cannot say whether the page looks right: the
  spacing, the writing lines, how much white space is left at the foot of a page by moving a whole question to the next. A long
  test is a page or so longer than it was, because a question that would have been split is moved whole. Look at one, and at
  a question that is taller than a page (a long essay prompt), which is still broken where it must be. Seen so far, in a
  recording of 1 November 2026: a PDF student copy of ten questions in a desktop PDF program, with question 5 ending page 1 and question 6
  beginning page 2, and some white space under question 5. The Word copy has not been looked at since the change.
- [ ] **Open a printed PDF in the viewers you use** (a browser, a desktop PDF program, a phone). The PDF is written by hand with the
  standard fonts and no tags, so a viewer that is stricter than the ones tried here may complain. Look for a character that
  printed as `?`; the print screen lists those before you print.
- [ ] **Look at the screens at phone width and in dark colours.** The browser pane was used at desktop width. The page has
  dark colours and narrow layouts that nobody has looked at.
- [ ] **Use the whole app with the keyboard only, and once with a screen reader.** Focus moves to the content when a screen
  changes and every control is a real button or field, but that is the design, not a check.
- [ ] **Import a Moodle XML or GIFT file you really use** (the exporters were checked by reading their own output back; no
  Moodle was available, so neither file has been imported into one). `docs/design-plan.md` lists sandboxes as an open
  question.
- [ ] **Decide whether the installer should be signed.** A code-signing certificate costs money, so it was not bought.
  Until it is, every other computer shows a warning on first run.

## Decisions that are mine until you say otherwise

These change what the app does, and were made without asking. Each is one flag or one line to reverse.

- [ ] **The window is Tauri around a local Node server, and the installer carries its own copy of Node** (about 90 MB).
  You chose Tauri; carrying Node is mine, because the engine runs on Node's type stripping and there is no other way to
  keep the rule of no runtime dependencies. The alternative is a smaller installer that asks the person to install Node.
- [ ] **The library is `Documents/OpenAssess`** (banks, `Deleted`, `Exports`), or the folder named by `--home` or
  `OPENASSESS_HOME`. A deleted bank is moved to `Deleted`, never removed. A deleted question cannot be got back from the
  app, and it says so first.
- [ ] **An error finding cannot be dismissed; a warning or a note can.** A question with an error is kept, shown, and
  exported only with the destination check naming it.
- [ ] **A retired question is left out of an export unless you ask for it.**
- [ ] **A printed student copy shows no answer; the key shows only answers the bank records, and says "No answer is recorded
  for this question." for the rest.** It never fills one in. Matching and ordering are shuffled on the student copy, the same
  way every time for the same question.
- [ ] **PDF uses the standard fonts, with the Symbol font for Greek letters and signs of mathematics.** A character outside
  Latin-1 and that font (Cyrillic, Chinese) prints as `?` and is reported first. Print a test that has α, ≤, ∑ and → in a
  stem and an option, and look at it in the PDF viewer you use: the letters should be there, at the size of the words round
  them. It was seen once, in Windows' own renderer, and in no other viewer.
- [ ] **The app keeps at most 12 open imports at once**, and the oldest is dropped. Nothing is stored until you accept one.
- [ ] **A table is read by the names in its first row, and a table with none is read only if it starts with a question type.**
  Author reads any table with no names in the template's order. Here a layout nobody has told it is refused, because a
  guessed column puts one cell's words where a key goes.
- [ ] **A row of a table with a mistake is kept, not left out.** Author leaves it out. Here it is on the repair screen with its
  row beside it, marked with no answer.
- [ ] **Hidden rows and hidden sheets in a workbook are read, and counted.** A filter hides rows without removing them, so a list
  filtered to the questions you wanted comes in whole, with a note of how many were hidden. The other way (leaving them out)
  would drop questions a person never sees, which is the thing this project does not do.
- [ ] **A `Category` or `Topic` column becomes a tag, an `Explanation` or `Rationale` column becomes general feedback, and an
  `Attempts` column is reported and not stored** (attempts are a setting of the course).
- [ ] **An `ES` row is an essay, and a row whose Type is empty is worked out only where the row says what it is** (two answers
  or more is multiple choice, no answers and True or False in Correct is true or false, anything else is an essay, flagged).
- [ ] **A PDF is refused with a message, not read.** See above. The message says to open the PDF in Word and save it as `.docx`.
- [ ] **A PDF is read from its text alone, and formatting is never read as a key.** A bold option in a PDF, with no asterisk and no
  Answer line, has no key: the question fails and says so. A Word file whose author bolded the answers reads differently, because
  Word says what is bold; a PDF's fonts are only names, and a font named Bold is often bold for another reason.
- [ ] **A page number and a running title are left out of a PDF**, counted and quoted in the file's notes, never a line that begins
  like a question or an option.
- [ ] **A broken word at the end of a PDF line keeps its hyphen** unless the document spells the word whole elsewhere
  ("writ-ten" stays so; "self-concept" is not run together). The other way (always joining) would change real words.
- [ ] **An Answer line is believed only where its letter and its words agree.** A line that spells an option's words another way
  ("Speaking" for "Spoken") is refused and says both, and no answer is marked, where a person would see the one letter and trust
  it. Whether to match loosely is yours; it would sometimes be a guess.
- [ ] **A numbered outline before the questions is read as essays and flagged**, as eight were in one PDF. Telling an outline from a
  list of essay prompts would be a guess, and numbered prompts with no heading are common. They are marked for review and can be
  left out of the save from the import screen.
- [ ] **Every quality note is a note, never a warning or an error.** A warning makes a question "needs review" and an error makes
  it "failed", and the import gate and the exports go by those. So Check quality can never make a question look broken, and also
  never holds one back from an export. If you want a kind of note to count (two options that read the same, say), it is one
  severity in `quality/items.ts`, and the questions that have it would then show as needing a look.
- [ ] **A question saved in a bank has its notes made fresh; an import has none until the bank is checked.** At import a finding means
  the importer had to guess, and notes about style would be mixed in with them. So a bank you just imported shows no notes until you
  press Check quality or save a question in it.
- [ ] **What looks across questions (copies, the spread of right answers) is shown and never kept.** A note about two questions goes
  stale when either changes, so it is worked out each time. The cost is that "these two are meant to be alike" cannot be remembered.
- [ ] **A picture's description is written in the editor, and a missing one is a warning that goes when it is written.** It is raised
  by the importers and by adding a picture by hand, and dismissed or cleared by a description or a mark as decoration. Is a warning
  (which makes a question "needs review") the right weight for a missing description on every figure of a bank? An equation that is
  a picture is not covered.
- [ ] **The samples are about the planets, and are in the repository** (`packages/app/samples`, made by `tools/make-samples.ts`),
  so they are offered on the first screen of any install. Saving one writes it to the Exports folder, never over a file.

- [ ] **Types read from the answer are not flagged for review** (`True`/`False` alone with no options, `Accepted answers:`, a
  matching instruction with `left = right` lines). Each leaves an information note instead. The old rule flagged a type worked
  out from the shape of a question.
- [ ] **`Accepted answers: Paris, France` is read as two answers**, cut at semicolons or at a comma and a space, and the
  question says it was cut. A single answer with a comma in it is cut wrongly.
- [ ] **A choice question whose option letters have a gap (A and C, no B) is flagged for review.**
- [ ] **Two spaces or a tab before an option letter start a new option, whatever follows** (`A. mother   B. aunt`).
- [ ] **Two letters on an answer line with no type named make a multiple response, and the question is flagged.** A stated
  `Type: MC` is not overruled and still fails. Whether a slip like `B, D` on a single-answer bank should be flagged as a
  multiple response, or refused as before, is yours.
- [ ] **A stem with no options and an answer in words, and no blank, stays an essay, flagged.** Reading it as a short answer
  when the answer is a few words would clear most of what the generated banks still flag, and would be a guess about the
  author's intent. Whether to do it is yours.
- [ ] **A one-line statement ending `(T)` or `(F)` is read as true or false when three do.** The habit is what keeps a stem such
  as "Convert 100 C to degrees (F)" from becoming a false statement.
- [ ] **A stem with a blank and an answer in words is a fill in the blank, with a note and no flag.** An answer that is a letter
  is never read this way.
- [ ] **A bank with no numbers and no letters is read by its layout, and only the file as a whole is warned.** A question in it
  is `parsed` unless the step saw a sign that its stem may be longer than one line. Whether every question read this way should
  instead be marked for review is yours: it is one `warn` per question in `standard-text.ts`, beside the suspect note.
- [ ] **A dash, `n/a` or `none` in an answer key means that question has no key.** It is never taken for an answer, so the
  question is refused unless it carries its own answer. A key that really means "N and A" for `N/A` would be misread, which
  is rare enough to prefer a refusal to a guess.
- [ ] **A heading `Answer Key` followed by entries is a key; followed by questions it is the copy with the answers.** One lone
  line that looks like an entry, with nothing after it that does, is not enough to make a key.
- [ ] **Hidden text is not read.** A note to self or an old answer that Word hides is left out, and the file says how much and
  quotes the first. The other way (reading it as text) would put hidden notes in stems and old answers in keys without a
  word, so this is the safe one; but a bank whose only key is hidden has no key to read, and is refused with the file naming
  what was left out. Whether hidden text should ever be read, say by an option you set, is yours.
- [ ] **Text in a text box is not read, only counted and quoted.** A question in one is missing from the bank, and the file
  says so. Offering it as an orphan with its place was decided against until a real file holds a question in a box.
- [ ] **The review page is written to the folder you run it from** (`<name>-review.html`) unless `--out` is given. Whether it
  should open itself in the browser, or sit beside the document, is yours.
- [ ] **The 13 openly licensed files** (CC BY 4.0) are kept on this machine only. Whether to commit them as fixtures, with
  attribution, so that the check runs from a clone. The page that shared them names no author.

- [ ] **Brightspace takes plain text for options, items, answers and feedback.** Only the question text is written as HTML,
  because that is the one place the article shows it. Bold in an option arrives plain, and the check says so. Whether
  Brightspace also reads the `HTML` flag on an option is a thing to try in a course, and it is one line to change.
- [ ] **Difficulty, tags, images, an answer key for a written response, and a model answer are not written to the Brightspace
  file.** The article does not document entries for them (it documents `Image`, but as a file path that would have to travel
  with the CSV), so none is guessed. The check names each loss.
- [ ] **A points value that is not a whole number from 1 to 100 is not written to the Brightspace file,** and the question is
  said to arrive with Brightspace's default. Half a point is the usual case.
- [ ] **A fill in the blank with one blank goes to Brightspace as a short answer;** one with several blanks is left out,
  because Brightspace's CSV cannot import a fill in the blanks question.

- [ ] **The QTI package leaves out ordering, numeric, hotspot and calculated questions, and carries no feedback or partial
  credit.** Neither Brightspace nor Canvas documents an ordering or numeric question in a QTI file, so none is written untried;
  the ordering note points to the Brightspace CSV, which carries ordering. Feedback and partial credit are not written in this
  first version: both are possible in QTI and neither is checked against either tool. Say if you want them.
- [ ] **One QTI package serves Brightspace and Canvas.** They are two destinations in your mind and one file here. It is written
  the way Canvas writes its own QTI 1.2, which Brightspace is said to import as well. If a tool wants something the other does
  not, they split.
- [ ] **Blackboard's file gives every question the same points,** the number typed when you upload. A question worth something
  else is said to arrive with that number instead. A file of more than 250 questions is written as several files.
- [ ] **A short answer goes to Blackboard as a fill in the blank,** because that is the Blackboard question that checks a typed
  answer against a list. Blackboard's own short answer is marked by hand. A fill in the blank with several blanks is left out:
  Blackboard's file for several blanks (FIB_PLUS) needs the blanks named in the text, which is not done.

- [ ] **A person's own answer replaces only the importer's two errors about the file's key, and only when the answer changed and is
  usable.** You asked for the repair screen to stop keeping the error after a person chooses the answer; where the edges are is
  mine. Replaced: "the key names an option the question does not have" and "the letter and the words name different answers",
  dismissed under the person's name and still listed, with the save saying so. Not replaced: anything when only the wording,
  the title or a setting changed; anything when two answers are marked on a single-answer question; a question kept as an essay.
  The wider choice was turned down: replacing on any edit that leaves a usable key (it would hide an error while the file's key
  is still the one in use). Each is one set or one condition in `quality/answer-key.ts`.
- [ ] **Words written where a placeholder was replace the importer's error about it, one option at a time.** Also asked for as a
  follow-up, and the edges are mine: "Option C has no text" goes when option C has words, "only one option" and "no options" go
  when there are two or more options and none is `(missing)`, empty or only spaces. A placeholder typed in again keeps its error.
  Dismissed under the person's name, listed as "Fixed by your words". A matching question with fewer than two pairs is not
  covered (its placeholder pairs are raised as a missing answer, which an edit re-derives). Each is a condition in
  `quality/placeholders.ts`.
- [ ] **Repair the second practice file, in the window.** `repair-practice-2.docx` (in Downloads) has an option with no words, a
  question with one option, and a multiple response with none. Write words into each placeholder, tick the answer where the
  question needs one, and each question should turn Parsed with "Fixed by your words" beside it. Checked in a browser and by
  tests, and not in the window.

## Not in this repository

- [ ] The notes about the OpenStage Guide add-in were sent to its own session and have not been seen answered.
