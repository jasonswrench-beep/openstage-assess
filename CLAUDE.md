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
library, that is worth a conversation first. That conversation was had on
4 November 2026: a library may be added when plain code will not do, its licence
works with Apache 2.0, a copy of it with its licence file is kept in the repository
and carried in the installer (it is never fetched at install), its notice goes
into `NOTICE`, and the commit says why nothing simpler would do. The app (`packages/app`) keeps the
same rule: plain JavaScript modules, no framework, no build step. The one
exception is the Tauri window in `packages/app/shell`, which is built with
Rust crates and the Tauri command-line tool, is kept out of the npm workspaces,
and is not needed to run OpenAssess (`Open OpenAssess.cmd` runs it in a browser
with only Node installed).

**Item quality and accessibility checks are notes, and say nothing when unsure.** `quality/items.ts` (one question) and
`quality/bank.ts` (copies, and how the right answers are spread) raise `info` findings only. A warning makes a question "needs
review" and an error makes it "failed", and those are what the import gate counts and what an export holds back, so advice about
writing must never move either. They run when a question is saved into a bank (`Bank.update`) and when a person asks to check the
whole bank (`Bank.checkQuality`, `assess check`, Check quality in the app), and not at import, where a finding means the importer had
to guess. A rule that depends on which option is right is skipped for a question with no usable key, so none of them can guess one.
Looking is not editing: a check writes the notes and leaves the version, history and status alone. What looks across questions is
worked out each time and never stored, because a note about two questions goes stale when either changes (the same fault that
once left findings unrefreshed). A dismissal survives the next check. The lines (1.5 times and 20 characters, 8 pairs, 0.85 alike,
20 answers) are judgements in named constants; change them on a bank of real questions, never to make a test pass.

**A damaged file is read or refused in words, and what is damaged inside a bank is kept, reported and shown.** A file that cannot be
read is refused with a message a person can act on, never a TypeError or "Cannot read properties of undefined"; `fuzz-import.test.ts`
damages the repository's own files (Word, Excel, PDF, text, banks, scans of sheets) from a fixed seed and holds every one to that, and
a run of about 60,000 more found two crashes in the bank reader (a folder tree damaged inside) that are fixed. A bank that opens with
a part it cannot read (a question file that is not JSON, a folder file of the wrong shape, a lost file) opens with the rest, keeps the
damaged file byte for byte through every save (`passthrough`; a damaged folder file is kept as `folders.damaged.json`), and says so:
the engine in `OpenReport`, the app in the amber box on the bank screen. A branch of the bank reader that reports a file and does not
keep it is a bug (two were found). Do not add a path that drops a file the reader could not understand.

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

**An answer chosen by hand replaces what the file's key said, and nothing else does.** An importer's errors about the key the
file gave (`KeysDisagree`, `KeyLetterMissing`) stay on a question until a person changes the answer itself (`editQuestion`,
`replaceFileKeyProblems`): then they are dismissed by that person, kept in the list with their words, and the save says so.
A change of stem, title or wording does not replace them, a choice that is not a usable answer does not, and no other finding
is touched. Do not widen it to any edit, or the error that says the file's key was not applied would vanish while the file's
key is still the one in use. The same goes for placeholders (`quality/placeholders.ts`): the importer's errors about an option
it had to fill with `(missing)` go only when the words are written in where the placeholder was, one option at a time, and
they are dismissed and kept like the others.

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

**An assembled test holds a copy of its questions, and its versions come from its stored seed.**
`model/test.ts`: the record freezes every question as it was used, so editing the bank never
changes a test already given; versions B to D are made from the seed and kept, never made again
from chance; true or false is never reordered; a question whose answers depend on their place
keeps them in order, with the reason. A letter on any version maps back to the bank's own answer
through the record (`answerAt`, `letterFor`), and the key of a version is read from the record's
copies (`quality/test-key.ts`), never from the bank. A record that does not hold together is
refused, and a damaged one in a bank is kept as it was and reported, never dropped.

**An answer sheet is printed from one geometry file, and its code strip never changes meaning.**
`sheets/geometry.ts` holds every position in millimetres, and the printer and the reader both
build on it, so they cannot disagree about where a bubble is. A sheet printed once is in a
classroom for a term: the squares of `sheets/code.ts` (layout, paper, test, page, version, check)
are pinned in `sheet-code.test.ts`, and a change that makes a pinned strip come out differently
is a change that stops printed sheets reading, which is never made quietly. A new arrangement
gets a new layout number. A sheet carries no answer and no student detail, and it says in words
which test and which sheet it is.

**The sheet reader flags what it cannot vouch for, and an answer read wrong without a flag fails the gate.**
`sheets/decide.ts` records a question as answered only when every bubble is plainly filled or plainly
empty and the pattern means an answer; a blank row, a faint mark, two marks on one answer, a mark where
this version has no bubble, and a row whose printed circles are not where the transform puts them are all
flagged and never read. A picture whose corner marks cannot be found, whose code strip does not check,
that belongs to another test, that is too blurred, or whose circles show at less than half the clearness
its own sharpness allows, is refused with the reason and what to do. A black and white picture is
recognised and no question with several answers is read from it, because it can lose a pale mark or turn a
smudge solid and nothing in it shows which. The lines for filled and empty (0.5, 0.1, and 0.06 for several
answers) are provisional and are changed only on numbers from `assess sheets gate` and real sheets, never
to make a test pass. The harness draws a black and white student as marking firmly with no smudge, since
it judges the reader on what the picture can show; keep that said wherever it is described. Do not loosen
a refusal, a flag or the gate's first line to get a number up.

**A scanned PDF is read only where each page is one picture, and what is not read is said.**
`sheets/pdf-page.ts` takes the one picture a page draws (Flate, plain, or a JPEG handed on as bytes for the
window to decode) and works out the mirror, turn and black and white swap from how it is drawn. A page of
several pictures, layers, fax or JBIG2 or JPEG 2000 compression, or no picture is refused for that page with
the scanner setting to change, and the other pages are still read. Do not add a decoder for a refused
format to make a file open: the spec leaves the fax decoder and pdf.js until the real scanner test says
they are needed. A batch is put into sheets in the order it came (`sheets/batch.ts`): the same picture twice
is flagged and not counted, and a sheet is known by its place in the batch and nothing else (no name, no file
name is kept).

**Scores are worked out, never stored, and no bank or scores file ever holds a student.**
`sheets/score.ts` puts the readings, a person's decisions, the test record's own key and the
adjustments together every time a score is shown, so a new key or an adjustment needs no rescan. A
flagged or unconfirmed question is undecided, earns nothing and is counted, never guessed. The
scores file (`sheets/scores-file.ts`) holds sheet numbers, page numbers and picture fingerprints, and
no file name, picture or name; a bank holds class-level figures only (`model/statistics.ts`, in
`statistics/`). Both refuse a field they do not know when read, which is what keeps a response or a
name from being carried in by another writer. Do not add a field to either to make something easier,
and do not write figures into a bank unless the instructor asked (`--save-statistics`).

**The app never keeps a picture of a student's sheet, and keeps what it holds in memory until the person saves.**
A scoring sitting (`packages/app/src/scoring.ts`) holds the readings, the person's decisions and the
adjustments, and for each question a person may have to look at a small cut-out of the row, cut upright
through the reader's own transform (`sheets/crop.ts`) and served as a PNG; the page itself is let go as soon as
it is read. Nothing is written until the person saves a scores file (under `Scores`, through the engine's
whitelist writer) or writes results (into `Exports`, never over a file, with an empty Name column). The file
labels the window gives a scan are shown to the person and live only in memory: none reaches a file. Class
figures go into a bank only when the request says `confirm: true`, and once for a state of the sitting. A
sitting opened from a saved file has no pictures, and takes no more scans, because its sheet numbers are the
ones its decisions refer to. Do not keep a whole picture to make Review nicer.

**The window decodes what it can, and a page nothing could open is kept as a refused page, in its place.**
`ui/scan.js` makes a JPEG, WebP, GIF or BMP into grey pixels (the camera's turn applied, laid on white, 3300
pixels on the long side) and sends the pixels; a PNG or a PDF is sent as it is. A JPEG page inside a scanned PDF is
held in its place until the window sends what it decoded, so the order of the batch is kept, and one that
cannot be decoded is replaced by a refused page with the reason. Nothing is dropped, and a page that is read is
never replaced by a refusal (`replace` is for a page that is waiting).

**Review decides nothing for the person.** A flagged question, an unconfirmed blank and an unsettled version are
queued, never guessed; a decision (`/scoring/<id>/decisions`) is refused for a place the question does not have,
for two answers to a question that takes one, and before the version is settled; it replaces the reader's reading
with the reader's own words kept in `readerSaw`; and Z takes the last back. The keys are letters and digits for the
bubbles, 0 for blank, Enter for several, and the arrows: they are part of the screen and are tested in a browser
by hand (`TESTING-TODO.md`), so do not rebind one without looking.

## Commands

```
npm test                       # 2135 engine tests and 191 app tests, Node's own runner
npm run typecheck              # strict, and it currently passes clean (the app's interface is checked as JavaScript)
npm start --workspace packages/app   # the app, in your browser
npm run assess -- score        # the 95 percent import gate
npm run assess -- sheets gate  # the answer sheet reader's gate: no answer read wrong without a flag, on drawn and spoiled sheets
npm run assess -- sheets read <bank> <picture.png|scan.pdf|folder>    # scanned sheets against a test in the bank, put into sheets in order
npm run assess -- sheets score <bank> <scans...> [--accept-blanks] [--drop N] [--out <folder>]   # scores, item statistics, and with --out the scores file, workbook, CSV and item analysis
npm run assess -- sheets print <bank> --out <folder>   # the answer sheet, and a booklet and a key for each version
npm run assess -- sheets rescore <bank> <file.openassess-scores>   # score again from a saved file, with no rescan
npm run assess -- sheets check <bank> <picture.png>   # Check my printing: a scan of a blank printed copy
npm run assess -- score fixtures/publisher/pdf   # the real PDF banks, when they are on this machine
npm run assess -- perf         # the speed budget on a 500-question bank
npm run assess -- export <bank> --to gift|moodle-xml|d2l-csv|qti-1.2|common-cartridge|blackboard-upload   # the destination check; the Author/Scroll CSV is the default; --out writes it
npm run assess -- print <bank> --out <folder>   # a student copy and an answer key, as Word or PDF
npm run assess -- review <file>  # one web page: what an import made of a file, question by question
npm run assess -- check <bank> [--save]   # notes on the writing of each question, copies, and where the right answers sit
npm run assess -- coverage <bank> [--rows objective] [--cols bloom]   # what the bank covers: questions by objective, chapter, tag, Bloom level and so on
npm run assess -- contract     # the read contract and consumer capabilities
npm run check:word --workspace packages/assess   # asks Word itself what its lists show (Windows with Word)
npm run check:word-formatting --workspace packages/assess   # asks Word itself how text looks
npm run check:word-authored --workspace packages/assess   # has Word write sample documents and reads them
npm run check:word-print --workspace packages/assess   # has Word open the printed tests, read back every paragraph, and say what page each question of a long test lands on
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
