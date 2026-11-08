# OpenAssess design plan

Written on 27 October 2026, after reading the product specification (25
October), the published guides for the standard test-bank text format, a long discussion with two AI assistants
about what an assessment tool could be, and a working session on what is
realistic for one person to build. It records what was decided and why, so that
the next session does not have to rediscover it.

`docs/review-findings.md` is the list of known defects. This file is the list of
intentions. Where the two disagree about direction, this one wins.

## What OpenAssess is

A standalone program for one person on one computer. An instructor writes,
imports, organises, checks and prints test questions, and exports them to the
places they are used: a learning management system (LMS), paper, or a web page.
It needs no account, no server, no network and no AI. Windows first.

It is one of the OpenStage suite of tools (Author, Scroll, Explainer, Capture and
others). Each has its own purpose and stands on its own. They do not depend on
each other. Where one is useful to another, the link is a file that a person
carries across, such as the question spreadsheet that Author and Scroll read.

The pitch, borrowed from the wider discussion: turn existing assessment
materials, such as a publisher's Word test bank, into accessible, reusable,
outcome-aligned assessments without retyping them. The promise that matters is a
transparent, repairable import. Every question is parsed, flagged or reported,
and nothing is dropped silently.

## What it is not

It does not deliver tests to learners, collect their answers online, keep a
gradebook, run a server, proctor, or adapt questions to a learner. Those need
accounts, hosting and data protection that this project is not set up to carry,
and the LMS already does them. It is not a collaboration platform: there are no
accounts and no live editing.

## Decisions

1. **Standalone.** The suite is a family of independent tools, not a pipeline.
2. **Individual use.** One person works on a bank at a time. Banks are shared as
   files, and anyone with the software can open one, so test banks can be sent
   back and forth. A later feature could compare a returned copy with the
   original and show which questions changed. There is no merging in real time.
3. **The read API is retired in spirit.** `src/read/` was built so Author and
   Scroll could read banks through six functions. They do not. Nothing depends
   on it, so it is not a promise to anyone. It is kept and tested for now and
   may be removed once the desktop app exists. Item 3 of the findings (does the
   delivery payload carry the answer key) is closed by this: a table of
   questions carries its answers, as every LMS import does. The question
   returns only for a web-quiz export, and is decided there.
4. **Student privacy by design.** OpenAssess stores no student names, no student
   IDs and no photographs in any file it creates. This is a design choice that
   avoids holding student records at all, not a statement about what the law
   requires. See "Answer sheets" below.
5. **Other companies' brand names stay out of the product.** A feature is called
   "answer sheets", not by the name of an existing product. A format is named
   generically wherever it can be ("reads the standard test-bank text
   format"), and only a file format or an LMS is named where the program must
   say what it reads or writes, with the non-affiliation notice in `NOTICE`.
6. **The Standard Format is four dialects.** The generic, Canvas, Moodle, D2L and
   Blackboard guides differ in small, real ways, recorded in the findings. The
   importer reads the generic one and the common additions, and refuses the types
   it cannot yet read by name.
7. **AI is optional, reviewed and recorded.** It helps with the slow parts of
   writing items and never decides what goes on a test. Anything it drafts stays
   marked as a draft until a person approves it, and the model and source
   passage are recorded. Nothing requires it.
8. **The app is a local server with a window around it.** Everything the app does
   is done by `packages/app`: a Node server that listens on 127.0.0.1 only, serves
   a vanilla JavaScript page (no framework, no build step, no runtime dependency)
   and imports the engine by relative path. A browser can open it
   (`Open OpenAssess.cmd`, which needs only Node). The native window
   (`packages/app/shell`, Tauri) is a thin shell that starts that server, waits for
   it to say where it is, and shows the page. It has no commands for the page to
   call. It is outside the npm workspaces so that installing the repository never
   fetches the Tauri tools. Reasons: the engine stays free of dependencies, the
   same code is tested through a real HTTP client, and the window can be replaced
   without touching the app. The server is built to be safe from other pages in the
   same browser, not only from other computers (host check, a key held in a
   cookie other sites are not sent, a header on every change, no outside script).
   The installer carries its own copy of Node, so the person using it installs
   nothing else.

## The rules that do not change

Never guess an answer key. Nothing is dropped silently. Checks warn and do not
block. No runtime dependencies, so adding a library is a conversation first.
Delivery settings (attempts, time limits, feedback timing, weighting) are not
part of a question. `CLAUDE.md` explains each of these and the bugs behind them.

## Where questions go

| Destination | Format | Notes |
| --- | --- | --- |
| Moodle | Moodle XML, GIFT as an option | Moodle's own formats keep more than QTI does |
| Brightspace | Question Library CSV (done, imported twice); Common Cartridge 1.3 package (built, in the form a Brightspace quiz tool writes, never imported); QTI 1.2 zip (built, tried twice, not accepted); QTI 2.1 zip (built, never imported); 3.x for Course Import (to do) | See below |
| Canvas | QTI 1.2 and QTI 2.1 packages (built, never imported) | The same file as Brightspace's. Classic and New Quizzes behave differently, and only Classic is described by the guide that was read |
| Blackboard | The Upload questions text file (built, never tried) | Works in Ultra and Original. Blackboard's pool package and its QTI import are not written |
| Any other LMS | QTI 1.2, 2.1 or 3.0 | The user picks the version |
| OpenStage Author and Scroll | The question spreadsheet (CSV) | See below |
| Paper | Word and PDF, student copy and answer key | Versions A and B from one seed |
| Paper, machine scored | Answer sheets and a key | See below |
| Web | A self-contained quiz as SCORM or cmi5, through OpenPublish | The one case where the key sits in the page |
| Publisher | Word in the publisher's template | For ancillary work |

Every export starts with a **destination check**: it lists what will not survive
(a question type the destination lacks, feedback it ignores, partial credit it
treats differently) and the fallback it will use. The exact behaviour of each LMS
is treated as unknown until a sandbox course has imported every question type,
and that compatibility matrix then drives the exporters.

### The OpenStage question spreadsheet

Author's "Quiz from a file" reads a CSV, and the user says Scroll reads the same
file (Scroll was not checked). It is a CSV, not `.xlsx`: Author's own
documentation says an Excel file is not read. Excel opens the CSV, so nothing is
lost by writing CSV.

- **Columns:** Type, Question, answers A to H, Correct, Points, Attempts,
  Feedback if right, Feedback if wrong. The games add Category and Value.
- **Types:** multiple choice (`MC`), multiple response (`MR`), true or false
  (`TF`) and short answer (`SA`). Matching, ordering and the rest cannot be
  written in a table, so the destination check lists them as left out.
- **Lost on the way:** feedback under each option, bold, pictures and links. It
  is plain text.
- **Limits:** 200 questions per file (a larger bank is split into several files;
  Author refuses a longer file whole) and eight answers per question.
- **Line breaks:** Author reads the Question cell as one line, so paragraph
  breaks in the wording become spaces. Feedback keeps its breaks.
- **Short answers:** Author takes at most ten accepted answers. Up to eight go in
  the answer columns; nine or ten go in the Correct column, separated by bars.
- **Multiple response:** Author always scores a share of the points (the right
  answers ticked, less the wrong ones), so a question with partial credit
  arrives as meant. One marked all or nothing is reported as a difference.
- **Attempts** is a delivery setting and not part of a question, so there is no
  Attempts column and Author applies its own default.
- **A picture or an equation** cannot be carried. It is written into the text as
  `[Picture: its alternative text]` or `[Equation: LaTeX]`, so the question still
  makes sense and the author can see where to put it back, and it is counted in
  the report. (Moodle XML is the exception for an equation: it is written as LaTeX
  between `\(` and `\)`, which Moodle shows as an equation when its MathJax filter
  is on, and the file says so. A printed Word file carries an equation as an
  equation, from the copy of Word's own XML the bank keeps.)

**Reading the same table in.** A list of questions kept in Excel is the other common way an instructor holds a bank, so
the same columns are read back (`src/import/spreadsheet.ts`), from `.xlsx` as well as CSV and Unicode text. Author's
documentation says an Excel file is not read, and asks for the table saved as CSV; this reads the workbook itself, with no
library (`table-xlsx.ts` is a zip and XML reader built on the pieces the Word reader already had), so a person need not save a
second copy first, and a CSV written for Author still works here. Differences from Author, each on purpose:

- A row with a mistake is **kept**, with the mistake said, where Author leaves it out. An empty Correct cell, a letter that
  names an empty answer, or a word that is not True or False leaves the question with no answer marked, and a message that
  names the cell. Author's dialog says "row 9 was left out", and the question is not seen again; here it is on the repair
  screen with its row beside it.
- A line break inside a cell is kept. A `Category` or `Topic` column becomes a tag, and an `Explanation` column general
  feedback. `Attempts` is a setting of the course, so it is not stored, and the file says it was not used. A `Value` column beside a
  `Category` column is the games' board value (100, 200, 300), also a setting of the game, and is said the same way as information;
  a Value column in any other table might mean anything, so it stays an unused column with the warning (the real OpenStage quiz
  board file, 9 questions, read this way on 7 November 2026).
- An essay (`ES`) can be listed. Matching, ordering and the rest still cannot be written in a table.
- Every sheet with a Question column is read, not only the first, hidden rows and sheets are read and counted, and a sheet
  that was not read is named. A cell that holds an error, or a formula that was never calculated, is read as empty and
  named: reading the error's text could put `#N/A` where a letter was expected.
- A table with no names in its first row is read in the template's order only if it begins the way the template does, with a
  type; any other layout is refused with a message. Author reads any such table in the template's order.

The blank table, and a sample with two mistakes in it on purpose, are files the app offers on its first screen, made by
`packages/app/tools/make-samples.ts`.

**A PDF is read from its text, and says what that costs.** A PDF holds text placed on pages. It carries no numbers,
letters, lists or styles, so what the Word reader does (rebuild a list from Word's own numbering, read a bold run as a mark) has
nothing to work on. What it does have is where each piece of text stands, and that is enough to put the lines and paragraphs
back (`src/import/pdf/`, no library: the file's objects and streams, the fonts' maps of their codes, the content of each page,
then lines, then paragraphs), and then the same scanner reads it as it reads a Word file or a text file. The importer's one
rule, that it never invents a key, is held by reading an answer only where it is written down: an asterisk, an `Answer:` line,
an Answers list. Nothing is read from a font, because a bold option can be bold for a reason that is not a key.

What was decided, and why:

- **A line of an Answer entry is believed only where its letter and its words agree.** The first real PDFs wrote
  `Answer: c.`, the words of the option, and a reason, and the scanner then took every single-letter word in the reason (the
  article "a") for an option letter. That was a defect of the scanner and not of PDFs, and it is fixed in it: an entry that is
  nothing but letters is a key; a longer one is read only if the letter and the option's words name the same option; if they
  name different ones it is an error that quotes both and no answer is marked; and prose is never mined for letters.
- **A page number and a running title are left out, and counted and quoted.** A line at the very top or bottom of a page is
  one if it is only a page number, or if the same line (numbers aside) is at the edge of another page. A line that begins like a
  question or an option is never one.
- **A word broken at the end of a line keeps its hyphen**, with no space, unless the document spells the word whole elsewhere
  and never hyphenated. A typesetter sets a break in a word and a hyphen that belongs to it the same way, so dropping hyphens
  would turn "self-concept" into one word. A broken word is shown broken ("writ-ten"), where it can be seen and mended.
- **A picture shows as `[Picture]` where it was drawn**, set apart from the text round it, and the file counts them. An
  equation or a figure that the PDF holds as a picture is not text and cannot be, and a question that depends on one is found
  by the marker.
- **A page set in columns is said to be**, because its lines are read across; it is not read in columns.
- **A PDF that is protected, or is a scan, is refused** with the reason and the way round (an unprotected copy, the original
  document, or text recognition done in a PDF program), and a text file called .pdf says it is not one. Reading a scan would
  need character recognition, which is a service or a model and so a dependency.
- **The file always says it was read from a page.** Every PDF import carries a warning that there is no numbering or formatting
  to read, that columns, tables, pictures and equations may have lost something, and that the answers most of all should be
  checked against the PDF.

What was measured. Five real banks, from one typesetting program, in the private fixtures folder
(`fixtures/publisher/pdf`, expected files written from the documents). The layout rules were written after looking at the first
page of four of them, so the first run was not blind to layout, and only the scanner can be reported as measured before and
after: with the scanner as it was, the five scored 50.6 percent (22.6 and 33.3 on two of them, 0 on one, 100 on two); with the
answer-line rule, the doubled full stop of a typed question number ("13..") and the heading "True and False", 77.7 percent, 100
on four of the five. The fifth begins with a lecture outline whose eight numbered items are read as eight essays, each flagged for
review, which a score by position counts as every question after them wrong; its 28 real questions are read right. Two answers in
one of the banks disagree with their own options in the document, and are declared failed in its expected file. All five come from
one producer, so none of this says how a PDF from Word, a desktop PDF program or Google Docs will read.

This is the first exporter, and it is built (`src/export/`, command `export`). It
needs no library. It was checked against Author's own reader, which accepted
every row it wrote, and the tests apply Author's documented rules so that they do
not depend on that project being on the same machine. It also proves the
destination-check mechanism that every later exporter uses: a report with one
entry per question, saying it arrived as written, arrived with something lost, or
was left out and why. A question with no usable key is left out, never exported
and never given a guessed one.

### Brightspace (D2L)

Brightspace imports questions into its Question Library from a CSV file, and from QTI. The CSV is built (`src/export/d2l-csv.ts`,
destination `d2l-csv`), because it is the route Brightspace documents most fully, takes seven types, and needs nothing but a
text file. QTI for Brightspace is not built; see the end of this section. What Brightspace's own article says, and what was
decided from it:

- **Rows, not columns.** The first cell of a row is a keyword and the rest hold its values: `NewQuestion,MC`, then
  `QuestionText`, `Points`, and the rows of the type (`Option,100,text`). Every row here is written three cells wide, as the
  article's examples are, so a row with nothing to say in its third cell ends in a comma.
- **Types it can import:** written response, short answer, matching, multiple choice, true or false, multiselect and ordering.
  **Types the CSV cannot import:** fill in the blanks, arithmetic, significant figures and multiple short answer. So a numeric
  question, a question with several blanks, a hot spot and a calculated question are left out, each with the reason. A
  fill in the blank with one blank is written as a short answer and says so, because the file cannot say where in the text the
  blank is.
- **A right answer is 100 for a multiple choice and 1 for a multiselect.** The article gives the two different values, which is
  the kind of thing that would pass a quick look and import wrongly, so a test of the file reads the article's rules
  separately from the exporter. A multiselect's partial credit is its `Scoring` row (`RightMinusWrong`, or `AllOrNothing`: until 7 November 2026 this wrote the
  article's display name `All or nothing`, and a faculty guide to the template and a thread of people who tried it say the importer
  reads `AllOrNothing`, `RightAnswers`, `RightMinusWrong` and `CorrectAnswersLimitedSelections`, and that a display name such as
  "Correct Selections" is not accepted and the question comes in with the default, which is all or nothing).
- **True or false has two rows,** `TRUE` and `FALSE`, one worth 100 and the other 0. A question with neither chosen is left
  out and never written as false.
- **An ordering's items are written in the right order,** with the text in the second cell. A matching question is `Choice,n`
  and `Match,n` rows; a spare answer belongs to no choice, so it is said to be lost.
- **HTML only where the article shows it:** the question text takes HTML when the third cell says `HTML`, and a stem with
  formatting is written that way. Options, items and feedback are plain text, with the loss said, because the article documents
  the flag only for the question text.
- **Left out of the file because the article does not document them:** difficulty, tags, `Answer Key`, `Initial Text`, images,
  per-answer feedback and the feedback for a right and a wrong answer. Points must be a whole number from 1 to 100; any other
  value is said to be lost and the question arrives with Brightspace's own default. A title is written only when someone wrote
  one; the title an untitled question is given is the start of its text, which Brightspace shows anyway.
- **No byte order mark,** CRLF line ends, and a first row that is a `//` comment with no comma in it, so that it is never
  quoted. The CSV cannot place questions in a section; the check says to move them afterwards.

**What has been checked, and what has not.** On 1 November 2026 a person imported one file this wrote into a real Brightspace
course (Question Library, Import, Upload a File, then a quiz built from it): 13 multiple choice, 10 true or false and 5 written
response questions arrived as 28 questions of those types, each worth 1 point, with their text, and the one true or false that
was opened in Brightspace's editor had the answer the source document gives (False). That was seen in a recording, so it says
nothing about the right answer on each multiple choice question, which the preview does not show. Multiselect, short answer,
matching, ordering, a question with formatting, accented letters and a multiselect's scoring were not in that file. A second file
with all seven types (a twelve question test bank, made the same day) was then imported and the person who did it said it worked
fine; no record was kept of each question, so the right answer on each, a multiselect's scoring and the formatting are still
unseen (`TESTING-TODO.md` lists what a person with a course should try). The tests read the file back through the CSV reader and hold every question of every fixture bank to
a second reading of the article, which shows the file follows the article and nothing about whether the article is complete.
Brightspace's own blank template file was not available to compare with.

**Course Import, still to do.** Brightspace's Quizzes tool imports QTI up to 1.2 only; Course Import (Import/Export/Copy Components)
takes a subset of QTI 2.x and 3.x, according to a D2L staff reply in April 2026. The QTI 1.2 package below is for the first of
the two. The second is not built, and the matrix of what each accepts is built from sandbox imports, as M2 says.

### Moodle XML in

`src/import/moodle-xml.ts`, profile `moodle-xml`, for a `.xml` file whose first element is `quiz` (told by what it holds, so a quiz saved
under another name is still found). It exists because an instructor whose questions are in Moodle, or whose publisher hands over Moodle
XML, should not have to retype them, and because reading the exporter's output back is the only way to hold the exporter to what it
writes. The file states its key, so the rule of the project is easy to keep: an answer is the right one only where its `fraction` is the
whole of the points (99.99 or more, since Moodle writes 33.33333 for a third). A single answer question where none is has no key and
says so; one where two are leaves both marked, as the file has them, and the question fails the key check; part credit on a single
answer and credit for a wrong answer in a short answer are said and never turned into a key. A multiple answer question is read as
partial credit unless every wrong answer takes everything away, in which case it is all or nothing, and weights that are not equal
shares are said not to be kept.

Read: multiple choice, multiple answer, true or false, short answer (with the case rule), matching (with spare answers), essay (the
information for graders is the model answer, which is where this program's own export writes it), and numerical (one number worth the
whole of the points, its tolerance as the most it may differ, one unit with the multiplier 1). Each keeps its points, its title, its
tags and category (the category line, without its context, is a tag, as GIFT does), the general feedback, the combined feedback for right
and wrong, the feedback on a single answer, and its pictures. A picture is a base64 file beside the text; it is kept when it is a PNG,
JPEG or GIF by its bytes (named for them, with the description the tag gave and a note on the question when there is none), and is
`[picture]` in the text, with the question flagged and the reason said, when it is linked from another site, is not in the file, or is
another format. LaTeX between `\(` and `\)` is left in the text as typed. Not read, and kept as text so that nothing is lost: a cloze,
the drag and drop kinds, select missing words, the calculated kinds, a plugin's ordering question, and anything else, each as an
essay that fails, with the reason. A description is an orphan. A numerical question with several right numbers or a right answer that
is not a number is kept as text too. Not kept, and said: partial credit feedback, the template of an essay, the other units, an
asterisk's meaning in a short answer.

Moodle puts its own sentences ("Your answer is correct." and two others) in the combined feedback of nearly every question when
nothing is typed. They are not authored feedback, and flagging a question for each would make a real export read as all needing a
look, so they are not kept and the file says how many there were. This is the one place English is assumed.

What has been checked: the sample in `fixtures/moodle-xml` has the shape of a real export (the comments, the boilerplate, the
category question, a picture) and was written from Moodle's documented format and memory of real files; no export from a real Moodle
has been read. This program's own exporter is read back: every question of every fixture bank that Moodle XML can hold comes back with
the same type, title, points, text, answers, key, pairs, accepted answers and feedback, and exporting that again gives the same file,
byte for byte. So do the real banks in `fixtures/publisher` (1,196 questions of the kinds it holds, which have pictures, accented
letters, quotation marks and tables of their own; 20 more are fill in the blanks, which come back as short answers and are not compared): none differed in type, points, text, answers, key or pairs, and none gained an error. A file cut at every length and one with characters changed is read or refused in a sentence and never throws. Six faults
planted one at a time (a guessed key, true and false swapped, the standard feedback kept, part credit read as an accepted answer, a
picture kept without looking at its bytes, the case rule inverted) were each caught.

### QTI in

`src/import/qti.ts`, profile `qti`, for a `.zip` or `.imscc` package (a Common Cartridge, which is a zip of the same kind and is what this
program's own Common Cartridge export and a Canvas course export are called; added 7 November 2026, with the fix that a cartridge's
`cc_weighting` is read as the points, since it fixes the score of a right answer at 100) or an `.xml` file whose first element is `questestinterop` (1.2), `assessmentItem`
or `assessmentTest` (2.1). It is the way to bring in a quiz that was exported from Canvas or Brightspace, or a test bank a publisher
hands over as a QTI package, and it lets this program's own two QTI exports be read back. A package's XML files are read apart from
the manifest; those that are items or a test are questions, the others (settings, course data) are counted and said, and one that is
not well formed is said with its name. A 2.1 test gives the order of its items and its title becomes a tag; items no test lists
follow, and a reference to an item that is not there is said. A 1.2 file is read item by item, with the assessment's title as a tag.

The key. In 1.2 the question's scoring states it: a choice is right where a condition that asks for that label alone sets SCORE to the
whole of the points (the decvar's maximum, 100 in Canvas's files and the points in this program's); a multiple answer's right labels are
those of a condition that asks for every right one and none of the wrong (`and` with `not`), or labels that each add a share (partial
credit); a short answer is the conditions that set the whole of the points, with their case rule; a matching question is a response for
each left side with the right side that scores. In 2.1 it is the declared correct response, or when there is only a mapping the entries
worth the most, and the response processing says only whether credit is shared (a `mapResponse` or the `map_response` template, with a
mapping, is partial credit; `match_correct` is all or nothing). What cannot be read stays unread and said: an answer worth part of the
points is not the key; a rule that sets points and that no shape reads is reported as not read; a left side scored for none or more than one
right side makes the question text, because the pair would be a guess; the correct order of an ordering question must be declared for
every item. Feedback in Canvas's identifiers (`general_fb`, `correct_fb`, `general_incorrect_fb`, `<answer>_fb`) is kept; feedback on a
condition in 2.1 (`modalFeedback`) is said and not placed.

Pictures are kept only from inside the package: an `img` is looked for beside the file, then in `web_resources` for the cartridge's file
base (`$IMS-CC-FILEBASE$/...`), and a path that climbs out of the package, a link and an inline `data:` address are not followed; the
rest is as for Moodle XML (`import/html-pictures.ts`, shared). MathML is not turned into LaTeX, so an equation stays as `[equation]` and
the question is flagged. A text box in the middle of a sentence is a fill in the blank with the blank where it stood; a text box alone is
a short answer. Kinds not read (a hotspot, a drag and drop, a calculated question, several drop downs, a numerical question) are kept as
essays with their words and fail.

A file in a package that ends in `.qti` is not read and is counted and said (a warning when nothing else was found, so a package that
holds only such files does not come in empty without a word). Canvas is said to name some of a course export's files this way, among
them its question banks and a second copy of each quiz; reading them could double the questions, and no real Canvas export has been
seen to say what they hold, so they wait for one.

What has been checked: this program's QTI 1.2, QTI 2.1 and Common Cartridge exports of every fixture bank are read back as what they were (type, title, points,
text, answers, key, pairs, accepted answers; a 1.2 package does not carry credit for part of a multiple answer, so that is left out of
the comparison), and the 2.1 package is read and exported again to the same files, byte for byte. The real banks in `fixtures/publisher` come back
the same way from both (1,196 questions each, none different in type, points, text, answers, key or pairs, none with a new error; the 20 fill in the blanks arrive as short answers and are not compared). Files in the shape Canvas writes and in
the shape of the standard's templates, written by hand from memory of those shapes, are read as expected; no real export from Canvas
has been read, and `TESTING-TODO.md` asks for one. One real Brightspace question library has (80 multiple choice questions, found on 7
November 2026): it read none until the reader was corrected on what it showed (`qti_metadatafield`, an answer's words inside a
`flow_mat`, a multiple choice question written with `rcardinality="Multiple"`, the points in `qmd_weighting`, no declared score scale,
`shuffle="no"` in lower case), and then reads 80 of 80 and agrees with a second, independent reading of its XML on every stem, answer, key
and point; the shapes it does not show (its true or false, multi-select, matching, ordering, short and long answer) are not read from memory
beyond the type names `Multiple Choice` and `True/False`, which are single answer. With no `decvar` the whole is 100, or 1 where 1 is the
biggest, and no smaller biggest is called the whole. A package cut at many lengths and one with bytes changed are read or refused
in a sentence and never throw. Seven faults planted one at a time (part credit counted as the key, the first answer guessed when none is
scored, the same in 2.1, partial credit always on, a path allowed to climb out of the package, a matching pair taken from the first of
several hits) were each caught.

### QTI 1.2 package (Brightspace and Canvas)

One package serves both (`src/export/qti12.ts`, destination `qti-1.2`). It is a zip of `imsmanifest.xml` (IMS content packaging
1.1.2, one resource of type `imsqti_xmlv1p2`) and `assessment.xml` (a questestinterop file: one assessment, one section, an item
for each question). The items take the shapes that IMS describes for QTI 1.2 and that Canvas writes itself. A multiple choice
question is one response_lid with a render_choice and a condition that sets SCORE for the right label. A multiple answer
question is the same with Multiple cardinality and a condition that is every right label and none of the wrong ones, so partial
credit is not carried. A short answer has one condition for each accepted answer, with the case rule. A matching question has
a response_lid for each left side offering every right side (a spare answer is a label no left side uses), and each right match
adds a share of the points, the last share being what is left so that they add up to the points exactly. An essay can score
nothing by itself and is marked by hand. Each item names its kind and its points in the qtimetadata Canvas reads
(`question_type`, `points_possible`) and sets SCORE to the same number of points, so a reader of the conditions alone and a
reader of the metadata alone agree. A fill in the blank with one blank arrives as a short answer. Ordering, numeric, hotspot
and calculated questions are left out, because neither tool documents them in a QTI file; the ordering note points to the
Brightspace CSV, which carries ordering. Feedback is not carried.

What the help pages and staff replies say: a D2L staff reply says the Quizzes tool takes a zip up to QTI 1.2 and reports "no
quizzes or sections can be found" when the structure is not what it reads. D2L's own course import table (Course import and
course conversion support) lists QTI 1.2.1 and IMS CP 1.1.2, 1.1.3 or 1.2 for the packages Import/Export/Copy Components reads,
and a published import guide gives the steps for a QTI zip there: Import Components, from a File, Advanced Options, tick Quizzes, and type the
exact name of the zip in the Import file to box. D2L's help article for the Question Library (updated August 2026) names a CSV
file, an existing collection and the Learning Object Repository, and does not name QTI. A staff post said a QTI zip imported
there lands in a folder named for the file; that is the one claim here the help does not back, and the first try below did
not bear it out. Canvas takes it under Import Course Content as a QTI .zip file, with an option to make a question bank. The Canvas guide that could be read is for Classic Quizzes and dated 2021, it names no QTI version, and
Canvas's own community document (which another source says gives QTI 1.2 and 2.1) was not found at its address, so the versions
rest on a secondary source. The example that a D2L staff member posted in the community thread turned out to be a Blackboard
question pool (`questions.dat`, `.bb-package-info`), not QTI, so there was no known-good Brightspace QTI file to compare with.

What has been checked: every package is held to a second reading of the structure, written apart from the exporter, and to a
small QTI 1.2 response processor that works out the score of every answer a student could give (every subset of a multiple
answer question, every assignment of a matching one). The right answer must score the points and nothing else may, for every
question of every fixture bank. That shows the package follows the standard and carries the key. It shows nothing about whether
Brightspace or Canvas accepts it, which only an import can. In Brightspace it has been tried twice and not accepted: the first
time it "just uploaded as a zip" (the screen was not said, and the note then pointed at the Question Library, which D2L's help
does not give for QTI), and the second time, by the Course Admin route that guide documents, it "still does not like the format"
(no message was recorded). Canvas has not been tried (`TESTING-TODO.md`).

### QTI 2.1 package (Canvas, and Brightspace's Course Import)

`src/export/qti21.ts`, destination `qti-2.1`, written as `<name> - QTI 2.1.zip`. QTI 2.1 is a different file from 1.2 and not a newer
spelling of it: the package is an `imsmanifest.xml`, an `assessmentTest.xml` that lists the questions and adds their scores up, and
a file of its own for each question (`q1.xml`, keeping the question's place in the bank, so a question left out leaves a gap). The
resource types are `imsqti_test_xmlv2p1` and `imsqti_item_xmlv2p1`, the test depends on every item, and the manifest's schema line
is `QTIv2.1 Package` 1.0.0, written from memory of IMS's own examples and not compared with a package an LMS wrote.

What a question is: the text is XHTML written into the file as markup (the 1.2 package holds it as escaped text), an answer is
declared once and scored by response processing in the standard's own operators, and the points are the number the processing
sets (and the top of `SCORE`). A multiple choice or true or false question is a `choiceInteraction` with one choice allowed, scored
by `match` of the response against the correct response. A multiple answer question is the same with any number of choices (QTI
compares a multiple response without regard to order); one with partial credit is a mapping instead, each right answer an equal share
of the points and each wrong one taking the same share away, never below nothing, which is how the bank itself scores it
(`sheets/score.ts`). A short answer or a fill in the blank with one blank is a `textEntryInteraction` scored by a mapping with an
entry for each accepted answer and the case rule on each entry. Matching is a `matchInteraction` scored by a mapping of an equal share
to each right pair (the last share is what is left, so every pair right is exactly the points), a left side takes one answer, and a
right side may take as many left sides as there are, so the shape of the question does not show. An essay is an
`extendedTextInteraction` with no processing, so it is marked by hand.

What it carries that the 1.2 package cannot: an answer that stays in place when the others are mixed (`fixed`, exactly, answer by
answer), a picture (a file in `images/`, named for what its bytes are, listed against the questions that use it, with its
description as `alt` and an empty one when the picture is decoration), an equation (the MathML the bank holds, when it is well
formed and is MathML; otherwise `[Equation: LaTeX]` as words, counted), and partial credit. What it cannot hold, and says: feedback,
a model answer, a rubric, the expected length of an essay, ordering, numeric, hotspot and calculated questions (left out with the
reason, as in the 1.2 package: neither tool documents them in a QTI file), and a fill in the blank with several blanks. Underline,
strike-through and a list's starting number are not in the markup QTI 2.1 allows in a question, so they are taken out, the words stay,
and the question says so. A question with no usable answer key is never written.

What the vendors say, from a search on 6 November 2026 (the Canvas guide and the campus pages, not a test): Canvas's guide says New
Quizzes imports QTI 1.2 and 2.x, and Classic Quizzes 1.2 and 2.1; no per-type list for 2.1 was found. Campus guides list QTI 2.1 as
"partial" for Brightspace's Import/Export/Copy Components, and a D2L community reply says Course Import reads a subset of 2.x and 3.x.
One vendor's page says the Quizzes tool's own import reads 1.2 only. None of this says which question types arrive.

What has been checked: every package is held to a second reading of the structure, written apart from the exporter
(`test/support/qti21-reader.ts`: the manifest and its dependencies, every file accounted for, the nesting and order of the parts of
an item, an interaction that agrees with its declaration, choices and pairs that exist, markup limited to XHTML the standard allows,
pictures that are in the zip and described), and to a small QTI 2.1 response processor that runs the item's own processing for every
answer a student could give (every subset of a multiple answer question, every way of matching three to five). The right answer must
score the points and nothing else may, for every question of every fixture bank. Six faults planted in the exporter one at a time
(a wrong answer adding where it should take away, the case rule ignored, a pair pointing at the wrong side, underline kept, `fixed`
dropped, the last share not the remainder) were each caught. That shows the package follows the standard and carries the key. It
shows nothing about whether Canvas or Brightspace accepts it, which only an import can (`TESTING-TODO.md`). The shares of the points
are written to five decimals, so two ways of getting the same part of a matching or partial-credit question right can differ by a
hundred-thousandth of a point.

### Common Cartridge 1.3 package (Brightspace)

`src/export/common-cartridge.ts`, destination `common-cartridge`, written as `<name> - Common Cartridge.imscc`. It exists because
the bare QTI zip was not accepted, and because D2L's own course import table names Common Cartridge 1.0 to 1.3, with QTI 1.2.1,
as a source its importer reads, and a bare QTI package is none of the sources it names. A maintained tool for building Brightspace
courses (Brightspacosaurus 0.35.0, whose source was read on 1 November 2026) writes quizzes this way and says to import them with
Course tools, Import/Export/Copy Components, Import Components, from a course package, Import All Components. This follows its
shape. The manifest is in the Common Cartridge 1.3 namespace with the schema `IMS Common Cartridge` 1.3.0 and a title, an
organization lists the quiz, and one resource of type `imsqti_xmlv1p2/imscc_xmlv1p3/assessment` points at
`quiz/qti-assessment.xml`. That file is QTI 1.2 in the Common Cartridge profile: the assessment has `cc_profile` `cc.exam.v0p1`,
`qmd_assessmenttype` Examination and `cc_maxattempts` unlimited (the format asks for a number, and attempts are the course's, so
the quiz is made with no limit and the check says so); each item has a `cc_profile` and a `cc_weighting` (its points); SCORE runs
0 to 100 and a right answer sets it to 100.

The profile holds multiple choice, multiple answer, true or false, fill in the blank and essay, so a short answer is written as a
fill in the blank, a fill in the blank with one blank keeps one answer box, and matching, ordering, numeric, hotspot and
calculated questions are left out, each with where it can go (the QTI zip carries matching, the Brightspace CSV carries matching
and ordering). Feedback and partial credit are not carried. What is known: the multiple choice, multiple answer and fill in the
blank shapes are what that tool writes, and it says its packages import. True or false and essay follow the profile's description
and were not seen in a package Brightspace took. The package is held to a second reading of all of this and to the response
processor, with the right answer scoring 100 and nothing else scoring, for every question of every fixture bank. It has not been
imported into Brightspace or Canvas.

### Blackboard, the Upload questions file

`src/export/blackboard-upload.ts`, destination `blackboard-upload`. Blackboard documents this file (the help page "Upload or
Import Questions", with a sample file): tab-delimited text, one question to a row, no header row and no blank line, the type in
the first field, and `correct`, `incorrect`, `true` and `false` in English. It is written for multiple choice (MC), multiple
answer (MA), true or false (TF), fill in the blank (FIB), matching (MAT), ordering (ORD) and essay (ESS). A short answer is
written as a fill in the blank, because that is the Blackboard question that checks a typed answer against a list, and
Blackboard's own short answer (SR) is marked by hand. A numeric question is left out: the file takes a tolerance and the page
does not say what it means. Points are one number typed at upload for every question, and the file has no feedback, formatting
or picture, so each is said against the question. A bank of more than 250 questions is written as several files, because
Blackboard recommends that size so the browser does not time out.

Blackboard's help lists ordering for the Original course view and does not list it among the eight types of the Ultra page, so
an ordering row says that Ultra may refuse it; the other rows still upload. Not stated by Blackboard and not tried: the
encoding (the file is UTF-8 with no byte order mark and CRLF line endings), whether a double quote at the start of a field
needs doubling (it is written as it is, as the sample file has it), and whether HTML is accepted (none is written). Two other
Blackboard routes are not built. Its own pool package is the `.dat` format of D2L's example; it is not documented and Ultra
reads only pools exported from Original. Its QTI import is Original only according to several university guides, and one
Blackboard page mentions QTI 2.1, so the sources disagree.

The upload file is read back too (`src/import/blackboard-upload.ts`, added on 7 November 2026 after the file this program writes came
back as "No questions were found" and 66 pieces of text no question used): the key is the word correct beside an answer, true or
false, the order of the items, and nothing else; a fill in the blank is a short answer since the file marks no blank; the rest is as
in `CLAUDE.md`. Everything it reads was written by this program's own exporter or by hand from Blackboard's page; no file written by
Blackboard has been read, and a file from a tool that writes more than this page documents (a quoted field, HTML, a points column)
is not read as that.

## Ideas taken from the wider discussion

The long discussion described a full assessment platform. Most of it is out of
scope, and the useful part is what extends a question workshop.

| Take | Later | Leave out |
| --- | --- | --- |
| A real list of objectives per bank, so the objective-by-Bloom grid shows objectives with no questions | Shared passages with several questions, once the LMS matrix shows who accepts them | Learner delivery, gradebooks, grading queues, role dashboards |
| A review prompt when an objective needs one kind of thinking and every item asks another | Item statistics (see below) | LTI, APIs and webhooks, self-hosting, audit trails, proctoring |
| Source, copyright and licence on each item, since publisher banks make this real | Calculated variables and hotspot | Branching scenarios, which is Author's job |
| AI provenance: model and source passage, kept as a draft until approved | Comparing a returned copy of a bank with the original | Hints, attempt rules and when answers are shown (delivery settings) |
| A published bank format and JSON Schema, so a user can always leave with everything | Translation links between items | Workplace observation, sign-offs, adaptive testing |
| Tests that record the exact question versions used, so editing a question never silently changes a test already given | Review and approval workflows | |

Item statistics means the difficulty of each question, whether strong students
got it right more often than weak ones, and which wrong options were chosen.
They come naturally from scored answer sheets (below), with the number of
students shown beside every figure so that a small class is not over-read.

## Answer sheets

A teacher builds a test, prints a matching bubble sheet, collects the completed
sheets as scans, and the program scores them. It is realistic as a later
milestone, after printing and versions exist, and not part of 1.0.

**What it covers.** Only questions a sheet can carry: multiple choice, multiple
response and true or false, with a handful of options each. The destination
check lists essays, short answers and the rest as left off. It never replaces
the accessible route, because some students cannot use a bubble sheet.

**Stages.**

1. Print the sheet and a key from an assembled test. Useful by itself for
   scoring by hand.
2. Score from images. The first-class input is a folder of JPG or PNG files, one
   per sheet, from a scanner or a phone. These can be read directly by the
   desktop app. PDF is second, and only where each page holds a single embedded
   image that the program can decode: a JPEG, which is what most scanner and
   phone-scan apps produce, or an uncompressed or Flate one. A PDF the program
   cannot read (fax compression, JBIG2, JPEG 2000, a page in strips or layers)
   says so and says what to do instead (save the pages as JPG, or change the
   scanner's setting). Nothing is guessed. Changed on 4 November 2026 from
   "a single embedded JPEG", when the buildable plan was written.
3. Straightening is part of reading from the start, because every sheet carries
   four corner marks, and phone photos taken at an angle or in poor light are
   tested against real photos. This is the main technical risk. Changed on
   4 November 2026 from a last stage.

The buildable plan, with its phases and gates, is `docs/paper-tests-spec.md`. Where it stands is
written there, under Build plan: the assembled test with versions, the printed sheet, the reader
that turns a picture of a sheet into a reading (with its accuracy gate), images and PDFs coming in
(a JPEG through the window), scoring with adjustments and item statistics, and the app's Answer
sheets area (assemble, print, check my printing, score, review, results) are built, as of
5 November 2026. What is open is real paper: real sheets, real scanners and phones, and the
thresholds tuned on them (`TESTING-TODO.md`).

**Never guess.** A blank answer, two marks, or a faint mark is flagged, with a
picture of that part of the sheet beside it, for the teacher to settle with a
keypress. The review screen is keyboard and screen-reader operable.

**Privacy.** No roster, no student IDs, no names, no OCR.

- Sheets are identified by their position in the file or folder, plus the
  version bubble. Scores are keyed by sheet number, version and answers.
- The scans stay where the teacher keeps them. The review screen shows them from
  there and does not copy them into any file OpenAssess writes.
- If students print their names, the review screen shows that area as a picture
  next to the score so the teacher can read it. Reading handwriting by software
  needs a recognition library, is unreliable, and would put names into the
  program's data. The exported scores leave the name column empty for the teacher
  to fill in their own spreadsheet.

**Evidence it can be built.** Open-source projects that read bubble sheets exist,
which suggests it is feasible. None has been evaluated here. Accuracy is measured
as the import is: sheets generated with known answers, then noise, tilt and blur
added, plus a small set of real scans, with every uncertain mark counted as
flagged, never as correct.

## Order of work

The nine-phase build plan is not in this repository. The code names phases 1, 2,
3 and 7, and the specification names four milestones. The order below is by what
depends on what, and the phase numbers should be reconciled with the original
plan.

**Done.** The question model, the bank file, the answer-key check, the read API,
the accuracy harness and the plain-text importer, which reads the generic
dialect plus Moodle, D2L and Blackboard additions (61 questions across 21
fixtures, 100 percent), the first exporter, the question spreadsheet for Author
and Scroll, with the destination check, and the Word importer as far as stage 4h
(`docs/word-import-plan.md`): a `.docx` whose question numbers and option letters are typed
(`1.`, `1)`, `Q1.`, `Question 1:`, `(1)`, `4.1`) or made by Word's own lists, whose questions
may be laid out in tables, in a publisher's layout, or with no numbers or letters, and whose
right answers are marked by an asterisk, an `Answer:` line, an Answers list, a key beside the
question or formatting, all read through the same scanner and gate. It reads 21 real files at
100 percent, which were fitted to; the honest numbers are the first contact with files it was
not fitted to, 3 percent on real files and 20 to 41 percent on sixteen generated ones, with
no question wrong and marked fine in any of them. After the stage 4h rules, run again on those
files and on a second set that may be fitted to, the generated ones read 75 to 80 percent, still
with no question wrong and marked fine; that is a second contact and says nothing about real banks.

`openassess review <file>` still writes one web page that shows
each question as the importer built it, with its answer, its checks and the lines of the file it came from, then the text
no question used and the warnings about the file. It has no script and no outside address, shows no answer the importer did
not find, and changes nothing.

**The app exists** (`packages/app`; decision 8). Opening it, in a native window or a browser, shows the banks in the
library folder and lets a person: make a bank or open one from a file; import a Word, Aiken, GIFT or text file and see
what was read beside the lines it came from, then repair it (write the missing key, turn an orphan into a question,
dismiss a warning, but never an error) before it is stored; browse a bank, search and filter it, edit, add, duplicate and
retire questions, with the key never filled in for anyone; bring in a question table from Excel or CSV, or a PDF read from its text, as well as a Word,
text, Aiken or GIFT file, or try one of four samples; export to the OpenStage spreadsheet, Moodle XML, GIFT, a Brightspace
question library file, a QTI 1.2 package (Brightspace and Canvas) or a Blackboard upload file with the destination check shown first; and print a student copy and an answer key as Word and PDF. Cheap formats (Aiken and
GIFT in, Moodle XML and GIFT out) and printing, items 3 and 4 below, are done. The window is built and starts, shows the
home screen and stops its server when it is closed; the installer is unsigned.

**Next, in this order.**

1. **The question spreadsheet exporter** and the destination-check mechanism.
   The first complete loop from file in to file out. Done on 27 October 2026.
2. **The Word import engine** (phase 2; the plan is `docs/word-import-plan.md`).
   This is the feature that earns users,
   so it gets the most engineering. The usual guidance for the format asks
   authors to strip headers, lists, tabs, indents and all bold and italic,
   because a plain-text reader cannot see Word's structure. Word's automatic numbering is not in the text at all, so the
   engine has to rebuild question numbers and option letters from Word's list
   definitions, and keep the formatting. Exit: a real publisher chapter imports
   at 95 percent or better, with every other question listed and linked to its
   source text.
3. **Cheap formats:** Aiken and GIFT in, Moodle XML and GIFT out. Done. Moodle XML in was added on 6 November 2026 (below).
4. **Printing:** Word and PDF with a student copy and a key. Done.
5. **The desktop app** (phase 3): bank browser, editor, import preview and repair,
   export wizard. Done as described above, except that the 95 percent exit on three real
   chapters of item 2 is still not met.

**Milestones, as in the specification.**

- **M1, import and print.** Items 1 to 5 above.
- **M2, LMS exports.** QTI 1.2, 2.1 and 3.0, the per-LMS compatibility matrix
  built by importing every type into a sandbox course on each LMS, destination
  checks, and round-trip tests. The Brightspace question library CSV is done
  and imported twice into a real course: once seen for three of its seven types, and once with all seven, reported to have
  worked fine without a record of each question. A QTI 1.2 package (Brightspace and Canvas) and a
  Blackboard upload file are built and tested against the standard and the help pages, and have not been imported anywhere;
  a QTI 2.1 package is built the same way and has not been imported anywhere (below); QTI 3.0, and the 3.x subset of Brightspace's Course Import, are not started.
- **M3, banks and tests.** Folders, tags, duplicates, the objective coverage grid,
  pools, blueprints, versions, the item quality and accessibility checks (phase
  7), and the web quiz. Done so far: versions (the test record), copies, and a first set of
  item quality and accessibility notes (Check quality, below), and the coverage grid and narrowing a list by chapter, objective,
  tag, Bloom level and so on (`bank/coverage.ts`, `assess coverage`, and the Coverage button; it counts what is there, puts a
  question with nothing set under "(none)" so the gaps show, and leaves retired questions out), and Pick for me on the Make a
  test screen (`bank/pick.ts`: some questions with a value, at random, never a retired one, one already chosen, one with no usable
  key or a copy of one in the test, and it says what it left out and why; it is a helper for building a test chapter by chapter;
  a stored recipe is a blueprint, below), and folders in the app (`bank/store.ts`: make, rename, move and take away a folder, file a question in one, narrow the list to one; a folder never holds a question, so taking one away leaves its questions in the bank in no folder, and the folders inside it move up). an import can be saved into a folder by name. Several questions are filed at once (`Bank.moveManyToFolder`, the control beside the list: the questions shown, all or nothing). Blueprints are done in their first form (`bank/blueprint.ts`, the Blueprints panel above Make a test, `assess blueprint`): a stored recipe
  in `blueprints/`, each rule a value on one axis, up to four more on other axes that a question must have as well (added 7 November
  2026: "chapter 2 and the Apply level" is one cell of the grid a test is planned on, and is the common case of a test plan), and
  how many to take, drawn rule by rule through the same pick, so it takes a
  question that fits two rules once, never fills a rule up from another value when the bank is short (it says how many short and why),
  holds no question id and no seed, and is kept byte for byte when its file cannot be read. A set of values no question could meet (two
  chapters, a tag and no tag) is refused with the reason, since a rule that can take nothing would read as a short bank. A limit
  ("at most 2 hard") and a blueprint that draws when a student takes the test are not built. Not done: pools in that sense, the web quiz, and from the original list of checks
  the reading level, which would need a reading-level formula that is not misleading on technical
  words, and an equation that is a picture, which the import already reports.

**Pictures.** A Word file's pictures are read, kept and used: `import/docx/pictures.ts` keeps a PNG, JPEG or GIF that can be shown
exactly as the author placed it (named by a hash of its bytes, with Word's description of it) and refuses, with the reason, one that
cannot (cropped, rotated, flipped, drawn on, grouped, linked, in a text box or in another format). The bank writes a picture only
for a question that is saved and says on the bank screen when a question names one it does not hold; the editor shows each picture,
writes its description or marks it as decoration, and writes it in the text as `[picture 2]`. A printed test draws pictures (the
Word file embeds them, the PDF draws a PNG or a JPEG and prints the rest as words with the reason), and Moodle XML carries the picture in
a question's text. A picture is added, replaced or removed by hand in the editor (`model/picture-edit.ts`: a PNG, JPEG or GIF chosen from
the computer, told by its bytes, put at the end of the text, with no description and a note that it has none; one an import refused, such
as a cropped one, is put back this way), and Word's own "mark as decorative" is read. Not done: a picture in the text format
(`[ img: ... ]` names a file nothing supplies), pictures in the other exports (none has a place for the file but Moodle's; QTI and
Common Cartridge could carry them and have not been accepted by Brightspace at all), a turned picture shown the right way up, and a
GIF or CMYK JPEG in a PDF.

**Check quality** (phase 7, first set; `quality/items.ts`, `quality/bank.ts`, `assess check`, and the Check quality
button on a bank). Every result is a note (severity `info`) and never a warning or an error, because those two are what
the import gate counts and what an export holds back, and advice about writing must not move either. The checks speak
only when sure: a rule that depends on which option is right is skipped for a question with no usable key; the a/an rule is
silent when any option starts with a letter that does not settle the sound (an hour, a university, a one); the negative
stem rule leaves "at least", "whether or not", "not only" and "least common multiple" alone, and (after 1421 real questions gave 79
notes, a third of them wrong) a word in the story before the question, in a quotation, in a why question and in a condition ("if you
do not understand, you should"; "when the object is not near the focus"), where the question itself is positive: 79 became 49, and
what is left is mostly "which of the following is not". An independent reader then showed where that had gone too quiet, and each
is noted again: a when, where or while that opens the question ("When should a nurse not administer this drug?"; a comma that closes
it, or a sentence that is not a question, keeps it a condition), an instruction after a sentence ("Select the statement that is not
true. Choose one answer."), and an inch mark (a straight quote is a quotation mark only where it opens and closes a group of words).
Two options are copies when they differ only in spacing, the stop at the end,
or the capital that starts an option of four letters or more; a capital inside is left alone (PV = nRT against PV = NRt, a calorie
and a Calorie, Mb and MB), because real questions had those and the rule called them copies and advised changing one. On the same
1421 questions 3 notes became 1, which is a real repeated option. They run when a question is
saved into a bank and when the whole bank is checked, and not at import. The notes are written to the questions without
changing a version, a history or a status (looking is not editing), and a dismissal survives. What looks across questions
is worked out each time and not stored: the same question twice or nearly (0.85 of the words, with the same numbers, and not when
both the stem and the right answer differ, which is how a bank of parallel questions reads: measured on 549 real multiple choice
questions, 22 groups became 2; all 22 were parallel questions, and the 2 left agree on their right answer; stems are compared without
their small words, "one", "of", "in" and the like, so that a near-copy with a word dropped and its answer reworded is still said), and
a letter that holds more of the right answers than chance would (a binomial test, divided by the number of letters tried,
at 20 answers or more), for the questions that keep their option order and for each version of an assembled test. The
lines are judgements, kept in named constants: the right answer is noted when it is 1.5 times as long as the longest wrong
one and 20 characters longer; a matching list is long above 8 pairs. A short answer or fill in the blank whose accepted answer has a curly quote, a dash or an
ellipsis in it is noted, with the plain form to add, since a keyboard makes the plain form and a learning system compares letters;
it is silent when the plain form is accepted too, and the author's answer is never rewritten. What is not covered: a question with a picture is not
compared for copies (the pictures are not read here), and `MissingAltText` stays an import warning, since the app cannot
edit a description yet.
- **M4, assistance.** AI drafting and import rescue, the MCP server, and publisher Word templates. QTI import from
  LMS exports (1.2 and 2.1, and Moodle XML) was built on 7 November 2026 (above) and has not read a real export.
- **M5, answer sheets.** Stages 1 to 3 above, and item statistics from scans.

No dates are set.

## Open questions

- Which LMS sandboxes can be had? A Brightspace course is the first, a second
  is still to be found, and Moodle runs locally for free.
- Which publisher test banks can be used as fixtures without rights problems?
  The author's own ancillary banks are the safest start.
- Does reading PDF scans justify a library (a PDF reader), given the rule of no
  runtime dependencies? Decide when answer-sheet scoring starts, and only if
  reading single-JPEG pages proves too narrow.
- How do PDFs from other programs read (Word, a desktop PDF program, Google Docs, a publisher's own tools)? Only one typesetting program's have
  been measured.
- iPhone photos are HEIC by default. Reading them would need a decoder; the
  alternative is asking the teacher to save as JPG.
- How do the nine original phases map onto the milestones above?
- Does Scroll read exactly the same CSV as Author? Check before promising it.
