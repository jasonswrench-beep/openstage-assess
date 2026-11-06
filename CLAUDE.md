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

**A folder is a way of finding questions and never a place one can be lost.** Taking a folder away (`Bank.removeFolder`) leaves its
questions in the bank, in no folder, and moves the folders inside it up (a name that would clash is numbered, never merged); a folder
cannot go inside itself, two side by side cannot share a name, and a question is in one folder at a time even when a damaged file
listed it in two. Filing a question is not an edit of it (no version, no history entry, no change of notes), and filing several at once
(`Bank.moveManyToFolder`, the "File these N in…" control, the `/filing` route) is all or nothing: every id and the folder are checked
before one is moved. What a folder names that
the bank could not read is said in the history. The folder rules are held by `folders.test.ts` (engine, with a seeded run of random
changes that checks them after every step, and the app's) and `mutate`-style runs; do not add a path that deletes a question with
its folder.

**A blueprint is a recipe and never a list of questions.** `bank/blueprint.ts` keeps rules (a value on one axis, and how many) in
`blueprints/<id>.json`, and drawing one is `pickQuestions` for each rule in turn with what the earlier rules took counted as chosen,
so a question that fits two rules is taken once and the second rule says it found it taken. It holds no question id, so nothing it
holds goes stale when a question changes or goes, and changing or removing one touches no question and no test (a test holds its own
copies). A rule that finds too few is reported short, by how many and why, and is never filled up from another value, because a
question taken to make up a number is one nobody chose. A blank value is refused (`matchesFacets` reads it as no filter, so the rule
would take from the whole bank and read as though it had asked for something), in the engine and again in the app's routes. A
blueprint file the bank cannot read, or that holds a field it does not know, is kept byte for byte, reported and not used, like a
test. Names are told apart without regard to case when one is added or renamed, and are not refused when a merge left two. The seed
is not kept (the test record keeps the one it used). Do not add a field that holds a question id, a seed or a way to fill a rule up.

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
every field it was not given as stored, formatting and all; text that refers to a
picture or an equation the question does not carry is refused, not rewritten without it; a new answer row is
not marked right, and a true or false question starts with neither chosen. A
question made in the app is checked for its answer key before it is kept, or it
would show as parsed with no answer.

**Typography is what the author wrote.** Curly quotes, the en dash, the em dash and the ellipsis are stored as typed and come out as
typed, on the printed test and in every export. `normalizeCharacters` cleans what has no place in a question (what XML forbids, a
no-break space, a soft hyphen) and nothing more; it once also flattened them to straight quotes and `--`, which changed about one
question in eight of the real Word files and printed an instructor's em dash as two hyphens. `foldTypography` is the flat form, for
comparing only and always on both sides (the check for copies, the accuracy gate): never store it, and never fold one side of a
comparison. A short answer's accepted answers are the author's own and are not rewritten; Check quality notes one that a keyboard
may not type (`typedAnswerTypography`) and asks for the plain form as well. `typography.test.ts` follows one question through every
importer, a saved bank, the seven exports and both printed forms, and fails if the flattening comes back.

**A picture is kept only when it can be shown exactly as the author placed it.** The Word reader (`import/docx/pictures.ts`) keeps a
PNG, JPEG or GIF, told by its bytes and never its name (`model/image.ts`), under a name made from the bytes (`media/p-<hash>.<ext>`, so
the same picture is one file and two questions cannot collide), with the description Word holds for it. A picture cropped, rotated or
flipped in Word, with shapes drawn on it, grouped with others, in a text box, linked from outside the file, or in a format it does not
read is not kept: it says why, one reason at a time, and `[picture]` stays where it stood. Showing a cropped picture whole would show
what the author cut away, which may be the answer. A picture with no description flags its question (a warning, dismissable; the editor
writes the description or marks the picture as decoration, and the flag goes). A bank stores a picture only for a question that was
saved; a picture a question names that the bank does not hold is reported on the bank screen (`Bank.missingMedia`) and never makes the
question go. The server serves a picture by the type its bytes have and not the type its name or file claims. In the editor a picture
is the token `[picture 2]` in the text, moved or removed like words, and text the person leaves alone is kept exactly as stored.
Word's own "mark as decorative" is read (`adec:decorative val="1"`, seen in a file real Word wrote) and a decorative picture needs no
description. A picture is added, replaced or removed by hand in the editor (`model/picture-edit.ts`, the `/pictures` routes): told by
its bytes, put at the end of the text, added without a description and flagged for it, never removed from under the words that show it
(the person takes its `[picture N]` out first), and a picture added in a review is stored only if its question is saved. A floating
picture's tag goes after the words of its paragraph, never in front of a question number. A printed test draws a picture
under the words it was in (`print/layout.ts`, `expandPictures`): in the Word file as an embedded picture with its description, in the
PDF as an image (a PNG is decoded and laid on white, a JPEG is handed on; a GIF, a CMYK JPEG, an interlaced PNG or damaged data is
words with the reason against the question, never dropped). Moodle XML carries a picture in the text of a question and no other
export has a place for one, so those write words and say so.

**A Word equation is read only when every part of it is one the reader knows, and otherwise it keeps its marker with the reason.**
`import/docx/omml.ts` reads an equation into one small tree and writes the LaTeX, the MathML and a copy of Word's own XML from
that tree, so the three cannot disagree. It knows fractions, roots, scripts on either side, sums and integrals with limits,
brackets, functions, accents, bars, limits, matrices, arrays of equations, braces and boxes. An element it does not know, a
bracket or separator it cannot map, a bar that does not say which side, a box with a strike, loose text, an equation nested past
60 deep or past 5000 parts, or one with nothing in it, makes the whole equation unread: `[equation]` stays where it stood and the
file says why, once for each reason. It is never read with a part left out, because a wrong equation that looks right is worse than
a marker. Every table lookup goes through `own`, so a run of the word "constructor" is a word; the MathML is generated and escaped,
never copied; the kept XML holds only the elements the reader understands. The reader leaves a tag `[ eq: "eq-<hash>" ]` in the
line and hands the equations over beside the blocks (`import/math-tags.ts`, held for one `parse` and no longer); the builder turns
a tag in a stem or an option into an equation of the question (`q1_e1`, `q1o0_e1`), and an equation in feedback, a matching pair, a
model answer or text no question claimed is written as `[Equation: LaTeX]`. A stem or an option that is only an equation (or only
a picture) is a stem or an option and not an empty one. In the editor an equation is the token `[equation 2]`, moved or removed like
words, and is shown drawn and with its LaTeX but not edited (`ui/math.js` builds each element from a list, never from the string).
A printed Word file carries the equation as an equation, from the stored XML read again by the same reader (`cleanOmml`, because a
bank can be edited by hand); a PDF prints the words and says so. Moodle XML writes the LaTeX between `\(` and `\)`. Everything else
writes `[Equation: LaTeX]` and counts it. Asked of real Word, all twenty kinds it can build were read as the parts it was given
(`check:word-equations`), and Word opens a printed test with three of them as three inline equations (`check:word-print`).

**A character typed from the Symbol font is read by a table that holds only the codes it is sure of.** Insert Symbol and text set
in the Symbol font are the Greek letters and signs they show (`import/docx/symbols.ts`); a code the table is not sure of is left as
written and counted in a warning, and a Wingdings or other symbol is marked `[symbol]` and counted by its font. The table leaves out
the codes whose glyph is a piece of a bracket or is not certain, and a code is added only when Word (`check:word-symbols`) shows it.

**A marker for something the reader could not read flags its question, and not only the file.** `[picture]`, `[equation]` and
`[symbol]` (and the PDF reader's `[Picture]`) stand where something was not read, and a question that still holds one gets the
warning `import.unread-object` (`model/unread-objects.ts`) at import: it needs a look, it is never an error, and it counts what is
missing in the stem, the options and the feedback. Without it the question read as parsed with the figure it depends on gone.
`withRecomputedFindings` takes the note away when the last marker is out of the text and never raises it (only an import leaves a
marker that stands for something real), and a dismissal survives an edit. Only the exact words count: the editor's `[picture 2]` and
`[equation 1]` name something the question carries. A table that is none of the question layouts is read cell by cell as lines of
text (its blocks carry `table.plain`), and a question with such a table inside its text that is not kept as a table (see the next
rule) gets `import.table-flattened` for the same reason; a question that stands in the table (a test item file with a question to a
cell) does not, because nothing of it was flattened, and counting it once flagged 373 of the 375 questions of a real file that read
perfectly. Measure a rule like this on the real files before keeping it.

**A data table inside a question's text is kept as a table only when it is plainly one, and otherwise is read cell by cell and said.**
The Word reader hands over, beside its blocks, each table that is none of the question layouts and is a grid (`gridOf` in
`import/docx/document.ts`): two or more rows, a row of two or more cells, no table inside a cell, no cell joined the older way
(`w:hMerge`), at most 100 rows and 1000 cells. When the scanner is about to add a line to a question's stem and the line is a cell of
such a table that is not the table the question stands in, it writes one tag line `[ tbl: "N" ]` where the table stood and claims
all the table's cells; but not when any cell of the table is a line it reads as something else (an option, a number that starts a
question, an answer, feedback, a type or title line), because that is options or a key laid out in a grid. The builder makes the tag
into markup between control-character markers (`import/standard-text.ts`, `gridMarked`), so the picture and equation tags in the
cells are read with the rest, and every cell's words are escaped. A row is a header (`thead`, `th scope="col"`) only when Word
marked it to repeat as a header row; a first row that only looks like one is not made one. A cell keeps its words, pictures and
equations, a joined cell its `colspan`, and not its bold, italics or colour. The rich text holds the table as markup, so
`model/table.ts` finds, replaces and reads tables (a table in a table is one table; a table never closed runs to the end, so none is
dropped), and a title is made from the words outside the tables (`titleText`). In the editor a table is the token `[table 2]` in the
text, on a line of its own, moved or removed like words, shown drawn from its rows and cells and not edited (`tables` in
`EditorQuestion`; text that holds only tables is not "formatting" that editing would flatten); a table that is not in the text any
more is not in the question, since it lives in the text. A table that is not kept is read as it always was and flagged. A printed
Word file draws a table of the stem as a table (`TableBlock` in `print/layout.ts`, `tableXml` in `print/docx.ts`: a thin rule round
every cell, equal columns across the room the text has, a header row marked to repeat only where every cell of the row is a header
cell, a row never split across a page, a cell that spans keeps its span, a short row has its last cell spread over the rest); a PDF
and a table in an option, in a table or in feedback print as lines, a row to a line with the cells between bars, and say so against
the question. A `TableBlock` is made only for a Word file (the PDF writer refuses one), and a printed Word file with a table is
read back by the importer as the same table. Moodle XML, GIFT and the Brightspace CSV carry a table as markup, and the others write
its words and say tables became plain text. Real Word wrote five tables and agreed with the reader on every row, cell and header
mark (`check:word-tables`), and opened a printed test with three tables without repair and showed their rows, header marks and
cell text as laid out (`check:word-print`).

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
npm test                       # 2478 engine tests and 296 app tests, Node's own runner
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
npm run assess -- blueprint <bank> list|add|draw|remove   # a stored recipe for a test; draw writes nothing and says how short each rule came out and why
npm run assess -- contract     # the read contract and consumer capabilities
npm run check:word --workspace packages/assess   # asks Word itself what its lists show (Windows with Word)
npm run check:word-formatting --workspace packages/assess   # asks Word itself how text looks
npm run check:word-authored --workspace packages/assess   # has Word write sample documents and reads them
npm run check:word-print --workspace packages/assess   # has Word open the printed tests, read back every paragraph, and say what page each question of a long test lands on
npm run check:word-pictures --workspace packages/assess   # has Word write documents with pictures (placed, cropped, floating, flipped, in a text box) and reads them
npm run check:word-symbols --workspace packages/assess   # has Word write characters from the Symbol font (Insert Symbol, and typed in that font) and reads them
npm run check:word-equations --workspace packages/assess   # has Word build twenty kinds of equation and reads them back as the parts it was given
npm run check:word-tables --workspace packages/assess   # has Word write data tables inside a question and holds the reader's rows, cells and header marks to what Word says
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

`check:word-pictures` is run after any change to `import/docx/pictures.ts` or to how `import/docx/document.ts` meets a drawing, and
`check:word-print` also opens a printed test with pictures and asks Word for each one's size and description. Real Word found two
faults the tests from our own writer could not: a floating picture's offsets (numbers in the XML) were taken for the words of a
text box, so every floating picture was refused, and its tag at the start of a numbered line stopped the line being a question.
`npm run check:word-pictures -- --update-fixtures` keeps what Word wrote in `fixtures/word-authored/pictures`, where `npm test` reads it.
Word's automation would not turn a picture here, so a turned one (`rot` on the drawing's transform) is only tried with our own writer.

`check:word-symbols` is run after any change to `import/docx/symbols.ts` or to how `w:sym` and a Symbol-font run are read: a code the
table maps to the wrong sign is a wrong word in a stem and, in an option, a wrong answer. `check:word-equations` is run after any change
to `import/docx/omml.ts`: it has Word build each kind of equation through its object model (a fraction, a root with and without a
degree, scripts, a sum, an integral, a function, an accent, a bar, limits, a bracket, an array, a brace, a prescript, a box, a matrix and
typed Greek letters), one in a question, and holds the LaTeX the reader finds to the parts Word was given. Hand-written XML is only as
good as what its author believes Word writes; the first run found one fault in the check itself (Word puts the text it replaced into
the degree of a root) and none in the reader. `npm run check:word-symbols -- --update-fixtures` and `npm run check:word-equations --
--update-fixtures` keep what Word wrote in `fixtures/word-authored/symbols` and `fixtures/word-authored/equations`.

`check:word-tables` is run after any change to how a table's grid is read for a question (`gridOf` in `import/docx/document.ts`: the
rows, the cell text, the header mark, the spans). It has Word write a table of scores in a question, one with a header row, one with a
merged title row, one with a cell of two paragraphs and one of a single column, asks Word what each table is (its rows, the text of
each cell, whether a row repeats as a header) and holds the reader's own account to that. It found no disagreement the first time.
`npm run check:word-tables -- --update-fixtures` keeps what Word wrote in `fixtures/word-authored/tables`, where `npm test` reads it.

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
