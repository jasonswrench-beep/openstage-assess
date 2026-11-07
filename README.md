# OpenAssess

[Roadmap & Feature Requests](https://app.productbridge.io/widget/784db895-cb64-45f4-9bde-4645df4aa083?tab=roadmap)

A free desktop tool for writing, importing, organizing and exporting assessment
questions, so an instructor can turn a Word test bank into an LMS-ready quiz
without retyping a single question.

One of the OpenStage suite of tools; it stands on its own. Apache 2.0.

The engine came first, on purpose: the parse-accuracy target is the whole product, and it
cannot be iterated on through a user interface. It is built and measured, and **there is
now an app on top of it**: open a Word, Excel, CSV, PDF, text, Aiken, GIFT or Moodle XML file, see what was found beside
the lines it came from, repair what needs it, save it into a bank, write and edit questions,
and export or print them. The Word importer's acceptance target (95 percent on three real
chapters it was not fitted to) is not yet met, because no such chapters exist yet; see
`docs/word-import-plan.md` and `TESTING-TODO.md`.

## Running it

**In a window.** The installer for the desktop window is built from `packages/app/shell`
(see its README) and carries everything it needs, including Node.

**In your browser, with only Node installed.** Double-click **Open OpenAssess.cmd**, or run

```
node --experimental-strip-types packages/app/src/main.ts --open
```

Your banks and exports are kept in `Documents/OpenAssess`. The app runs on your computer
only and answers only to the window it opened.

## What works today

- The open question model: eleven question types, one envelope, validation,
  migrations, a restricted rich-text subset.
- The `.openassess` bank container: zip of JSON, read and write, folders, saved
  filters, history, an in-memory search index.
- A read API for other programs (`src/read/`). Nothing depends on it and it may
  be removed; see `docs/design-plan.md`.
- Profile one of the importer: the standard test-bank text format (the
  plain-text layout many publisher test banks follow), read from plain text.
- The Word importer, so far: a `.docx` is read into the same blocks the text
  importer uses, so a question in a Word file goes through the same scanner,
  builder and accuracy gate. Question numbers and option letters can be typed or
  made by Word's own lists, including multilevel lists and lists set by a paragraph
  style. Questions can be laid out in tables: a grid with a header row, rows that
  begin with a label, an answer key, or a table for each question with a table inside
  it for each option, as publishers lay them out. Headings such as "True / False"
  give the questions under them their type, and a bank given twice, once to print and
  once with the answers after an "Answer Key" heading, is read as one bank. The
  correct option may be marked with an asterisk (before the letter, or after it when
  the whole file does so), an `Answer:` line, an Answers list,
  a column, a letter alone under the options, `(T)` or `(F)` at the end of a true or
  false line, or by formatting it (bold, underline, a highlight, a colour, on the words
  or on the option letter alone), which is read as a habit of the whole file and
  reported for the author to confirm. Banks numbered chapter.question (`1.14`),
  page notes such as `(Page 3)`, a note on an Answer line, matching exercises as
  tables, and fill in the blank sentences with the answer in bold are read too, as are
  several options on one line, an `ANS: C` at the end of a line, a KEY line of fields, the
  explanation under an answer, `(Difficulty 3)` notes, matching given as terms,
  definitions and foils, and a bank with no numbers or letters at all, each question a
  type line (`MC`), its stem and its options, with a star before the right one. A
  question that never names its type is read from its answer when that is plain: a
  statement answered `True` or `False`, an `Accepted answers:` line, or an instruction
  to match with a line for each pair. A
  Text that Word hides is not read, so a note or an old answer left hidden in a bank
  does not turn up in a question; the file says how much was left out and quotes it.
  Text inside a text box is not read either, and the file says so. A
  Word 97-2003 `.doc` has to be saved as `.docx` first. Lists and formatting are checked against Word
  itself, and `fixtures/word-authored` holds documents that Word wrote
  (`docs/word-import-plan.md`).
- The app (`packages/app`): a small local server that puts the engine behind a web
  interface, shown in a browser or in a Tauri window. Screens for your banks, the
  import review and repair, a bank (search, filters, writing and editing questions of
  nine types), export, and print. It is plain JavaScript with no framework and no build
  step, runs on 127.0.0.1 only, and is built to be safe from other pages in the same
  browser: a key handed to the window once, a Host check, a header every change must
  carry, and a policy that allows only its own scripts. See `docs/design-plan.md`.
- Moodle XML in (`import-moodle-xml`): the file Moodle writes when a question bank is exported, read
  with the key the file gives and none it does not (an answer is right when it is worth the whole of
  the points; a question where none is has no key and says so). Multiple choice, multiple answer,
  true or false, short answer, matching, essay and numerical questions are read, with their points,
  feedback, tags, category and pictures. A cloze, a drag and drop and the rest are kept as text and
  marked failed; a description is an orphan. Moodle's standard feedback sentences are not kept as
  feedback. Read back, what this program exports is what was exported.
- Aiken and GIFT in; GIFT and Moodle XML out, each with the destination check that says
  what will arrive, what will be lost and what cannot go. A `.txt` file is told apart
  by what is in it.
- A Brightspace (D2L) Question Library file out: the CSV that Brightspace's Import, Upload
  a File reads, with multiple choice, multiselect, true or false, short answer, matching,
  ordering and written response. What its CSV cannot take (a numeric or arithmetic question,
  several blanks) is left out with the reason, and what it cannot carry (feedback on one
  answer, a rubric, pictures) is said against the question. It has been checked against
  Brightspace's published description of the file, and one file of multiple choice, true or
  false and written response questions has been imported into a real Brightspace course and
  arrived as written. A second file with all seven types (a twelve question test bank) was
  imported later and the person who did it said it worked fine; no record was kept of each
  question, so the right answer on each, a multiselect's scoring and the formatting have
  not been looked at one by one. A file in this shape comes in as well (a .csv whose first row
  that is not a comment is a NewQuestion row): each question is read by the keyword in its rows,
  and what this program exports is what comes back. A weight that is part of the points is never
  a key, and a kind it does not read is kept as an essay with its words and fails.
- A QTI 1.2 package out, for Brightspace's Import/Export/Copy Components (quizzes) and for
  Canvas's Import Course Content (QTI .zip file): multiple choice, multiple answer, true or
  false, short answer, matching and essay, each with its points. Ordering, numeric, hotspot
  and calculated questions are left out with the reason, and feedback and partial credit are
  not carried. It is held to the structure of QTI 1.2 and to a response processor that scores
  every possible answer, so the key is shown to travel. It has not been seen to import
  anywhere: in Brightspace it was tried twice and not accepted (see `TESTING-TODO.md`).
- QTI in, versions 1.2 and 2.1, as a package (a `.zip` or a Common Cartridge `.imscc`, the way a learning
  system exports a quiz) or a bare `.xml` file. The key is read only from a scoring shape the reader knows: in 1.2 the label whose
  condition sets the whole of the points, in 2.1 the declared correct response (with a response map
  for shared credit). A question whose scoring it cannot read is kept with its words as an essay that
  fails, never given a guessed key. Choice, true or false, multiple answer, short answer, a text box in
  a sentence (a fill in the blank), essay, matching and (2.1) ordering are read; pictures in the
  package are kept; MathML is not turned into LaTeX and stays as `[equation]` with the question
  flagged. This program's own two QTI exports read back as what was exported. The Canvas shapes are
  written from memory of them: no real Canvas or Brightspace export has been read.
- A QTI 2.1 package out (`qti-2.1`), for Canvas's Import Course Content (its guides name QTI 2.1 for
  Classic Quizzes and 2.x for New Quizzes) and for Brightspace's Import/Export/Copy Components (campus
  guides list QTI 2.1 there as partly read). It is a file for each question in XHTML, with a test that
  adds the scores up. It carries what the 1.2 package cannot: pictures as files in the package, equations
  as MathML, an answer fixed in place when the others are mixed, and the partial credit of a multiple
  answer question. The same six types are written, and ordering, numeric, hotspot and calculated
  questions are left out with the reason. It is held to the structure of QTI 2.1 and to a response
  processor that scores every possible answer. It has not been imported anywhere.
- A Common Cartridge 1.3 package (`.imscc`) out, for Brightspace's Import/Export/Copy
  Components, written in the form a tool that builds Brightspace quizzes writes: multiple
  choice, multiple answer, true or false, short answer and essay, with their points. Matching,
  ordering, numeric, hotspot and calculated questions are left out with the reason, since the
  format's QTI profile has none. It follows that tool and the format's description and has not
  been imported into Brightspace yet.
- A Blackboard Upload questions file out: the tab-delimited text that Blackboard's Ultra and
  Original courses read, for multiple choice, multiple answer, true or false, fill in the
  blank, matching, ordering and essay. A short answer is written as a fill in the blank.
  Points, feedback and formatting are not in the file and are said against each question.
  It follows Blackboard's help pages and sample file, and has not been tried in Blackboard.
- An assembled test with up to four versions: the bank keeps a copy of each question as it was
  used, so editing the bank later never changes a test already given, and booklets and answer
  keys are printed for every version (Word or PDF) with the version at the top of every page.
  This is the first part of the answer sheets planned in `docs/paper-tests-spec.md`.
- A bubble answer sheet for a test, printed as a PDF to be photocopied (Letter or A4; standard
  A to E with 100 questions to a page, wide A to H, or large print): numbered bubbles, a name
  box, one sheet for every version or one for each, four corner marks and a strip of squares
  that say which test and which page a sheet is. A question a sheet cannot carry keeps its
  number and says to answer in the booklet.
- A reader for a picture of a filled-in answer sheet (a PNG, or a scanned PDF where each page is one
  picture; a JPEG or a phone's photo is decoded by the app's window): it finds the four corner
  marks and which way up the page is, reads the code strip, finds each row of bubbles by its
  printed outline, and says for each question what is marked, what is blank and what a person
  has to look at, and why. A mark it is not sure of is flagged and never guessed. A picture it
  cannot read (a corner hidden, another test's sheet, too blurred, too small) is refused with the
  reason and what to do. `assess sheets gate` draws sheets with known answers, fills them in like
  students, spoils them like scanners and cameras, and fails if one answer is read wrong without
  a flag; `assess sheets check` reads a scan of a blank printed copy and says what is wrong with
  the printing. A scanned PDF page that is fax or JBIG2 compressed, in layers or strips, or empty of
  pictures is refused for that page with the scanner setting to change, and the other pages are
  still read; a batch is put into sheets in the order it came and the same picture twice, a missing
  page and pages out of order are flagged. Sheets are scored against each version's own key, with
  all-or-nothing or partial credit for questions with several answers, and adjustments (drop a
  question, count another answer as right, give everyone credit, change its points) that show how
  many sheets they change before they are applied and need no rescan. Item statistics (difficulty,
  discrimination, which answers were marked, blanks, KR-20 or Cronbach's alpha) carry their number
  of sheets and say when a group is under 30. The results go to a spreadsheet (xlsx and CSV, with an
  empty Name column), a printable item analysis and a scores file that holds no names or file names;
  a bank can keep the class-level figures for each question, never a response.
- The app's Answer sheets area (the "Answer sheets…" button on a bank): make a test from the bank's
  questions, print its answer sheet, booklets and keys (Letter or A4, one sheet for every version or
  one for each, PDF or Word), check a scan of a blank printed copy, and score a class from scans or
  phone photographs. The window opens the pictures it can (a JPEG, with the camera's own turn) and
  sends grey pixels; a PNG or a scanned PDF is opened by the engine. What the reader is not sure of
  is put in front of you one question at a time, with a piece of the picture and how full each
  bubble read, and can be settled from the keyboard alone (a letter chooses the bubble, 0 says
  blank, Enter records several, the arrows move, Z takes the last back). Scores, adjustments (with
  how many sheets each changes shown first) and item statistics update at once, and nothing is
  guessed. No picture of a sheet is kept: only a small cut-out of each row a person has to look at,
  in memory, and a scores file you save holds readings and decisions and no name, file name or
  picture. The same paper can be made from the command line with `assess sheets print`.
- A bank that opens with something wrong says so. A file in it that cannot be read (a question damaged by a sync that did not
  finish) is kept exactly as it was, even through a save, and the bank screen says how many files could not be read, which, and
  why; a bank that opens with fewer questions than it says it held (a file lost in a sync or a merge) is told so, with the
  numbers. `validate` fails on it and `info` says it.
- Coverage (the "Coverage" button on a bank, or `assess coverage <bank> [--rows objective] [--cols bloom]`): how many
  questions a bank has for each objective, chapter, section, tag, Bloom level, difficulty, kind or status, and any two of them
  against each other as a grid, with totals. A question with nothing set is counted under "Not set" so the grid shows how much is
  not yet tagged, retired questions are left out, and a question with several tags is counted under each. Each count in the app
  is a button that narrows the list to those questions. A bank's list can also be narrowed to one chapter, objective, section,
  tag, Bloom level, difficulty or status, whichever the bank has values for.
- Folders (the "Folders" button on a bank): make folders and put folders inside folders, rename them, move them, and file each
  question in one folder (a choice beside the question, or by writing it while a folder is open). A folder is a way of finding
  questions and never holds one: taking a folder away keeps its questions in the bank, in no folder, and moves the folders inside
  it up, and the screen says so before it does. A bank's list can be narrowed to a folder (and what is inside it) or to the
  questions in none. Two folders side by side cannot have one name. An import can be saved into a folder named for the file (or any name), made if the
  bank has none of that name and found if it has, so a chapter comes in as one folder. Folders are kept in the bank file, so they
  travel with it.
- Pick for me, on the Make a test screen of the Answer sheets area: choose some number of the questions that have a chapter, an
  objective, a tag, a Bloom level and so on, at random, and add them to the ones already chosen; pressed again with another value it
  builds a test chapter by chapter, and every question stays visible and can be taken out. It does not pick a retired question, one
  already chosen, one with no usable answer key, or a copy of (or one very much alike to) a question already in the test, and it
  says how many of each it left out, so a short answer is never a mystery.
- Blueprints, above Make a test (or `assess blueprint <bank> list|add|draw|remove`): a recipe for a test that the bank keeps, such
  as five questions from chapter 1 and two at the apply level. A rule is a value on one axis, if you like more values on other axes that a question must have as well ("chapter 2 and the apply level", one cell of the grid that Coverage shows), and how many to take; using a blueprint
  adds what it takes to the questions already chosen, with another draw each time, and every question stays visible and can be
  taken out. It takes a question that fits two rules once, never fills a rule up from another value when the bank has too few (it
  says how many it came out short and why), and leaves out what Pick for me does. A blueprint holds no question, so changing or
  removing one touches no question and no test.
- Check quality (the "Check quality" button on a bank, or `assess check <bank>`): notes about the
  writing and the accessibility of each question, never warnings, so a note cannot change whether
  a question counts as read or what an export holds back. They name an option that depends on the
  others ("all of the above", "both A and B"), a right answer that is much the longest, NOT or EXCEPT
  or LEAST in a stem with nothing to set it apart, a stem ending "a" or "an" that rules out some
  options by grammar, two options that read the same, a picture whose description gives the answer,
  a picture with a colour word, and a long matching list. Across the bank it reports the same
  question twice (or nearly: a few words changed) and a letter that holds more of the right answers
  than chance would, for the questions that keep their option order and for each version of a test.
  A check that depends on which option is right says nothing about a question with no key, and
  looking is not editing: the notes are written without changing a question's version, history or
  status. A note can be dismissed and stays dismissed. The thresholds are judgements, kept in named
  constants, and are for a person to change on real questions.
- A question table in: a list of questions kept in Excel (`.xlsx`) or saved as CSV or
  Unicode text, in the columns OpenStage Author reads (Type, Question, A to H, Correct,
  Points, feedback, Category), so one file works in both tools. A row is a question
  whether or not it has a key: an empty Correct cell, or a letter that names no answer,
  leaves the question with no answer marked and says which cell, and a question that
  cannot be built is kept as an essay with its words. Every sheet that names a Question
  column is read, hidden rows and sheets are read and counted, and a column, a sheet or
  a cell that was not used is named. The workbook is read with no library, as an untrusted
  file, and is checked against what Excel itself says each cell holds (`check:excel-authored`).
  A table that gives the right answer in a column of its own (Correct answer) with the wrong ones in
  Incorrect answer 1, 2, 3 is read too, from the names in the first row: the key is the column the words
  stand in, the answers are mixed so the key is not A throughout (and the file says how many), the columns
  of a second language are reported as not read, and a question's own number is kept. Answer
  columns may be numbered (Option 1 to Option 4) with a number in the Correct column; a number
  that is also the words of another answer is reported and not guessed at. Columns for chapter,
  section, objective, page, Bloom level, difficulty and tags become the question's own fields,
  so the coverage grid and a blueprint can use them.
- A PDF in, from its text alone (`src/import/pdf/`, no library): the pages' words are put back into lines
  and paragraphs, the page numbers and running titles are left out and counted, and the result goes through the
  same scanner as a Word file. A PDF has no list numbering and no styles, so nothing is read from formatting, and an
  answer is read only where it is written down (an asterisk, an `Answer:` line, an Answers list). A picture
  shows as `[Picture]` where it was, a page that looks set in columns is said to be, a scan (a picture of a page) or a
  protected file is refused with the reason, and the file always says it was read from a page and that its answers
  should be checked. Five real banks from one typesetting program read at 100 percent on four of them; the fifth begins
  with a lecture outline whose numbered items are read as essays and flagged. See `docs/design-plan.md`.
- Samples on the first screen: a clean Word bank, one with problems to repair, an Excel
  table, and a blank table to fill in, so a person with nothing to import can see what the
  app does.
- Printing: a student copy and an answer key, as Word and PDF, written with no library.
  The student copy shows no answer; the key shows only what the bank records and says
  when it records none. Matching and ordering questions are shuffled for the student,
  the same way every time.
- A review page: `review <file>` writes one web page that shows each question as the
  importer built it, with its answer, its checks and the lines of the file it came from,
  then the text no question used. It has no script and no outside address, shows no
  answer the importer did not find, and changes nothing. It is the first look at the
  preview screen the desktop app will have, not the app.
- The first exporter: the question spreadsheet (CSV) that OpenStage Author and
  OpenStage Scroll read, with a destination check that lists what will arrive,
  what will be lost and what cannot go.
- The accuracy harness and its fixture corpus.
- A command-line tool that drives all of it.

## Check it on a Windows machine

Install [Node.js](https://nodejs.org) (the LTS version), then double-click
**Check OpenAssess.cmd**. That runs the tests, the import accuracy harness and
the speed check, and tells you whether everything passed.

Nothing else needs installing. The engine has no third-party runtime
dependencies at all; it uses only what comes with Node.

## Using the command-line tool

From this folder:

```
node --experimental-strip-types packages/assess/src/cli/index.ts <command>
```

| Command | What it does |
| --- | --- |
| `info <bank>` | Manifest, counts by type and status, finding totals |
| `validate <bank>` | Check every question against the model |
| `new <bank> --title "..."` | Create an empty bank |
| `import <file> [--out <bank>] [--details] [--key-mark <mark>]` | Read a `.txt`, `.docx`, `.xlsx`, `.csv`, `.pdf`, `.aiken` or `.gift` file and report the verdicts. `--key-mark` says what formatting means in a Word file: `off`, `bold`, `underline`, `highlight`, `color` and so on |
| `review <file> [--out <page>] [--key-mark <mark>]` | Read a file as `import` does and write one web page showing each question with its answer, its checks and its lines of the file, then the text no question used. Nothing is written to a bank |
| `export <bank> [--to <destination>] [--out <folder>]` | Run the destination check for the Author and Scroll spreadsheet (the default), Moodle XML (`moodle-xml`), GIFT (`gift`) a Brightspace Question Library CSV (`d2l-csv`), a QTI 1.2 package for Brightspace and Canvas (`qti-1.2`), a QTI 2.1 package (`qti-2.1`), a Common Cartridge package for Brightspace (`common-cartridge`) or a Blackboard upload file (`blackboard-upload`), and with `--out` write it |
| `print <bank> [--kind student\|key\|both] [--format docx\|pdf] [--paper letter\|a4] [--out <folder>]` | Say what a printed student copy and answer key would hold, and with `--out` write them |
| `sheets gate [--sheets 60] [--seed s] [--only synthetic\|damaged]` | The answer sheet reader's accuracy gate: drawn and spoiled sheets with known answers; an answer read wrong without a flag fails it |
| `sheets print <bank> --out <folder> [--test <id>] [--paper letter\|a4] [--sheet shared\|each\|none] [--large] [--no-booklets] [--no-keys] [--docx]` | Write the answer sheet, and a booklet and a key for each version, of an assembled test; a file already there is never written over |
| `sheets read <bank> <picture.png> [--test <id>] [--json]` | Read one page of a scanned answer sheet against a test in the bank |
| `sheets check <bank> <picture.png> [--test <id>]` | Check my printing: read a scan of a blank printed copy and say whether the printing is fine |
| `sheets score <bank> <scans...> [--test <id>] [--accept-blanks] [--drop N] [--credit N] [--points N:P] [--also-right N:L] [--out <folder>] [--save-statistics]` | Score scanned sheets against the test's own key, with adjustments and item statistics; `--out` writes the scores file, workbook, CSV and item analysis; the bank keeps class figures only with `--save-statistics` |
| `sheets rescore <bank> <file.openassess-scores>` | Score again from a saved scores file, with no rescan |
| `coverage <bank> [--rows objective] [--cols bloom] [--retired]` | How many questions the bank has for each value of two things set against each other (objective, chapter, section, tag, bloom, difficulty, type, status); nothing is changed |
| `blueprint <bank> list`, `add <name> --rule axis=value:count ...`, `draw <name> [--seed s]`, `remove <name>` | A recipe for a test that the bank keeps: `draw` shows the questions it would take and how many short each rule came out and why, and writes nothing; `add` and `remove` change the bank |
| `check <bank> [--save]` | Notes about the writing and accessibility of each question, and across the bank the same question twice and right answers that sit in one place too often; nothing is changed unless `--save`, which writes only the notes |
| `search <bank> <words>` | Search a bank |
| `score [directory] [--details]` | Run the accuracy harness |
| `perf [--count 500]` | Time open, search and save |
| `contract` | Print the read contract and what each consumer can deliver |

## Repository layout

```
packages/assess/        the engine, published as @openstage/assess
  src/naming.ts         every product-facing name, in one place
  src/model/            the open question model, validation, migrations
  src/container/        the zip reader and writer, and the bank file layout
  src/bank/             opening, saving, changing and searching a bank
  src/quality/          item quality checks
  src/import/           importers: the Standard Format, Word (docx/ is its XML and package reader), PDF (pdf/ is its
                        reader, from the file's objects to lines and paragraphs), Aiken, GIFT, Moodle XML, QTI and
                        the question table (spreadsheet.ts, with table-csv.ts and table-xlsx.ts to read the file)
                        and the Brightspace question library CSV (d2l-csv.ts)
  src/export/           exporters and the destination check: the spreadsheet, GIFT, Moodle XML, Brightspace CSV, QTI 1.2, QTI 2.1, Common Cartridge and Blackboard upload
  src/print/            a printed test: the layout, and the Word and PDF writers
  src/read/             a read API nothing uses yet; see docs/design-plan.md
  src/harness/          accuracy scoring
  src/report/           the review page: what an import made of a file, as one web page
  src/cli/              the command-line tool
  test/                 2807 tests, run by Node's own test runner
  test/tools/           checks that ask Word itself what its lists, its formatting and a printed test show
packages/app/           the app: a local server and its web interface, published as @openstage/app
  src/                  the server, the routes, the editor's conversion to and from the engine's question
  ui/                   the screens: plain JavaScript modules, no framework, no build step
  test/                 115 tests
  shell/                the Tauri window (kept out of the npm workspaces; see its README)
fixtures/standard-format/   source files with expected output beside them
fixtures/word-authored/     documents that Word wrote itself, for tests that need no Word
fixtures/publisher/         publisher chapters, never committed
brand/                  the icon, and every size generated from it
```

## Three decisions this code makes, and why

**Findings are not schema errors.** The validator checks whether a question is
well formed. Whether it has a sane answer key is a quality check that reports a
finding. A question half-written in the editor has to be saveable, and a
question imported from a file with no key has to be storable so it can be shown
beside its source text and repaired.

**Nothing is guessed.** Where a file gives no answer key, the question is
flagged and nothing is guessed. Text no question
claimed becomes a reported orphan rather than being discarded.

**Delivery settings are not part of a question.** Attempts, time limits,
feedback timing and weighting belong to a course or a quiz, not to an item, so
the validator refuses them with an explanation. That boundary is what lets one
bank serve an LMS export, a printed test and a spreadsheet for OpenStage Author
and OpenStage Scroll without being rewritten for each.

## Licence

OpenAssess is licensed under the Apache License, Version 2.0. `LICENSE` holds the
official text, taken from <https://www.apache.org/licenses/LICENSE-2.0.txt>, with
the copyright line and notice after it. `NOTICE` names what the project includes
and what it does not.

## The plain-text format

The plain-text import profile reads the standard test-bank text format, a de
facto convention that many publisher test banks already follow. No third-party
code, text or data is included here, and OpenAssess is not affiliated with or
endorsed by any other software vendor.
