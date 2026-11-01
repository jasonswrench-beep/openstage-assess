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
  `import/docx/numbering.ts`, `formatting.ts` or how tables are read. Stage 4h changed none of them. The hidden text change
  (stage 5) touched `formatting.ts`, so `check:word-formatting` and `check:word` were run on 1 November 2026, each with
  hidden text added, and found no disagreement with Word. `check:word-authored` is not due.
- [ ] **Hide a whole numbered paragraph in Word and look at the numbers.** Triple-click one item of a numbered list, press
  Ctrl+Shift+H, and make sure Word is not set to show hidden text. Word's object model counted the hidden item (the item after
  it kept its number), and the reader does the same. What the page shows on screen is not something the check can see.
- [ ] **Put a question in a Word text box and import it.** `check:word-authored` does not write a text box, so how Word spells
  one in a real file is read from memory of the format. Expected: the question is missing, and the file says so and quotes the
  start of the box.

## Needs a person's eye

- [ ] **Look at the review page.** `npm run assess -- review <a .docx or .txt file> --out review.html`, then open the page. It is
  the first thing you can see, so it is the first thing to judge: is it the right information in the right order, and what would
  you want to change a question into, by hand, from it? It has no script and cannot change anything yet. Try it on a real bank
  if you have one. It was looked at in the browser pane at desktop width and at phone width; the dark colours were not looked at.

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

## The app and its window

Everything below was run by tests (`npm test` in `packages/app`, 96 of them, through a real HTTP client) and looked at in
the browser pane and in the built window at desktop width. None of it has been used by a person, and none of it has been
run on a machine other than the one it was built on.

- [ ] **Double-click `Open OpenAssess.cmd`, make a bank, import a real Word bank, repair a question, export, print.** The
  whole loop as a person would walk it. Write down the first place you hesitate; that is where the screen is wrong.
- [ ] **Run the window** (`packages/app/shell/src-tauri/target/release/openassess-shell.exe` after `npm run build:exe` in
  `packages/app/shell`) and close it. Check Task Manager afterwards: there should be no `node.exe` left. It was checked
  here by closing the window and listing processes; the force-quit case (End task on the window) was checked by killing it.
- [ ] **Run the installer on a machine that is not this one**, if you want to hand the tool to anyone. It was built, and
  its layout was started from a copy in a temporary folder; it was not installed, because installing changes your machine.
  Expect Windows to say the publisher is unknown (the installer is unsigned) and, on a machine without the Edge WebView2
  runtime, to fetch Microsoft's bootstrapper.
- [ ] **Open the printed Word copies in Word and look.** `check:word-print` asks Word what the paragraphs, numbers and page
  count are (4 documents, 148 paragraphs, no disagreement). It cannot say whether the page looks right: the spacing, the
  writing lines, where a question breaks across a page.
- [ ] **Open a printed PDF in the viewers you use** (a browser, a desktop PDF program, a phone). The PDF is written by hand with the
  standard fonts and no tags, so a viewer that is stricter than the ones tried here may complain. Look for a character that
  printed as `?`; the print screen lists those before you print.
- [ ] **Look at the screens at phone width and in dark colours.** The browser pane was used at desktop width. The page has
  dark colours and narrow layouts that nobody has looked at.
- [ ] **Use the whole app with the keyboard only, and once with a screen reader.** Focus moves to the content when a screen
  changes and every control is a real button or field, but that is the design, not a check.
- [ ] **Import a Moodle XML or GIFT file you really use** (the exporters were checked by reading their own output back; no
  Moodle was available, so neither file has been imported into one). `docs/design-plan.md` lists sandboxes as an open
  question.
- [ ] **Decide whether the installer should be signed.** A code-signing certificate costs money, so it was not bought.
  Until it is, every other computer shows a warning on first run.

## Decisions that are mine until you say otherwise

These change what the app does, and were made without asking. Each is one flag or one line to reverse.

- [ ] **The window is Tauri around a local Node server, and the installer carries its own copy of Node** (about 90 MB).
  You chose Tauri; carrying Node is mine, because the engine runs on Node's type stripping and there is no other way to
  keep the rule of no runtime dependencies. The alternative is a smaller installer that asks the person to install Node.
- [ ] **The library is `Documents/OpenAssess`** (banks, `Deleted`, `Exports`), or the folder named by `--home` or
  `OPENASSESS_HOME`. A deleted bank is moved to `Deleted`, never removed. A deleted question cannot be got back from the
  app, and it says so first.
- [ ] **An error finding cannot be dismissed; a warning or a note can.** A question with an error is kept, shown, and
  exported only with the destination check naming it.
- [ ] **A retired question is left out of an export unless you ask for it.**
- [ ] **A printed student copy shows no answer; the key shows only answers the bank records, and says "No answer is recorded
  for this question." for the rest.** It never fills one in. Matching and ordering are shuffled on the student copy, the same
  way every time for the same question.
- [ ] **PDF uses the standard fonts and Latin-1 only.** A character outside it prints as `?` and is reported first.
- [ ] **The app keeps at most 12 open imports at once**, and the oldest is dropped. Nothing is stored until you accept one.

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
- [ ] **Hidden text is not read.** A note to self or an old answer that Word hides is left out, and the file says how much and
  quotes the first. The other way (reading it as text) would put hidden notes in stems and old answers in keys without a
  word, so this is the safe one; but a bank whose only key is hidden has no key to read, and is refused with the file naming
  what was left out. Whether hidden text should ever be read, say by an option you set, is yours.
- [ ] **Text in a text box is not read, only counted and quoted.** A question in one is missing from the bank, and the file
  says so. Offering it as an orphan with its place was decided against until a real file holds a question in a box.
- [ ] **The review page is written to the folder you run it from** (`<name>-review.html`) unless `--out` is given. Whether it
  should open itself in the browser, or sit beside the document, is yours.
- [ ] **The 13 openly licensed files** (CC BY 4.0) are kept on this machine only. Whether to commit them as fixtures, with
  attribution, so that the check runs from a clone. The page that shared them names no author.

## Not in this repository

- [ ] The notes about the OpenStage Guide add-in were sent to its own session and have not been seen answered.
