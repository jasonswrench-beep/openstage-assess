# OpenAssess

A free desktop tool for writing, importing, organizing and exporting assessment
questions, so an instructor can turn a Word test bank into an LMS-ready quiz
without retyping a single question.

One of the OpenStage suite of tools; it stands on its own. Apache 2.0.

This repository is at **phase 1 of 9**. There is no desktop application yet, on
purpose. Phases 1 and 2 build and prove the engine, because the parse-accuracy
target is the whole product and it cannot be iterated on through a user
interface.

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
  style. The correct option may be marked with an asterisk, an `Answer:` line, an
  Answers list, or by formatting it (bold, underline, a highlight, a colour), which
  is read as a habit of the whole file and reported for the author to confirm. Lists
  and formatting are checked against Word itself. Tables are the next stage
  (`docs/word-import-plan.md`).
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
| `import <file> [--out <bank>] [--details] [--key-mark <mark>]` | Read a `.txt` or `.docx` file and report the verdicts. `--key-mark` says what formatting means in a Word file: `off`, `bold`, `underline`, `highlight`, `color` and so on |
| `export <bank> [--out <folder>]` | Run the destination check for the Author and Scroll spreadsheet, and with `--out` write it |
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
  src/import/           importers: the Standard Format, and Word (docx/ is its XML and package reader)
  src/export/           exporters and the destination check
  src/read/             a read API nothing uses yet; see docs/design-plan.md
  src/harness/          accuracy scoring
  src/cli/              the command-line tool
  test/                 535 tests, run by Node's own test runner
  test/tools/           a check that asks Word itself what its lists show
fixtures/standard-format/   source files with expected output beside them
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
