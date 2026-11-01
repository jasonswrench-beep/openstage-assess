# OpenAssess

A free desktop tool for writing, importing, organizing and exporting assessment
questions, so an instructor can turn a Word test bank into an LMS-ready quiz
without retyping a single question.

One of the OpenStage suite of tools; it stands on its own. Apache 2.0.

The engine came first, on purpose: the parse-accuracy target is the whole product, and it
cannot be iterated on through a user interface. It is built and measured, and **there is
now an app on top of it**: open a Word, Excel, CSV, text, Aiken or GIFT file, see what was found beside
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
- Profile one of the importer: the standard test-bank text format, read from plain
  text.
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
- Aiken and GIFT in; GIFT and Moodle XML out, each with the destination check that says
  what will arrive, what will be lost and what cannot go. A `.txt` file is told apart
  by what is in it.
- A question table in: a list of questions kept in Excel (`.xlsx`) or saved as CSV or
  Unicode text, in the columns OpenStage Author reads (Type, Question, A to H, Correct,
  Points, feedback, Category), so one file works in both tools. A row is a question
  whether or not it has a key: an empty Correct cell, or a letter that names no answer,
  leaves the question with no answer marked and says which cell, and a question that
  cannot be built is kept as an essay with its words. Every sheet that names a Question
  column is read, hidden rows and sheets are read and counted, and a column, a sheet or
  a cell that was not used is named. The workbook is read with no library, as an untrusted
  file, and is checked against what Excel itself says each cell holds (`check:excel-authored`).
  PDF files are refused, with the way to bring one in through Word; see `docs/design-plan.md`.
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
| `import <file> [--out <bank>] [--details] [--key-mark <mark>]` | Read a `.txt`, `.docx`, `.xlsx`, `.csv`, `.aiken` or `.gift` file and report the verdicts. `--key-mark` says what formatting means in a Word file: `off`, `bold`, `underline`, `highlight`, `color` and so on |
| `review <file> [--out <page>] [--key-mark <mark>]` | Read a `.txt` or `.docx` file as `import` does and write one web page showing each question with its answer, its checks and its lines of the file, then the text no question used. Nothing is written to a bank |
| `export <bank> [--to <destination>] [--out <folder>]` | Run the destination check for the Author and Scroll spreadsheet (the default), Moodle XML (`moodle-xml`) or GIFT (`gift`), and with `--out` write it |
| `print <bank> [--kind student\|key\|both] [--format docx\|pdf] [--paper letter\|a4] [--out <folder>]` | Say what a printed student copy and answer key would hold, and with `--out` write them |
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
  src/import/           importers: the Standard Format, Word (docx/ is its XML and package reader), Aiken, GIFT and
                        the question table (spreadsheet.ts, with table-csv.ts and table-xlsx.ts to read the file)
  src/export/           exporters and the destination check: the spreadsheet, GIFT and Moodle XML
  src/print/            a printed test: the layout, and the Word and PDF writers
  src/read/             a read API nothing uses yet; see docs/design-plan.md
  src/harness/          accuracy scoring
  src/report/           the review page: what an import made of a file, as one web page
  src/cli/              the command-line tool
  test/                 1347 tests, run by Node's own test runner
  test/tools/           checks that ask Word itself what its lists, its formatting and a printed test show
packages/app/           the app: a local server and its web interface, published as @openstage/app
  src/                  the server, the routes, the editor's conversion to and from the engine's question
  ui/                   the screens: plain JavaScript modules, no framework, no build step
  test/                 111 tests
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

**Nothing is guessed.** Where a file gives no answer key, the test-bank vendor silently
selects option A. This flags the question and guesses nothing. Text no question
claimed becomes a reported orphan rather than being discarded.

**Delivery settings are not part of a question.** Attempts, time limits,
feedback timing and weighting belong to a course or a quiz, not to an item, so
the validator refuses them with an explanation. That boundary is what lets one
bank serve an LMS export, a printed test and a spreadsheet for OpenStage Author
and OpenStage Scroll without being rewritten for each.

## Before publishing

The `LICENSE` file is a stub. Paste the official Apache License 2.0 text into
it from <https://www.apache.org/licenses/LICENSE-2.0.txt>. The copyright line
and boilerplate already in the file are correct and should be kept.

## Not affiliated with the test-bank vendor

The plain-text import profile reads a question layout documented in the
test-bank vendor's user guide, which many publisher test banks already follow. No
the test-bank vendor code, text or data is included here. the test-bank vendor is a registered
trademark of its owner
