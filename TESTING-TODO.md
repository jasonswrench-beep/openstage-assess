# Things only a person can check

Everything that a program can check is checked by the tests (`npm test`), the accuracy gate, the real-file score and the
mutation runs, and is not listed here. This is what is left: what needs Word on screen, a person's eye, or a decision. Each
item says what has been run and what has not. Items are removed when done, with the date.

## Needs Word, on a Windows machine

- [ ] **Run `Check OpenAssess.cmd` by double-click, start to finish.** Its test line has been run through `cmd.exe` and runs all
  the tests, but the whole file has not been run: the accuracy step, the speed step and the pause at the end.
- [ ] **Open a few of the generated documents in Word and look.** The checker reads the XML, and only Word can say what Word
  shows. Worth opening: `c-06` (Word's own numbering), `c-11` (bullets and `(Correct)`), `c-16` (highlight), `c-21` (bullets
  and underline), `c-10` (font colour). They are in the session's scratch folder under `generated/` and in the zips you sent.
- [ ] **Run `npm run check:word-authored`, `check:word` and `check:word-formatting`** after any change to
  `import/docx/numbering.ts`, `formatting.ts` or how tables are read. Stage 4h changed none of them. The hidden text change
  (stage 5) touched `formatting.ts`, so `check:word-formatting` and `check:word` were run on 1 November 2026, each with
  hidden text added, and found no disagreement with Word. `check:word-authored` is not due.
- [ ] **Hide a whole numbered paragraph in Word and look at the numbers.** Triple-click one item of a numbered list, press
  Ctrl+Shift+H, and make sure Word is not set to show hidden text. Word's object model counted the hidden item (the item after
  it kept its number), and the reader does the same. What the page shows on screen is not something the check can see.
- [ ] **Put a question in a Word text box and import it.** `check:word-authored` does not write a text box, so how Word spells
  one in a real file is read from memory of the format. Expected: the question is missing, and the file says so and quotes the
  start of the box.

## Needs a person's eye

- [ ] **Look at the review page.** `npm run assess -- review <a .docx or .txt file> --out review.html`, then open the page. It is
  the first thing you can see, so it is the first thing to judge: is it the right information in the right order, and what would
  you want to change a question into, by hand, from it? It has no script and cannot change anything yet. Try it on a real bank
  if you have one. It was looked at in the browser pane at desktop width and at phone width; the dark colours were not looked at.

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

## Brightspace

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
- [ ] **Course Import's QTI 2.x and 3.x subset is not built.** Brightspace's Quizzes tool takes QTI up to 1.2 (built, below) and
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

**The second try, the same day, by the Course Admin route the test-bank vendor documents:** "It still does not like the format". No message
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

## Answer sheets (the scantron part)

Planned in `docs/paper-tests-spec.md`. These are the parts that need people, paper and machines. Everything a program can check is
in the tests and in `assess sheets gate`.

- [ ] **Scan a test page on the department copier, and with two phones, and look at what each PDF holds.** In grey, in colour and in
  black and white on the copier; one scan each from the iPhone and the Android document scanners. For each PDF: the image format
  (JPEG, fax, JBIG2 or something else), how many images are on a page, and the page rotation. The build reads JPEG, Flate and
  uncompressed images only, so this says whether a fax decoder or pdf.js is needed. Decided on 4 November 2026 to build without it.
- [ ] **A real-sheet corpus.** Volunteers fill in printed sheets by hand to a written answer list; scan them on the department
  copier (feeder, 200 and 300 dpi, grey and black and white), on a flatbed, and photograph them on an iPhone and an Android phone in
  office light. The expected answers come from the volunteer's list, never from the reader. Tune thresholds on half and report on the
  other half. The targets are in the spec's success criteria.
- [ ] **Print the sheet on the department printer and photocopy it.** Check my printing should read a scan of one blank photocopy:
  corner marks, code strip, no blank bubble read as filled, and the scale within 2 percent.

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
- [ ] **PDF uses the standard fonts and Latin-1 only.** A character outside it prints as `?` and is reported first.
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
