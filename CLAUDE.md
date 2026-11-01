# Working in this repository

OpenAssess is a free desktop tool for writing, importing, organising and
exporting assessment questions, so an instructor can turn a Word test bank into
an LMS-ready quiz without retyping anything. It is one of the OpenStage suite of
tools, stands on its own, and is licensed Apache 2.0. The other tools do not
depend on it and it does not depend on them.

The build plan runs nine phases across four releases. Phase 1 is done. Phase 2
is the Word import engine, planned in `docs/word-import-plan.md`. Phase 3, the
app, has its first version (`packages/app`): the import review and repair, the
bank, export and print, as a local server shown in a browser or a Tauri window.
`docs/design-plan.md` records what is intended and why: read it first. `docs/review-findings.md` is the list of known defects:
read it before starting work, because it records what is already known to be
broken and why two delivery fallbacks were deleted rather than repaired.

## Rules that are easy to break by accident

**Never guess an answer key.** This is the rule the product rests on. A missing
or ambiguous key is flagged with an error finding and the field is left unset.
A wrong answer that looks authored is worse than a parse failure, because a
parse failure gets looked at. Four separate bugs in phase 1 came from code that
filled in a key rather than admitting it did not have one.

**Nothing is dropped silently.** Text no question claimed becomes an orphan
with its source location. A question that cannot be built is reported and kept,
not discarded. A file that cannot be read is kept in the bank as passthrough.

**Checks warn, they do not block.** A half-written question has to be saveable,
and an imported question with no key has to be storable so it can be shown
beside its source text and repaired. Findings carry severity; the schema is for
structural validity only.

**No runtime dependencies.** The engine has none and should keep none. It runs
on Node's native type stripping, so it installs by copying and works offline.
Dev dependencies are the type checker only. If something seems to need a
library, that is worth a conversation first. The app (`packages/app`) keeps the
same rule: plain JavaScript modules, no framework, no build step. The one
exception is the Tauri window in `packages/app/shell`, which is built with
Rust crates and the Tauri command-line tool, is kept out of the npm workspaces,
and is not needed to run OpenAssess (`Open OpenAssess.cmd` runs it in a browser
with only Node installed).

**Delivery settings are not part of a question.** Attempts, feedback timing,
time limits and scoring weight belong to the course that uses the question, not
to the item. `schema.ts` rejects them by name with an explanation.

**The app is a local server, and a web page can reach 127.0.0.1 as easily as
anything.** `packages/app/src/server.ts` answers only a request that names its
own Host, carries the key it handed the window (an HttpOnly, SameSite=Strict
cookie), and, if it changes anything, carries a header another page cannot add
and no foreign Origin. Every name that comes from outside is checked before it
is joined to a path, every file the app writes is under one folder, and the
interface sets all text with `textContent`, never as markup (`server.test.ts`
reads every script for `innerHTML`). Do not loosen any of it to make something
easier to test.

**A table's columns are never assumed.** A spreadsheet or CSV is read by the names in its
first row. With no names it is read in the template's order only if its first cells are
question types; any other layout is refused with a message, because reading one column's
words as another's is how a key lands where there was none. A row below the first counts
as the names only if it names two known columns, so a note with the word Question in it
is not mistaken for them. A cell that holds an error, or a formula with no stored result,
is read as empty and named, never as text that could be taken for a letter.

**A PDF is read from its words and where they stand, and never from a font.** It has no list numbers and no styles, so
the whole of what is known of a question is its text, and an answer is read only where it is written down (an asterisk, an
`Answer:` line, an Answers list). A bold or italic option is never taken for a key, because it can be bold for another
reason. What the reader leaves out is counted and quoted (page numbers, running titles), what it cannot read is marked
(`[Picture]`) or refused with the reason (a scan, a protected file), and every PDF import says that it was read from a page.

**An Answer line is read as letters only when it is nothing but letters, or when its letter and its words name the same
option.** The scanner once split a whole Answer line into words and took every single-letter word for an option letter, so a
line such as `Answer: c. <the option>. <a reason with the word "a" in it>` marked option A, a wrong key that looked read.
Prose is never mined for letters. Where the letter and the words name different options it is an error that quotes both, and
no answer is marked.

**The editor never writes back what the person did not change.** An edit keeps
every field it was not given as stored, formatting and all; text that holds a
picture or an equation is refused, not rewritten without it; a new answer row is
not marked right, and a true or false question starts with neither chosen. A
question made in the app is checked for its answer key before it is kept, or it
would show as parsed with no answer.

**A printed test shows no answer on the student copy and invents none on the
key.** A question with no usable key is printed, and the key says in bold that no
answer is recorded. A matching or ordering question is shown shuffled, never in
the order of the key. What cannot be printed is said against the question.

## Commands

```
npm test                       # 1449 engine tests and 116 app tests, Node's own runner
npm run typecheck              # strict, and it currently passes clean (the app's interface is checked as JavaScript)
npm start --workspace packages/app   # the app, in your browser
npm run assess -- score        # the 95 percent import gate
npm run assess -- score fixtures/publisher/pdf   # the real PDF banks, when they are on this machine
npm run assess -- perf         # the speed budget on a 500-question bank
npm run assess -- export <bank> --to gift|moodle-xml|d2l-csv   # the destination check; the Author/Scroll CSV is the default; --out writes it
npm run assess -- print <bank> --out <folder>   # a student copy and an answer key, as Word or PDF
npm run assess -- review <file>  # one web page: what an import made of a file, question by question
npm run assess -- contract     # the read contract and consumer capabilities
npm run check:word --workspace packages/assess   # asks Word itself what its lists show (Windows with Word)
npm run check:word-formatting --workspace packages/assess   # asks Word itself how text looks
npm run check:word-authored --workspace packages/assess   # has Word write sample documents and reads them
npm run check:word-print --workspace packages/assess   # has Word open the printed tests and read back every paragraph
npm run check:excel-authored --workspace packages/assess   # has Excel write a workbook and CSV and compares every cell with what Excel says
npm run check:generated --workspace packages/assess -- check <folder> --piece N   # holds a generated bank to its plan
```

The last three are not part of `npm test`. Run the first after any change to
`import/docx/numbering.ts`: a list number is what an Answers list matches a key
to, so a number that is off by one gives a wrong key without a word, and Word is
the only judge of what the number should be. Run the second after any change to
`import/docx/formatting.ts`: a run read as bold that Word shows as plain is a wrong
key when the file marks its answers with bold. Run the third after a change to how tables
or lists are read: it has Word write the documents, so it is the only check that reads
XML Word, and not our test writer, produced. `npm run update:word-authored` keeps what it
writes in `fixtures/word-authored`, where `npm test` reads them on any machine.

`check:word-print` is the fourth, and is run after any change to
`print/docx.ts`: a printed test that Word will not open, or opens after offering to
repair it, is a test that cannot be handed out. (The PDF is checked by taking it
apart in `print.test.ts` and by opening it in a browser's own viewer, since no Word
is involved.)

`check:excel-authored` is the fifth, and is run after any change to `import/table-xlsx.ts`
or `import/table-csv.ts`: a cell the reader takes for something other than what Excel stored
in it (a typed TRUE read as text, a stored 0.30000000000000004 shown as it is stored, a
formula's answer lost) is a key that is wrong or missing in a column called Correct. It starts
its own hidden Excel and closes only that one. The workbook writer in `container/xlsx.ts`
is not Excel, so tests that use it say nothing about files Excel wrote.

`Check OpenAssess.cmd` runs the engine tests, the app tests, the accuracy gate
and the speed check by double-click, which is how this gets verified on a
Windows machine with nothing installed but Node. It needs no Word.

## The accuracy gate

`fixtures/standard-format/` holds source files with a `.expected.json` beside
each. An expected question declares the `verdict` it should come out with, and
absent means `parsed`. A fixture that deliberately withholds an answer key
declares `failed`, so the parser flagging it is the pass.

The score counts a question only when its type, stem, options, key **and**
verdict all match. Orphan mismatches and invented questions are in the
denominator. Do not loosen this: scoring on text agreement alone is how the
gate once reported 100 percent on questions nobody could use.

The corpus is only 61 questions across 21 files and should grow alongside the
parser. Real publisher chapters go in `fixtures/publisher/`, which is
gitignored and read when present, each with an `.expected.json` beside it written
from the document and not from the importer. `npm run assess -- score fixtures/publisher`
measures them, and `test/word-publisher-layout.test.ts` runs them when they are there.
Twenty-one files so far, two in a publisher's layout, six from one instructor's projects and
thirteen from one open-licensed course, all at 100 percent; but every rule was written from the file
that needed it, so none of the twenty-one is a test of rules written without it, and the acceptance
criterion is three chapters the rules were not fitted to. A blind run of the last sixteen, before any
rule was changed, read 200 of 200 (all refused, as it had no key), 25 of 45, 0 of 33 and 0 of 618: do
not read the 100 percent as how a new file will go. `docs/review-findings.md` says what each file taught.
Five PDF banks from one typesetting program are in `fixtures/publisher/pdf` (the harness does not descend into folders, so
`assess score fixtures/publisher` does not run them and `assess score fixtures/publisher/pdf` does): measured before and after
the answer-line rule above they went from 50.6 to 77.7 percent, 100 on four of the five. The fifth begins with a numbered
lecture outline that is read as eight flagged essays, which shifts every question by position; `test/pdf-publisher.test.ts`
holds that state. Every rule was fitted to these five, and they are one producer's.
A batch of 24 generated files (`docs/synthetic-bank-spec.md`) read 33 of 72 blind; it was five distinct
documents in one layout, so it is reported apart and never counts toward the criterion. The brief now gives
each file its layout and `check:generated` holds the files to it before the importer sees them: never run
the importer on a generated batch that has not passed it.

## The read API

`src/read/` was built so OpenStage Author and OpenStage Scroll could read banks
through six operations. They do not: each OpenStage tool stands alone, and the
only link between them is a file that a person carries across (for Author and
Scroll, the question spreadsheet OpenAssess will export). Nothing depends on
this code, so its shapes are not a promise to anyone. It is kept and tested for
now and may be removed once the desktop app exists. Do not build on it. See
`docs/design-plan.md`.

## Style

Comments explain why, not what, and they are worth writing where a reader would
otherwise assume the obvious thing was simply forgotten. Several comments in
this codebase record a bug that used to live on that line; leave them there.

Prose in documentation and in commit messages: no em dashes.
