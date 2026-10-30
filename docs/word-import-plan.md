# The Word import engine: plan

Written on 28 October 2026, for phase 2. `docs/design-plan.md` says why this
engine matters and where it sits; this file says how to build it and how to know
it works. Nothing here is built yet.

Word import is the feature that earns OpenAssess its users: an instructor has a
test bank in Word and wants it in an LMS without retyping it. The target from the
specification is that a real publisher chapter imports at 95 percent or better,
with every question that did not parse listed and linked to its source text.
Only a question that comes out `parsed` counts toward the 95 percent, so a
question that needs review is a miss, and a question that is wrong without saying
so is worse than a miss.

## Where it stands

The first slice (stages 0 and 1) was built on 28 October 2026, stage 2 (Word's own
list numbering), stage 3 (answer keys from formatting and `Answer:` lines) and stage 4
(questions in tables) on 29 and 30 October. A `.docx` goes in, questions come out, and the
real harness scores them. `openassess import file.docx` works, and so does
exporting what it imports to the Author spreadsheet.

**Built:** the XML reader (`import/docx/xml.ts`), zip entry names that are checked
on read and write, the package reader (`package.ts`), the paragraph and table walker
(`document.ts`), the importer (`word.ts`, profile `word-docx`), an importer registry
shared by the harness and the command line, the scanner reading list labels, and
the test-side Word writer (`test/support/docx-writer.ts`).

**Stage 2 built:** `import/docx/numbering.ts` works out the label that Word's lists
put in front of a paragraph, from `numbering.xml`, the paragraph's own list
properties and its style. A question numbered "1." and an option lettered "a)" by
Word's list buttons now reach the scanner as `listLabel`, exactly as if typed.
`test/tools/word-numbering-check.ts` asks Word itself what it shows (see below).

**Stage 3 built:** two ways to find a key that the file does not give with an
asterisk or an Answers list. An `Answer: C` line beside the question
(`standard-text-scan.ts`) is the question's own key, and is read in text files too.
A Word file that marks the right option by formatting it (bold, italic, underline, a
highlight, a colour) is read by `standard-text-format.ts`, which decides what the
formatting means once for the whole file. The formatting of each run comes from
`import/docx/formatting.ts`, and reaches the scanner as `runs` on each block.
`test/tools/word-formatting-check.ts` asks Word what it shows.

**Stage 4 built:** `import/docx/tables.ts`. A table is first read into its cells, then
recognised as one of three layouts or left as it was. A *grid* has a header row naming
the columns (a number, Question, options headed A, B, C, an Answer column, and a type,
points, a title, feedback and the labels publishers use) and a question to each row.
*Labelled rows* are rows that begin with a label such as `1.` or `b.`, which is a question
to a table or several in one; a check mark in a last cell marks the option correct. An
*answer key* is a table of a question number and its answer. Each becomes the lines the
Standard Format scanner already reads, so the same scanner, builder and gate do the rest.
`test/tools/word-authored-check.ts` has Word itself write sample documents, and
`fixtures/word-authored/` keeps them.

**Measured:**

- All 20 text fixtures, written out as `.docx` in two styles (typed labels, and
  noise) with four seeds each, come back identical to the text version: the same
  questions, findings, orphans and source positions, and a score of 100 percent.
- 300 generated files of lines in no sensible order read the same as text and as
  Word, every marker survives, and the header, footer and deleted text are never
  read as content.
- The same fixtures score 100 percent through the real harness from a folder of
  `.docx` files.
- 500 questions in a noisy `.docx` import in about 0.1 seconds, against the
  proposed 3 second budget.
- Seven kinds of hostile or wrong file end in a readable message: a name that
  climbs out of its folder, a document type declaration, nesting a million deep,
  an entry that inflates far past its declared size, parts that differ only in
  case, an older `.doc` (or a password-protected file), and a PDF or RTF.
  Eight deliberate breaks of the new code were each caught by a test.
- Stage 2: the 20 fixtures, numbered by Word's lists, come back identical to the
  text version and score 100 percent, in five forms (a list for each kind of label;
  the same with the list split into instances that carry on from each other; the
  options numbered and the questions typed; one multilevel list; the same list with
  the levels coming from paragraph styles), each also with the noise. 180 generated
  files of lines in no sensible order read the same as text when numbered by Word.
  500 questions in each form import in under a quarter of a second.
- Stage 2, against Word itself: 151 documents and 2,363 paragraphs, each asked of
  Word through `test/tools/word-numbering-check.ts`, and the reader agrees on all of
  them except 3 where it gives no number on purpose (a format it does not know).
  This is the strongest evidence in this plan so far, because Word is the judge and
  not our own writer. It found five places where the first reading of the
  specification was wrong (below), each now a test.
- Stage 3: the 20 fixtures with the key marked by formatting in place of the asterisk
  (bold, italic, underline, highlight, colour, and bold by the Strong style; each on
  the whole line and on the text alone; typed and numbered by lists; with and
  without noise) come back identical to the text version and score 100 percent,
  560 comparisons in all. The same fixtures with an `Answer:` line in place of the
  asterisk score 100 percent as text and as Word files. Because most fixtures are too
  short to show a habit, the habit itself is tested by putting thirty marked
  questions in front of each fixture and letting the file decide: 60 comparisons.
- Stage 3, against Word itself: 146 documents and 2,680 paragraphs, each asked what
  it looks like (`test/tools/word-formatting-check.ts`), with no disagreement. That
  covers every route a look can take: direct formatting, a character style, a
  paragraph style, styles based on styles, the document's defaults, and bold meeting
  bold between style levels.
- Thirty-one deliberate breaks of the stage 3 code: all caught by a test in the end.
  One escaped at first because a test was too weak (turning formatting off was not
  checked question by question), and it was strengthened. Another escaped because the
  break itself was badly made, and was redone.
- Stage 4: the 21 text fixtures put in tables, five ways (a row for each line; the same
  with the key as a check mark; with the answer key headed; with it under its heading;
  check marks and a headed key), each with and without noise, come back identical to
  the text version and score 100 percent, 210 comparisons. Their simple questions
  (a stem, lettered options, a key, at most a Type line) are also put in grids, and
  read the same, positions apart. 120 files of lines in no sensible order, in tables,
  lose nothing. 500 questions in a grid, and in rows, import in about 100 ms each.
- Stage 4, against Word's own files: seven documents written by Word through its object
  model (a question to a table with a check mark, a grid, an answer key table, an
  outline list with the key in bold, a table with a merged title row, typed lines with an
  Answer line, numbered and lettered lists) all read as intended, and the list labels
  the reader works out from the XML Word wrote agree with what Word shows. This is the
  first time the importer has read XML that Word, and not our writer, produced.
- Twenty-nine deliberate breaks of the table code: all caught by a test in the end. Four
  got through the first tests (a merged cell in a grid, a check mark on a question
  number, a row that starts late, and a table with no labels counted as a layout), and
  each got a test of its own.
- Thirty-two deliberate breaks of the numbering code and the code that finds and
  joins its labels: all caught by a test in the last round. Four survived an earlier
  round (an override read as once per instance and not once per level, and three in
  how the numbering part is found) and each got a test of its own.

**Decided while building:**

- A soft line break starts a new block, because a block is one visual line and the
  scanner is line-based. A page or column break does not, and a break at the end
  of a paragraph is not a blank line.
- Tracked changes, hyperlinks, fields and content controls are read now, not at
  stage 5, because the walker had to decide what to do with them to read a
  paragraph at all. Text boxes, alternate content and hidden text are still stage 5.
- A picture or shape leaves `[picture]` in the text and an equation leaves
  `[equation]`, and the file reports a count. Until stages 6 and 7 a question that
  holds a marker can still come out `parsed`, because the report is for the file
  and not for the question. That gap is recorded in the findings.
- Part names are matched without regard to case, as the format says, and a
  package with two parts that differ only in case is refused.
- An XML part that declares a document type is refused outright.
- A list the reader cannot work out is reported and left unnumbered, never guessed.
  An Answers list matches a key to a question by its number, so a number that is off
  by one would point a key at the wrong question without a word. The causes are a
  list the file does not define, a level it does not define, a number format the
  reader does not know (Word's spelled-out numbers, for instance), a restart that
  Word itself shows nothing for, and a numbering part that cannot be read.
- Bullets show no label and are not a finding: a bullet says "this is a list item"
  and nothing else.
- A paragraph whose mark was deleted by a tracked change, and whose text went with
  it, is gone once the changes are accepted, and so is its number. Leaving it would
  put every number after it out by one. (A paragraph whose mark is deleted but whose
  text survives joins the next paragraph in Word; here it stays a paragraph of its own.)
- Word lets an author who letters the options automatically put the key's asterisk
  only after the letter ("b. *Mars"). An asterisk at the start of an item whose
  label is an option letter is read as the mark and moved where the format has it.
  A typed "b. *Mars" is still not a mark, so nothing read before is read differently.
- Word writes a label as "(a)" as readily as "a)". The opening bracket is dropped,
  because the Standard Format knows only the second.

**How a key is found from formatting, stage 3.** Formatting is the nearest the
importer comes to guessing a key, so the rules are strict, and each has a test.

- It is a convention of the file, decided once. A property (bold, italic, underline,
  a highlight, a colour) is a candidate when some options of a question carry it
  and others do not. An option carries it only if all of its own text does, so a
  bold word inside an option, a bold label, bold feedback and a bold stem are not
  marks.
- It becomes the convention only when at least 3 choice questions, and at least 80
  percent of them, show it. A short file is refused with a message that says why
  (and the author can name the mark with `--key-mark` or `keyMark`).
- Two properties that always pick the same option are one convention (a bold,
  underlined answer). Two that pick different options are no convention and no key
  is taken.
- A key in words comes first: an asterisk, then an `Answer:` line, then an Answers
  list, then formatting. Formatting only supplies a key where there is none. Where
  it names different options from the key in words, the question carries a warning
  that says both (`KeysDisagree`). The same warning now covers an asterisk against
  an Answers list, which used to pass without a word.
- A question that breaks the habit (no option marked, or every option marked) gets
  no key from formatting and a warning that says why. Two marked options make it a
  multiple response question, flagged as inferred, as two asterisks do.
- The convention is reported once for the file, as a warning, with the counts, for
  the author to confirm. A question keyed by it has no finding of its own, so it
  counts toward the 95 percent. That is the plan's trade: flag only the outliers.
- A mark that is only in the file's text is never a mark: a plain text file has no
  formatting, so nothing changes for it whatever is asked.
- Publisher banks put `Feedback:`, `Rationale:` and the like straight under the last
  option, and the scanner used to add them to that option's text. They are labels now
  (see `docs/review-findings.md`, "Explanations under the correct option became part
  of the option"). This is not about Word, but it is the layout of the dialect pack's
  publisher-style document, and it was found by checking a claim made for stage 3.

**What asking Word taught us, which the specification did not say:**

- Bold and italic toggle between style levels: bold in the paragraph style and bold
  in a character style on top of it is not bold. (Confirmed.)
- A highlight in a character style does nothing in Word, even one that says none.
  A highlight in a paragraph style, or in the run itself, does.

- A style that names a list holds a level, and Word lets only one style hold each.
  The holder is the style the level is tied to, and failing that the first style in
  the styles part to ask for it. Any other style that asks for the same level is not
  numbered at all, however its paragraphs are set, and Word shows nothing for them. A
  style that names a list and no level asks for the first level, even when another
  level is tied to it; the tie does not move its paragraphs to that level.
- A skipped level counts as used once, so after an item at level 2 the next item of
  level 1 is the second. Counting from the start would have been off by one.
- Legal style turns the level's own number into digits as well as the levels it names.
- A list that links to a numbering style takes that style's levels and counts on its
  own. It does not carry on from the list it links to.
- A restart set to a level that is not above it makes Word show nothing for that
  level. The reader reports it and gives no number.
- Instances of one definition carry on from each other, and an instance's start
  override applies the first time that instance reaches that level, not the first
  time the instance is used.

**How a table is read, stage 4.** The conditions are strict, because a table that only
looks like a layout is how a wrong answer gets in.

- A table with another table in a cell, cells merged down, or a row that starts late or
  ends early is never read as a layout, and a grid or an answer key with a cell merged
  across is not either. Labelled rows allow one cell spread across a whole row, which is
  how Word writes a line of text in a table of two columns.
- A grid needs exactly one Question column, at least two option columns with different
  letters, and every row the same width as the header. Its headers are matched by name
  (a list in `tables.ts`), and a header repeated at the top of a page is not a question.
- A grid's Answer column becomes an `Answer:` line, so it is compared with the key in
  formatting like any other. A column the profile does not know is not dropped: its
  words follow the question as `Column: <header>: <value>`, which the scanner reports
  as stray text, with its place. A type or points that do not read as one are kept the
  same way and are never made a directive.
- Labelled rows need every row with two or more filled cells to begin with a label, and
  at least one. A check mark in a last cell marks an option only for a mark that cannot be
  an option's own words (a tick, a star, "correct", "right"), never "x" or "yes".
- A two-column table of a number and a letter, with no heading above it, is an answer key
  and gets the heading it lacks. The same two cells are also a question whose stem is a
  letter, and a key is far the commoner. A key whose answers are words needs a header row.
- A table that is none of these is read cell by cell as before, and the file says how
  many were, and how many were read as questions. Both are information.

**Not built yet:** a key in a table by shading, matching questions as a two-column table, a
question that spreads over several rows of a grid, text boxes and alternate content (rest
of stage 5), pictures with their bytes and alt text (stage 6), equations (stage 7), and
everything that needs real Word files (stage 8). The dialect pack is still the thing most
wanted: stages 3 and 4 were built on files our own writer made and on a few that Word
wrote from a script, and a publisher's real layout will be messier. Word's
spelled-out number formats ("One", "First") and the many non-Latin ones are not read
yet; a list in one is reported, not guessed.

**Asking Word itself.** `npm run check:word --workspace packages/assess` builds the
documents, starts a separate hidden Word, reads the label Word shows on every
paragraph and compares. It needs Windows with Word, it only ever closes the Word it
started, and it is not part of `npm test`. Run it after any change to `numbering.ts`.
`npm run check:word-formatting --workspace packages/assess` does the same for how
text looks, and is the one to run after any change to `formatting.ts`.
`npm run check:word-authored --workspace packages/assess` has Word write sample
documents (tables, lists, bold) and checks that they read as intended, and
`npm run update:word-authored --workspace packages/assess` keeps them in
`fixtures/word-authored`, with the author's name taken out of their properties. Those
fixtures are read by `npm test` on any machine. All three start a separate hidden Word and
only ever close the Word that automation started, which they tell from one a person
opened by its `-Embedding` command line (`test/tools/word-guard.ps1`).
It is the model for the later stages: where Word can be asked, ask it, and keep the
questions.

## The shape

The engine is two parts, and only one of them is new.

**A front-end, new.** It reads a `.docx` and produces `SourceBlock`s: the text of
each paragraph as Word would display it, with the list label Word would render
("3." or "b)") resolved from the numbering definitions, and the formatting of each
run (bold, italic, underline, highlight, colour). A table becomes blocks too, with
its position kept so a preview can find it.

**A back-end, existing.** The scanner and builder that read the plain-text
Standard Format already turn blocks into questions, findings and orphans, and
`standardTextImporter.parse` already accepts blocks as well as text. The accuracy
harness, the provenance (`SourceRef` block ranges) and the nothing-dropped-silently
checks all carry over. The Word engine reuses all of it.

What the interface already provides: `SourceBlock` has `kind`, `runs` and
`listLabel`, and the comment on it says they are for this parser. What it does not
yet provide:

- The scanner reads only `block.text`. It has to learn to put `listLabel` in front
  of the text, and to read `runs` for answer marks.
- The scanner recognises `Answers:` lists but not an `Answer: B` or `ANS: B` line
  after each question, which publisher banks use.
- `Importer.parse` takes a string or blocks. A `.docx` is bytes, so the Word
  importer needs a bytes entry point, and the harness, which reads every source
  file as UTF-8 text, needs to hand bytes to it.

What the zip reader already gives: it is built on `node:zlib`, reads store and
deflate, refuses more than 512 MB when expanded, caps each entry as it inflates
(so a tiny file declaring a huge one is stopped), and limits the entry count. It
does not sanitise entry names yet (item 7 of the findings), and that must be fixed
before anything is extracted from an untrusted `.docx`.

There are no runtime dependencies, so the XML reader is ours. It reads elements,
attributes, text, character references and CDATA, and does not support DTDs, so an
entity expansion attack has nothing to work with. It limits nesting depth and
size, and reports malformed input as a readable error.

## Design decisions

**Answer marks from formatting are decided once per document.** Publisher banks
mark the key by making the right option bold, underlined, highlighted or coloured.
That is a convention of the document, not of one question. The engine looks at the
whole document, finds the convention (for example "bold marks the key in 41 of 43
questions"), reports it once as a file-level finding for the author to confirm, and
flags only the questions that break it. Flagging every question would make the 95
percent target unreachable, and guessing silently would break the rule the product
rests on. If no convention is clear, no key is inferred, and the question fails
visibly.

**Tracked changes: keep what was inserted, drop what was deleted, say so once.**
Both `w:ins` and `w:del` are common in a test bank that has been through review.
A file-level finding (`TrackedChangesPresent` exists) tells the author that the
text is the version with the changes accepted.

**Read each piece of content once.** Word writes some content twice, once in
`mc:Choice` and again in `mc:Fallback`, notably text boxes. Reading both would
double the text. Exactly one is read.

**Hidden and surrounding content is counted, not silently skipped.** Headers,
footers, comments, footnotes and hidden text (`w:vanish`) are not part of a
question. They are left out and the file says how many there were, so a question
that lives in a text box or a footnote is not lost without a word.

**One scope: `.docx`.** Word, Google Docs and LibreOffice can all save as `.docx`.
The old `.doc`, `.rtf` and `.pages` formats are out.

**Equations arrive late and fail gracefully.** Word equations (OMML) convert to
MathML and LaTeX, and the model stores both. Until that stage is built, an
equation is replaced by a visible marker and a finding, never removed.

**Images need the bank to hold their bytes.** Today an imported image gets a media
path and nothing is copied (item 6 of the findings): files are not stored, names
collide across questions, and nothing checks that a reference resolves. The image
stage fixes that along with the engine.

## Order of work

Each stage ends in a measurement, and the work stops at each one to run it.

| Stage | What | Done when |
| --- | --- | --- |
| 0 | The groundwork: the XML reader, safer zip entry names, a test-side Word writer, harness support for `.docx`, and the scanner reading `listLabel` and `runs` (no effect on text files) | A typed-text `.docx` scores through the harness |
| 1 | Paragraphs and tables into blocks, text and tabs and breaks | The typed-label and noise styles score the same as their text fixtures |
| 2 | Word list numbering: restarts, `a)`, `(a)`, `A.`, roman, multi-level, numbering that comes from a paragraph style | The auto-numbered styles match |
| 3 | Answer marks: the document convention for bold, underline, highlight and colour, and `Answer:` lines | The formatting styles match |
| 4 | Table layouts: a question per table, a question per row, a key column | The table styles match |
| 5 | Tracked changes, text boxes, hyperlinks, fields, hidden text, alternate content | The noise style and the property test pass |
| 6 | Images, alt text from the picture's description, bytes into the bank | Pictures survive a round trip and a missing description is a finding |
| 7 | Word equations to MathML and LaTeX | The equation fixtures pass |
| 8 | Real files: the dialect pack and real chapters | 95 percent on three real chapters |
| 9 | Saved import profiles as JSON, and the data a repair screen needs | A fix made once applies to the next chapter |

The desktop app and its preview screen belong to phase 3. Stage 9 produces what
that screen will read, not the screen.

### The first slice

Stages 0 and 1, the smallest path that goes all the way through: a `.docx` goes in,
questions come out, and the real harness scores them. Concretely:

1. The XML reader, with tests for malformed input, depth and size limits.
2. Zip entry names sanitised, with tests.
3. The test-side Word writer: paragraphs, runs, a table, nothing else yet.
4. A `docx` package reader that finds `word/document.xml` and the relationships.
5. A paragraph walker that produces `SourceBlock`s from `w:t`, `w:tab` and `w:br`.
6. The Word importer (profile `word-docx`) with a bytes entry point, and the
   harness handing bytes to it.
7. The typed-label style of the existing fixtures rendered as `.docx`.

The Word writer is not wasted effort. The print export needs to write `.docx` too,
and the same code will do it.

## How we measure

**1. The differential corpus, the main measure.** The 57 hand-checked questions in
the 20 text fixtures already exist, with expected files. The test-side writer
renders each fixture as a `.docx` in several styles, and every rendering must score
exactly as the text version does. That gives hundreds of checked questions with no
new hand labelling. The styles:

1. Typed labels: the numbers and letters are text, as the test-bank vendor's own handout asks.
2. Word auto-numbering: the questions are a numbered list and the options are a
   lettered list that restarts for each question.
3. Mixed: typed question numbers with auto-lettered options.
4. Bold marks the key, with no asterisk and no answer list.
5. An `Answer: B` line after each question.
6. An answer key in a table at the end.
7. A question per table, and a question per table row.
8. Tracked changes around some of the text.
9. Noise: headers and footers, empty paragraphs, text boxes, page breaks,
   hyperlinks and fields.

**2. A property test.** Random documents in which every paragraph carries a unique
marker. Every marker must come out in a question, an orphan or a finding, and the
count of unattributed paragraphs must be zero. This is the same test that found
three data-loss bugs in the text scanner, generalised to Word.

**3. Real files.** The writer is ours and is not Word. Real Word splits one label
across several runs, adds hidden proofing and bookmark marks, restarts lists in
ways the specification only hints at, and names things its own way. Two sets cover
that:

- The dialect pack: about six small documents saved from real Word, one for each
  layout above, with a note of which answers are right. They are small enough to
  commit. See the appendix.
- Three or more real chapters from banks the author owns (the safest start for
  rights), hand-checked in the preview and kept in `fixtures/publisher/`, which is
  not committed unless the author decides it can be. This is the acceptance test.

**4. Acceptance.** The specification's bar: three real chapters at 95 percent or
better, every question that is not `parsed` listed and linked to its source text.
An import speed budget is proposed here for the author to confirm: 500 questions
in under 3 seconds.

**5. Safety tests.** A zip bomb, a path-traversal entry name, a deeply nested XML
file, a truncated zip and a file that is not a zip at all. Each must end in a
readable error. None may hang, crash or write outside its folder.

## Risks

- **Real Word is messier than anything we can synthesise.** The dialect pack and
  the real chapters exist for this, and they come before stage 8 declares success.
- **Auto-numbering has many edge cases.** Lists restart, continue, share
  definitions and take their numbering from styles. The differential styles cover
  the common shapes, Word itself has been asked about 2,363 paragraphs, and the
  real files will find the rest. What remains is documents that other programs
  (Google Docs, LibreOffice, a script) wrote in their own way.
- **Reading a key from formatting is a guess in disguise.** The per-document
  convention, the single confirmation and the flag on every outlier are there so
  that it never becomes a silent one.
- **Layouts we have not seen.** Tables with a separate answer column and banks that
  put several questions in one cell are possible. Samples should be collected
  before stage 4 is designed, not after.
- **Equations are a long tail.** They come late, with a marker and a finding for
  anything not yet converted.

## Decisions owed

- Where are the author's own Word test banks, and which of them may be committed as
  fixtures?
- Which publisher layouts matter most? One sample of each would shape stages 3 and
  4 more than anything else.
- Will the author save the dialect pack from Word?
- Is `.docx` only the right scope?
- Is 500 questions in under 3 seconds the right import budget?

## Appendix: the dialect pack

Six short documents, saved from real Word as `.docx` (not in compatibility mode),
with four to six questions each. Do not tidy them; the mess is the point. For each,
add a note saying which answer is right for every question, so the expected file
can be written without guessing.

1. **typed-labels.** Type every question number ("1.") and option letter ("a.") by
   hand. Mark each right option with an asterisk. Add an `Answers:` list at the
   end for two further questions.
2. **auto-numbered.** Use Word's numbered list for the questions and a second,
   lettered list for the options, restarting for each question. Put an
   `Answer: B` line after each question.
3. **bold-key.** Auto-numbered questions, options lettered `a)`, and the right
   option in bold. No other mark.
4. **table-layout.** One table with a question per row: number, question, options
   and answer in separate columns.
5. **publisher-style.** A stem, options, then `Answer: C`, `Difficulty: Medium`,
   `Page: 12`, `Learning Objective: ...`, `Bloom's: Apply` and `Feedback: ...`
   lines under each question.
6. **messy.** A header and a footer, a text box, one tracked insertion and one
   tracked deletion, a hyperlink, a picture with alt text, a Word equation, a page
   break, and some empty paragraphs.

If it is easy, save a copy of one of them from Google Docs and one from LibreOffice
as well. Each program writes the same layout differently, and those differences are
what the engine has to survive.
