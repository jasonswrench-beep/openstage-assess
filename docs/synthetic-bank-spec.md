# A brief for generating test banks to measure the Word importer

Most real test banks are behind closed walls, and the ones we have are all fitted: every rule in the
importer was written from a file that needed it, so a score on those files says nothing about a new one.
The first run on each new file is the honest number, and it has been about 3 percent. This brief is for
another model to write test banks that we have not seen, so the importer can be run on them before it is
changed. Two parts: a note for the person running this, and the brief itself, which is written to be given
whole to another model.

## For the person running this

**What these files are for, and what they are not.** They test whether the importer copes with layouts a
model can imagine, which is not the same as layouts that real instructors and publishers use. A good score
on them is not evidence about real banks, and a bad one is a real finding. Report them apart from the real
files, and never count them toward the criterion of three real chapters the rules were not fitted to
(`CLAUDE.md`, "The accuracy gate").

**What they have that real files do not.** The answer key is written by someone other than the person
writing the importer, they can be committed to the repository (no licence, no one's course material), and a
new batch is cheap.

**How to keep a run blind.**

1. Ask for two sets in one batch. Set A files may be read, and rules may be written from them. Set B files
   are given to the importer first, unread, with no rule changed, and the score is the first-contact
   number. Only after that are B's failures looked at.
2. Keep each set's `layouts.md` (the generating model's own description of how each file is laid out) apart
   from the files. It is the one thing that would make a B run less than blind.
3. A batch is blind once. After rules have been written from it, ask for a new batch with a different list of
   layouts, or the next score is fitted.
4. The generating model will get some expected answers wrong. When the importer and an expected file
   disagree, settle it by reading the document, and fix whichever is wrong. That happened with a real file
   in the last stage, and it was the expected-file writer that was wrong.

**What to give the other model.** Everything under the line below, and nothing about how the importer works.
Do not paste in the importer's rules or its source: a file written to match them proves nothing.

---

## The brief

### What this is for

I am measuring a program that reads Word test banks (the files an instructor keeps their exam questions in)
and turns each question into structured data: the type, the question text, the options, and which option is
correct. I need Word files that look like the ones real people make, and for each file an answer file saying
what a careful human would read from it. I will run the program on your files and compare.

You are not testing the program and you do not need to know how it works. Do not make the files easy to read
by a program. Make them the way a real instructor, or a real publisher's editor, would have made them.

### What to produce

- **24 Word files** (`.docx`), named `a-01.docx` to `a-08.docx` and `b-01.docx` to `b-16.docx`. Each has
  between 8 and 40 questions, and about 600 questions in all.
- **For every file an answer file** beside it, named `a-01.docx.expected.json` and so on, in the format below.
- **One file `layouts.md`** with two or three sentences per file saying how it is laid out (how a question
  begins, how options are labelled, how the answer is marked, what else is in the file). Write it as you go;
  it is kept apart from the files.
- **A short checker script** that reopens every `.docx`, and confirms for each expected question that its
  stem and each of its options appear in the document text, in order, and that the count of questions matches.
  Run it and fix what it finds before you hand anything over. Say in one line what it found.

If you cannot write files, write one Python script (python-docx is fine) that writes all of the above, and say
how to run it.

### Make them look real

- Invent every question. Any subject, any level. Do not copy text from a textbook, a publisher's test bank or
  another instructor's exam, and do not name publishers, products or real people.
- A real file has one habit that it keeps most of the time and a few places where it does not. For each file
  choose one dominant way of doing each thing in the grid below, and then put in two to five lapses that a
  tired person would make: a number skipped or repeated, a missing blank line, a space before a full stop, an
  option left unmarked in one question, an extra blank line, a trailing space, a stray note to self.
- Use the Word features a person would use. Where the layout calls for automatic numbering or lettering,
  use real Word list numbering (not typed numbers). Where it calls for a table, make a real table. For
  bold, underline, highlight or a coloured font as the answer mark, apply it to the run in Word's own
  properties. If you cannot make a feature properly (lettered lists are the hard one in python-docx), type
  it instead and say so in `layouts.md`.
- Vary the look: different fonts and sizes, a title at the top, a header or footer in some files, some files
  with section headings and some with none.

### The grid

Give each file a different combination, and make sure every value below appears in at least two files.
Add values of your own if you know a layout that is not listed; they are the most useful.

**How a question begins:** `1.` or `1)` or `(1)` or `Q1.` or `Question 1:`; Word automatic numbering;
numbering that restarts in each section; numbers like `3.14` meaning chapter 3, question 14; a bullet or a dash;
no number at all, with a blank line between questions; a line giving the type (such as `MC`) above each question.

**How options are labelled:** `A.` `A)` `(A)` `a.` `a)`; Word automatic lettering; no label at all, one option to
a line; labels like `A:`; bullets; several options on one line (`A. red   B. blue   C. green`); options in a
table, one to a cell or one to a row; the first option on the same line as the question.

**How the correct answer is marked:** an asterisk before the option, or after the letter, or at the end of
the line; bold, underline, highlight, or a coloured font on the right option; `Answer: C` or `ANS: C` or
`Correct: C` on a line under the question or at the end of the last option; a key at the end of the file
(a list such as `1. B  2. D`, a table, or a second copy of the questions with the answers shown); `(Correct)`
or a tick at the end of the option; the answer in brackets after the question.

**What else surrounds a question:** a title and instructions at the top; section headings by type (`Multiple
Choice`, `True / False`); point values; difficulty, level or learning objective lines; a page or section
reference; an explanation of the answer under it, with or without a label; feedback lines; a line of
codes such as `DIF: Easy  REF: 4.2  OBJ: 3`.

**Question types:** multiple choice with 3 to 5 options; multiple response (more than one correct); true or
false (as `True`/`False` options, as a `(T)`/`(F)` after the statement, or with the answer on a line below);
fill in the blank (blank as `____`, with the answer in bold, or in a key); short answer; essay; matching
(a table, or two lists, or `term = definition` lines).

Use all of these types across the batch, with multiple choice in most files and the others in some.

### Make some of them hard in ways that are fair

Real files are hard in the following ways. Include each in at least one file.

- A question whose text contains a numbered or lettered list of its own (steps 1 to 4, or options to choose
  among in the stem).
- An option that begins with a letter and a full stop, or a number, as part of its words.
- A stem or option that contains the words `Answer:`, a star, or a colon.
- A question that goes over two paragraphs, or that has a line break inside a paragraph.
- A question with no answer marked anywhere in the file (so the right output is "no key", not a guess).
- A question with two answers marked where only one is allowed.
- A file that is entirely clean and conventional. Two or three of these are a floor, so that a bad score can
  be told apart from a bad file.
- A file in the plain "the test-bank vendor" style: a number and a full stop, lettered options, `Answer: C` under the
  options, a blank line between questions.

### The answer files

One JSON file per Word file. Write what a careful human reads from the document, not what a program would
extract. Use this shape:

```json
{
  "file": "a-01.docx",
  "note": "One or two sentences on what is unusual about this file, if anything.",
  "questions": [
    { "type": "multipleChoice", "stem": "Which planet is nearest the sun?",
      "options": ["Venus", "Mercury", "Mars", "Earth"], "correct": [1] },
    { "type": "multipleResponse", "stem": "Which are prime?",
      "options": ["2", "4", "5", "9"], "correct": [0, 2] },
    { "type": "trueFalse", "stem": "Water boils at 100 degrees Celsius at sea level.", "correctBoolean": true },
    { "type": "fillInBlank", "stem": "The capital of France is ____.", "accepted": ["Paris"] },
    { "type": "shortAnswer", "stem": "Name one cause of the First World War.", "accepted": ["Alliances", "Nationalism"] },
    { "type": "essay", "stem": "Discuss the causes of inflation." },
    { "type": "matching", "stem": "Match each country to its capital.",
      "pairs": ["France = Paris", "Italy = Rome"] },
    { "type": "multipleChoice", "stem": "A question the file gives no answer for.",
      "options": ["One", "Two", "Three"], "verdict": "failed" }
  ]
}
```

Rules:

- **Text is exactly the words in the document**: the stem without its number, each option without its letter
  or star, in the order they appear. I will ignore differences in spacing and in curly or straight quotes.
- **`correct` is a list of zero-based positions** in `options`. A true or false question uses `correctBoolean`.
  Fill in the blank and short answer use `accepted` (every answer the file gives). Essay has no answer.
- **`"verdict": "failed"`** goes on a question that the file gives no usable answer for (none marked, or two
  marked where one is allowed). Leave `correct` out of it. Everything else is assumed to be fine; you may add
  `"verdict": "needsReview"` to a question that a careful human would say is genuinely ambiguous, such as
  a question that starts where a line wrap broke a sentence.
- **Do not include** points, difficulty, feedback, explanations, headings or page references. I am not
  scoring them.
- **Do not include** an `orphans` field. Leave out of `questions` anything that is not a question, such as
  the title, instructions, headings and notes to self.
- Questions are in the order they appear in the document. If a file gives its questions once and its answers
  later (a key at the end), the answer file still has each question once, with its answer.

### Before you hand it over

Run your checker. Then read three of your own files as a stranger would and ask whether an instructor would
believe they made them. If the files are all tidier than that, make more of them messy.
