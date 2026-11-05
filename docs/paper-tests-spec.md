# OpenAssess Paper Tests Specification

Nov 4, 2026, Jason Wrench

OpenAssess will print a paper test, a matching answer sheet and a key, then score the completed sheets from scans or photos, with no scanner hardware, no purchased forms and no student records kept. This spec turns milestone M5 of `docs/design-plan.md` (Answer sheets) into a buildable plan. Where the two differ, the design plan's rules win unless this document says it is proposing a change.

## Purpose and scope

Many departments still pay per form and per machine for bubble-sheet scoring, or have lost the machine altogether. An instructor who already keeps questions in OpenAssess should be able to give a paper test on any printer and score it on any scanner or phone.

In the product the feature is called "answer sheets", never by a vendor's brand name (design plan, decision 5).

Version 1 covers:

- Multiple choice, multiple response and true or false questions, the types a bubble can carry.
- Up to four versions of one test, with questions and options reordered.
- A printed student booklet per version, an answer sheet, and an answer key per version.
- Scoring from a folder of JPG or PNG images, and from PDFs whose pages each hold one embedded image.
- A review screen for every mark the reader is unsure of.
- Scores and item statistics out to a spreadsheet, and aggregate statistics back into the bank.

Out of scope for version 1: essay, short answer, matching, ordering, numeric and calculated questions on the sheet (the destination check lists them as left off); handwriting recognition; a student roster; live camera scanning; and sheets printed by other programs.

## Goals, non-goals and success criteria

The one rule that matters most is the import rule carried over to paper: a mark the reader is not sure of is flagged, never guessed. A wrong score that looks read is worse than a flag, because a flag gets looked at.

Goals:

- Any office printer and photocopier makes usable sheets: one master, photocopied for the class.
- Any flatbed or feeder scanner, and a phone held roughly square to the page, gives readable images.
- An instructor with no technical background goes from test to scores in one sitting.
- The rules of the repository hold: no runtime dependencies, nothing dropped silently, no student records kept.

Non-goals: a gradebook, a roster, sending scores to an LMS directly, reading handwriting, and grading anything but bubbles.

Success criteria, measured by the harness in Testing and validation:

| Measure | Target | Corpus |
| --- | --- | --- |
| Answers read wrong and not flagged | 0 | Every corpus, every run |
| Answers flagged on feeder or flatbed scans | 1 in 100 or fewer | Real scans at 200 dpi or more |
| Answers flagged on phone photos | 5 in 100 or fewer | Real photos, page filling most of the frame |
| Sheets refused as unreadable | 1 in 50 or fewer | Real scans |
| Time to read one sheet | under 1 second | 100-question sheet, ordinary laptop |
| Time for a class | under 3 minutes | 150 sheets from one PDF |

The first row is a gate, like the 95 percent import gate: a release that misses it does not ship. The others are targets to report against.

## Instructor workflow

The instructor works in one new area of the app, Answer sheets, and never types an answer key: it comes from the bank.

1. Assemble the test. Pick questions from a bank. The destination check lists any question a sheet cannot carry. Choose one to four versions. OpenAssess freezes a copy of every question as used, so editing the bank later never changes a test already given.
2. Print. One PDF holds the answer sheet master. Each version gets a student booklet (Word or PDF) and an answer key. The instructor photocopies the sheet master for the class.
3. Give the test. Students fill in the version bubble and their answers, and print their name in the name box if the instructor wants it.
4. Scan. Any scanner or copier makes a PDF or a folder of images. Phone photos work too. Sheets can go in any order.
5. Score. Open Answer sheets, pick the test, and choose the files. Every sheet is read, and anything uncertain goes to the review queue.
6. Review. Settle each flagged mark from a picture of that part of the sheet, by keypress. Nothing is scored until the queue is empty or the instructor chooses to score what is settled.
7. Adjust. Drop a question, accept a second answer, or give everyone credit. Scores update with no rescan.
8. Export. A spreadsheet of scores by sheet number goes to the instructor's own gradebook. Item statistics go back to the bank.

A student who cannot use a bubble sheet answers on the booklet or another accessible format, and the instructor keys those answers in on the same screen (manual entry), so every student is scored by the same key.

## Answer sheet design

One sheet master serves the whole class: every photocopy is identical, the student marks the version, and four corner marks plus a printed code strip tell the reader where everything is. The printer and the reader share one geometry file, so the two cannot disagree about where a bubble sits.

[Figure not included in this copy: the answer sheet mock-up, US Letter, standard layout.]

The mock-up is drawn to scale for US Letter; the filled bubbles in the first column and version B show what a completed sheet looks like.

Page and registration:

- US Letter and A4, each with its own geometry; the code strip says which.
- Four solid corner squares, 8 mm, inset 12 mm from the paper edge so printers, copiers and scanners do not crop them. The top-left square has a white centre, which tells the reader which way up the page is.
- Nothing the reader needs sits within 10 mm of the edge.
- The sheet is printed only as a PDF, at 100 percent. Word cannot promise where a shape lands on the page, so it is not offered for sheets.

The code strip is a row of 48 black or white squares, 3 mm each, between the top corner marks. It is OpenAssess's own code rather than a QR code, because a fixed row of squares at a known place is simple to print and read with no library. It holds:

| Field | Bits | Purpose |
| --- | --- | --- |
| Start | 1 | Always black, so a strip read backwards is caught |
| Layout revision | 4 | Lets old sheets stay readable after the layout changes |
| Paper | 2 | Letter, A4, large print Letter, large print A4 |
| Test | 20 | Short fingerprint of the test record, so a sheet from another test is refused |
| Page and page count | 6 | A test longer than one page has numbered sheet pages |
| Version | 3 | 0 on the shared sheet; 1 to 4 when version-specific sheets are printed |
| Check | 12 | A CRC, so a damaged strip fails rather than reading as another test |

The header holds the test title, short instructions with a correctly filled bubble and three wrong ones (a tick, an X, a half fill), a name box, and the version bubbles A to D. The name box is never read by software; its picture is shown at review (see Privacy). The version bubbles are left off a test with one version.

The answer grid:

- Questions run down columns of 25, numbered as the student's booklet numbers them.
- The standard sheet has bubbles A to E and holds 100 questions on one page. A test with any question of six to eight options uses the wide sheet, A to H, 50 questions a page. A longer test takes a second page.
- Bubbles are 5 mm circles with a thin black outline, 6.5 mm apart across and 6 mm down, with the letter printed small and light grey inside.
- A true or false question prints T and F in the first two places.
- Multiple response uses the same bubbles; the booklet says to mark all that apply.

A large print sheet uses 7 mm bubbles, 14 point type and 50 questions a page, for students who need it.

Before a class set is copied, Check my printing reads a scan of one blank photocopy and confirms the corner marks and code strip read, no blank bubble reads as filled, and the page was not shrunk to fit (the scale is within 2 percent).

## Booklets, keys and versions

Every version is generated from one test record, so the instructor never builds a version or types a key by hand. The existing print module (`print/layout.ts`) already makes a student copy and a key in Word and PDF; this extends it rather than starting again.

The test record holds, for each version, the order of the questions and, for each question, the order of its options. Scoring maps a student's letter back through that order to the bank's own option, so statistics from all versions add up per question and per option.

Rules for reordering:

- Versions come from one seed stored in the record, so reprinting gives the same versions.
- Questions can be shuffled within sections the instructor sets, or kept in bank order.
- Options are shuffled unless the question is marked to keep its order. An option such as "All of the above" or "Both A and B" depends on its place, so a question with one is kept in order and the check says why.
- True or false is never reordered.
- A question with no usable key is printed but not scored, and the key says in bold that no answer is recorded, as printing does today.

What prints:

- Student booklet per version: "Version B" at the top of every page, questions numbered from 1, and a line telling the student to fill in bubble B and mark answers on the sheet.
- Answer key per version: the right letter beside every number, and a one-line strip in sheet order for scoring by hand.
- One sheet master (or version-specific sheets if the instructor prefers sheets that need no version bubble).

## Recognition pipeline

The reader turns each page image into marks with a measured darkness, then applies fixed rules; a page it cannot trust is refused with the reason, and a mark it cannot call is flagged. The thresholds below are starting values that the harness will tune.

1. Bring the image in. The app's page decodes JPG and PNG with the window's own image decoder (no library), applies the photo's rotation flag, reduces it to grey at no more than 3300 pixels on the long side, and hands the pixels to the local server. A PDF is opened by the engine's existing PDF reader. A page that holds one JPEG has its image passed to the page to decode; a page that holds one uncompressed or Flate image is decoded in the engine with Node's own zlib. The page's own rotation, the place and turn at which the image is drawn on it, and an inverted decode setting (common in black and white scans) are honoured, so a sideways or upside-down scan reads the same as an upright one. Any other page (black and white fax compression, JBIG2, JPEG 2000, a page made of several image strips or layers, a page drawn as vectors) is refused, naming the setting to change on the scanner. An iPhone HEIC photo and a TIFF file are refused the same way, naming the camera or scanner setting that saves JPG or PDF.
2. Find the corner marks. Dark, solid, square blobs of the expected size are scored for squareness and fill, and the four that make the right shaped quadrilateral are kept. Fewer than four is a refusal: "a corner of the page is hidden or cut off".
3. Straighten. A perspective transform maps the four corners to the sheet's geometry. The hollow corner says which way up the page is, so an upside-down scan is fine.
4. Read the code strip. The 48 squares are sampled and the check bits must agree. A sheet from another test, or a strip that fails its check, is refused with that reason.
5. Check quality. The corner marks' spacing must match the geometry within 3 percent (a page shrunk by the copier fails here), their edges must be sharp enough, and the whole grid must be inside the image. A failure names the cause: too small in the frame, blurred, cut off, or printed at the wrong size.
6. Measure each bubble. Copiers shift and stretch slightly, so each bubble is re-centred within 1 mm by matching its printed outline. Darkness is the mean ink inside the inner 70 percent of the circle. Each sheet calibrates itself: most bubbles on a sheet are blank, so the median is the blank level and the darkest group is the ink level, and each bubble gets a fill score from 0 (blank) to 1 (solid).
7. Decide each question.

| Situation | Fill scores | Result |
| --- | --- | --- |
| One bubble filled | one at 0.60 or more, the rest at 0.25 or less | Answer recorded |
| Nothing marked | all at 0.25 or less | Blank, flagged for a quick confirm |
| Faint or erased | any between 0.25 and 0.60 | Flagged |
| Two or more filled, single-answer question | two or more at 0.60 or more | Flagged |
| Multiple response | each bubble at 0.60 or more or 0.25 or less | The set of filled bubbles recorded |
| Version bubble not exactly one | any other pattern | Sheet flagged; not scored until settled |

8. Record the reading. Each sheet becomes a reading: its source file and page, an image fingerprint, its position in the batch (the sheet number), its version, every bubble's fill score, and every flag with the rectangle of the sheet to show. Scoring is a separate step that runs on readings, so a key change never needs a rescan.

Batch checks run after every sheet is read: the same image twice is flagged as a duplicate, and on a two-page test each page 1 must be followed by its page 2.

## Review and correction

Every flag is settled by a person looking at the paper itself, one keypress at a time, and every decision is kept beside what the reader saw. The screen is fully keyboard and screen-reader operable, as the design plan requires.

The queue groups flags so the fast ones go first:

1. Refused pages, with the reason and the image. The instructor can rescan, skip, or key the sheet in by hand.
2. Sheet-level flags: version bubble unclear, duplicate image, page out of order.
3. Blank answers, shown as a grid of row pictures that can all be confirmed with one key.
4. Faint, erased or multiple marks, one at a time: a crop of the question's row, enlarged, with each bubble's fill score beside it.

Keys: a letter records that answer, the space bar confirms the reader's reading, 0 records blank, and the arrow keys move. A decision can be undone until the batch is saved.

Adjusting the scoring never touches the readings. After review the instructor can, per question and per version where it matters:

- Drop the question from the total.
- Accept another option as right as well.
- Give everyone credit.
- Change its points.

Each adjustment shows how many sheets it changes before it is applied, is reversible, and is listed in the exported results so the scores can be explained later.

## Scoring, item statistics and export

Scores are worked out from the readings and the test record every time they are shown, so they always reflect the current key and adjustments.

Scoring rules:

- Multiple choice and true or false: full points for the right option, nothing otherwise. A blank scores nothing.
- Multiple response: all or nothing by default; right minus wrong (never below zero) when the question is set to give partial credit.
- Points come from each question's points (1 when none is set). The total and the percentage are shown for every sheet.
- A question with no usable key is printed and read but never scored, and the results say so.

Item statistics, computed across all versions per bank question:

| Statistic | What it tells the instructor |
| --- | --- |
| Difficulty (proportion right) | How hard the question was for this group |
| Discrimination (point-biserial, and the top 27 percent against the bottom 27 percent) | Whether stronger students got it right more often |
| Option counts | Which wrong options drew students, and which drew none |
| Blanks | How many skipped it |
| KR-20 for the whole test | How consistent the test was as a measure |

The number of sheets is printed beside every figure, and a group under 30 carries a note that the figures are unstable, so a small class is not over-read.

What goes where:

- The scores file is a spreadsheet (`.xlsx` and `.csv`): sheet number, version, an empty Name column for the instructor to fill, each answer, score, percentage, and a second sheet with the adjustments and the item statistics.
- The bank gets aggregate statistics only: for each question, the test name, date, number of sheets, difficulty, discrimination and option counts. No individual response is written into a bank, because banks are shared as files.
- A printable item analysis report, one question per block, showing the question as printed and its figures.

## Architecture and data model

All recognition and scoring lives in the engine as plain TypeScript with no dependencies, working on arrays of grey pixels; the app's only new job is decoding images, which the window already knows how to do. That keeps the reader testable in Node with the rest of the suite, and keeps the no-dependency rule intact.

[Figure not included in this copy: where each part lives, in the page, the server and the engine, with the three files.]

The page sends grey pixels to the server, the engine's reader turns them into a reading, and the review screen shows crops from the image the page already holds. Only the scores file and the bank are written; the scans are never copied.

Engine, a new folder `packages/assess/src/sheets/`:

| File | Job |
| --- | --- |
| `geometry.ts` | Every position on every sheet layout, in millimetres; the one source both printer and reader use |
| `code.ts` | Writes and reads the 48-square code strip and its check bits |
| `print.ts` | Draws the sheet as a PDF with the existing PDF writer in `print/pdf.ts` |
| `raster.ts` | Draws the same sheet as pixels, with simulated pencil marks, for the test harness |
| `image.ts` | The grey image type; a PNG reader using Node's zlib; pulling the single image out of a scanned PDF page |
| `locate.ts` | Corner marks, orientation and the perspective transform |
| `measure.ts` | Re-centring and the fill score of each bubble |
| `decide.ts` | The rules table above, giving a reading with its flags |
| `score.ts` | Readings plus the test record plus adjustments give scores |
| `stats.ts` | Item statistics |

New model pieces:

- A test record (`model/test.ts`): its name, a frozen copy of each question as printed, the seed, the order of questions and options for each version, the sheet layout, and the 20-bit fingerprint. It is stored inside the bank's `.openassess` file, under `tests/`. This is the "tests that record the exact question versions used" item from M3.
- A scores file (`<test> - Scores <date>.openassess-scores`, a zip of JSON like the bank): the readings, every review decision and every adjustment. It is kept in `Documents/OpenAssess/Scores`, apart from the bank.

App, `packages/app`: an Answer sheets area with screens for Assemble, Print, Score, Review and Results. The page decodes each image with `createImageBitmap` and a canvas, sends grey pixels to the server, and shows crops from the image it already holds. New server routes follow every rule in `server.ts`: the key cookie, the change header, a size limit of 16 MB per page, and names checked before they touch a path.

Command line: `assess sheets print`, `assess sheets read`, `assess sheets score`, and `assess sheets gate` for the harness, mirroring the existing `print`, `review` and `score` commands.

## Third-party code and licensing

No outside code is copied into OpenAssess for this feature; two MIT-licensed projects supply ideas, and the GPL projects were read for their published descriptions only. If any MIT code is ever ported, its copyright notice goes into `NOTICE`, which MIT requires and Apache 2.0 allows.

Where this list came from: the projects below, and the proposals to use a QR code, jsQR, OpenCV.js, pdf.js and an optional student ID grid, come from an earlier discussion on 4 November 2026, in which Jason asked for a do-it-yourself alternative to scantrons and open-source bubble sheet readers were surveyed. This spec departs from each of those proposals for the reasons given here and under Open questions: the no-dependency rule, and decision 4 of the design plan. The licence statements in the table come from that discussion's web research and have not been checked against each project's licence file. Check the file at the source before any code is ported.

| Project | License | Taken | Not taken |
| --- | --- | --- | --- |
| [QuickGrade](https://github.com/dancockrell/quickgrade) | MIT | One photocopiable master with a machine code identifying test, version and page; a review queue built on crops of the real paper; changing the scoring after the fact with no rescan | Its QR code (our strip needs no library); its browser storage of student records |
| [OMRChecker](https://github.com/Udayraj123/OMRChecker) | MIT (relicensed from GPL 3; only the current master is MIT) | A layout described as data; thresholds set per sheet from the sheet's own bubbles | Its Python code; its PDF reading through PyMuPDF, which is AGPL |
| [Auto Multiple Choice](https://www.auto-multiple-choice.net/) | GPL 2 or later | Nothing but the general workflow | Any code |
| [SDAPS](https://manpages.ubuntu.com/manpages/lunar/man1/sdaps.1.html) | GPL 3 | Nothing but the general workflow | Any code |
| [FormScanner](https://sourceforge.net/projects/formscanner/) | GPL 3 | Nothing | Any code |
| [OpenMCR](https://github.com/iansan5653/open-mcr) | GPL 3; its sheet is CC BY-NC-SA | Nothing | Its code and its sheet design |
| [Moodle Offline Quiz](https://github.com/academic-moodle-cooperation/moodle-mod_offlinequiz) | GPL 3 or later | Versions as groups with their own question order; correcting unclear forms by hand | Any code |

Libraries considered and held back for now, each a "conversation first" under the no-dependency rule: OpenCV.js (Apache 2.0, about 10 MB of WebAssembly), jsQR (Apache 2.0) and pdf.js (Apache 2.0). All three are compatible with Apache 2.0. pdf.js is the one most likely to be worth it, if copiers that save JBIG2 or layered PDFs turn out to be common (see Open questions). If it is ever added, it is loaded only for a PDF the engine cannot read itself, so everything else keeps working without it.

## Privacy and student data

OpenAssess keeps no student names, no student IDs, no roster and no photographs in any file it writes, which is decision 4 of the design plan applied to paper. A sheet is known by its sheet number (its place in the batch) and its version, and nothing else.

- The name box is never read by software. At review and on the results screen its picture is shown beside the sheet number, from the image the instructor opened, so the instructor can read it.
- Scans stay where the instructor keeps them. The scores file records each sheet's source file name, page number and an image fingerprint, so the pictures can be shown again by reopening the same files; it never holds the images or any crop of them.
- The exported spreadsheet leaves the Name column empty. The instructor fills it in their own spreadsheet, or sorts the sheets into roster order before scanning so sheet numbers follow the roster.
- Responses stay in the scores file; only class-level statistics go into the bank, which may be shared.
- Everything runs on the instructor's computer. Nothing is sent anywhere.

## Testing and validation

Accuracy is measured the way the import is: sheets with known answers go through the reader, and the gate counts a bubble right only when its reading matches, with every flag counted as flagged and never as right. The gate is `assess sheets gate`, and it runs from `Check OpenAssess.cmd` like the import gate.

Three corpora, kept apart and reported apart:

| Corpus | How it is made | What it proves |
| --- | --- | --- |
| Synthetic | `raster.ts` draws sheets at 150, 200 and 300 dpi with known answers and simulated marks: solid fills, light pencil, off-centre marks, ticks, crosses, half fills, erasures, stray marks | The rules, at volume, on every kind of mark |
| Synthetic, damaged | The same sheets turned up to 5 degrees, put in perspective, blurred, darkened like a photocopy, speckled, saved as low-quality JPEG, cropped at the edge | That damage produces flags or refusals, never wrong answers |
| Real | Sheets filled in by hand by volunteers to a written answer list, then scanned on the department copier (feeder, 200 and 300 dpi, grey and black and white), a flatbed, and photographed on an iPhone and an Android phone in office light | That it works on real paper; this is the corpus the targets are judged on |

Rules for the corpora, from what the import gate taught:

- The expected answers for real sheets are written from the answer list the volunteer filled in, never from what the reader produced.
- Thresholds are tuned on one half of the real sheets and reported on the other half, which they were not fitted to.
- Any answer read wrong and not flagged, in any corpus, fails the gate and is added as a regression case.

Unit tests cover the pieces that can be checked exactly: the code strip round trip and its check bits against every single-bit error, the geometry against the printed PDF (every bubble where the geometry says it is, measured from the PDF's own drawing commands), the perspective transform, scoring rules for every question type, and the item statistics against hand-worked examples. The new server routes get the same security tests as the existing ones.

## Build plan

Six phases, each finished only when its gate passes; Phase 1 is already useful to instructors on its own, and Phase 2 is where the real risk sits. The figure that held the phases did not come through in this copy, so they were written again from this document's text on 4 November 2026 and are the plan that is built to.

| Phase | What is built | Gate |
| --- | --- | --- |
| 0 | Test records and versions: `model/test.ts`, stored in the bank under `tests/`; a seed; up to four versions with questions and options reordered; booklets and keys per version | A record freezes each question as used and survives saving and opening the bank; the same seed gives the same versions; a letter on any version maps back to the bank's own option; a bank without tests opens as it did |
| 1 | The sheet, printed: `geometry.ts`, `code.ts`, `print.ts`; Letter, A4, wide and large print layouts | The code strip round trips and every single-bit error is caught; every corner mark, bubble and strip square in the printed PDF is where the geometry says, measured from the PDF's own drawing commands |
| 2 | The reader: `raster.ts`, `image.ts` (grey image, PNG), `locate.ts`, `measure.ts`, `decide.ts`, and `assess sheets gate` | Sheets drawn by `raster.ts` read back with 0 answers wrong and not flagged on both synthetic corpora; clean sheets at 200 dpi flagged at 1 in 100 or fewer; every refusal names its cause; a 100-question sheet reads in under 1 second; Check my printing reads a blank copy |
| 3 | Images and PDFs in: JPG and PNG through the page; the one image on a PDF page (JPEG, Flate or uncompressed) with its rotation, placement and decode setting; refusals with the setting to change; duplicate and page order checks | A PDF page gives the same reading as the image inside it; every kind of page that is refused has a test of its message; the same image twice and a page 2 out of place are flagged |
| 4 | Scoring, adjustments, item statistics, the scores file and its spreadsheet export; aggregate statistics into the bank | Scoring rules hold for every question type; an adjustment changes scores with no rescan and is listed; statistics match hand-worked examples; the scores file round trips; no individual response and no file name is written into a bank |
| 5 | The app's Answer sheets area (Assemble, Print, Score, Review, Results), its server routes, and `assess sheets` on the command line | The routes pass the same security tests as the others, through a real HTTP client; Review works from the keyboard alone; the gate runs from `Check OpenAssess.cmd`; the whole suite passes |

Real-sheet testing is not a phase of code. It runs beside Phases 2 to 5 and stays open in `TESTING-TODO.md` until volunteers have filled in real sheets and they have been scanned on the department copier, a flatbed and two phones; thresholds are tuned on half of them and reported on the other half.

**Built so far.** Phase 0 is built (4 November 2026): `model/test.ts`, `quality/test-key.ts`, a `tests/` folder in the bank, and booklets and keys for every version (`printVersions`). Decisions made while building it:

- Version A is the test as it was assembled. Versions B to D are made from the stored seed: the answers of each question are put in another order (never the order they came in), and the questions too when the test says to shuffle them, within their sections.
- A test of one version is printed with no version, since there is nothing to tell apart.
- The fingerprint is 20 bits from the test id, the seed, the number of versions and the question ids, and a record whose fingerprint does not match what it holds is refused.
- A test in a bank that cannot be read is kept as it was, reported, and written back unchanged, like a question.
- The version is in the booklet's title and in a running header at the top of every page (a Word header part, and a line at the top of each PDF page), and a line tells the student which bubble to fill in. The Word header was checked against Word itself.
- The key ends with a strip, ten answers to a line: `3-AC` is question 3 with A and C right, a dash alone is a question a sheet cannot carry, and a question mark is one with no usable key.
- Writing the tests found two faults in the record's validator before anything used it: a version's order that repeated a question and left another out was accepted, and a record with a damaged question made the reader throw. Both are fixed and tested.

Phase 1 is built (4 November 2026): `sheets/geometry.ts`, `sheets/code.ts`, `sheets/plan.ts` and `sheets/print.ts`. Decisions made while building it:

- The sheet is a PDF only, at 100 percent, written by a small writer of its own (Helvetica, nothing embedded), because Word cannot promise where a shape lands. Every position is in millimetres in `geometry.ts`, the one source the printer and the reader both use.
- Standard is A to E, 100 to a page in four columns of 25. Wide is A to H, 50 to a page in two columns of 25. Large print is 7 mm bubbles, A to E, and holds 51 to a page in three columns of 17, because 50 does not divide into columns. A test takes at most 8 pages, from the 3 bits of the code that say how many. There is no wide sheet in large print.
- The code strip is 48 squares of 3 mm: a start square, the layout (1 standard and large, 2 wide), the paper, the test's 20-bit fingerprint, the page and number of pages, the version (0 on a sheet shared by every version) and a CRC-12. Three strips are pinned in the tests, with the check bits worked out again from the definition, so a sheet already in a classroom keeps reading in later versions of the program.
- A test of several versions shares one sheet with bubbles for A to D, or has one sheet per version with the version in its code and named on it. A place has the most bubbles any version needs. It is labelled T and F only when it is true or false in every version; otherwise its bubbles are lettered, and the sheet says that A is True and B is False.
- A question a sheet cannot carry (an essay, one with fewer than two answers, one with more than eight) keeps its number and has no bubbles. A question with no usable key still has them: it is read and never scored. The sheet says to answer in the booklet when any version has such a question, because with shuffled questions an essay can stand where another version has a choice question.
- The name box is printed unless it is left off. Under the code strip, in words, is `Test 0F3C5   Sheet 1 of 2` (and the version), so a loose sheet can be put back with its test. One mark to copy and three not to make are drawn and never read.
- Writing the tests and looking at the printed sheets found three faults before anything used them: the last row of a large print sheet ran into the line printed under the grid (the rows are now 10 mm apart and a test holds the grid clear of the line), the note about the booklet was missing from a shuffled test, and the plan's notes spoke of version A only.
- Checked by breaking 80 rules of the code, geometry, plan and printer one at a time and running the tests: seven survived at first, each was given a test, and every break is now caught.

Phase 2 is built (4 November 2026): `sheets/image.ts` (the grey image, a PNG reader and writer), `homography.ts`, `raster.ts` and `damage.ts` (the harness's sheets and the ways to spoil them), `locate.ts`, `measure.ts`, `decide.ts`, `read.ts`, `check-print.ts` and `gate.ts`, and `assess sheets gate`, `read` and `check`. The gate's rule held on 800 drawn sheets (942 pages, eight seeds' worth of the same recipe): no answer was read wrong without a flag, firm marks on clean scans were flagged 0 times in 100, no clean page was refused, and a sheet of 100 questions reads in about 50 ms. Decisions made while building it, and what the gate found:

- The pixel renderer draws a sheet through the same function that prints it (`drawSheetPage`, onto a `Surface`), so the picture a reader is tested on is the printed page and not a second description of it. Pencil marks are drawn in eight kinds (firm, scribble, light, off centre, tick, cross, half, erased) with strays; a picture is spoiled by a turn, a lean, a squeeze, blur, noise, specks, a dull or darkened scan, a black and white scan, JPEG-style blocking and a crop.
- The finder takes the four largest solid, square blobs that make a four-sided figure with exactly one hollow mark, and the hollow one is the top left. It refuses with the reason a picture with fewer than four, none or two hollow, marks that run the way of a page seen from the back, or marks that do not make the shape of a sheet. The paper (Letter or A4) is settled from the code strip, read as each, and a strip must say it was printed on the paper it was read as.
- The spec's check that the corner marks' spacing matches the geometry within 3 percent turned out not to be a thing a picture can say: the transform takes its scale from the marks themselves, so a sheet printed at 95 percent reads exactly as well as one at 100. What can be checked, and is: how soft the picture is (measured from the corner marks' edges, refused over 0.5 mm of blur), that the printed circles show at half the clearness a picture that sharp should show them at (a grid 2.2 mm from where the marks put it shows them at a fifth), that the marks are the size they are printed at, and, in Check my printing, the printed size from the dots to the inch the picture says it was scanned at.
- A row of bubbles is found again by its own printed outline, within a millimetre of where the transform puts it, and the five circles of a question move together. A row at the edge of the search is flagged and not read. A row whose outlines are hidden because its bubbles are solid takes the shift of the rows round it; a row whose outlines are not clear and whose bubbles are not solid is not where it was looked for, and is flagged. The gate's first runs did not make that difference, and the second found out: a row 1.4 mm out was read in the wrong place with no flag.
- The lines for a filled bubble and an empty one are 0.5 and 0.1 (0.06 for a question with several answers), where the spec's table started at 0.60 and 0.25. On drawn sheets a firm mark reads 0.65 to 0.85, a hurried scribble 0.4 to 0.6, half a fill about 0.4, a cross 0.2 to 0.3, a tick 0.15 to 0.25, and an empty bubble 0.00 to 0.02 (the greatest seen was 0.28, on a damaged page). At 0.25 for empty, a tick on a question with several answers read as nothing, and the set was wrong with no flag; the gate found seven wrong answers in its first 20 sheets of each corpus, most of them that. These are provisional until real pencil on real scanners sets them.
- Each sheet is set against the corner marks' darkness and its own blank level (the median bubble), not against "the darkest group": a sheet whose only marks were faint would then read as solid, which is a wrong answer that looks read.
- A black and white picture is recognised by having hardly any grey in it, said so in the reading's notes, and no question with several answers is read from it. The gate found the reason: scanned in black and white, a pale mark vanishes and a smudge can come out solid, and on 8 answers in 373 damaged pages, every one on a black and white scan, that changed the set of answers with nothing in the picture to show it. No reader can see what the scan has thrown away. The harness draws the student of a black and white scan as marking firmly and leaving no smudge, since it judges the reader on what the picture can show.
- The reading holds the fill of every bubble, so a settled version or another key needs no rescan, and a version that is not settled leaves the questions undecided until it is.
- The gate itself is tested: a reader that gives a wrong answer, drops one answer from a set, records both marks of a doubled question, reads the wrong version, refuses clean pages, is too slow or flags nearly everything makes it fail, and the same seed makes the same sheets (a test's id, and so its code strip, is made from its place in the corpus).
- Checked by breaking 104 rules of the reader one at a time: 82 were caught by the first tests, 21 survived and one could not be applied. Thirteen of the survivors pointed at real gaps (the inner 70 percent, the cap on the blank level, a row of one solid bubble taking its neighbours' shift, a Paeth tie, the 8 mm mark size, and others) and each now has a test (as has the one that could not be applied), and every one of those is caught. Eight were left: they are second lines of defence that no picture reaches, since the code strip, the corner marks and the printed outlines each refuse a page first (sampling the black level at the middle of each mark and not its body, which the median of 32 samples does not notice; a quadrilateral that is not convex, a blob a quarter of the picture across, the exact strictness of the hollow-mark test, the grid being outside the picture, the strip's paper agreeing with the paper it was read as, the edges failing to measure, and the version bubbles of a test of one version). The same pass found a test that failed one run in sixteen, because a test's id was random and a code square it painted black was sometimes black already.

Phase 3 is built in the engine and on the command line (4 November 2026): `sheets/pdf-page.ts`, `sheets/intake.ts` and `sheets/batch.ts`, with `assess sheets read` taking a PNG, a scanned PDF, several files or a folder. The window's own decoding of a JPEG, which is what the app's Score screen does, is not here: the engine hands a JPEG on as its bytes, with how it is to be turned, and takes grey pixels back, and that is built and run in a real browser in Phase 5. Decisions made while building it:

- A file is told by its first bytes and not by its name. A PNG is decoded by the engine; a JPEG, WebP, GIF or BMP is handed to the window; a PDF is opened a page at a time; an iPhone HEIC photo, a TIFF and anything else are refused with what to do (Settings, Camera, Formats, Most Compatible; save as JPG, PNG or PDF).
- A PDF page is read only where it is one picture drawn over it. A text layer from character recognition and a picture under a twentieth of the page (a logo) are ignored; a picture drawn from inside a form is found. Fax compression (CCITT), JBIG2, JPEG 2000, a picture in layers (a mask), a page of several pictures, an inline picture, a page with no picture, a picture that is damaged, cut short, in an odd colour space or too large are each refused for that page with the reason and the scanner setting to change, and the other pages are still read.
- What is done to a picture is worked out from how it is drawn: the page's own rotation, a transform that turns it a quarter or mirrors it, and a decode setting that swaps black and white (a stencil in a black and white scan paints where its sample is 0, or where it is 1 when the setting is swapped). The result is the page as a person sees it, so a sideways scan marked to be turned reads and shows upright. The reader would read it either way up; the mirror is what matters, since a mirrored page is refused as one seen from the back.
- A flat picture is reduced to 3300 pixels on its long side, as the window does for one it decodes, and its dots to the inch (the pixels across the length of page they cover) are kept and adjusted for the reduction, so Check my printing can say the printed size from a PDF.
- Pages are put into sheets in the order they came. The same picture twice is flagged and the second is not counted, so a sheet is never scored twice. A page 2 that comes before its page 1, or a page 3 before a page 2, is put with its sheet and the order is said. A page 1 with no page 2 after it, and a page 2 with no page 1 before it, are flagged as missing. A page that could not be read is held where it would have been. The pages of a sheet must name the same version. A sheet is known by its place in the batch and nothing else.
- The PDFs the tests read are written by `test/support/pdf-scan.ts` from the format's description, as scanners write them (plain, Flate, Flate with a row predictor, RGB, CMYK, ICC grey, indexed, a stencil, a decode setting, mirrored and turned placements, a form with a matrix, strips and layers), and not by the engine's own writer. They were not written from any real scanner's file, so the first test of this reader on real files is the scan item in `TESTING-TODO.md`.
- Checked by breaking 56 rules: 47 were caught by the first tests and 9 survived. Eight now have tests (a form's matrix, a JPEG wrapped in another compression, a palette that is not black then white, the weights of colour, an unknown colour space, the dots to the inch after a reduction, and a page that comes out of order on a sheet of three), and the ninth, mirroring and inverting in the other order, is the same thing, since they commute.

Phase 4 is built in the engine and on the command line (4 November 2026): `sheets/score.ts`, `sheets/stats.ts`, `sheets/scores-file.ts`, `sheets/results-export.ts` and `model/statistics.ts`, with a `statistics/` folder in the bank, and `assess sheets score` and `rescore`. The app's Results screen is Phase 5. Decisions made while building it:

- A reading is settled into answers before it is scored: what the reader was sure of is taken; a row it found blank is settled only when confirmed (or when `--accept-blanks` says to take blanks as read); a flag is never taken as read; and a person's decision replaces what the reader said, whichever it was, with the reader's own words kept beside it. A version a person settles for a page the reader could not decide has the page's questions decided from the fills it kept, with no rescan. The pages of a sheet that name different versions give it no version.
- A question that is not settled earns nothing and is counted in what the sheet could earn, so a total can be shown while the queue is still full, and says how many questions it does not yet include. A sheet is complete only when nothing is undecided and no page is missing.
- The key is the test record's own frozen copy of the question, with its answers in the order of the sheet's version, and a letter is taken back to the bank's own answer through it. A question with no usable key, and one a sheet cannot carry, are not in what a sheet could earn, and the results say so.
- Multiple response is all or nothing, or the right ones less the wrong ones as a share of the right ones and never below nothing when the question is set to give partial credit. A question with one answer is right only when exactly one place is marked and it is a right one.
- The adjustments are drop, another answer counts as right, credit for everyone, and a change of points, each for all versions or only those named, each with a note, and the last change of points wins. How many sheets an adjustment changes is worked out before it is applied, and the exported workbook lists each with the sheets it changed.
- Item statistics are of complete sheets only, across every version, per bank question: difficulty is the share of the points earned; discrimination is the correlation of the question's score with the total score (which includes the question) and the top 27 percent against the bottom 27 percent, the second only when each group has at least two sheets; and the options marked and the blanks. The test gets KR-20, or Cronbach's alpha when a question gives partial credit, and says which. Variances are those of the class, not of a sample. Every figure carries its number of sheets, and under 30 the figures say they are unstable. Worked examples in the tests: five students and three questions give KR-20 0.5769 and point-biserial 0.7206 and 0.7845.
- The scores file is a zip of JSON (`manifest.json`, `sheets/<n>.json`, `decisions.json`, `adjustments.json`). It holds every bubble's fill, so a new key or a settled version needs no rescan, and for each page the sheet number, the page number and the picture's fingerprint. It holds no file name, no picture and no name, and a field it does not know is refused when the file is read, so that a file written by anything else cannot carry one. It can be restored into the batch and readings that scoring works on.
- A bank keeps the figures of a test given to a class (the test's name and id, the day, how many sheets, and per question its difficulty, discrimination, how many sheets marked each answer and the blanks) in `statistics/<administration id>.json`. The figures have no field that could hold a response, and any other field is refused when a bank is opened: the file is kept exactly as it was, reported, and not used. Nothing is written to a bank unless the instructor says so (`--save-statistics`).
- The workbook has the scores (an empty Name column, each answer as the letters marked, the score, the possible, the percentage, whether it is settled), the key of each version, the adjustments, and the item statistics; the scores alone are written as a CSV with a byte order mark and CRLF. The item analysis is a printable page with a block for each question, escaped, with the counts for each answer.
- Checked by breaking 80 rules: 68 were caught by the first tests, and 10 survived and 2 could not be applied. Each of the twelve pointed at a real gap (a question with one answer given to a sheet that marked the right one among others, the 27 percent and its tie-break, a constant question shown as NaN, a field smuggled into an adjustment, a sheet whose pages disagree on the version, a percentage not rounded, and others) and has a test, and all are caught. One of the tests had been passing for nothing, because it asked for the figures of a question from a record that did not have it.

Phase 0 is the one piece of M3 this needs. Phases 1 and 2 can run side by side once the geometry file exists, because the printer and the reader both build on it. No dates are set, as in the design plan.

## Open questions

Each of these had a recommended answer. Jason accepted all of them on 4 November 2026, so they are decisions now. The scanner test in the third item is still to be done, and the build goes ahead without it, as that item says.

- [x] Order of work. The design plan puts answer sheets at M5, after M2 and M3. This spec needs only one piece of M3 first (test records and versions). Recommended: build that piece, then go straight to answer sheets.
- [x] Student ID bubbles. An ID grid would let a large class be matched to a roster automatically, but it puts student IDs into OpenAssess's files, against decision 4. Recommended: no ID grid in version 1; sheet number plus the name box picture.
- [ ] What the scanners save. Many copiers save black and white scans with fax (CCITT) or JBIG2 compression, and some high compression modes split a page into layers; this plan refuses both. Recommended: before Phase 3, scan a test page on the department copier in grey, in colour and in black and white, and make one scan each with the iPhone and the Android document scanners, then look at what each PDF holds (the image format, how many images are on the page, and the page rotation). The phone scanners usually write one cropped, straightened JPEG to a page, which this plan reads. Then go in steps: read JPEG and plain images (this plan); write a CCITT decoder (a few hundred lines) only if black and white turns out to be common; have the library conversation about pdf.js only if JBIG2 or layered PDFs turn out to be common, and if it is added, load it only for a PDF the engine cannot read itself. Decided on 4 November 2026: build for JPEG, Flate and uncompressed images in PDFs only. The fax decoder and pdf.js wait for this test, which stays open in `TESTING-TODO.md`.
- [x] Options per question. Recommended: A to E on the standard sheet, A to H on the wide sheet. Is more than eight ever needed?
- [x] Multiple response default. Recommended: all or nothing, with right minus wrong per question.
- [x] Blank answers. Recommended: flagged for one quick group confirm, not one by one.
- [x] Name box. Recommended: printed by default, with a setting to leave it off.
- [x] iPhone HEIC photos. Recommended: refuse with the setting to change, rather than writing a HEIC decoder.
- [x] Where scores files are kept, and for how long. Recommended: `Documents/OpenAssess/Scores`, kept until the instructor deletes them, with the date in the file name.

### Added when this was checked against the repository (4 November 2026)

These were found by reading the spec against `docs/design-plan.md`, `CLAUDE.md` and the code. Jason accepted the recommended answer on each on 4 November 2026.

- [x] The three figures. The build plan's six phases and their gates, the answer sheet mock-up and the diagram of where each part lives did not come through in this copy. Phase 0 is described in the text (the test record and versions), and Phases 1 and 2 can be told apart from it, but the other phases and every gate need the figure. Decided: the phases were written again from the text (see Build plan). The sheet mock-up and the diagram of where each part lives are still not in this copy.
- [x] Source file names in the scores file. The scores file records each sheet's source file name. An instructor whose scans are named by student (`Smith_John.pdf`) would put student names into a file OpenAssess writes, against decision 4. Recommended: record only the sheet number, the page number and the image fingerprint, and ask the instructor to choose the same files again to see the pictures, or say plainly on the Score screen that file names are kept. Decided: as recommended. The scores file records the sheet number, the page number and the image fingerprint, and no file name.
- [x] KR-20 with partial credit. KR-20 is defined for questions scored right or wrong. When a multiple response question gives partial credit (right minus wrong), it does not apply to that test. Recommended: show Cronbach's alpha when any question has partial credit, and say which of the two is shown. Decided: as recommended.
- [x] Differences from the design plan that this spec does not mark as proposals. The design plan reads a PDF only where each page holds one embedded JPEG; this spec also reads uncompressed and Flate images and refuses the rest. The design plan makes straightening phone photos the last stage; this spec makes it part of the reading pipeline from the start. Recommended: treat both as proposed changes, and change the design plan if they are accepted. Decided: both are accepted as changes to the design plan, and the design plan is changed to match.
- What the existing PDF reader does. The engine's PDF reader (`import/pdf/`) opens a file's objects and inflates streams, but it refuses an image stream outright ("This stream is an image") and refuses a PDF with no text as a scan. Reading the picture on a page is therefore new code (`image.ts`), not a change to the import's reader, though the two can share the reading of objects and streams.

## Sources

- [OpenAssess repository](https://github.com/jasonswrench-beep/openstage-assess): `docs/design-plan.md` (decisions 4, 5 and 8, Answer sheets, M5) and `CLAUDE.md` (the repository's rules), read on 4 November 2026
- [OMRChecker LICENSE](https://github.com/Udayraj123/OMRChecker/blob/master/LICENSE), MIT, copyright 2024-present
- [QuickGrade](https://github.com/dancockrell/quickgrade), MIT
- [OpenMCR](https://github.com/iansan5653/open-mcr), GPL 3
- [Moodle Offline Quiz](https://moodle.org/plugins/pluginversion.php?id=21621), GPL 3 or later
- [jsQR](https://awesome.ecosyste.ms/projects/github.com%2Fcozmo%2FjsQR), Apache 2.0
- The earlier discussion of 4 November 2026 (a chat, not linked), in which the projects above were surveyed
