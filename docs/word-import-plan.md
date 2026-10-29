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

The first slice (stages 0 and 1) was built on 28 October 2026. A `.docx` goes in,
questions come out, and the real harness scores them. `openassess import
file.docx` works, and so does exporting what it imports to the Author spreadsheet.

**Built:** the XML reader (`import/docx/xml.ts`), zip entry names that are checked
on read and write, the package reader (`package.ts`), the paragraph and table walker
(`document.ts`), the importer (`word.ts`, profile `word-docx`), an importer registry
shared by the harness and the command line, the scanner reading list labels, and
the test-side Word writer (`test/support/docx-writer.ts`).

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

**Not built yet:** Word's own list numbering (stage 2), answer marks made with
bold or highlight and `Answer:` lines (stage 3), table layouts as questions (stage
4), text boxes and alternate content (rest of stage 5), pictures with their bytes
and alt text (stage 6), equations (stage 7), and everything that needs real Word
files (stage 8). The dialect pack is still wanted before stage 3.

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
  the common shapes and the real files find the rest.
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
