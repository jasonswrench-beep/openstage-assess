# Learning system compatibility

Which of OpenAssess's files have been taken into which learning system, and what is known about each. This is the matrix the
development list asks for (item 6). It is filled in from real imports only: a cell says "works" only when a person imported the file
into a real course and said so, and the date and what was looked at go with it. Everything else is what the system's own help pages
say, and is marked as such.

Updated 15 November 2026. Only one export has been imported for real so far.

## Exports into a learning system

| File OpenAssess writes | Brightspace (D2L) | Canvas | Moodle | Blackboard |
|---|---|---|---|---|
| Brightspace question CSV (`d2l-csv`) | **Works**: imported twice into a real course (early November 2026) and reported fine; the questions were not checked one by one, and the multiselect scoring word (`AllOrNothing`) is not yet confirmed | Not for Canvas | Not for Moodle | Not for Blackboard |
| QTI 1.2 package (`qti-1.2`) | **Not accepted**, twice (1 November 2026), in the Quizzes import: "just uploaded as a zip", then "still does not like the format"; no message recorded | Not tried. Canvas's guides list QTI 1.2 for Classic and New Quizzes | Not tried. Moodle core has no QTI import | Not tried |
| QTI 2.1 package (`qti-2.1`) | Not tried. Campus guides list QTI 2.1 as partly read by Course Import | Not tried. Canvas's guides list 2.1 for Classic Quizzes and 2.x for New Quizzes | Not tried | Not tried |
| QTI 3.0 package (`qti-3.0`, new 15 November 2026) | Not tried. Course Import is said to read a subset of 3.x | Not tried; whether Canvas reads 3.0 is not known | Not tried | Not tried |
| Common Cartridge 1.3 (`common-cartridge`) | Not tried. Built in the form a Brightspace quiz-building tool writes, after the QTI 1.2 package was not accepted | Not tried. Canvas imports Common Cartridge courses | Not tried. Moodle restores Common Cartridge | Not tried |
| Moodle XML (`moodle-xml`) | Not for Brightspace | Not for Canvas | Not tried. Written from Moodle's documented format | Not for Blackboard |
| GIFT (`gift`) | Not for Brightspace | Not for Canvas | Not tried (a real Moodle GIFT export of 139 questions reads into OpenAssess) | Not for Blackboard |
| Blackboard upload file (`blackboard-upload`) | Not for Brightspace | Not for Canvas | Not for Moodle | Not tried. Written from the documented tab-delimited format |
| OpenStage spreadsheet | For OpenStage Author and Scroll, not a learning system | | | |

## Files from a learning system, read into OpenAssess

| File | Read? |
|---|---|
| Brightspace question library zip (QTI 1.2 `objectbank`) | **Reads**: one real library of 80 multiple choice questions, 80 of 80, held to an independent reading in `import-brightspace-library.test.ts` |
| Moodle GIFT export | **Reads**: one real export of 139 questions |
| Canvas quiz export (QTI) | Not tried with a real file; the Canvas shapes were written from memory |
| Moodle XML export | Not tried with a real file |
| Blackboard export package (`.dat` files) | Not read, and says so; Blackboard's upload file is read |
| Quiz results reports (Canvas Student Analysis, Brightspace quiz statistics, Blackboard Download Results; new 15 November 2026) | Not tried with a real report; written from documentation |

## How to fill in a cell

1. Export a small bank with one question of each kind (multiple choice, multiple answer with and without partial credit, true or
   false, short answer, matching, ordering, essay), one with a picture, one with an equation and one with a table.
2. Import it as the system's help says. Write down the exact words of any message, or that there was none.
3. Open each question in the system and compare it with the bank: the words, the right answers, the points, partial credit, the
   picture's description, the equation.
4. Put the result in the table with the date, and in `TESTING-TODO.md` tick the item or say what failed.

The steps for each export are in `TESTING-TODO.md`, under each format's own heading.
