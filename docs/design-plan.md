# OpenAssess design plan

Written on 27 October 2026, after reading the product specification (25
October), the test-bank vendor's guides, a long discussion with two AI assistants
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
   only where it must be, to say what the program can read ("reads the
   standard test-bank text format"), with the non-affiliation notice in `NOTICE`.
6. **The Standard Format is four dialects.** The generic, Canvas, Moodle, D2L and
   Blackboard guides differ in small, real ways, recorded in the findings. The
   importer reads the generic one and the common additions, and refuses the types
   it cannot yet read by name.
7. **AI is optional, reviewed and recorded.** It helps with the slow parts of
   writing items and never decides what goes on a test. Anything it drafts stays
   marked as a draft until a person approves it, and the model and source
   passage are recorded. Nothing requires it.

## The rules that do not change

Never guess an answer key. Nothing is dropped silently. Checks warn and do not
block. No runtime dependencies, so adding a library is a conversation first.
Delivery settings (attempts, time limits, feedback timing, weighting) are not
part of a question. `CLAUDE.md` explains each of these and the bugs behind them.

## Where questions go

| Destination | Format | Notes |
| --- | --- | --- |
| Moodle | Moodle XML, GIFT as an option | Moodle's own formats keep more than QTI does |
| Canvas, Brightspace, Blackboard | QTI package, tested per LMS | Classic and New Quizzes behave differently |
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
  the report.

This is the first exporter, and it is built (`src/export/`, command `export`). It
needs no library. It was checked against Author's own reader, which accepted
every row it wrote, and the tests apply Author's documented rules so that they do
not depend on that project being on the same machine. It also proves the
destination-check mechanism that every later exporter uses: a report with one
entry per question, saying it arrived as written, arrived with something lost, or
was left out and why. A question with no usable key is left out, never exported
and never given a guessed one.

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
   JPEG, which is what most scanner and phone-scan apps produce. A PDF the
   program cannot read says so and says what to do instead (save the pages as
   JPG). Nothing is guessed.
3. Phone photos taken at an angle or in poor light get a straightening step,
   tested against real photos. This is the main technical risk.

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

A first look at the preview and repair screen exists as a page. `openassess review <file>` writes one web page that shows
each question as the importer built it, with its answer, its checks and the lines of the file it came from, then the text
no question used and the warnings about the file. It has no script and no outside address, shows no answer the importer did
not find, and changes nothing. It cannot repair anything and is not the desktop app; it is the first version of what the
app's preview screen will show, built from the same result that screen will read.

**Next, in this order.**

1. **The question spreadsheet exporter** and the destination-check mechanism.
   The first complete loop from file in to file out. Done on 27 October 2026.
2. **The Word import engine** (phase 2; the plan is `docs/word-import-plan.md`).
   This is the feature that earns users,
   so it gets the most engineering. the test-bank vendor asks authors to strip headers,
   lists, tabs, indents and all bold and italic, because it cannot read Word's
   structure. Word's automatic numbering is not in the text at all, so the
   engine has to rebuild question numbers and option letters from Word's list
   definitions, and keep the formatting. Exit: a real publisher chapter imports
   at 95 percent or better, with every other question listed and linked to its
   source text.
3. **Cheap formats:** Aiken and GIFT in, Moodle XML and GIFT out.
4. **Printing:** Word and PDF with a student copy and a key.
5. **The desktop app** (phase 3): bank browser, editor, import preview and repair,
   export wizard.

**Milestones, as in the specification.**

- **M1, import and print.** Items 1 to 5 above.
- **M2, LMS exports.** QTI 1.2, 2.1 and 3.0, the per-LMS compatibility matrix
  built by importing every type into a sandbox course on each LMS, destination
  checks, and round-trip tests.
- **M3, banks and tests.** Folders, tags, duplicates, the objective coverage grid,
  pools, blueprints, versions, the item quality and accessibility checks (phase
  7), and the web quiz.
- **M4, assistance.** AI drafting and import rescue, the MCP server, QTI import
  from LMS exports, and publisher Word templates.
- **M5, answer sheets.** Stages 1 to 3 above, and item statistics from scans.

No dates are set.

## Open questions

- Which LMS sandboxes can be had? SUNY New Paltz is the first, Excelsior a
  second, and Moodle runs locally for free.
- Which publisher test banks can be used as fixtures without rights problems?
  The author's own ancillary banks are the safest start.
- Does reading PDF scans justify a library (a PDF reader), given the rule of no
  runtime dependencies? Decide when answer-sheet scoring starts, and only if
  reading single-JPEG pages proves too narrow.
- iPhone photos are HEIC by default. Reading them would need a decoder; the
  alternative is asking the teacher to save as JPG.
- How do the nine original phases map onto the milestones above?
- Does Scroll read exactly the same CSV as Author? Check before promising it.
