# Things only a person can check

Everything that a program can check is checked by the tests (`npm test`), the accuracy gate, the real-file score and the
mutation runs, and is not listed here. This is what is left: what needs Word on screen, a person's eye, or a decision. Each
item says what has been run and what has not. Items are removed when done, with the date.

## Needs Word, on a Windows machine

- [ ] **Run `Check OpenAssess.cmd` by double-click, start to finish.** Its test line has been run through `cmd.exe` and runs all
  the tests, but the whole file has not been run: the accuracy step, the speed step and the pause at the end.
- [ ] **Open a few of the generated documents in Word and look.** The checker reads the XML, and only Word can say what Word
  shows. Worth opening: `c-06` (Word's own numbering), `c-11` (bullets and `(Correct)`), `c-16` (highlight), `c-21` (bullets
  and underline), `c-10` (font colour). They are in the session's scratch folder under `generated/` and in the zips you sent.
- [ ] **Run `npm run check:word-authored`, `check:word` and `check:word-formatting`** after any change to
  `import/docx/numbering.ts`, `formatting.ts` or how tables are read. None of those changed in stage 4h, so none is due yet.

## Needs a person's eye

- [ ] **Read three generated files as an instructor would.** Do they look like banks a person made? The checker cannot say. This
  is step 6 of "Doing a piece" in `docs/synthetic-bank-spec.md`, not done for pieces 2 to 6.
- [ ] **Open one real bank with no numbers and no letters, if you have one, and look at the first five questions it reads.**
  The step that reads those is judged only on invented banks. The warning on the file says where to look.
- [ ] **Make a Word list with bullets, type a question under a numbered item with three bulleted options, and import it.** The
  tests write the bullets with their own writer, which Word has not read: `npm run check:word-authored` has Word write
  documents, and does not yet write a bulleted one.
- [ ] **Read the review messages as a person who has never seen the code.** What the importer says about a question it flagged
  (`import.option-letter-gap`, `import.type-from-evidence`, `import.pair-left-out`, `import.accepted-answers-split`) has been
  tested for what it says, not for whether it is clear.
- [ ] **Three real chapters the rules were not fitted to.** The acceptance criterion for the Word importer is 95 percent on three
  real chapters. None exists yet: the real files are all fitted, and the generated ones say nothing about real banks.

## Decisions that are mine until you say otherwise

These change what the app does, and were made without asking. Each is one flag or one line to reverse.

- [ ] **Types read from the answer are not flagged for review** (`True`/`False` alone with no options, `Accepted answers:`, a
  matching instruction with `left = right` lines). Each leaves an information note instead. The old rule flagged a type worked
  out from the shape of a question.
- [ ] **`Accepted answers: Paris, France` is read as two answers**, cut at semicolons or at a comma and a space, and the
  question says it was cut. A single answer with a comma in it is cut wrongly.
- [ ] **A choice question whose option letters have a gap (A and C, no B) is flagged for review.**
- [ ] **Two spaces or a tab before an option letter start a new option, whatever follows** (`A. mother   B. aunt`).
- [ ] **Two letters on an answer line with no type named make a multiple response, and the question is flagged.** A stated
  `Type: MC` is not overruled and still fails. Whether a slip like `B, D` on a single-answer bank should be flagged as a
  multiple response, or refused as before, is yours.
- [ ] **A stem with no options and an answer in words, and no blank, stays an essay, flagged.** Reading it as a short answer
  when the answer is a few words would clear most of what the generated banks still flag, and would be a guess about the
  author's intent. Whether to do it is yours.
- [ ] **A one-line statement ending `(T)` or `(F)` is read as true or false when three do.** The habit is what keeps a stem such
  as "Convert 100 C to degrees (F)" from becoming a false statement.
- [ ] **A stem with a blank and an answer in words is a fill in the blank, with a note and no flag.** An answer that is a letter
  is never read this way.
- [ ] **A bank with no numbers and no letters is read by its layout, and only the file as a whole is warned.** A question in it
  is `parsed` unless the step saw a sign that its stem may be longer than one line. Whether every question read this way should
  instead be marked for review is yours: it is one `warn` per question in `standard-text.ts`, beside the suspect note.
- [ ] **A dash, `n/a` or `none` in an answer key means that question has no key.** It is never taken for an answer, so the
  question is refused unless it carries its own answer. A key that really means "N and A" for `N/A` would be misread, which
  is rare enough to prefer a refusal to a guess.
- [ ] **A heading `Answer Key` followed by entries is a key; followed by questions it is the copy with the answers.** One lone
  line that looks like an entry, with nothing after it that does, is not enough to make a key.
- [ ] **The 13 openly licensed files** (CC BY 4.0) are kept on this machine only. Whether to commit them as fixtures, with
  attribution, so that the check runs from a clone. The page that shared them names no author.

## Not in this repository

- [ ] The notes about the OpenStage Guide add-in were sent to its own session and have not been seen answered.
