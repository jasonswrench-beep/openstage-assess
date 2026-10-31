# A brief for generating test banks to measure the Word importer

Most real test banks are behind closed walls, and the ones we have are all fitted: every rule in the
importer was written from a file that needed it, so a score on those files says nothing about a new one.
The first run on each new file is the honest number, and it has been about 3 percent. This brief is for
another model to write test banks that we have not seen, so the importer can be run on them before it is
changed.

The first version of this brief asked for 24 files in one request and trusted what came back. What came back
was five documents saved under 24 names, identical but for the title, three questions each, in one layout, with
a description of layouts the files did not have and a checker that printed success whatever it found. This
version asks for four files at a time, gives each file its layout instead of leaving it to choose, and holds
every file to its assignment with a checker we wrote, which reads the Word XML itself.

## For the person running this

**What these files are for, and what they are not.** They test whether the importer copes with layouts a
model can imagine, which is not the same as layouts that real instructors and publishers use. A good score
on them is not evidence about real banks, and a bad one is a real finding. Report them apart from the real
files, and never count them toward the criterion of three real chapters the rules were not fitted to
(`CLAUDE.md`, "The accuracy gate").

**What they have that real files do not.** The answer key is written by someone other than the person
writing the importer, they can be committed to the repository (invented, no licence, no one's course
material), and a new batch is cheap.

### The plan

24 files, in six pieces of four. `npm run check:generated --workspace packages/assess -- plan` lists them. Each
file has a layout made of three choices (how a question begins, how its options are labelled, how the right
one is marked), the other question types it must include, one hard case, a subject, a size, and a number of
lapses. Every way of beginning, labelling, marking and every hard case is used at least twice, and the
combinations that cannot be built (a key by letter over options with no letters, a key by number over
questions with no numbers) are left out. The plan is in `packages/assess/test/tools/generated-bank-plan.ts`.

| Pieces | Files | Use |
| --- | --- | --- |
| 1 to 4 | c-01 to c-16 | The blind set. Run on the importer first, unread, and score it. |
| 5 and 6 | c-17 to c-24 | May be read, and rules may be written from them. |

### Doing a piece

1. Print the text for the model. This is the brief below and the assignment for the piece, in one block:

   ```
   npm run check:generated --workspace packages/assess -- prompt 1
   ```

2. Start a new conversation with another model and paste all of it. Say nothing about OpenAssess, and
   never paste in the importer's rules or its source: a file written to match them proves nothing.
3. Save the files it makes, both the `.docx` and the `.docx.expected.json` of each, in one folder per piece, outside
   the repository until they pass.
4. Check them, with the absolute path to the folder:

   ```
   npm run check:generated --workspace packages/assess -- check C:\path\to\piece-1 --piece 1
   ```

5. If it says FAILED, paste the list of problems back into the same conversation and ask for corrected files for
   the files named. Do this until it says PASSED. If a file will not pass after three rounds, leave it out; do not
   loosen the checker to fit it.
6. When it passes, open three of the files yourself and ask whether an instructor would believe they made them.

### Keeping the run blind

1. The plan is public, so it is known what kinds of layout are coming, but not the files. Before the blind
   pieces are run, no rule is written for a layout on the plan. Run all of pieces 1 to 4 through
   `npm run assess -- score` first, write the number down, and only then look at what failed.
2. A blind set is spent once rules have been written from it. After that, ask for new pieces with a new plan, or
   the next score is fitted.
3. The model will get some expected answers wrong that the checker cannot see (a fill in the blank whose
   answer is not the only acceptable one, a matching pair that is arguable). When the importer and an expected
   file disagree, settle it by reading the document, and fix whichever is wrong. That happened with a real file
   in an earlier stage, and it was the expected-file writer that was wrong.
4. Do not send the importer a batch the checker has not passed. A bad batch spends the blind set.

### What the checker holds each file to

It opens each `.docx` and reads `word/document.xml` for itself. It shares nothing with the importer but the zip
reader, and it was tested on documents written by the test writer and on documents Word wrote
(`fixtures/word-authored`). For each file it checks that:

- the expected file is well formed, and its questions are in the document in the order given, with every stem and
  every option word for word (curly quotes, dashes and spacing aside);
- the file is laid out as assigned, counted question by question, with room for the lapses: how questions begin
  (typed, or Word's own numbering, or none), how options are labelled (or bulleted, or share a paragraph);
- the right answer, read from the document by the assigned mark (a star, bold, underline, highlight, a colour,
  `(Correct)`, an Answer line, a key at the end as a list or a table) is the one the expected file says, and a
  question the expected file calls failed really has no single mark;
- the assigned hard case is there, the other types it must include are there, the size is right, and the
  Answer line of a fill in the blank or short answer, a true or false answer, and each pair of a matching
  question are in the document as the expected file says;
- no question is in two files, whatever the case or punctuation.

It does not check that the questions are good or read like a real instructor's, that the lapses asked for are
there, the formatting of anything but the options, or the answers of essay and short answer questions beyond
what is above. A pass means the files are what was asked for, not that they are good.

---

<!-- brief:start -->
## The brief

### What this is for

I am measuring a program that reads Word test banks (the files an instructor keeps their exam questions in)
and turns each question into structured data: the type, the question text, the options, and which option is
correct. I need Word files that look like the ones real people make, and for each file an answer file saying
what a careful human would read from it. I will run the program on your files and compare.

You are not testing the program and you do not need to know how it works. Do not make the files easy to read
by a program. Make them the way a real instructor, or a real publisher's editor, would have made them, in the
layout each file is assigned.

### What you will produce

An assignment follows this brief. It names some files. For each one, produce:

- a Word file `NAME.docx`, and
- an answer file `NAME.docx.expected.json` beside it, in the format below.

Nothing else. Do not write a description of the layouts or a checker of your own: I will check the files with a
script I wrote, and I will not read a description.

### How your files will be checked

A script opens each `.docx` and reads the Word XML. It checks that the layout is the one assigned, that the
right answer in the document is the one your answer file says, that the hard case is there, that the size is right, and
that no question appears in two files. A file that is not as assigned is sent back with the list of what is
wrong. So build exactly what the assignment says. If you cannot build something as assigned, build the nearest
thing you can and say what you could not do in the `note` of that file's answer file. That is better than
hiding it, and it will not be counted against you.

### Make them look real

- Invent every question, in the subject you are given. Do not copy text from a textbook, a publisher's test
  bank or another instructor's exam, and do not name publishers, products, brands or real people. No student
  names or identifiers.
- No question may appear in more than one file, and no two files may share a question's wording. Each file is
  about its own subject.
- A real file has one habit that it keeps most of the time and a few places where it does not. Follow the
  assignment's layout throughout, and put in exactly the number of lapses it asks for, none if it asks for
  none. A lapse is one of the small slips a tired person makes: a skipped or repeated number, a missing blank
  line, a space before a full stop, an extra blank line, a trailing space, a stray note to self such as
  "check this one". Lapses never change which option is right or what any text says, and never touch the marks.
  A lapse that falls inside a question's words or an option's words, such as a space before a question mark,
  goes into the answer file exactly as it is in the document.
- Vary the look from file to file: fonts and sizes, a title at the top, a line of instructions, a header or
  footer in some, section headings in some, point values in some. Nothing but questions, their options and
  their answers carries meaning; the rest is dressing.
- Do not use text boxes, pictures, columns or headers and footers for anything that is part of a question.

### How to build the Word features

Use Word's own features, not typed imitations, wherever the assignment says so. With python-docx:

- *Typed numbers and labels* are ordinary text in an ordinary paragraph: `1.`, `Q1.`, `A)`.
- *A real numbered list* (Word's automatic numbering): paragraphs in the style `List Number`. The numbers come
  from Word. Do not type them.
- *A real bulleted list*: paragraphs in the style `List Bullet`.
- *Bold, underline, highlight, font colour*: direct formatting on the run, for example `run.bold = True`,
  `run.underline = True`, `run.font.highlight_color = WD_COLOR_INDEX.YELLOW`,
  `run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)`. Put it on the option's words only, in their own run, not on
  its label, and on no other option. Bold elsewhere in the file (a title, a heading) is fine.
- *A table*: `document.add_table(rows, cols)` and fill the cells. A matching table has the left item in the first
  cell of a row and its match in the second. An answer key as a table has the question number in the first cell
  and the letter or letters in the second, with a heading row above if you like.
- *A line break inside a paragraph* (Shift+Enter): `run.add_break()`.

### The answer file

One JSON file for each Word file. Write what a careful human reads from the document, not what a program
would extract. For example:

```json
{
  "file": "c-01.docx",
  "note": "One or two sentences on anything unusual, or on anything you could not build as assigned.",
  "questions": [
    { "type": "multipleChoice", "stem": "Which planet is nearest the sun?",
      "options": ["Venus", "Mercury", "Mars", "Earth"], "correct": [1] },
    { "type": "multipleResponse", "stem": "Which are prime?",
      "options": ["2", "4", "5", "9"], "correct": [0, 2] },
    { "type": "trueFalse", "form": "options", "stem": "Water boils at 100 degrees Celsius at sea level.", "correctBoolean": true },
    { "type": "trueFalse", "form": "inline", "stem": "The moon is a planet.", "correctBoolean": false },
    { "type": "trueFalse", "form": "answerLine", "stem": "Ice is denser than water.", "correctBoolean": false },
    { "type": "fillInBlank", "stem": "The capital of France is ____.", "accepted": ["Paris"] },
    { "type": "shortAnswer", "stem": "Name the gas plants take in.", "accepted": ["carbon dioxide"] },
    { "type": "essay", "stem": "Discuss the causes of inflation." },
    { "type": "matching", "stem": "Match each country to its capital.",
      "pairs": ["France = Paris", "Italy = Rome"] },
    { "type": "multipleChoice", "stem": "A question the file gives no answer for.",
      "options": ["One", "Two", "Three"], "verdict": "failed" }
  ]
}
```

Rules:

- **`file`** is the name of the Word file. Do not add an `orphans` field.
- **Text is exactly the words in the document**: the stem without its number, each option without its label or
  mark (no letter, no asterisk, no `(Correct)`, no bullet), a true or false statement without its `(T)` or
  `(F)`, which is the answer and not part of the statement. Copy the words character for character. The only
  differences I ignore are how many spaces there are in a row (two in a row count as one) and whether quotes are
  curly or straight. A space before a full stop or a question mark counts, so if the document has one, the answer
  file has it too. A stem that runs over two paragraphs is written as one string with a single space between them.
- **Questions are in the order they appear in the document**, each once, even when the answers are in a key at
  the end. Leave out of `questions` anything that is not a question: the title, instructions, headings, notes to
  self, the key.
- **`multipleChoice`** has one correct option, `multipleResponse` has two or more. `correct` is a list of
  zero-based positions in `options`.
- **`trueFalse`** has `correctBoolean` and a `form`: `options` when the document gives True and False as options,
  `inline` when the answer is a `(T)` or `(F)` at the end of the statement, `answerLine` when a line under the
  statement gives it.
- **`fillInBlank` and `shortAnswer`** have `accepted`: the one answer the line under the question gives.
- **`essay`** has only a stem. **`matching`** has `pairs` written `left = right`, in the order of the rows or
  lines.
- **`"verdict": "failed"`** goes on a question the file gives no usable answer for (none marked, or two marked
  where only one is allowed). Leave `correct` out of it. You may add `"verdict": "needsReview"` to a question a
  careful human would call genuinely ambiguous.
- **Do not include** points, difficulty, feedback, explanations, headings or page references.

### Before you hand it over

Count the questions in each file against the size you were given and against your answer file. Check that
nothing is marked on a question the answer file calls failed except as the hard case says, that every other
question is marked once, and that no stem is in two files. Then give me the files.
<!-- brief:end -->
