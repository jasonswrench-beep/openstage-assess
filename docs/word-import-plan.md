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
(questions in tables) on 29 and 30 October, and on 30 October stage 4b, the layout of the
first real publisher file the project was shown (below). A `.docx` goes in, questions come out, and the
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

**Stage 4b built, from the first real file.** The dialect pack was still the thing most
wanted, and the first real publisher chapter (a test bank in Word, 60 questions) arrived
before stage 5. Imported as stage 4 left it, it gave 0 of 60: every question was read as an
essay or swallowed into the one before it. It is not what stage 5 (text boxes, hidden text)
would have fixed, so this came first. Six things changed, each described below:

- a fourth table layout, *numbered cells*: the number in one cell (with the page it comes
  from under it) and everything else of the question in the next, including a table for
  each option inside that cell;
- a heading such as "Fill in the Blank Questions" or "True / False" gives the questions
  under it their type;
- a true or false answer, a fill in the blank answer and an essay's model answer can be a
  line of their own under the question;
- the right option can be marked on its letter alone, and a file that greys out the
  letters of the wrong options is read as agreeing with the one that marks the right one;
- the bank given twice, a copy to print and a copy after an "Answer Key" heading, is read as
  one bank, and what was folded is reported;
- a stem with several blanks and one answer written "one; two" is one answer to each blank.

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
- Stage 4b, against a real file: the first real publisher chapter, 60 questions (15 fill in
  the blank, 15 true or false, 15 multiple choice, 15 short answer), each given twice, went
  from 0 of 60 to 60 of 60 through the real harness. The expected file was written from the
  document's XML by a separate script and not by the importer, and the harness counts a
  question only when its type, stem, options, key and verdict all match. The chapter is a
  publisher's and is kept only on the machine (`fixtures/publisher/`, ignored by git), so
  this cannot be rerun from a clone, and it is one chapter, not the three the acceptance
  criterion asks for.
- Stage 4b, against an invented lookalike: `test/support/publisher-layout.ts` writes a bank in the
  same layout with none of its words, with every part switchable (which copies, how the
  right option is marked, the headings, the page references). The 54 tests of
  `test/word-publisher-layout.test.ts` read it each way, take one piece away at a time,
  and try each rule on small plain examples. 500 questions, each given twice, import in
  about 110 ms.
- Stage 4b, against Word itself: Word wrote an eighth sample document, two questions each a
  table with a table inside it for every option, the right letter bold and underlined and
  the others grey (`H-nested-option-tables`). It reads as intended, and it is the first
  table inside a table that Word, and not our writer, produced. All eight documents read as
  intended and the list labels still agree with Word's: 0 disagreements. Word was not asked
  about the real file itself.
- Fifty-five deliberate breaks of the stage 4b code: all caught by a test in the end. Six
  got through the first tests (padding blank lines above and below a cell's words, a row
  with an empty question cell, a long line ending in "answer key" taken as the heading, one
  twin answering for several copies, and the options not compared when copies are folded),
  and each got a test of its own.
- Stage 4c, against a second real file: an instructor's manual chapter, 28 questions (15
  multiple choice, 10 true or false, 3 essays) typed by hand, with "1)" numbers, "a." options
  and the right option marked with an asterisk after its letter ("c. *text"). It read 3 of 28
  before (every choice question failed honestly, for having no key) and 28 of 28 after,
  through the real harness. The expected file was written from the author's ODT export by
  a separate script. The chapter came as ODT, EPUB, Markdown and a Google Docs link; the
  importer reads none of those, so it was read as a .docx that a separate hidden Word made
  from the ODT, and a .docx that Google Docs itself writes was not tried. It stays in
  `fixtures/publisher/`, ignored by git.
- Stage 4c, the rule: a typed asterisk after the letter is the key only as a habit of the
  whole file, on the terms a mark made with formatting has (some options of a question
  start with one and others do not, in at least three choice questions and 80 percent of
  them). The format's own asterisk before the letter is read as ever. The asterisk is taken
  out of the option's words, the file says once that it was read as the key, and a file
  that does it too seldom keeps the asterisks as text and says why. 23 tests in
  `test/star-after-letter.test.ts`, including the same bank typed and as a Word file.
- Twenty-one deliberate breaks of the stage 4c code: all caught by a test in the end.
  Three got through the first tests (questions with no options counted as choice
  questions, the lettered parts of an essay counted as one, and the severity of the message for
  a habit that was not met), and each got a test of its own.
- Stage 4d, against three more real files, all one instructor's: a test item file of 15 chapters
  (375 questions: 150 multiple choice, 150 true or false, 75 short answer or essay, written in 2005),
  a chapter of 42 questions (written in 2007) and a bank of 30 (written with Word's lists). They read
  0 of 375, 0 of 42 and 5 of 30 before and 375 of 375, 42 of 42 and 30 of 30 after, through the real
  harness, so with the two earlier real files the five score 535 of 535. The expected files were
  written from each document's XML by a separate script and not by the importer. Two questions in
  the item file have no usable answer in the source (7.11 reads "fasle", 10.5 has no answer line) and
  the expected file declares both failed, which is the parser refusing to guess, and they do.
  The two `.doc` files reached the importer as `.docx` files that a separate hidden Word made from
  copies, opened read-only; the original files were not touched. The 375-question file imports in
  about 30 ms.
- Stage 4d, against Word itself: Word wrote a ninth sample document, a matching exercise as a table of
  rows (a number, a term, an empty cell, a definition and a page). It reads as one matching question
  with its three pairs, and all nine documents read as intended: 0 disagreements. The other eight were
  regenerated by the same run and put back as committed.
- Ninety deliberate breaks of the stage 4d code: all caught by a test in the end. Eighteen got through
  the first tests. One was a guard that could never matter (a row of fewer than three cells already
  fails the test for two cells of words) and was taken out. Seventeen each got a test of their own: the
  brackets of a page, a range with spaces in it, a stem line that ends in a page, a number under a number,
  the mode a lone letter is read in, a lone letter in a question with a key, in a question that is not a
  choice question, naming no option, in a question with one option, and given back to the option above, a
  cell spread across columns in a matching table, a table under a heading that is not Matching, and a bold
  space inside a sentence. Two of those needed a second try because the first test did not reach the code.
- Stage 4e, a blind test, against three files from authors the rules had not been written for: the
  importer was run on them with no rule changed, and scored against expected files written from each
  document's XML by separate scripts. A 200-question exam from 2002 (a `.doc` with no answer key in it,
  the answers were in a second file) read 200 of 200, each declared failed, because there is nothing to
  read a key from and nothing was guessed. A second chapter of the 2007 bank scored 25 of 45 (34 of its
  44 questions read right; the harness counts the ten matching items the importer made against the one
  exercise the expected file has, and the 44 `(Difficulty n)` lines it left as stray text). A nursing
  test bank in a publisher's layout scored 0 of 33, with 20 keys on the right option, 4 on an option
  that had the next one fused to it, 9 with none, and no key on a wrong one. After the stage 4e rules
  the three read 200 of 200, 35 of 35 and 33 of 33, the five earlier files still 535 of 535 and the
  61-question gate 61 of 61. One expected result was changed after the first run, on purpose: the
  nursing question whose stem a line wrap had broken is now declared needsReview, because the importer
  has to guess where that question ends and says so. The two `.doc` files reached the importer the
  same way as before, as `.docx` that a separate hidden Word made from copies.
- Seventy-six deliberate breaks of the stage 4e code: all caught by a test in the end. Fourteen got
  through the first tests and each got a test of its own: the spelling and the gluing of an answer label,
  an answer that closes the question in each of the four places it can stand, a letter with no space
  before it, formatting read from a stem line that holds options, a label other than KEY read as a list of
  fields, a one-field KEY, the message about the fields, a rationale not right under the Answer line, a
  rationale in too small a share of the questions, and the severity of the matching heading's flag. A fifteenth was a condition
  that could never matter (the scanner is in stem mode only until the first option) and was taken out.
- Stage 4f, a blind test, against thirteen files from one instructor's physical science course, shared
  under a CC BY 4.0 licence (found on the open web and downloaded with the user's say-so). The importer
  was run on them with no rule changed and read 0 of 618 questions. Each file left between 88 and 456
  blocks as stray text, three of them (lessons 1, 4 and 12) made one essay each out of a stretch of the
  file that was flagged for review, and no key was set anywhere. The layout has no question numbers and no
  option letters, so nothing said where a question began. The expected files were written from each
  document's XML by a separate script, whose first version glued the first option of one question onto
  its stem where Word had put a line break inside the paragraph; that showed as a disagreement, was
  checked against the XML, and fixed in the script, and no other question changed. After the stage 4f
  rules the thirteen read 618 of 618 (three declared needsReview and one declared failed), the eight
  earlier files still 803 of 803 and the 61-question gate 61 of 61. Two expected results were chosen
  before the importer was changed: the three questions whose type line was left off are needsReview,
  because the importer guesses where they begin, and the one question with no starred option is failed.
- Fifty-five deliberate breaks of the stage 4f code: all caught by a test in the end. Four got through the
  first tests and each got a better one: the page line (the form `(Page 12)` is also caught by the
  bracketed note, so the forms `(p. 230)` and `(pp. 12-14)` needed tests of their own), an option that looks
  like a label in the second place, and two conditions of the read for a question with its type line
  left off, whose first tests never reached the branch. Three conditions that could never matter (length
  checks that the count of options already makes) were taken out.
- Stage 4g, a blind test, against 24 Word files that another model wrote from `docs/synthetic-bank-spec.md`,
  run before anything was changed. The blind set read 23 of 48 questions and the set that may be fitted to
  10 of 24 (33 of 72). The batch was less than the brief asked for: five distinct documents, identical but
  for the title, three questions each, in one layout, with a `layouts.md` that described layouts the files do
  not have and a checker that printed success whatever it found. So the number measures one layout from
  five angles, and it is reported apart from the real files. Of the 39 questions missed, 29 had a type the
  file never names (ten true or false statements answered `True` or `False`, fourteen typed-in answers under
  `Accepted answers:`, five matching exercises written as `Bell = Telephone` lines) and came out as essays
  with the answer in the stem or no key, and 10 differed only in the verdict. No question had a wrong key,
  and all 24 with no answer marked were refused. After the stage 4g rules the blind set reads 42 of 48 and
  set A 20 of 24, with every question's content right; the 10 left are the verdict on two kinds of
  question that stay flagged on purpose (a multiple choice question with two stars and no type, and an
  essay with no answer). The real files are still 1421 of 1421 and the 61-question gate 61 of 61. The rules
  are fitted to these five documents now, so the honest number is the first one.
- Sixty-seven deliberate breaks of the stage 4g code: sixty-three caught by the first tests. Of the four that
  got through, two (the forms of an `Accepted answers` line are trimmed again further on, so only the count
  in the note showed it) got a better test, one was the offset of a pair line's text, which has no letter to
  tell it from and was taken out, and one, a guard that only an empty line passes through, changes nothing in
  the whole suite and was left. A probe found two things the breaks could not, both of the same kind, a
  matching exercise that looked complete with a pair missing and was `parsed`. A repeated left side on the
  third line left the first pair in the stem and read the two lines after it as the exercise, so a run now
  has to begin right after the instruction. A note or a blank line in the middle of the pairs ended the run
  and left the rest as stray text, so a pair-shaped line after the run is now a warning on the question
  (`import.pair-left-out`).
- The brief for generated banks was rewritten after stage 4g, and the checker that holds a batch to it
  (`npm run check:generated`) was built and tested before any second batch was asked for: 24 files in six
  pieces of four, each assigned a layout, the blind set being pieces 1 to 4. See `docs/synthetic-bank-spec.md`.
- Stage 4h, begun: the layouts that sixteen generated files could not be read in. With the importer unchanged the
  sixteen files of the blind set read 47 of 232 questions and the sixteen of the fit set (pieces 5 and 6, and a second
  version of pieces 3 and 4) 44 of 230; `docs/review-findings.md` has what was not read. The first step is the safety
  fix. Options that share a paragraph are now split where two spaces or a tab come before the next capital letter and
  a full stop, whatever follows, because a bank whose options are all lower case (a vocabulary test's) had no other
  way to show where one ends; a single space before a lower case word is still not a new option, so "C. difficile" stays
  in its sentence. And options lettered with a letter missing, A and C with no B, are a warning on a choice question
  (`import.option-letter-gap`), because that is what a question looks like when two options were not told apart, and
  one such question had been `parsed` with two merged options and a key that pointed at the right words. After it the
  fit set reads 53 of 230 (23.0 percent), c-09 10 of 12 (from 4), the five refused questions in the blind set are
  right, the real files are still 1421 of 1421 and the gate 61 of 61. 13 new tests (994 in all), and 18 deliberate
  breaks, 17 caught and one equivalent (letters that are unique and in the wrong order always include one later
  than expected, so "later" and "different" are the same test).
- Stage 4h, step 2: question numbers written `Q1.`, `Question 1:`, `(1)` and `4.1 Which ...`, and options labelled
  `(A)` and `A:`. `Q` and `Question` with a number and a stop or colon are read wherever they begin a line, but a number must
  be followed by a space or the end of the line, so that a stem that begins "Question 1.1?" is not question 1. A
  bracketed number is read only where the file does it as a habit (at least three, most of them going on from the one
  before, which allows a repeat, a skip of up to three, and a restart from 1), and then only as the next number, so
  that a line Word wrapped in an answer, "(2) the offer is ...", is not question 2; a real file showed that, and so did
  c-16, which skips a number. `4.1 Which ...` is read on the same terms as the bare `1.14`, and only as a habit.
  `(A)` and `A:` are options only as the next letter the question is waiting for, so "(T) Ice floats." in a true or
  false bank, and a "Q:" and "A:" card, are not. One helper (`anyOf`) tries several forms and hands back the
  same groups, so none of the call sites changed. Run on the sixteen files to fit to, they read 80 of 230 (33.3 percent
  as the harness scores it, with the ten questions made from key lists counted against it), from 53; the sixteen blind
  files, now a second contact, 102 of 232 (40.8 percent), from 53; the real files are still 1421 of 1421 and the gate
  61 of 61; and in none of the five generated sets is a question that is wrong marked `parsed`. 24 new tests, 28
  deliberate breaks, three of which got through the first tests (a stray "(5) minutes are allowed" before the first
  question, decimals that mostly do not go on, and questions that follow each other with no answer lines) and each got
  a test.
- Stage 4h, step 3: marks at the end of an option, a line `Correct: C`, a list inside a stem, and numbers that skip.
  `(Correct)` or a check mark at the end of an option that stands alone on its line is the right answer and is taken
  out of the words; a star at the end of the line is a mark only where at least three options end that way and no more than
  half of all the options do; a line of several options is left alone, because the mark could belong to any of them. The
  file says how many options were read this way (`import.mark-at-end-of-option`). `Correct:` is an answer line, as
  `Answer:` is, and `Correct feedback:` is not. And a plain `3.` in a file whose questions are numbered `2.5`, `(2)` or
  `Q2.` is a step in a list inside the stem and not a question: found by a question whose stem was "To solve a system, a
  student performs these steps:" and three typed steps, which came out `parsed` with a right key and the first half of its stem
  gone, the one kind of fault this importer must not have, and now it is the whole stem. A bracketed number may skip up to
  three, or repeat, as a tired author leaves it (c-16 skips a number, which made the whole file unreadable). The fit set reads
  115 of 230 (50.0 percent as the harness scores it), from 80, and the sixteen blind files 122 of 232 (49.4 percent), from
  102; no question in any of the five generated sets is wrong and `parsed`; the real files are 1421 of 1421. 39 new tests (1038
  in all), and 38 deliberate breaks of the question-start rules and 21 of the end marks, all caught in the end.
- Stage 4h, step 4: a key at the end of the bank. Under a heading such as `Answer Key`, entries with several to a line
  (`1. B   2. C`), one to a line, with a chapter in the number (`4.1. B`), a colon (`3: B`), `True` or `False`, or in a table
  of two columns, are a key and not questions. Before, every row of a key table became an essay whose stem was a letter and
  every line of a key list became a question made of entries, all counted against the file. A heading that is followed by
  questions is still the copy with the answers, not a key. A dash, `n/a` or `none` in a key says that question has no key:
  it is never an answer, so a choice question given one is refused and a fill in the blank with its own answer keeps it. Found
  by breaking the rules: a key list with a dash in its first or middle entry was not read as a key at all. A dotted number
  with words after it (`4.5. Bromine`) is an entry only where a question above has that number. The fit set reads 135 of 230
  (58.7 percent as the harness scores it), from 115, and the sixteen blind files 143 of 232 (61.6 percent), from 122; in none
  of the five generated sets is a question that is wrong marked `parsed`; the real files are 1421 of 1421 and the gate 61 of
  61. 24 new tests (1062 in all), and 28 deliberate breaks of the key rules. One is not caught and is left: a lone plain
  entry takes the older path, which gives the same answer except for a lone entry with options under it or for a number no
  question has.
- Stage 4h, step 5: two more types read from the answer. With no type named, an answer line or key that marks two
  options (`ANS: B, D`, `B and D`, `B/D`) is a multiple response with those two options marked, and is flagged, because two
  letters may be a slip: it was an error on a single-answer question before. A stated `Type: MC` is not overruled and still
  fails. A stem with a blank (`____`) and an answer in words (`Answer: Paris`) is a fill in the blank, with an information
  note and no flag, as `Accepted answers:` is. Not when any answer is a letter or letters (`B`, `B, D`, `A and C`): that is the
  key of a choice question whose options were not read, and a fill in the blank made of it would look right and be wrong.
  Found when the first form of the rule took the word `Paris` for letters, since every letter of it is between A and T; the
  separator is now required. The fit set reads 149 of 230 (64.8 percent as the harness scores it), from 135, and the blind
  files 155 of 232 (66.8 percent), from 143; in none of the five generated sets is a question that is wrong marked `parsed`;
  the real files are 1421 of 1421 and the gate 61 of 61. 17 new tests (1079 in all), and 19 deliberate breaks, all caught in
  the end; three got through at first and one of them changed the rule (an answer line of words beside a key that gives a
  letter now reads neither way).
- Stage 4h, step 6: a bank with no numbers and no letters, or numbered stems and no letters. A stem, its options under it
  one to a line, a blank line, the next stem, with the right option marked by bold, a highlight, a colour, `(Correct)` or a
  star. `standard-text-relabel.ts` gives such a file the labels the page does not show, as Word's own list would (the stem is
  numbered unless it is, the options lettered in order) and the scanner reads it again as it reads any other, so every key
  and type rule is the existing one. It decides only where a question begins and where its options are, and only from how the
  whole file does it: three groups at least, nearly every run of lines in the file one of them, and the second reading kept
  only if it finds keys the first did not and keys on at least four in five groups. A stem with an answer line and no options
  (true or false, a blank, a short answer) is a group too. Not applied to a file the plain scan already read a choice question
  from, which includes the type-line layout. The file gets a warning that says it was read by its layout. Guards, each found
  by thinking of the question that would be wrong and look right: a stem set apart from its options by a blank line (the
  first option would be the stem) makes the file unreadable by this step, a word or two on a line is not a stem (a type tag),
  a title and up to three lines of instructions at the head of the first run are left out and listed, a line under the stem
  that ends in a question mark or a colon closes a stem that has a second paragraph, and a line far longer than the options,
  or a stem that ends in a colon above a full sentence, flags the question for a check because it may be more of the stem.
  The fit set reads 183 of 230 (79.6 percent as the harness scores it), from 149, and the blind files 175 of 232 (75.4
  percent), from 155; in none of the five generated sets is a question that is wrong marked `parsed`, after the first run of
  this step put one there (a second paragraph of a stem read as an option, which the second paragraph rule and the long-line
  flag now catch); the real files are 1421 of 1421 and the gate 61 of 61. 39 new tests (1118 in all), and 34 deliberate breaks,
  all caught in the end; 24 got through the first tests, and most of those were checks hidden behind a later one.
  Not read yet: a true or false statement with its `(T)` or `(F)` at the end and no stem number (c-23).
- Stage 4h, step 7: bulleted options. Word keeps no label for a bullet, so the reader gave nothing to tell an option from a
  stem and a bank of numbered stems over bulleted options with no blank line between the questions was one run of lines. A
  block now says it is a bullet (`SourceBlock.bullet`) and a later line of a bulleted paragraph, after a soft line break, says
  it is more of that item (`bulletMore`). The step that labels a bank with no letters ends a group at the first line after the
  last bullet, and leaves the later line of a broken bullet with its option. The fit set reads 184 of 230 (80.0 percent as the
  harness scores it) and the blind files 187 of 232 (80.6 percent), from 183 and 175; no question in the five generated sets is
  wrong and `parsed`; the real files are 1421 of 1421 and the gate 61 of 61. 8 new tests (1126 in all), and 11 deliberate breaks
  of the bullet rules; one got through the first tests (a bulleted option with a soft line break in it, which would have begun a
  new question) and now has a test.
- Stage 4h, step 8: a statement that ends with its own answer, `The Sun is a star. (T)`, with no type line. It is a true or
  false question where the file does it as a habit (three one-line numbered statements at least, because `(F)` may be the last
  word of a stem that means Fahrenheit) and where the statement stands alone, with nothing under it. A stated type is not
  overruled. In a bank with no numbers a one-line statement with its answer at the end is a group of the step that labels
  such a bank. The fit set reads 190 of 230 (82.6 percent as the harness scores it) and the blind files 190 of 232 (81.9
  percent), from 184 and 187; no question in the five generated sets is wrong and `parsed`; the real files are 1421 of 1421 and
  the gate 61 of 61. 10 new tests (1136 in all), and 11 deliberate breaks, three of which got through the first tests (what the
  habit counts) and now have tests.
  What is left in the generated sets is mostly a question with no options and an answer in words and no blank, which is an
  essay or a short answer and is flagged because the file does not say which, and a question with two bold options and no type
  line, which is a multiple response and flagged because it may be a slip.
- Stage 5, the rest: hidden text, and text in boxes. Text that Word hides (`w:vanish`, set on a run, by a character style or
  by a paragraph style) is not read. It is not on the page a person reads, and an old answer or a note to self left hidden
  must not turn up in a stem, an option or a key. Hidden is a toggle like bold, so a hidden paragraph style under a hidden
  character style shows the text again. A paragraph whose text and mark are both hidden is not a line at all, because Word
  joins it to the next one, and it still takes its number in a list, which Word was asked and did (the item after it was
  numbered as if it were there); in a table cell it is kept as a blank line, since the end of a cell joins to nothing. The
  file says how many paragraphs had hidden text left out and quotes the first, with how to bring it back, and says
  separately how many paragraph marks are hidden. Asked of Word: `check:word-formatting` now holds 14 paragraphs of hidden
  text reached by direct formatting, character styles, paragraph styles, styles based on them, and the document defaults,
  and the reader and Word agree on all of them (155 documents, no disagreement); `check:word` holds a hidden item in a list.
  Text in a text box, shape or picture is still not read, as the design said: it is counted, quoted once, and the message
  says that a question in one is in no question and no orphan. Where Word writes a box twice, in `mc:Choice` and again in
  `mc:Fallback`, it is counted once and quoted from the newer copy. 19 new tests (1172 in all with the review page's) and 15
  deliberate breaks, all caught.
  Not modelled: a hidden paragraph mark that still has text, which Word joins to the next paragraph and the reader keeps as a
  line of its own (the file says so, and `check:word` leaves the case out, since Word then counts one paragraph fewer than the
  file holds); and document defaults that hide text met by a character style that hides as well, where Word is not the plain
  toggle ("paragraph style off, character style on" shows, "defaults on, character style on" hides). No file sets hidden text
  in its defaults.
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
  paragraph at all. Hidden text is left out, and text in boxes is counted and quoted, not read (stage 5, above).
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
  A typed "b. *Mars" is a mark only as a habit of the whole file (stage 4c, below): a
  lone one is still text, so nothing read before is read differently.
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

- Cells merged down, or a row that starts late or ends early, are never read as a layout,
  and a grid or an answer key with a cell merged across is not either. Labelled rows allow
  one cell spread across a whole row, which is how Word writes a line of text in a table of
  two columns. A table with another table in a cell is read by one layout only, numbered
  cells (stage 4b), and otherwise cell by cell as before: the grid, labelled rows and the
  answer key would read the lines of the inner table under the wrong column.
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

**How a publisher's layout is read, stage 4b.** Every rule is for one piece of the first real
file, and each has a test, on the lookalike and on small plain examples.

- *Numbered cells.* A table whose every row has two cells, the first holding a number
  (`31.`), reads as a question to a row. The second cell's lines go on as they are, blank
  lines included, because a blank line is what ends an option. Under the number, a line
  such as `(p. 230)`, `(pp. 12-14)` or `Page 3` becomes a `Page:` line; any other line is
  kept after the question, behind a blank line so that it is not read as more of the stem or
  the last option, and the scanner reports it. A row whose question cell is empty, a merged
  cell, a first cell that is not a number, or a third cell means the table is not read as
  this layout. The layouts that came first are tried first and read what they always read.
- *Headings give a type.* A line that is wholly one of "Fill in the Blank", "True / False",
  "Multiple Choice", "Multiple Response", "Short Answer", "Essay" or "Matching", with or
  without "Questions" and a colon, sets the type of the questions after it, until the next
  heading. A `Type:` line on a question is the file's own word and wins. A heading no
  question used is reported as stray text. "True / False" directly under a true or false
  question is that question's list of choices and not a heading, and the two words with only
  spaces between them are never a heading.
- *Short answer is read as an essay with a model answer*, because a paragraph cannot be
  matched exactly, and a short answer question in this model is one that is. This is a decision to
  confirm. `Type: S` still makes a short answer in the model's sense.
- *Answers on a line of their own.* The word True or False alone under a true or false
  question is its answer, anywhere. Under a fill in the blank or an essay, the line after a blank
  line is the answer only after an answer key heading (a short line ending in "Answer Key"),
  because in any other file it is more of the stem and was always read as such. The
  file says how many answers were read this way, as information. A printed true or false
  question's list of choices, and a fill in the blank's line of underscores to write on,
  are not added to the stem.
- *Marking on the letter.* A property carried by an option's letter and by none of its
  words (a bold underlined `A.` with plain words) is a mark, named "on the option letter",
  and follows the same rules as a mark on words: a convention of the whole file, at least
  three questions and 80 percent of them. A letter that is bold together with the words
  after it, or a bold term at the start of an option with its letter, is not one. This
  reverses an earlier test that said a bold label alone is nothing; the real file marks it that way.
- *Letters greyed out.* Two groups of marks that split the options of every question between
  them, such as bold letters on the right option and grey letters on all the others, are
  one convention seen from both sides, and the side that picks out fewer options in more
  questions is the key. One question where the two do not split the options is enough to
  take no key at all from formatting. Two options, which is what a true or false written
  as choices has, are always a tie, and a tie takes no key.
- *Two copies.* Questions before an answer key heading are folded into questions after
  it that say exactly the same, stem and options, compared without regard to case or
  spacing, once each and in order, when the earlier question gives no answer of its own.
  The copy with the answers is the one kept and its answer is its own: nothing is taken
  from the copy that was dropped. A question with no twin is kept and says so. This is not
  done in a file with an Answers list. Which copies were folded, and where, is reported.
- *Several blanks.* A fill in the blank stem with two or more runs of three underscores or
  more, and one answer with the same number of parts between semicolons, is one answer to
  each blank, in order. Any other count is not split, because which answer goes with which
  blank would be a guess; it is kept as one blank's accepted forms, as before, and flagged.

**How an instructor's own banks are read, stage 4d.** Three files from one instructor's
projects (2005, 2007 and this year), each a different layout, which read 0 of 375, 0 of 42 and
5 of 30. Each rule has a test on small invented examples; none of the files' words are in the
tests, and the files themselves stay in `fixtures/publisher`.

- *A page in brackets.* `(Page 3)`, `(p. 230)`, `(pp. 12-14)`, alone on a line, is the question's
  Page. It used to be added to the last option, which put a page number into that option's words
  and, when the right option was the last and bold, hid the bold: 7 keys in 15 were lost to it.
  At the end of a question's line it is taken off the line and kept. The brackets are required, and
  `(p. 24).` with a full stop after it is a citation that belongs to the sentence and stays.
- *The tail of an Answer line.* `Answer: b) (Textbook reference: ...)` is the key `b` and a note.
  A bracket or full stop after a letter or True or False is dropped when what is left reads as a
  key ("b)", "False."). A note is taken off only when it names a source (textbook reference,
  reference, ref, source, section, chapter, page, p.), and only when something that is not the note
  comes before it, so `(or d)` is not one and the line is reported as it was. The note comes
  back as metadata, so nothing is dropped; "Textbook reference" is read as the question's section,
  which is an interpretation.
- *Chapter and question alone on a line.* `1.14` with the text on the next line is a question, with
  the label kept for messages and for telling `1.1` from `2.1`. Between questions, after a heading
  or after a question's last line and a blank, any such number with text under it is a question,
  because a bank may start again in each section. Inside a stem or an option it has to be the next
  number, so a lone `3.14` among the words is not one. Options straight under it do not make it a
  question, and another number under it does not either.
- *A number alone with options under it.* `3.` and then `a. term = definition`: a question
  whose text is its options, which is how a table of matching pairs is written.
- *A letter alone under the options.* `e. manager`, a blank, `d`. The letter has to name an option the
  question has, in a choice question with no key of its own. It is taken, and given back at the end
  unless it is a habit of the whole file, on the terms formatting has (three questions and 80 percent of
  the choice questions). One in a file that does not do it, such as a stray cell of a table after the last
  question, goes back to being what it was: stray text, or the end of the option above. The file says how
  many answers were read this way, as information.
- *True or false in the line.* `(T)` or `(F)` at the end of the first line, before or after a page, under
  a true or false heading, is the answer, and is taken off the statement. The file says how many were read
  this way. A single word on a line of its own after a blank line, under a true or false heading, is an
  answer too, even when it is not one the question can use ("fasle"): it is not added to the statement,
  it is reported as a key that could not be read, and the question has none.
- *A chapter title ends the question.* `Chapter Two`, `Chapter Two Test Questions`, and nothing else
  that begins with the word, close the question above, which used to take the title as more of its text
  (13 essays in the large file). It is reported as stray text. Headings may begin with `Chapter One` or
  `In-depth`, and `Short Answer/Essay` is one heading.
- *A matching table.* A table of at least three and at most twenty rows, each a number, a term and
  a definition with empty cells between, the numbers counting up by one, is one matching question with a
  pair to a row, and not a question to a row. The page at the end of a definition is kept as the question's
  Page. The table has no text of its own, so the heading above it is the question's text, and the
  question is flagged for review.
- *A fill in the blank as a finished sentence.* The answer is the bold part of the sentence, which
  becomes a blank in the question and is the answer; two bold parts are one answer to each blank, in
  order. A habit of the whole file (three questions and 80 percent of them), single lines only, only under a
  fill in the blank heading or Type line, never where the question has a blank or an answer already, and
  never where the whole sentence is bold. Turned off with the rest of formatting (`--key-mark off`).
- *The right side of a matching pair, and a distractor, follow the model's character rule*, as the left
  side does, because they are plain strings and rich text is where the rule was applied.

**How a publisher's layout and a second chapter are read, stage 4e.** A blind test (see Measured)
found these. Each rule has a test on small invented examples in `test/blind-layouts.test.ts`, and
none of the files' words are in them.

- *Options on one line.* `B. SOLER C. DAR` is two options, and the first option may be at the end of
  the question's own line (`Which is a planet? A. Sirius`), when B is on the same line or begins the
  next. The letters have to come in order, from A (or from the letter after the option the line
  began with), each a capital letter and a full stop with a space before it and no lower case letter
  after it, so `C. difficile` and a stem that ends in `vitamin A.` are not options. The options
  that share a line are marked as sharing it, and the formatting reader skips them: how a line looks
  says nothing about one of its options. The file says how many lines were split, as information.
- *An answer at the end of a line.* `D. Affect ANS: C` is the option and the key `C`, and it ends the
  question, so the line under it is not added to the option. Only `ANS`, `Ans`, `Answer`, `Answers` and
  `Correct Answer` with a colon, and only when what follows is a key (letters, or True and False), so
  `answer:` in the middle of a sentence is not one. The same on the last line of a stem, for a true or
  false statement (`... ANS: T`).
- *A number that goes back to the start inside a stem.* `13. ... by the end of day` and then `1. Which
  diagnosis...` is a sentence that a line wrap broke. Directly under a stem that has no options yet, with
  no blank line between, a number that is the same as or lower than the question's own is more of its
  text, and the question is flagged for review (a warning), because the importer guessed where it ends.
  A number that goes on from the last is a question, and so is one after a blank line, after options, or a
  gap upward. A steps list inside a stem (`1. wash`, `2. dry`) stops being a run of questions.
- *A KEY line of fields.* `KEY: Cognitive Level: Application | Client Need: Safe Care` is a field of
  metadata for each, so the Bloom level is read from `Cognitive Level` and the rest are kept under
  `metadata.custom` with an information finding, not the warning an unknown label gets. A KEY line that
  Word broke across paragraphs (`... | Client` and then `Need: Safe Care`) goes on into the line directly
  under it, with no blank line between, but only for a label whose value is a list of fields separated by
  bars: stray text under `DIF: Easy` is still stray text. A `KEY:` that is not a list of fields stays one
  label this profile does not know, and says so.
- *The explanation under an Answer line.* A paragraph or two directly under an Answer line, with no label,
  is the explanation of the answer, kept as a note under `metadata.custom.Rationale`. It is **not made
  feedback**: a question's feedback is what a student is shown, and the profile already declines to make a
  `Rationale:` or `Explanation:` label feedback for that reason. Read only as a habit of the whole file
  (three questions and 80 percent of the questions that have an Answer line); in a file that does it
  now and then it is given back as stray text, as before.
- *A note in brackets alone on a line.* `(Difficulty 3)`, `(Chapter 4)`: any label this profile knows,
  as the page already was. `3` is read as hard, as `DIF: 3` is. A label it does not know (`(Note to self)`)
  is stray text.
- *Terms, definitions and foils.* `1) Term: ...`, a `Definition:` line, and sometimes a `Foil:` line, under
  a matching heading or none, are the items of one matching exercise: a pair to an item and the foil as a
  wrong answer to go with it. The exercise is under its heading, which stands for the instruction, so it is
  flagged for review as the matching table is. One exercise for each heading. The page and difficulty
  under each item are kept (the pages joined, the first difficulty used and the rest recorded with a
  warning, which the heading's flag covers anyway).

**How a bank with no numbers and no letters is read, stage 4f.** A blind test found this. The rules have
tests on invented questions in `test/type-line-layout.test.ts`, and none of the files' words are in them.

- *The layout.* The type of the question alone on a line (`MC`), or `MC` and the stem on one line; the stem
  under it; the options under that, one to a line, with no numbers or letters; the right one with a star in
  front; a blank line before the next. Capitals only, and only `MC`, `MA` and `MR`, the choice types, which
  are the ones whose options a star can tell apart. A line that says only `MA` is also a thing an option
  can say, so it counts only at the start of a run of lines (after a blank line, or under a heading) and
  only when the file does it at least three times.
- *The options.* Every line under the stem up to the blank line, except that a line that is the question's
  Answer line, a page, a feedback line or a label the profile knows ends them once there are two, and is
  read in the ordinary way. The letters a, b, c are given in order only so that messages can name an
  option. The star is the key and is taken out of the words. No star is no key, a star in the stem is not a
  key, two stars on a multiple choice question leave both marked and fail it (as in every layout), and `MA`
  or `MR` takes every starred option, whatever their number. A key marked by bold in a file like this is
  read by the habit of the whole file, as in any other.
- *A question whose type line was left off.* The last question of three files had none. Under a file that
  has the habit, after a question that has a type line, after a blank line: a stem and two or more options
  with exactly one starred, none of the lines numbered, lettered or a directive, and no star on the stem,
  is read as a question and flagged for review (a warning), because the importer guessed where it begins.
- *What it does not read.* Type lines for true or false, essay, fill in the blank and matching, which have
  no options a star can tell apart (a question with such a line is stray text). A stem of more than one
  paragraph: the second is taken for the first option. Questions with no blank line between them: they are
  read as one question, which has a type line among its options and is flagged for review, because if the
  first has no star of its own the second's would be taken for its key; with two stars it fails.

**How a type is read from the answer or the pairs, stage 4g.** A blind test on a generated batch found this.
The rules have tests on invented questions in `test/type-from-evidence.test.ts`. They apply only when the
file names no type: a Type line, a section heading or a type line that is stated wins, and a Type line this
profile does not know is worked out as before and flagged. They are not flagged for review, because the
evidence is the file's own word or pair and not the shape of the question, and no key is guessed. Each
leaves an information finding (`import.type-from-evidence`) that says what the type was read from. What
stays a flagged guess: an essay with no answer, a choice question with two stars and no type.

- *True or false.* A statement with no options whose answer, from an Answer line or an Answers list, is the
  word True or False alone (any case, a full stop after it is allowed). Not `T`, `Yes` or a sentence, which
  are not the words. Not when the stem has a blank (three underscores or more), since `A value is either
  ____ or false` has True for its answer. Not when two sources give different answers.
- *Accepted answers.* A line labelled `Accepted answers:`, `Acceptable answers:` or the singular is a key
  that only a typed-in answer has. It is a fill in the blank when the stem has a blank and a short answer
  when it has none. The plural is a list and is cut at its semicolons or, with none, at each comma followed
  by a space, so `1,000, one thousand` is two forms. The singular is one answer however many commas it has.
  The cut is the one judgment here: `Paris, France` is two forms, and the question says it was cut, with the
  forms, so that someone who meant one answer can join them. An empty line, or one of separators, gives no
  answer and does not make the question a typed-in one.
- *Matching, with no letters.* An instruction that says to match (`Match`, `Matching`, a word and not part
  of one), then a line of `left = right` for each pair, with a space each side of one equals sign. It needs
  both, and at least two pairs with different left sides. The run has to begin right after the instruction:
  a pair line that was refused (a star, a repeated left side) and left in the stem makes the rest no run,
  because the rest would look like a complete exercise with its first pair missing. The run ends at the
  first line that is not a pair, and that line is reported as stray text; if a pair-shaped line comes after
  it (past a note or a blank line) the question gets a warning that a pair may be missing, so it is sent to
  review and not passed as complete. An instruction that has an equals sign in it is not read, since its
  own sum looks like a pair.
- *What it does not read.* An answer of `T` or `F` on a statement with no options, a blank in the stem with an
  ordinary `Answer:` line and no label, a stated `MT` type over lines of pairs with no letters (it fails,
  with its lines left in the stem), pairs with a note or a blank line in the middle of them (the pairs
  before it are read and the question is flagged), and a wrong answer to go with the pairs.

**Not built yet:** a key in a table by shading, matching questions as a table of another shape
(two columns, no numbers), a question that spreads over several rows of a grid, a question that
stands in a text box (counted and quoted, not read), pictures with their bytes and alt text (stage 6), equations
(stage 7), the answers of a test kept in a second file (the 2002 exam's answers are in
a second file), and the rest of stage 8: real chapters written by other people than the two sources so
far. The dialect pack is still the thing most wanted. The first real file taught more in one
afternoon than stages 3 and 4 had learned from files our own writer made, and each file since has
needed rules of its own; the next layout will not be these. Word's spelled-out number formats
("One", "First") and the many non-Latin ones are not read yet; a list in one is reported, not
guessed. The old binary `.doc` is not read: Word and LibreOffice save it as `.docx`.

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
| 4b | A real publisher's layout: a table for each question with a table for each option, type headings, answers on lines of their own, a mark on the option letter, two copies | The first real chapter scores in full (done, one chapter) |
| 5 | Tracked changes, text boxes, hyperlinks, fields, hidden text, alternate content | The noise style and the property test pass |
| 6 | Images, alt text from the picture's description, bytes into the bank | Pictures survive a round trip and a missing description is a finding |
| 7 | Word equations to MathML and LaTeX | The equation fixtures pass (done 6 November 2026: `import/docx/omml.ts`, held to what real Word builds by `check:word-equations`) |
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

1. Typed labels: the numbers and letters are text, as the format's own guidance asks.
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
