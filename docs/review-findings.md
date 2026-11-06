# Code review findings

A full review of the phase 1 engine was run on 27 October 2026 against the
whole of `packages/assess`. It produced 44 findings, most of them confirmed by
running the code rather than by reading it.

Roughly twenty are fixed and are listed here anyway, because knowing what was
wrong is what stops it coming back. The rest are open, and the open list is the
real agenda for phase 2.

The principle that decides priority throughout: **a wrong answer that looks
authored is worse than a parse failure, because a parse failure gets looked
at.** Most of the serious findings are variations on that.

---

## Fixed

### The accuracy gate was not measuring what it claimed

The 95 percent score counted a question as correct on text agreement alone, so
an item that carried an error finding and could not be used still counted.
`fixtures/standard-format/90-broken-keys.txt` was scoring 100 percent while
producing three unusable questions. Orphan mismatches and invented questions
were recorded as mismatches that nothing acted on.

Fixtures now declare the verdict they expect, through `verdict` on each
expected question, so flagging a deliberately broken item is the pass rather
than the failure. Structural failures are in the denominator. See
`test/harness.test.ts`.

### Answer keys were fabricated in four places

- A true or false question keyed `T` in an `Answers:` list came out as **False**,
  verdict `parsed`, no findings. `/^[a-t]$/` matched `t` before the true/false
  branch could, making that branch dead code.
- A true or false question with **no key at all** was stored as `correct: false`
  and `hasUsableKey` returned true, because the check had no `trueFalse` branch.
- `Type: TF` with the options listed False first inverted the key, because
  option `a` was assumed to be True without reading it.
- `checkAnswerKey` covered 5 of the 11 types, so six types had no gate at all.

`TrueFalseBody.correct` is now optional, so "no key" is representable and is no
longer indistinguishable from "the answer is False". True is found by reading
the option text. Every type that has a key is checked. `hasUsableKey` also
consults stored findings, because the importer knows things the finished body
no longer shows. See `test/answer-key.test.ts`.

### Two delivery fallbacks invented answers

`calculated` to `numeric` discarded the formula and the variables and wrote
`value: 0`, delivering an unsubstituted stem that scored a made-up answer as
correct. `hotspot` to `multipleChoice` produced options reading "Region 1",
which ask nothing once the image is gone, and a single-region item produced a
one-option question the model itself rejects.

Both are removed. The destination check now says the type cannot be delivered,
which is true. Doing either properly is a feature of that question type, not a
fallback.

### The rich-text subset was never enforced

The subset was documented as enforced "on the way in" and the exporters'
guarantee rests on it, but no write path called the sanitizer. A stem
containing a `<script>` tag validated, round-tripped through the bank byte for
byte, and would have gone to a player unchanged.

Three further holes in the sanitizer itself: `ALLOWED_TAGS` is a plain object,
so `<constructor>` and `<__proto__>` passed the allow-list by inheriting from
`Object.prototype`, and the same lookup crashed when given attributes. An
out-of-range character reference such as `&#x110000;` threw a `RangeError` that
made an entire bank unopenable, because the index is built over every stem on
open.

`sanitizeDeep` now runs on create and on edit and reaches nested bodies
structurally, so a body shape added later is covered without anyone
remembering. See `test/richtext-enforcement.test.ts`.

### The container trusted what it read

The CRC32 was written on every entry and never checked, so a flipped byte came
back as content with no error. The zip-bomb guard summed sizes declared by the
file, so an entry that lied walked straight past it: a 204 KB entry declaring
10 bytes inflated to 200 MB against a 1 KB limit. An overstated compressed size
returned the payload with the central directory appended as content, because
`subarray` clamps instead of failing. A bogus local-header offset produced a
raw `RangeError`.

All four are fixed, and duplicate entry names are now refused outright.

### Three ways to lose a question

A damaged line in `history.jsonl` made the whole bank unopenable, which is the
file most likely to be truncated by a crash. A `folders.json` missing `root`
threw out of the folder walk. Two files claiming one question id meant one
vanished silently, and vanished for good on the next save, with the
kept-but-unreadable copy winning on reopen.

All three now degrade rather than fail, and report what happened. See
`test/store-resilience.test.ts`.

### Findings were never recomputed

Nothing on any write path re-ran the checks, so an author who supplied a
missing answer key still had the error afterwards. The question stayed
`failed`, the error filter still matched it, and every feature built on
findings inherited the staleness. `editQuestion` now recomputes the codes the
engine can re-derive and reapplies dismissals, which are decisions about the
item rather than about one evaluation of it.

### The Standard Format scanner was one state machine with no context

Six data-loss findings came from one cause: `scan` in
`src/import/standard-text.ts` was a single mutable `target` whose pattern checks
ran before any check of context. It is now `src/import/standard-text-scan.ts`,
an explicit mode machine (`outside`, `stem`, `option`, `optionFeedback`,
`questionFeedback`, `tail`, `key`), and the builder stays in `standard-text.ts`.

- **A question after a mid-file answer key was destroyed.** The key never
  closed, and its entry pattern also matches a question line, so the next
  question was appended to an answer entry. A key block now closes at the first
  line that is not an entry for the questions it covers. A key belongs to the
  questions since the previous key, so numbering that restarts every chapter
  works, and a model answer only continues onto a following line when that line
  directly follows a prose value.
- **Multiple-choice options containing `=` became matching pairs.** Matching is
  now inferred only when nothing marks an answer (no asterisk, no key entry) and
  the left sides are distinct. Anything else is a multiple choice, and an
  unkeyed one fails instead of being guessed.
- **A stem line reading `Points: 20` reset every later question.** Title, Type
  and Points count as directives only when a question follows them, so inside a
  stem they are text. A directive that a later one replaces, or that has no
  question after it, is reported as an orphan.
- **Content after the options was relocated into the stem.** After a blank line,
  a feedback line or a label, text that is not structure is an orphan. A stem
  still runs over several paragraphs before its first option, and a question
  with no options at all is flagged when its stem continues past a blank line,
  because there a heading and a paragraph look the same.
- **Duplicate publisher labels overwrote each other.** Different values are
  joined with a semicolon and flagged; an identical repeat says nothing.
- **Duplicate question numbers shared one key.** An entry for a number that two
  questions of the same stretch share is applied to neither, both fail, and the
  file says the numbers repeat.

The rule that holds it together: every non-blank line is owned by a question, a
key, a directive that a question used, or an orphan. A final sweep turns anything
the machine missed into an orphan and counts it in `unattributed`, which the tests
require to be zero. `test/standard-text-scanner.test.ts` also generates 400
shuffled files, each line carrying a unique marker, and requires every marker to
come out somewhere.

That property test found three more places text was lost, all fixed the same way
(the words are quoted in the finding): feedback under an option on a type with
no per-option feedback, an Answers entry that was ambiguous or unmatched, and
key text that a question type cannot use.

Four smaller ones came out of the same pass. A key naming "True" against a
False-first list marked the False option. A key letter shared by two options
marked both. An unrecognised `Type:` line was ignored without a word. An
`Answers:` heading is now always a key heading, so it can no longer be absorbed
into the option above it.

### An unkeyed import could refuse to save the whole bank

A keyless fill-in-the-blank produced `accepted: [""]`, which the schema
rejected, so `openassess import file.txt --out bank.openassess` printed the
verdicts and then aborted with nothing written. `Points: 5000` failed the same
way at `Bank.add`. That contradicted the rule that an unkeyed question has to be
storable so it can be repaired beside its source text.

The rule now holds: **the importer only emits questions that pass
`validateQuestion`.** Feeding it shuffled files found six shapes that did not,
and each is handled so that the question is stored and says it failed:

- **An unkeyed blank.** The schema now accepts an empty string in `accepted`
  (fill in the blank and short answer), because that is how an unkeyed blank is
  stored and `checkAnswerKey` already reads whitespace there as "no key". A
  placeholder such as `(missing)` was the alternative and was rejected: it reads
  as a real answer, and the next edit would recompute the error away and leave a
  question that scores the word "(missing)" as correct.
- **Points over 1000.** The default is used, `PointsAssumed` (a warning) quotes
  what the file gave, and `MAX_POINTS` is one constant shared by the schema and
  the importer. `PointsAssumed` had been defined and never raised.
- **A choice question with one option.** A placeholder second option is added and
  `TooFewOptions` is an error. It used to import as a clean, parsed question.
- **An option with a letter and no text.** It keeps its place, so the key still
  points at the right option, with placeholder content and an `EmptyOption`
  error. In a matching question the empty entry is left out with a warning.
- **`Type: MA` with no options** had a placeholder body with no `partialCredit`.
- **A metadata label with no value,** such as a blank `REF:`, was stored as an
  empty string. It carries nothing and is skipped.

A placeholder only ever sits beside an error, and `hasUsableKey` now also refuses
a question carrying `NoOptions`, `TooFewOptions` or `EmptyOption`, because the
placeholder looks like any other option and the body alone cannot show it.

The `todo` test is now an assertion, over 800 generated files, and the generator
has a wider vocabulary: empty and half-empty options, matching pairs, every type
hint, points past the ceiling, long titles, images and raw HTML. The wider
vocabulary also exercised the "nothing is lost" property and found three more
places text vanished, fixed the same way (the words are quoted in the finding):
a title cut at 64 characters, the other half of a matching entry missing one
side, and option text on a `Type: TF` question that is not True or False.

### `hasUsableKey` accepted a key that named a missing option

`Type: MA` with options a to c and the entry `1. A, E` is `failed`, because E
does not exist and a `KeyLetterMissing` error says so. But A is marked, so the
body looks keyed, and `hasUsableKey` read only the body plus a short list of
stored problems that did not include that code. It returned true, and an
exporter relying on it would have emitted a multiple-response question missing
one of its right answers. `KeyLetterMissing` is now in `STORED_KEY_PROBLEMS`, a
dismissal still lifts it, and `test/answer-key.test.ts` covers the multiple
answer case, the single answer case and the dismissal.

### Zip entry names were trusted

Names came back from `unzipSync` exactly as the file had them, so `../../etc/evil.json`
round-tripped. That was harmless while everything stayed in a Map and becomes a
"zip slip" the moment media is extracted from a `.docx`, which is untrusted input.
`safeEntryName` now checks every name on read and on write: it refuses `..`, a root
or a drive, control characters and an empty name, and it reads a backslash as a
slash because some generators write them in Word files. Two names that become the
same are still caught as duplicates. The writer refuses a name the reader would
change, so what is saved is what comes back.

### The Standard Format is four dialects, and the importer read one

The vendor guides for the generic (IMS QTI), Canvas, Moodle, D2L and
Blackboard versions of the format each describe the format a little differently. The
importer implemented the generic one, and testing the guides' own examples
against it found five gaps:

- **`Type: MR` was unknown.** Moodle and D2L write multiple response as MR, the
  generic and Canvas guides as MA, and the Word formatting handout uses MR. It
  is now read as MA. With asterisks it was flagged for review; with an Answers
  list (`1. a d`, the handout's own example) it was read as single choice and
  failed.
- **A Type code of three letters was not a Type line.** The pattern allowed two.
  `Type: ORD` was reported as stray text and the question read as something
  else. It now allows three.
- **`Type: S` was unknown.** It is short answer in D2L and Moodle, written like a
  fill in the blank, and now imports as `shortAnswer`. This gives the type its
  first import path.
- **`FMB`, `ORD` and `JUM` were misread.** Fill in multiple blanks, ordering and
  Blackboard's jumbled sentence came out as a multiple choice with no key, or an
  essay marked only for review. They are now refused by name: kept as an essay
  with the options as its model answer, so no text is lost, with an
  `UnsupportedType` error so that the question fails. `hasUsableKey` reads that
  code too, since an essay is graded by a person and would otherwise pass.
- **A lone `@` after the stem was silently reinterpreted.** The generic, Canvas
  and Blackboard guides write feedback for an incorrect answer with `@` beside a
  `~` line. D2L and Moodle write general feedback with a single `@`. A lone one
  is stored as incorrect-answer feedback, as before, but is now flagged
  `AmbiguousFeedback` instead of coming out as parsed with nothing to say.

One more was my own regression. The guides repeat the question number in an
Answers list to give several accepted forms of one fill in the blank or short
answer (`1. Van Hook`, `1. Dr. Van Hook`). The scanner rewrite closed a key at
the first prose line that repeated a number, so each repeat became a phantom
essay question and the alternatives were dropped. The old scanner got this right
by accident, because it never closed a key. A repeat now belongs to the key when
the question is typed F or S, and stays a question when options follow it, when
it ends in a question mark, or for any other type. No fixture covered it, which
is why the gate stayed green.

Fixtures 12, 13, 95 and 96 cover these, written as original questions in the
formats the guides show. Run against the code before this change they scored 25,
0, 20 and 66.7 percent, and the whole corpus 74.2 percent.

### A key that two parts of the file disagreed about, and an Answer line folded into an option

Found building stage 3 of the Word importer. Publisher banks give each question's
key on a line after the options (`Answer: C`, `ANS: B, D`). The scanner had no
rule for it: straight after the last option it was folded into that option's text,
after a blank line it was reported as stray text, and in capitals it was kept as a
custom label, so the question had no key and nothing said why. `Answer:` lines are
now the question's own key (`ANSWER_LINE` in `standard-text-scan.ts`), read in text
files as well as Word files.

Separately, a key in words that two sources gave differently passed without a word:
the asterisks won and an Answers entry that said otherwise was never read, so `*b`
against `1. C` produced a clean question. Keys now come from the first source that is
there, in the order asterisk, `Answer:` line, Answers list, formatting, and where a
later source names different options the question carries a `KeysDisagree` warning
that says both. Only the sources that resolve to options are compared, so a letter
that names no option is still its own error.

### Explanations under the correct option became part of the option

Found while checking the claims above, and fixed straight after. A `Feedback:` or
`Rationale:` line directly under an option, with no blank line, was added to that
option's text by the same rule that joins a wrapped option. Under the correct option
the question came out `parsed` with the right answer altered
(`y<br>Feedback: because b`), and nothing said so. Publisher banks put exactly these
lines there.

`Feedback` and `General Feedback` are now feedback for the student
(`feedback.general`); `Rationale`, `Explanation` and `Solution` are kept as notes
under `metadata.custom`, with an information finding that does not stop the question
being `parsed`; a blank one is simply a label with nothing after it. Any other line
with the shape of a label (up to three words, a colon, something after it) directly
under an option, an option's feedback or a question's feedback is no longer joined to
it: it is reported as stray text, with the reason, where it can be seen. `Ans. B` is
read as a key, as `Answer: B` is. Fixture 14 holds the layout; with the Feedback rule,
or the rule against joining a label to an option, switched off, the gate falls from
100 to 96.8 percent. A stem is left alone, since a stem line with a colon is far more
often prose.

### A question file that was not JSON was deleted by the next save, and the app never said a file could not be read

Found on 5 November 2026, while making the app say what it could not read, and fixed there.

The engine reports every file in a bank that it cannot read, and keeps each one so that the next save writes it back as it was. One
case was reported and not kept: a question file that was not valid JSON (damaged by a sync that did not finish, say). It was listed
as unreadable and "kept untouched", and the first change made to the bank wrote the bank without it. It is kept now, byte for byte.

The app threw the report away when it opened a bank. A bank with an unreadable question looked complete, with the question
missing from the list and nothing to say why; a bank that lost a question file looked like a smaller bank. The report is now held
with the bank, and the bank screen says how many files could not be read (and which, and why) and that they are kept. A bank also
says how many questions it held when it was last saved (`manifest.questionCount`, written for years and never read), so a bank that
opens with fewer is told so, with a line that the missing ones are in an earlier copy; with more, that nothing is lost. `validate`
fails on it, and `info` says it.

The folder file had the same two faults. One that was not JSON stopped the whole bank from opening, although the code said a bank
with a broken folder tree still has its questions; one of the wrong shape was replaced by an empty tree, without a word, and
written back that way by the next save, so the author's folders were gone. The bank now opens with no folders, the file is reported,
and the damaged file is kept as it was under another name (`folders.damaged.json`, then `-2` and so on, never over an earlier one).

Found by fuzzing the bank reader (about 12,000 damaged banks, two crashes): a folder tree whose root was a list but whose folders were
not (no list of questions, a child that was not a list) passed the shape check and threw out of the walk that builds the index, so a
bank with a folder file damaged in the middle would not open; the check now goes through every folder, bounded in depth. A manifest
with no format said the file was "undefined"; it says it does not say what kind of file it is. The importers (Word, Excel, CSV, PDF,
text) and the scan reader were fuzzed the same way (about 45,000 damaged files and 3,000 damaged scans) and had no crash and no hang;
`fuzz-import.test.ts` keeps a small, quick, repeatable run of all of it.

### One control character in one question made an LMS refuse the whole file

Found on 5 November 2026 by exporting 12,600 sets of awkward text (control characters, half a surrogate pair, markup, quotes, emoji,
right to left text, very long text) through every exporter and checking what came out.

Moodle XML, a QTI package and a Common Cartridge are XML 1.0, which forbids the control characters other than tab and line break,
half of a surrogate pair, and U+FFFE and U+FFFF. A form feed from a PDF, a vertical tab from Word or half a pair from a damaged copy
in one stem, one option or one bank name made the file not well formed, and an LMS refuses such a file whole. The Moodle escape took
out some control characters (not the ones inside a CDATA, and not the surrogates), the Word printer the same, and the text and
spreadsheet formats took out none. A printed Word test with U+FFFE in a stem is one Word says has unreadable content.

`stripInvalidCharacters` (in `model/richtext.ts`) takes them out, turning a vertical tab and a form feed into a space (they are a
line break and a page break, and must not join two words). It runs when text is first stored (`normalizeCharacters`), at the door
of every exporter and every destination check (`exportable`, in `export/text.ts`, which copies a question only when a string in it
is cleaned), in the XML escape and CDATA of the XML formats, in `safeName`, and in the Word printer's escape. Markup, quotes, emoji,
right to left text and a leading equals sign come out as they went in. `export-awkward-text.test.ts` holds it, and fails on the old
code. The spreadsheet writer (`container/xlsx.ts`) already took out everything XML forbids.

### A matching question padded with `(missing)` lost its error on the next edit

The importer pads a matching question that has fewer than two pairs with `(missing)` on both sides, so that it can be stored and
repaired, and says with an error that it is not complete. That error is about a missing answer, which an edit works out again from
the body, and the body looked complete: "(missing)" is a word. So the first edit of any kind cleared the error, and a question with a
pair of placeholders became usable, exported and printed as if it were an answer. `checkAnswerKey` now reads a pair whose either side
is the placeholder (or empty, or only spaces; a picture or an equation is something) as a pair with nothing in it, so the error is
worked out again every time and goes only when words are written in. The same holds for the pairs GIFT pads.

### Two checks that could pass without checking

Found on 5 November 2026, while adding the item quality checks, and fixed there.

`Check OpenAssess.cmd` listed `sheet-paper.test.ts` and `zip-names.test.ts` with no space between their two quoted names, so the
shell read them as one argument and the zip name test was not run by the double-click check, whatever `npm test` said. The space
is there now, and the line was run through `cmd.exe` to see that every file in it runs.

A bank saved twice with the same `at` was not byte for byte the same: the files in the zip were stamped with the clock, not with
`at`, so two saves a tick of the two-second zip clock apart differed. One test ("saves a test under tests/ and opens it again the
same") saves twice and compares, and failed now and then (once in the run through `cmd.exe` that found it, passing in the runs
before). `Bank.toBytes({ at })` now stamps every file with `at`, and a
test holds the clock still and moves it to prove it.

### Found by reading the quality checks, search and bank code once more (5 November 2026)

A review of the day's work, each one run before it was fixed.

**Data kept, not dropped.** A file kept because it could not be read (`passthrough`) is written back under its own name, but when a
live file had taken that name the kept file was dropped, and so was a damaged line of the history (`history.jsonl`). Both are now
written under a free name beside where they were (`.kept`, `.kept-2`; `history.damaged.jsonl`), which nothing reads as a question,
so they stay as they are on every later open. A question file named for one id but holding another was reported as a file that
could not be read although it was loaded; it is marked `loaded` and the bank screen does not count it with the unreadable ones.

**Notes that spoke wrongly.** Two options that were the same apart from a symbol, a mark or a case were not called the same, and
two that were different words in a script with no capital letters were. Option text is now compared as written (`normalForm`: NFC,
case, spaces, the quotes and stops round it), words are split by `wordTokens` (a minus sign and a symbol stay), and two questions
whose numbers or symbols differ, with repeats counted, are not called alike. The a/an note no longer speaks about a single letter
or an acronym, whose first sound depends on how it is said. A question added from the app is written with its notes; one from an
import is not (the import gate counts findings, so a note there would move it).

**Search.** The last word typed was dropped when it was a stop word or one letter, so "in" found everything; a stop word at the end
of a longer search is still left out, but the last word of a short one is kept.

**The app.** A bank titled "open" could not be written to (its name was taken for the route that brings a file in); the route now
needs a POST with nothing after the name. A cell of the coverage grid opened a list that included the retired questions the grid
does not count (`hideRetired=1`). A running check could replace the pane an unsaved edit was in; the results now wait. A kind of
question the editor cannot write (a hotspot, opened from a cell) and a value no question has any more both showed as "All" or
"Any" with the list still narrowed to them. The Make a test search box was empty after a test was made but its word still hid
questions.

### Typography was flattened on the way in (fixed on 6 November 2026)

`normalizeCharacters` turned a curly quote into a straight one, an en dash into a hyphen, an em dash into two hyphens and an ellipsis
into three dots, on every piece of text a question stores, so that exact-match grading, search and QTI would not trip over them. It
was a rule from phase 1 that three later stages asked to have decided (it is listed below as an open item three times), and its cost
was seen on a real file: an instructor's em dash read `--` on the printed test and in every export. Measured on the 21 Word files
and 5 PDFs that are kept on this machine, 169 of 1,421 Word questions and 34 of 165 PDF questions hold at least one of these
characters, so about one question in eight was being changed.

`normalizeCharacters` now cleans only what has no place in a question (what XML forbids, a no-break space, a soft hyphen, a
zero-width space, the line endings). A new `foldTypography` gives the flat form, and it is used only where two texts are compared and
always on both sides: the check for copies (`normalForm`, `wordTokens`) and the accuracy gate's comparison. Nothing stored is folded.
Search already split on anything that is not a letter, so an apostrophe of either kind finds the same word, and the quality checks
already read both kinds of quote. The PDF printer already had the Windows Latin-1 place and the width of each of the seven
characters, and the Word file and every export are UTF-8, so nothing in print or export had to change; `typography.test.ts`
follows one question full of them through the importers, a saved bank, the seven exports, the Word file and the PDF, and fails if
the flattening is put back. The gate read the same before and after (61 of 61; 1,421 of 1,421; 129 of 157 for the PDFs).

What is not done: a short answer's accepted answers keep a curly apostrophe if the author typed one, as they always did, and a
student who types a straight one on an ordinary keyboard will not match it in a learning system that compares letters exactly.
That is a note for Check quality to make and not a rewrite, because the form a student types is not for this program to guess.

---

## Open, and roughly in the order I would take them

Items 1 and 2 were the scanner and the importer's output, and are fixed above.
The numbers are kept so that references to the others stay valid.

### 3. Decide what the delivery payload may carry (closed)

**Closed on 27 October 2026 by `docs/design-plan.md`.** OpenAssess is standalone
and nothing consumes this payload, so there is no consumer whose needs this
decision would serve. A table of questions carries its answers, as every LMS
import does. The question returns only if a web-quiz export is built (milestone
3), and it is decided there. The original note follows, for the record.

`toDeliveryPayload` hands the full answer key to the consumer: `correct` per
option, `accepted` for text, `right` for matching, `position` for ordering.
Scroll is an inline web page, so that puts the key in the client bundle. There
is no mode that strips it.

This is a design decision, not a defect, and it should be settled **before the
read contract is treated as frozen**. The test suite checks that the Bloom
level does not leak but never checks the key.

Related and smaller: the payload drops the `format` discriminator and emits
`stem.content` as a bare string, so a consumer cannot tell plain text from
markup. Fixing that also makes the preview path safe, since `richTextToPlain`
decodes entities and can turn stored `&lt;img onerror=...&gt;` back into live
markup in a picker UI.

### 4. Make `QuestionBody` a discriminated union

`type` and `body` are independent fields, so `{ type: "numeric", body: <an
essay body> }` typechecks. Every body consumer casts to `Record<string, any>`
instead of narrowing, and the `isChoice` / `isTrueFalse` predicates are used in
only two places.

Both fallback bugs above lived inside those casts and would have been compile
errors under a union keyed on `type`. This is the single highest-leverage
refactor available and it gets harder the more code accumulates.

### 5. Search does not scale and ignores accents (fixed on 5 November 2026)

**Fixed.** `SearchIndex` keeps the tokens of each question, so taking one out costs its own words and not the whole index (16,000
questions build in about a fifth of a second; the old index took about 6 seconds), and `rebuildIndex()` clears first. Text is
folded before it is split (`fold` in `bank/search.ts`): accents come off Latin, Greek and Cyrillic letters, ß, æ, œ, ø and a few
others are written as a person types them, and words are split on anything that is not a letter, a mark or a number in any script,
so "núcleo" and "nucleo" find each other, "für" is one word, and a single character of Chinese, Japanese or Korean is kept as the
word it is. The marks of other scripts (the vowel signs of Hindi) are part of the word and stay. `search-fold.test.ts` holds it.
The original note follows, for the record.

`SearchIndex.add` calls `remove` first, and `remove` iterates every bucket in
the whole token map, so index build is quadratic: 500 questions 112 ms, 2,000
questions 1.1 s, 4,000 questions 4.7 s. The index is rebuilt on every open, so
a 10,000-question bank is roughly 30 seconds to open. A reverse `id -> tokens`
map fixes it.

Tokenising splits on `[^a-z0-9]+`, so `núcleo` is unreachable by searching
`nucleo`, and `für` tokenises to two single letters that are both dropped,
returning nothing for text that is present. Unicode-aware splitting plus
diacritic folding fixes it.

The existing performance test uses a 20-word vocabulary, which keeps the token
map small enough to hide both.

### 6. Media is cosmetic

`[ img: "chart.png" "alt" ]` mints a `media/` path and never copies any bytes,
so imported images are permanently dangling and nothing flags it: `checkReferences`
validates ids but never that `MediaRef.file` exists in the container. Names
also collide across questions. The read contract has no operation that
resolves media bytes, so a consumer holding a payload cannot render an image.
Media is never garbage collected either.

### 7. Smaller open items

- ~~`checkReferences` covers 4 fields out of about a dozen.~~ **Fixed on 5 November 2026:** it walks every piece of rich text a
  question has (`richTextFields`), so a reference that dangles in option feedback, a matching question's left side, an ordering
  item, a model answer or a hotspot's alternative is found. The promised orphaned-sidecar check (a picture nothing points at) is
  still not implemented.
- ~~`Bank.add` leaves the bank partially mutated when the folder id is wrong.~~ **Fixed on 5 November 2026:** the folder is checked
  before anything changes.
- ~~A zip whose archive comment contains the EOCD signature is rejected with the wrong diagnosis; a truncated file reports "not
  a zip".~~ **Fixed on 5 November 2026:** the end-of-directory record is the first one from the end that accounts for the whole end
  of the file by its own comment length (a signature inside a comment is not taken for it), a file that starts like a zip and has
  no end says it was cut short and to copy it again, and an empty file says it is empty. A file cut at every possible length is
  held to a sentence and never a TypeError (`bank.test.ts`).
- ~~`isEmptyRichText` ignores math refs, so a stem that is only an equation reports empty.~~ **Fixed on 5 November 2026.**
- A link whose stored version is **ahead** of the bank is reported as behind it,
  with advice that would overwrite newer course content. This is the restored
  from backup case and needs its own status.
- Migrations are a mechanism with no content and no tests, and a migration that
  throws midway leaves a partially migrated bank that `toBytes` will stamp with
  the current format version.
- `toBytes()` mutates the manifest, so it is not idempotent (with a given `at` it now is, byte for byte).
  ~~`save()` has no fsync before the rename and leaves a stray `.writing` file if the rename fails. `rebuildIndex()` never
  clears.~~ **Fixed on 5 November 2026:** a save flushes before it renames, a failed save removes its temporary file and leaves the
  bank that was there, and the index is cleared before it is built again. ~~`manifest.questionCount` is written but never checked on
  open.~~ **Fixed on 5 November 2026:** a bank that opens with a different count says so (see "A question file that was not JSON").
- Four of the eleven types have no import path: ordering, numeric, hotspot and
  calculated. The D2L and Blackboard dialects document ordering, so it is refused
  by name rather than missing.

### 8. Found while rewriting the scanner and reading the format's guides, not yet fixed

- **The importer has no notion of dialect.** The format's guides tie a file
  to the LMS it is for. Here a lone `@` has to be guessed, and the guess
  is only flagged. The Type codes are a usable signal: MR and S point to D2L or
  Moodle, FMB and ORD to D2L or Blackboard, JUM to Blackboard. Detecting the
  dialect from them, with a setting to override it, would settle the `@`
  question without asking the author.
- **`FMB` and `ORD` are documented and the model could hold them.** `fillInBlank`
  already has a `blanks` list, and `ordering` is a type. Both are written plainly
  (`[rose, red flower]` in the stem; options in the correct order). `JUM` has no
  model type.
- **A `~` under an option is read as question-level feedback.** The Word
  formatting handout shows `~` after the correct option as that answer's own
  feedback; the guide appendix uses `@` there, even on the correct answer. Both
  styles exist, and the second is handled. No text is lost, but the meaning
  moves.
- **(Fixed on 6 November 2026: typography is kept as written and folded only for comparing; see "Typography was flattened on the
  way in".) Typography is flattened on the way in, and exports show it.** Curly quotes
  become straight, an en dash becomes `-`, an em dash becomes `--` and an
  ellipsis becomes `...` (`normalizeCharacters`, applied by the sanitizer to
  every piece of rich text). The reason is sound: that noise from Word breaks
  exact-match grading, search and QTI. But an instructor's em dash will read
  `--` in Author, in an LMS and on a printed test. Decide whether the exporters
  should put the typography back on the way out, or whether the model should
  keep it and normalise only where a destination needs it.
- **A picture or equation marker is reported for the file, not for the question.**
  The Word importer writes `[picture]` or `[equation]` where one stood and counts
  them in a file-level finding, but nothing flags the question that holds the
  marker, so it can come out `parsed` with the figure it depends on missing. Fine
  for a first slice, wrong for the 95 percent target. Stages 6 and 7 read the
  content, and until then the question should carry a finding of its own.
- **(Fixed on 5 November 2026: a Rich Text file, by name or by what it begins with, goes to the Word importer, which does not
  read it and says to save it from Word as a `.docx`; the text importer no longer claims `.rtf`.) The text importer claims `.rtf`.** Its extensions are `.txt`, `.rtf` and `.md`,
  so an RTF file is read as plain text and its control words come in as stray
  text. RTF is out of scope; the extension should go, and the Word importer's
  message for an RTF file ("save it as .docx") is the better answer.
- **This importer reads on after the answer list, where a stricter reading would stop.**
  Deliberate, since a question after a mid-file key is more likely real than
  meant to be dropped. Recorded so nobody restores the stricter behaviour.
- **For the Word engine.** The appendix recommends the Answers list "when using
  Auto Numbering and Auto Lettering", because those numbers are not in the text.
  The Word handout tells authors to remove lists, tabs, indents and all bold,
  italic and underline for the same reason. Rebuilding question numbers and
  option letters from Word's list definitions, and keeping the formatting, is
  where this importer can do better than the tool it reads.

- **A true or false question keeps only its answer.** `Type: TF` with options
  that are not True and False (Yes and No, say) is flagged for having no key.
  The option words are now quoted in an `OptionNotKept` warning rather than
  vanishing, but they are still not stored.
- **(Fixed on 5 November 2026, see above.) A matching question padded with `(missing)` pairs loses its error on the next
  edit.** The padding satisfies the schema, but its error is `NoAnswerKey`, which
  `withRecomputedFindings` re-derives from the body, and `checkAnswerKey` sees
  two complete pairs. The choice placeholders use codes that are not re-derived,
  so they are safe; matching needs a code of its own.
- **A numbered line inside a stem starts a question.** A stem that lists steps as
  `1. Plan`, `2. Do` is cut at the first of them. The scanner cannot tell the
  two apart from the line alone; a run of numbers that continues the stem's own
  numbering would.
- **Feedback over several paragraphs is cut at the first blank line.** The rest
  is now an orphan, where it used to be appended. Visible, but not what the
  author wrote.
- **A question with no options can read as a key entry.** After an `Answers:`
  heading, a line such as `10) Explain X.` is taken as an entry when 10 is a
  number the stretch above already used and no options follow it. The words are
  quoted in a finding, so nothing is lost, but the question is.

### Hidden text and text in boxes (stage 5)

- **Hidden text was read as ordinary text.** Nothing looked at `w:vanish`, so a note to self or an old answer left hidden in
  a bank turned up in a stem, an option or the key. **Fixed:** it is left out and counted, the file quotes the first, and the
  rules (a toggle, a hidden paragraph that has no text left is not a blank line, it still takes its list number) were checked
  against Word. See `docs/word-import-plan.md`, stage 5.
- **Open: a hidden paragraph mark that still has text.** Word joins that paragraph to the next one, so Word counts one paragraph
  fewer than the file holds. The reader keeps it as a line of its own, and the file says how many marks are hidden. It is
  left out of `check:word` for that reason, and is not a case any real file has been seen to hold.
- **Open: document defaults that hide text, met by a character style that hides too.** Word does not apply the plain toggle
  there and the reader does. No file sets hidden text in its defaults.
- **Open: a question that stands in a text box is not read.** It is counted and quoted, and the message says it is in no
  question and no orphan, so it is looked for. The text could be offered as an orphan with the place of its anchor, so that a
  repair screen could show it, but a box has no sure place in the reading order of the page, and a margin note read in the
  middle of a question would be worse than a note about one. Decided against until a real file holds a question in a box.
- **Open: the XML for boxes was written by our test writer, not by Word.** `check:word-authored` has Word write tables, lists
  and bold; it does not yet write a text box or hidden text, so how Word spells a box, and what `mc:Fallback` holds in a real
  file, is read from memory of the format.

### Found by watching a recording of the window (stage 9)

The first person to use the export screen in the installed window recorded what happened. Two defects, both in code that had
tests, and both invisible to them:

- **Fixed: Show in folder opened the Documents folder and showed nothing.** The server ran `explorer.exe /select,<path>` and
  Node, given an argument with a space in it, put quotes around the whole of it, `"/select,C:\...\Quiz - Brightspace.csv"`.
  Explorer cannot read that, and falls back to the Documents folder without a word. A path with a space in it is nearly every
  path (a two-word bank title, the ` - Brightspace` suffix, a Windows user name with a space), so the button rarely worked on
  an exported file; only a one-word title with no space anywhere in the path got through. The argument is now passed as Explorer wants it, with the
  quotes around the path (`revealCommand`, tested), and a path with a quote mark in it is refused. The old call and the new one
  were each run against a file with spaces in its name, and where Explorer landed was read back: the old one reached
  Documents, the new one the Exports folder. The test of the route had stood in for Explorer, so it could not have seen this.
- **Fixed: Download saved the file and said nothing.** In the window a link with the download attribute sent the file straight
  into the Downloads folder, with no dialog and no message, so it looked as if nothing had happened and it was pressed again
  (three copies of one export were in Downloads). Two ways of fixing it were tried and one failed on the first real use:
  - The page's own save dialog (`showSaveFilePicker`) was written first and tested in a browser with a stand-in for the
    dialog. In the installed window it is offered (`typeof` says function, in a secure context) and then never opens: the call
    is made and never answers. The person who used it saw no dialog. A stand-in cannot show that, which is why the next one was
    tried in the built window itself.
  - What it is now: the link is a plain link again (`ui/files.js`), and the window's shell (`shell/src-tauri/src/main.rs`)
    answers any download of one of this app's own files with the system's Save dialog, the file's name filled in and the type
    set. Showing the dialog from inside the window's download event does not work: the dialog is owned by a window whose thread
    is waiting for it, so it never appears (once it returned the default path at once, and once it never returned). So the first
    request is declined, the dialog is shown from a thread of its own, and when a place has been chosen the same address is asked
    for again and let through to it. Closing the dialog drops the download. A download of anything else is declined. This is the
    first Rust crate the shell has beyond Tauri (`rfd`, the system's file dialogs, on Windows only); the page still has no
    command to call.
  - Checked in the built window, by pressing the real link and finding the dialog among the shell's own windows: it opens titled
    "Save a copy" with the name filled in and "CSV file" as the type; closing it saves nothing and changes nothing in Downloads;
    pressing OK writes one new file at the chosen path, byte for byte the exported file. Not done by a hand on the dialog.
  - The four sample buttons on the first screen had the same problem from the other side. Their Save a copy wrote the file
    into the Exports folder without asking where, opened the folder, and left a numbered copy behind each time it was pressed
    (`solar-system-test-bank 4`, `... with-problems 3`). Seen in a recording of the window. They are now links to
    `/files/samples/<id>`, which serves the sample's own file by an id of the fixed list (never by a name), so the same dialog
    asks where it goes and nothing is written into the library. The route that wrote the copy (`POST /api/samples/<id>/save`)
    is gone. Checked in the built window the same way: the dialog opens with the sample's name and "DOCX file", closing it
    saves nothing, and accepting it writes one file identical to the sample.
  - Two checks of this were first written carelessly: a script that pressed controls by their ids pressed file-list rows (ids
    "1" and "2" are not Save and Cancel in this dialog), and so overwrote two files in the Downloads folder of the person who
    was testing (`PDF TB 2 - Brightspace.csv` and `PDF TB 1 - Brightspace (2).csv`). Both were restored from identical copies
    (same hash as the untouched sibling downloads and the export). The check now posts OK or Close to the one dialog it found,
    only ever saves under a name no file has, lists Downloads before and after, and removes its own file.
- **Fixed: a key chosen by hand did not clear the importer's error about the key.** In the recording a person ticked the right
  answer on a question whose Answer line disagreed with its option (`Verbally bullying` against `Verbal bullying`), pressed
  Apply changes, and the question stayed Failed with the same error under Checks, which says an error goes when the question
  is fixed. It did not, because the findings about the key the file gave (`KeysDisagree`, `KeyLetterMissing`) were kept on
  purpose: the importer knew something the finished question no longer shows. Both such questions were then left out of the
  save. The decision, taken when asked: an answer chosen by hand replaces what the file's key said. The rule (`answerOf` and
  `replaceFileKeyProblems` in `quality/answer-key.ts`, called by `editQuestion`) is narrow on purpose:
  - It happens only when the answer itself changed, which is the options marked right (by id, so that rewording an option or
    taking away a wrong one is not a change), the true or false, the accepted answers. A new stem, a new title, a reworded
    option or a case setting leaves what the file said, and the question stays Failed, because the file's key is still the one
    applied.
  - It happens only when what was chosen is a usable answer. Two marked on a single-answer question, or none, is not, and the
    findings stay with the new error beside them.
  - It touches only those two codes. A question kept as an essay (`UnsupportedType`), a placeholder option (`EmptyOption`,
    `TooFewOptions`, `NoOptions`) and every other finding stay as they were, and a question carrying one is still not usable.
  - Nothing is deleted and nothing is chosen. The findings are dismissed by whoever chose and are listed on the screen as
    "Replaced by your answer", with the words they had; the history entry says that the answer was chosen and which codes it
    replaced; the save says so ("Your answer replaces what the file's key said"); an earlier dismissal is not rewritten.
  Seen on the screen in a browser (an import with the same fault: two errors before; after ticking B, one listed as replaced,
  the other gone, the question Parsed and the toast as above), and by 13 deliberate breaks of the rule, every one caught
  (the first run missed one, a check that case is not an answer, which hid behind the usable-answer test and now has its own).
  **The same class, since fixed (below):** a placeholder option that a person had replaced with real words kept its error.
- **Fixed: a placeholder option that was written over kept its error.** When a file has an option with a letter and no words, a
  question with one option, or a question with none, the importer keeps the question, writes `(missing)` where the words should
  be, and raises an error (`EmptyOption`, `TooFewOptions`, `NoOptions`). Writing the words in left the error, so the question
  stayed Failed and not usable (`hasUsableKey` reads those errors) after it was repaired. Not seen in a recording: found by
  reading, and reproduced by a test that failed before the change. The rule (`quality/placeholders.ts`, called by `editQuestion`
  beside the answer rule) replaces an error when what it says is no longer so:
  - "Option C has no text" goes when that option, found by the place it had, has words or is gone, so a question with two
    placeholders keeps the other's error until it is written too;
  - "only one option" and "no options" go when there are two or more options and none is a placeholder;
  - a placeholder typed in again, left as it was, or replaced by spaces keeps all of them, and so does one option left after the
    placeholder is taken away. It reads the question as it is, so an error that went stale in a bank before this rule goes at
    the next edit of that question.
  Nothing is deleted and nothing else is touched: the errors are dismissed by whoever wrote the words and listed on the screen as
  "Fixed by your words", with what they said; the history entry says so; the save says "The words you wrote replace the
  placeholder". Seen on the screen in a browser, and by 13 deliberate breaks, every one caught (the first run missed one, that
  one option left after the placeholder is taken away must keep its error, which has its own test now). A matching question
  with fewer than two pairs is a placeholder of another kind and is not covered: its error is raised as `NoAnswerKey`, which an
  edit re-derives from the body and so drops while the placeholder pairs are still there. Not seen in a recording; open.
- **Fixed: a printed question could be split across a page.** In a recording of a printed student copy opened in Word, question 6
  ended page 1 with its choices A and B and went on with C and D at the head of page 2. The layout tied only a question's wording
  to its first choice (`keepNext`), and the choices after the first were free to be separated, in Word and in the PDF. Measured with
  Word itself (`check:word-print` now has it say what page every paragraph of a long test starts and ends on): before, Word split
  20 of 180 questions (12 of 90 in a student copy, 8 of 90 in the key); after, none, at the cost of a long test being about a page
  longer (19 pages to 20 here), since a question that would have been split moves whole. Every part of a question but its last is
  now tied to the next, in every kind of question, and the last never is. That also fixes an older fault of the same kind: a
  question made of its wording alone (a blank in the text, nothing to write under it) was tied to the question after it. A
  question taller than a page is still broken where it must be (Word and the PDF writer both give up on a chain that cannot
  fit; the PDF's is tested). 8 deliberate breaks of the layout, the PDF writer and the Word writer, every one caught.
  The PDF is checked by taking it apart, not by Word, so how it looks is for a person (`TESTING-TODO.md`).

### Found while building the Brightspace question library export (stage 9)

`src/export/d2l-csv.ts`, tested by `test/export-d2l-csv.test.ts` (31 tests, one of which runs the real banks in the private
fixtures folder when they are there). 35 deliberate breaks of the exporter, on a baseline that passed: 34 caught, and one
survives because it is equivalent (the guard against a true or false with neither answer chosen is behind the key check, which
leaves such a question out first; it stays as defence and as the narrowing the types need). Two breaks survived the first
tests, both missing assertions (the note on a fill in the blank written as a short answer; a matching question with one pair),
and have tests now.

- **Fixed: the file's own comment row was quoted.** The first row is a `//` comment, and its text had a comma, so the writer
  quoted the cell and the line began with a quote mark, not with `//`. A reader that looks for the two slashes at the start of a
  line would not have seen a comment. The comment has no comma now, and a test reads the first line for a quote mark.
- **Decided, not fixed: what the CSV cannot hold is said, and left out where it would be a guess.** A numeric question, a fill in
  the blank with several blanks, a hot spot and a calculated question have no row Brightspace's CSV imports, and are left out
  with the reason. Feedback for one answer, for a right answer and for a wrong one, a rubric, a model answer, difficulty, tags and
  pictures are lost and named against the question.
- **Open: only three of the seven types were seen arriving in a Brightspace course; all seven were later reported to work.** The format was read from Brightspace's
  published article, in the browser, because a fetching agent reported the pages unreadable. The tests hold every exported file,
  including 1421 real questions, to a second reading of that article, so they find a file that departs from it. A recording of
  the first real import (1 November 2026) shows 13 multiple choice, 10 true or false and 5 written response questions arriving
  as 28 questions of those types with 1 point each, and the true or false that was opened showing the source's answer. Not seen:
  the right answer on each multiple choice question, and any multiselect, short answer, matching, ordering, formatted or
  accented question. A second file with all seven types (the twelve question test bank, 1 November 2026) was then imported and the
  person who did it said it worked fine, without a record of each question, so those types are reported and not seen. Whether the
  article is complete, and how Brightspace treats a row it does not know, is not known (`TESTING-TODO.md`).
- **Open: Course Import's QTI.** Brightspace's Quizzes tool imports QTI up to 1.2 (a package for it is built, below) and its
  Course Import takes a subset of 2.x and 3.x, which is not built.

### Found while building the QTI 1.2 and Blackboard exports (stage 10)

`src/export/qti12.ts` and `src/export/blackboard-upload.ts`, tested by `test/export-qti12.test.ts` (37 tests) and
`test/export-blackboard-upload.test.ts` (33), and two routes in `packages/app/test/server.test.ts`. 47 deliberate breaks of the two
exporters and the app's file writer, on a baseline that passed: 46 caught, and one survives because it is equivalent (the Blackboard
guard against a true or false with neither answer chosen is behind the key check, which leaves such a question out first; the
QTI exporter has the same guard and it was not in the list of breaks). Three survived the first tests. Two were missing
assertions and have tests now: text stored as plain text keeps a tab that would end a field (the model's own text turns a tab into
a space, so only a hand-built plain-text field shows it), and a matching question with a blank left side.

- **Fixed before the first run: matching conditions stopped at the first match.** QTI 1.2 stops at the first condition that is met
  unless it says `continue="Yes"`, and a matching question adds one share for each right pair, so the first draft would have
  scored one pair at most for a standard processor. The response processor in the tests follows the standard's rule, and a
  break of this is caught.
- **Fixed: the shares of a matching question added up to 0.99999.** A three-pair question worth one point had three shares of
  0.33333. The last share is what is left, so they add up to the points exactly. Found by the response processor on its first run.
- **Decided: a file can be bytes.** `ExportedFile` has an optional `bytes` beside `content`. A zip written as text would be damaged,
  and the app test reads the first two bytes of the file on disk and compares the download with it byte for byte.
- **Decided, not fixed: what neither tool documents is left out.** Ordering, numeric, hotspot and calculated questions are not
  written to a QTI file, because neither Brightspace nor Canvas says it reads them from one. Feedback and the partial credit of a
  multiple answer question are not carried in this first version. Blackboard's file has no points, feedback, formatting or picture,
  and a numeric question is left out because the page does not say what its tolerance means.
- **Decided, after the second try: a Common Cartridge package, in the form a Brightspace quiz tool writes.** The QTI zip was tried
  a second time by the Course Admin route a published import guide documents and "still does not like the format" (no message recorded). D2L's
  course import table names Common Cartridge 1.0 to 1.3 with QTI 1.2.1 as a source its importer reads, and Brightspacosaurus 0.35.0,
  which builds Brightspace courses and was published days before, writes quizzes as a Common Cartridge 1.3 package in the QTI
  profile and says to import them with Import Components, from a course package. `src/export/common-cartridge.ts` follows its
  shape (`test/export-common-cartridge.test.ts`, 29 tests, and one more in the app's route tests; 31 deliberate breaks, 30 caught
  at once and one, the order of answers when some are fixed, caught after an assertion that it had been missing). The tool's source was read
  in the browser on 1 November 2026, as data. The profile has no matching, ordering, numeric, hotspot or calculated question, so
  those are left out with where they can go. A short answer is written as a fill in the blank. True or false and essay follow the
  profile's description and were not in that tool's output, so they are the least certain. The package has not been imported.
- **Open: the QTI zip was tried twice in Brightspace and did not make questions.** The person who tried it said the zip "just uploaded as a zip" and that
  the structure of the file may be at fault; they did not say which screen they used. My note had sent them to the Quizzes tool's
  Import or the Question Library's Import, and D2L's own Question Library article (updated August 2026) names a CSV file, not
  QTI, while a published import guide documents Course Admin, Import/Export/Copy Components for a QTI zip. So the route was probably wrong, and
  the note now gives that route. It is not settled that the package is right: D2L's course import table lists QTI 1.2.1
  and IMS CP 1.1.2, 1.1.3 or 1.2, and that importer may want a package it recognises as one of the sources it names (Blackboard,
  Common Cartridge and others) and not a bare one. The QTI package is written from the standard, from the shapes Canvas is known to
  write (its `question_type` and `points_possible` metadata fields, one response for each left side of a matching question, a
  condition of every right label and none of the wrong ones), and from help pages. No Canvas-written package and no
  Brightspace-accepted QTI file was available to compare with: the example a D2L staff member posted in the community thread is a
  Blackboard question pool (`questions.dat`), not QTI. The names Canvas uses are from memory of its own export, not from a file
  read here. The resource type `imsqti_xmlv1p2`, the questestinterop namespace and the matching layout are the likeliest things
  to need changing after a first import.
- **Open: the sources for Canvas are thin.** The guide that could be read is for Classic Quizzes, dated 2021, and names no QTI
  version. Canvas's own community document was not found at its address, so "QTI 1.2 and 2.1" rests on a secondary source.
- **Open: what Blackboard does not say.** The encoding and line endings of the upload file, whether a quote at the start of a field
  must be doubled, whether HTML is accepted, and whether Ultra refuses an ordering row are not stated or not tried
  (`TESTING-TODO.md`). Blackboard's own pool package and its QTI import are not written: the first is undocumented and Ultra reads
  only pools exported from Original, and the sources disagree about the second.

### Found by the first real PDF test banks (stage 8)

Five PDFs from one typesetting program, kept in the private fixtures folder. Fixed, each with a test that fails when
the fix is taken out (47 deliberate breaks of the PDF reader, its paragraph rules and the answer-line reading, every one caught
once the tests that were missing were written, on a baseline that passed):

- **An `Answer:` line of prose marked an option from the words in it.** The scanner split an answer entry into words and took
  every single-letter word for an option letter, so `Answer: c. <the option's words>. <a reason with the article "a" in it>`
  marked option A. In one of the PDFs four of six such questions came out keyed A when the document said otherwise (two were
  right by luck), each only warned about ("key text not used") and not failed, so a wrong key was applied and looked as if it
  had been read. This was never a PDF problem: any bank whose Answer line carried a sentence could do it. It is fixed in the
  scanner. An entry that is nothing but letters is a key as before (`B`, `B, D`, and `B, Z` still applies B and says Z was not
  used); a longer one is read only where its letter and its words name the same option, or where its words are exactly one
  option's; where they name different options it is an error that quotes both, and no answer is marked; and prose names
  nothing. None of the 21 real Word files (1421 questions) changed. Two answers in one PDF disagree with their own options in
  the document (the letter says one option and the words another), and are refused and said.
- **A question number typed with two full stops (`13..`) was not a number.** Its options fell into the question before it, which
  became a multiple response with eight options, flagged but wrong, and every question after it was off by one. It is the same
  number now.
- **The heading "True and False" was text no question claimed.** "True or False" and "True / False" were headings.
- **The command-line `review` showed a table's or a PDF's bytes as its source lines.** It shows the importer's own lines now.
  (The table half of this was found in passing, from stage 7.)
- **Found by reading the pages and fixed in the reader**, not by the scanner: a running title and a page number are not text of a
  question and are left out, counted and quoted; a line-end hyphen cannot be told from a real one by looking, so it is kept
  unless the document spells the word whole elsewhere ("self-concept" had come out as one word); a subscript is part of its line;
  a wrapped line in a list set at one and a half line spacing is still the paragraph above; a stem has more room above its first
  option than two options have between them, and that is not a blank line; a picture is set apart and marked, and had stuck to
  the end of an option.

Open:

- **A numbered outline before the questions becomes questions.** The first PDF begins with a lecture outline whose eight numbered
  items have no options and no type, so each is read as an essay, flagged for review ("the file did not say what kind of
  question this is"), and shifts every question after it, so that it scores 0 percent by position although its 28 real
  questions are right. A rule that told an outline from a list of essay prompts would have to guess, and numbered essay prompts
  with no heading are common. The pdf-publisher test holds exactly this state so that it cannot get worse unseen.
- **Columns are read across, and the file says so only when long text stands on both sides of a wide gap on several lines.** A
  two-column page of short lines would not be told.
- **A table in a PDF is its lines of text**, with a tab where there is a wide gap, so a table of questions or a matching
  exercise laid out as a grid reads as text and not as pairs. The one rating scale in these banks read as a line.
- **A picture, an equation drawn as a shape, and a Greek letter set in a font whose text map is missing** are not text. A picture
  is marked. The others are not seen: the first question of one PDF reads "(1, 2, 3, 4." where its sentence has four named
  groups, because the file's own text has no such characters, and nothing in the file says they were meant to be there.
- **Answer text matching is strict.** An answer that spells the option's words another way ("Speaking" for "Spoken") is refused
  and said. It could be matched loosely and would then sometimes be a guess.
- **Only one typesetting program's PDFs have been read.** A PDF from Word's own export, a desktop PDF program, Google Docs, a scanner with text recognition or
  a publisher's tools sets its text another way (one piece for each word, text in reverse, text in a form drawn page by page), and
  none has been seen. The reader handles what the five and the test builder have: simple and composite fonts with a text map,
  an encoding with changes, packed objects and a stream for the table of objects, compressed streams with predictors, the
  old-style table, and a damaged table by searching. It does not handle: LZW-compressed streams, a protected file (refused even
  where the password is empty), text that is turned, CJK fonts with their own code maps, or tagged-PDF structure, which would give
  the reading order directly.
- **A scan (a picture of a page) is refused.** Reading it needs character recognition, which is a service or a model.

### Found while building the question table importer (stage 7)

Fixed while building, each by a test that fails when the fix is taken out. 47 deliberate breaks of the importer and its
readers were made, and two got through until a test was added for each; 8 more were made in the sample routes, and one got
through until a test was added:

- **A note with the word Question in it was read as the row of column names.** Found by the blank table the app offers: its
  sheet of instructions has a row that begins `Question`, and the importer took it for the names and read the instructions
  below as essays. A row below the first now has to name two known columns, and a sheet of notes is said in a line, not
  warned about.
- **A table in a layout nobody had told it was read in the template's order.** `Nothing,Useful` would have put "Useful" in
  the question and "Nothing" in the type. Author does this on purpose. Here, with no names in the first row, a file is read in
  the template's order only if its first cells are question types, and any other is refused with a message.
- **A sample could have been saved by a plain GET.** The route checked the method only by accident, through a later "not
  found". A GET needs no special header, so a page on another site could have asked for it. There is a test that no GET
  imports or saves.
- **An Excel error read as text could have named a letter.** A cell of `#N/A` in a Correct column is empty, and the question
  says so.

Open:

- **A date or a time in a cell is read as the number Excel stores.** The workbook's number formats are not read. A Points or a
  Correct cell is never a date, so this changes nothing a key depends on, but a stem that is a date would read as 46023.
- **Merged cells** have their words in the first cell and nothing in the others, as Excel stores them. A merged Category over
  several rows tags only the first.
- **Rich text in a cell** (bold, a superscript) is read as its words, and the formatting is not kept. A picture or a comment
  on a sheet is not read, and is not counted either.
- **Hidden rows are read.** A filter hides rows without removing them, and a person who filtered to the questions they
  wanted may not want the rest. The file says how many were hidden. Whether to read them is the person's to say.
- **A formula with no stored result is read as empty and named.** A workbook written by a program that never calculated it
  (some report generators) has such cells, and the person is told to open it in Excel and save it again.
- **Only A to H are answers.** A table with answers in nine columns has the rest named as not used.
- **Author's own reader was not run against a workbook this writes.** The columns and the codes are the ones its
  documentation and code give, and the template it ships reads here as five questions with their keys, but the reverse (a CSV
  this writes, read by Author) belongs to the exporter, which has not changed.
- **Excel itself has checked the reader, on one machine and one version.** `check:excel-authored` made 246 comparisons: every
  cell Excel wrote, in the workbook and in the three text files it saved (CSV, CSV UTF-8, Unicode text), against what Excel
  says it holds; and the workbooks this project's own writer makes (the samples, the blank table) opened in Excel, which
  opened all of them without repair, with the header bold and the drop-down in place. Google Sheets and LibreOffice write their
  own variants of the same XML, and no workbook from them has been read.
- **A PDF is refused.** See `docs/design-plan.md`.

### Found while building the app, the cheap formats, printing and the window (stage 6)

Fixed while building, each with a test that fails when the fix is taken out (the fix was removed, the test run, and the
file restored and compared byte for byte):

- **Two saves at once corrupted a bank.** The second save read the file again after the first had started writing it. A
  bank now has one queue for its writes (`BankStore`), and a save that was made from an older copy is refused.
- **Ids made in the same millisecond did not sort in the order they were made.** Ids are now increasing within a
  millisecond (`test/ids-order.test.ts`).
- **A question made by hand showed as `parsed` with no key.** Its checks were never worked out. A new question has its
  findings recomputed, and a half-written one (text, no key) is storable and shows its error.
- **Emptying difficulty or an objective did not clear it.** The engine merges metadata, so the field was set to undefined.
- **A key arriving in the address was answered with a redirect, and the redirect was turned away.** The window's first load
  starts on another site, and a browser does not send a `SameSite=Strict` cookie on any hop of that. The key is now answered
  with a page that moves on by itself, and the cookie stays Strict. The window found this; the browser pane could not.
- **The content area drew a focus ring** when the app moved focus to it for a screen reader. The ring is off for that
  element, and the controls inside keep theirs.
- **The window's icon was a broken-image symbol, in every size.** The first set was made from a picture that had failed to
  load. Found by extracting the icon from the built exe and looking at it; it is now made from `ui/icon.svg`.
- **The window's log wrote the start-up line with the key in its address,** which its README said never happened. The key is
  now left out of that line. The server's own requests were never logged with their query.

Open:

- **PDF output is Latin-1 only and untagged.** A character outside it prints as `?` and the print check says which. A PDF
  with no tags is read poorly by a screen reader; the Word copy is the accessible one. Embedding a font is the repair, and
  was not done because it needs a font file that can be shipped.
- **A printed multiple response reads back as a single answer with two marked.** The importer then flags it, which is the
  honest result of its rule. Printing a key in a form the importer reads as a multiple response is not worth bending the
  importer for.
- **Matching and ordering are shuffled on the student copy** by a seed taken from the question's id, so the same copy prints
  again. The key shows the true order.
- **The installer is not signed.** Windows will say the publisher is unknown. A certificate costs money and is the
  publisher's decision.
- **The window needs the Edge WebView2 runtime.** Windows 11 has it. Where it is missing the installer fetches Microsoft's
  bootstrapper, which is an outside download that was not exercised here.
- **Nothing here has been run on a clean machine**, only on the machine it was built on.
- **The page was looked at in a browser pane and in the window, at desktop width.** Phone width, dark colours, a screen
  reader and the keyboard alone were not looked at by a person.

### Found by a blind test on sixteen generated files that passed the checker (stage 4h), not yet fixed

The first set written to the new brief and held to its plan by `npm run check:generated`: pieces 1 to 4, files
c-01 to c-16, sixteen files in sixteen layouts. Piece 1 came in one zip and passed after four stems in its answer
files were fixed in a copy; pieces 2 to 4 came in another, from a second AI assistant, and passed at first sight except one repeated
matching instruction (c-15), which made the repeat check ask for the same stem and the same items and not the stem
alone. The importer was run on them once, with no rule changed since stage 4g (`6dccbe3`). It read **47 of 232
questions, 20.3 percent.** The first number is the honest one. What it shows:

- **Seven files read as empty.** The importer made no questions from c-03, c-04, c-05, c-08, c-14, c-15 and c-16,
  and every line of each is reported as stray text with an error that says no questions were found. Nothing is
  dropped. What is not read: a question that begins `Q1.`, `Question 1:` or `(1)`; a chapter and question number
  with the text on the same line (`3.1 Which ...`); questions with no number and options with no label, the right
  one marked by highlight or bold (the type-line layout needs its `MC` lines); and options labelled `A:` or `(A)`.
  `1.` and `1)` with `A.` and `a.` are read.
- **Four files were read, and read wrongly.** A key table at the end (c-07) was read as 15 questions, each
  an essay whose stem is a letter, and the real questions were left as stray text. A bank with Word's own numbering
  and bulleted options marked `(Correct)` (c-11) came out as 14 essays with the options inside the stem. A key list at
  the end (c-13) was taken for questions in the same way. Several options to a paragraph, split over two paragraphs,
  with the answer at the end (c-09), made options that are merged pairs or too few, and 5 of its 12 questions failed.
  All of this is flagged or refused except the next point.
- **One question was wrong and was not flagged.** In c-09, `A. mother   B. aunt` and `C. sister   D. grandmother
  ANS: C` became two options, `mother B. aunt` and `sister D. grandmother`, with the second marked right, and the
  verdict was `parsed`. The key points at the right words, but the question has two options where it has four and
  nothing says so. Of the 105 questions the importer made, 47 are right, 52 are flagged for review, 5 are
  refused, and this one is wrong and looks fine. Pairing every imported question with the expected one by its stem
  (68 pairs), no key named the wrong content: of 4 differing keys, 3 were refused and this was the fourth.
  **Fixed, in the first step of the stage 4h rules.** The cause was that "B. aunt" is not taken for an option when a
  lower case word follows the letter, so that "C. difficile" in the middle of a sentence is left alone, and all of this
  bank's options were lower case. A gap of two spaces or a tab before the letter now says a new option begins,
  whatever follows it. And options lettered with a letter missing (A and C, no B) are a warning on a choice question
  whatever caused them, because that is what a question looks like when two options were not told apart. After it
  c-09 reads 10 of 12 (from 4), the question has its four options and the right key, and no question in the sixteen
  files is wrong and not flagged. Not fixed: a bank whose options share a line on a single space, with lower case
  words, is still not split, and is now flagged and not passed.
- **Four files with typed `1.` or `1)` numbers or Word's own numbering, `A.` or `a.` options and a mark by an Answer
  line, bold or a font colour read 62 to 86 percent** (c-01, c-02, c-06, c-10). The misses there are two to six
  questions each, mostly of types the file does not name. They have not been looked at.
- **What this set is.** Sixteen files from the brief and the plan, so far more varied than the first two batches,
  which were five and six documents. It is still invented and still says nothing about what real banks do. It is
  not counted toward the criterion of three real chapters.
- **It is no longer blind.** To say what failed, the first lines of the seven empty files and two questions of c-09
  and c-11 were read. Any later score on these files is a second contact and not a first. The rules for the layouts above
  should be written from pieces 5 and 6, which exist to be fitted to, and these sixteen run again afterwards.
- **The failures follow the layout, not the author.** A second, independent version of pieces 3 and 4 arrived
  (`c_files_piece3_and_4.zip`: the same eight assignments, different questions). It passed the checker after five stems
  were repaired in a copy, the two mistakes already seen in piece 1: three statements with their `(T)` or `(F)`
  left in the stem, and two stems written without the document's space before a question mark. Run once with no rule
  changed, the importer read 15 of its 114 questions (13.2 percent), against 14 of 114 (12.3 percent) for the first
  version of the same eight files. Layout by layout the two agree: six of the eight layouts score no question right
  in either version (c-11 to c-16), c-10 reads 10 and 12 questions right, and c-09 4 and 3. So the gap list above
  is a list of layouts, and it did not depend on who wrote the files. These eight
  are kept as material to fit to, since their layouts are the ones already read about in the blind set.
- **The fit set, and its baseline.** Pieces 5 and 6 (`test-banks-c17-c24.zip`, written with the corrected brief) passed
  the checker at first sight with nothing repaired. With the second version of pieces 3 and 4 they make a fit set of
  sixteen files, which the stage 4h rules are written from. Importer unchanged, before any rule: **44 of 230 questions,
  19.1 percent**; pieces 5 and 6 alone read 29 of 116 (25.0 percent). Eight layouts read nothing in either set: a
  question that begins `Q1.`, `Question 1:`, `(1)` or `4.1 text`, no numbers at all, options labelled `A:` or `(A)`, and
  options that are bullets marked `(Correct)`. The sixteen blind files are run again after the rules, as a second
  contact.
- **A second version of pieces 5 and 6 arrived the same way**, in `c_files_pieces_1_to_6.zip`, which also held pieces
  1, 3 and 4 again, byte for byte the files already held (twelve of its twenty files; it had no piece 2). The eight
  new files passed after five stems were repaired in a copy, the same two kinds of mistake. With the safety fix in
  place, the importer read 33 of its 116 questions (28.4 percent) against 31 of 116 (26.7 percent) for the second assistant's
  version of the same eight, and layout by layout the two agree again: `1.` with `A)` and a key table, `1)` with
  several options to a paragraph, and Word's numbering with `a.` and a star each read 9 to 14 questions right in
  both, and `Q1.`, `Question 1:`, `(1)`, no numbers and `4.1` read none in both. The checker had a fault that this
  version showed: an option whose words begin with a star (the hard case assigned to c-18), in a file that marks
  its answers another way, was taken for the key mark and skipped, so the answer file's correct option was
  reported as not in the document. Both readings are now tried.
- **After the question starts, the safety fix and the end marks** the fit set reads 115 of 230 and the blind files 122 of
  232. A numbered list inside a stem, in a file whose questions are numbered `2.5`, `(2)` or `Q2.`, had been read as
  questions, and gave one question that was `parsed` with a right key and half its stem; that was the only wrong question
  marked `parsed` found in any set, and it is fixed. Still read as nothing or as junk, by layout: no numbers at all with unlabelled
  options (c-04, c-14, c-23); bulleted options (c-11, c-21); and a key at the end, as a table or a list, that is read as
  questions, so that its rows are made into essays, each refused or flagged and each counted against the score (c-07, c-13,
  c-22). The lines `Correct: C`, `(Correct)` at the end of an option and a star at the end of its line are read. Also two
  rules the importer lacks: two letters on an answer line with no type, `ANS: A, B`, are a multiple response, and a blank
  `____` with a plain `Answer:` line is a fill in the blank. No question wrong and marked `parsed`, in any of the
  five sets, compared by stem on type, options, key, accepted answers and pairs. Two answer files were corrected after the
  importer disagreed and the documents were read: c-13 (a statement with `Answer: false` under it is true or false, not a
  fill in the blank with the answer line in its stem) and c-15 (the instruction is repeated as a second paragraph of
  the stem, and the answer file had dropped it).
- **After the keys at the end** the fit set reads 135 of 230 and the blind files 143 of 232; the real files are 1421 of
  1421, the gate 61 of 61, and no question in the five sets is wrong and `parsed`. A key under `Answer Key`, as a list
  (several entries to a line, or one, `4.1. B`, `3: B`, `True`) or as a table, is a key, and the rows are no longer made into
  questions (c-07, c-13, c-22). A heading followed by questions is still the copy with the answers. Breaking the rules found
  a fault the generated files had not reached: a key list with a dash, `n/a` or `none` in its first or middle entry was not
  recognised as a key at all and was read as questions. A dash now means the question has no key, and never an answer: a
  choice question given one is refused and a fill in the blank with its own answer keeps it. Left alone, and recorded here: a
  lone plain entry such as `9. A` under a key, for a number no question has, is read as a question and flagged, as it was
  before, and not as an entry applied to nothing.
- **After the two types read from the answer** the fit set reads 149 of 230 and the blind files 155 of 232. No type named
  and two letters on the answer line or in the key: a multiple response, flagged. A blank in the stem with an answer in
  words: a fill in the blank. Both rules refuse to read a letter answer to a stem with a blank, because that is a choice
  question's key and its options may have been lost. Two blanks and one answer is read and flagged for the count. Still
  not read: no numbers at all with unlabelled options (c-04, c-14, c-23) and bulleted options (c-11, c-21).
- **After reading a bank with no numbers and no letters** the fit set reads 183 of 230 and the blind files 175 of 232. This is
  the layout that most needed a guard: reading a file by its shape alone is where a question that is wrong and looks right can
  come from, and the first version of the step put one into the results (c-21: a stem of two paragraphs, the second read as an
  option, the question `parsed` with five options and half its stem). The guards are listed in the plan, step 6. Still wrong in
  principle and not caught: a stem of two paragraphs where the second is a short phrase that does not end in a question mark
  or a colon, and options that are all long. They read as a stem and options and look right. The file is told that it was read
  by its layout, which is the only warning such a question has, so the first few questions of any file read this way are
  worth checking by eye (`TESTING-TODO.md`). Bulleted options (c-11) are read since the reader says which blocks are bullets;
  the fit set reads 184 of 230 and the blind files 187 of 232. A statement with `(T)` or `(F)` at its end is read as true or
  false where the file does it three times or more; after it the fit set reads 190 of 230 and the blind files 190 of 232.
  What is left is flagged on purpose: an answer in words with no blank and no options is an essay or a short answer and the
  file does not say which, and two marked options without a type may be a multiple response or a slip.
- **The files are on this machine only** (the session's scratch folder, `generated/blind`,
  `generated/second-author-3-4` and `generated/second-author-5-6`), not in the repository.

### Found by a blind test on a generated batch (stage 4g), not yet fixed

Twenty-four Word files that another model wrote from `docs/synthetic-bank-spec.md` were run with no rule
changed. The blind set read **23 of 48** and the set that may be fitted to 10 of 24 (33 of 72), and after the
stage 4g rules 42 of 48 and 20 of 24. The first number is the honest one. What it shows and what it does not:

- **The batch was five documents, not 24.** The files are identical but for the title line: three questions
  each, 15 distinct questions in all where the brief asked for about 600, in one layout (a typed `1.`, an
  indented `A.`, a star before the letter, an `Answer:` line). `layouts.md` describes parenthesis numbers,
  `Q1.` prefixes, bold answer marks and bulleted options, none of which is in the files, and `checker.py`
  checks that stems appear in the text and prints success whatever it finds. A generated batch has to be
  checked against its own XML before it is believed. This one measures one layout from five angles, so it
  says nothing about layout variety, and it never counts toward the criterion of three real chapters.
- **What it did show is a real gap, and a narrow one.** 29 of the 39 misses were questions whose type the
  file never names: a statement answered `True` or `False` (10), a blank or a question answered under
  `Accepted answers:` (14), and a matching exercise written as `Bell = Telephone` lines (5). All came out as
  essays with the answer in the stem or no key. Nothing was dropped and no key was invented. The other 10
  differed only in the verdict.
- **No question had a wrong key.** The 24 with no answer marked were all refused.
- **The three readings are not flagged for review, and the choice is a judgment.** The rule has been that a
  type worked out from the shape of a question is flagged. These are worked out from the answer itself or from
  the pairs, so there is nothing to check but the type, and a bank of forty answered statements would carry
  forty warnings on questions that are right. Each leaves an information finding that says what the type was
  read from. If a reader would rather be asked, the change is one flag in `inferType`. What stays flagged: an
  essay with no answer (a guess between essay and short answer) and a choice question with two stars and no
  type (a guess between multiple response and a slip). The generator expected both to be `parsed`; they are
  the 10 that still differ, and the expected files were left as written.
- **`Accepted answers: Paris, France` is two answers.** The plural label names a list, and a list is cut at
  its semicolons or, with none, at each comma followed by a space (so `1,000` stays whole). A single answer
  that has a comma in it is cut wrongly, which the question says, with the forms. The singular label
  (`Accepted answer:`) is never cut. The alternative, never cutting, gives a grader that accepts `0, zero`
  and nothing else, which is worse and does not look wrong.
- **Two holes were found by probing, not by the tests.** A matching exercise that looks complete and is
  missing a pair is the wrong answer that looks authored. A repeated left side on the third line left the
  first pair in the stem and read the rest as the exercise; a note or a blank line in the middle of the pairs
  left the rest as stray text under a `parsed` question. Both are closed (the run must begin right after the
  instruction, and a pair-shaped line after the run is a warning) and have tests.
- **Not read:** an answer of `T` or `F` on a statement with no options (`F` is also fluorine), a blank in the
  stem with an ordinary `Answer:` line and no label (read as an essay, with the answer kept, as before), a
  stated `MT` over lines of pairs with no letters (it fails and says so), and a wrong answer to go with the
  pairs.
- **The brief has been rewritten, and the checker is ours.** It asks for four files at a time, in six pieces,
  and gives each file its layout from a plan (`test/tools/generated-bank-plan.ts`): how a question begins, how
  options are labelled, how the right one is marked, the other types, one hard case, a subject, a size and a
  number of lapses. `npm run check:generated` reads each file's Word XML itself, holds it to the plan, reads
  the key out of the document by the assigned mark and compares it with the expected file, and fails on a
  repeated question. It rejects the first batch on every count (size, missing types, layout, the repeated
  stem, missing marks). It was tested on documents written in every assigned layout, on documents Word wrote,
  and with 80 deliberate breaks, which found and fixed three faults of its own: empty paragraphs that Word
  writes with attributes swallowed the table after them, the repeat test ignored digits, and 34 checks had no
  test that could fail them. It was first tested on python-docx output when the other model gave a script
  instead of files for piece 2: run in an empty environment (python-docx 1.2.0), it wrote c-05 and c-06 and then
  stopped on an undefined variable in c-07. The checker read c-06's `List Number` paragraphs as Word's own
  numbering (14 of 14), and read bold from c-05, so those two are now tested on real python-docx output. Not yet
  seen from python-docx: `List Bullet`, highlight, underline, font colour, a table with a heading row, and a
  line break inside a paragraph.
- **A second generated batch ("round 2") had the same fault, and is recorded so it is not scored again as if it
  were new.** It was written under the first brief, before the checker existed. It has 24 files named like the
  first batch's, but they are 6 distinct documents copied four times with a different title, 2 or 3 questions
  each, 14 distinct questions in all and none of them the first batch's. It is in the first batch's layout
  (typed numbers, indented `A.` options, a star before the letter, `Answer:` and `Accepted answers:` lines),
  with no Word numbering, table, bold, underline, highlight or colour anywhere. So it says nothing about layout
  variety and is not the blind set. Run with no rule changed, after the stage 4g rules, the importer read 44 of
  56, which is 11 of the 14 distinct questions. The three it did not are the verdict only, on cases that stay
  flagged on purpose: two questions with two stars and no type word, and an essay with no answer. Content was
  right in all 14, the one question with no answer marked was refused, and no key was wrong. That is evidence
  that the stage 4g rules carry over to new questions in the layout they were written for, and no evidence
  about any other. The batch's own `layouts.md` and `checker.py` were not read. The files are on the machine
  only (`banks-round2`, in the session's scratch folder), not in the repository.
- **The first piece written to the new brief (piece 1, c-01 to c-04) passed the checker on one file of four, and
  the three that failed taught two things.** All four problems were in the answer files and none in the Word
  files: two stems that had swallowed their `(T)` and `(F)`, which the brief says to leave out, and two stems
  written `...?` where the document has a space before the question mark (a lapse the assignment asked for). The
  second was the brief's fault. It said differences in spacing are ignored, and the scorer ignores only runs of
  spaces, so an answer file that tidies a slip would make a correct import score as wrong. The brief now says to
  copy the words character for character. The checker's messages were also poor ("not found"), and now say
  that the text is there and spaced differently, and show both. With the four stems fixed in a copy the four
  files pass, and nothing else was behind them. The copy is what is kept for the blind run, and pieces 2 to 4
  were asked for with the corrected brief. The importer has not been run on piece 1: the blind set is scored
  as one, after all four pieces pass.

### Found by a blind test on thirteen openly licensed files (stage 4f), not yet fixed

Thirteen files from one instructor's physical science course, shared under a CC BY 4.0 licence, were
found on the open web and run with no rule changed. They read **0 of 618** questions, and after the
stage 4f rules 618 of 618. The first number is the honest one. What it shows and what it does not:

- **The first-contact record is now about 3 percent.** Counting the first run of each real file before a
  rule was written for it, the importer has read about 33 of 1,231 questions (the 2002 exam, which has no
  key, is left out). Of the 13 files, none was a near miss: the layout had no numbers and no letters, so
  nothing was read. The earlier figures are in the entries below; some count questions read rather than
  questions scored, so the total is rough.
- **The 100 percent is fitted again, to one author.** There are now 21 real files, none of them a test of
  rules written without it, and the 13 new ones share one instructor's habits, so they are one layout and
  not thirteen. The acceptance criterion of three chapters the rules were not fitted to is still not met.
- **Only the choice types have a type line.** `MC`, `MA` and `MR`. A bank that writes `TF`, `E` or `FIB` the
  same way, with a stem and then an answer, is not read: the line is stray text and so is what is under it.
  None of the 13 files had one (one file has three lines that say `SM`, `PM` and `AM`, which are options
  of a question about radio waves).
- **A stem of more than one paragraph is read with its second paragraph as the first option.** The key is
  unaffected, since the star is on the option it names, but an option appears that is not one. Nothing
  says so. The 13 files have none, and neither the shape of the file nor the star gives a way to tell.
- **Two questions with no blank line between them are flagged, not split.** A type line among the options
  of a question gives a warning that two questions may have been read as one. It is a warning and not a
  split because an option can be the word `MA` (a degree), and the cost of the mistake if the two were
  merged is a key that belongs to the other question, which the warning is there to catch.
- **A question whose type line was left off is read, and flagged.** Three files each ended with one. The
  importer guesses where it starts, from the stem and two or more options with exactly one star, and
  says so. A last question that had no star would not be read, and is stray text.
- **A star in front of the words is the key whether or not the author meant a literal star.** An option
  that begins with `*` as part of its text, in a file that marks keys this way, is a key. The stem and the
  middle of an option are left alone (`What is 3 * 4?`, `3 * 4`), and one question in the files has a star
  at the end of its stem and no starred option, which is correctly refused.
- **One question had no key in the source.** Lesson 6 has a question with no starred option, so it is
  declared failed and no option is chosen. Worth fixing in the file by hand.
- **The number given to such a question is the one it comes in, from 1.** A file that mixes numbered
  questions with these would have numbers that repeat, and the file would say so.
- **The first expected-file writer got one question wrong.** It ignored a line break inside a paragraph
  and glued an option onto a stem. The importer disagreed, the XML showed the break, and the script was
  fixed. The lesson is the one the files already taught: the expected-file writer is a reader too, and a
  disagreement is a thing to look at in the document, not to settle in either one's favour.
- **The licence and the credit are as the page gave them.** The page says the test banks are shared under CC BY
  4.0 and were authored, remixed or curated by the platform that hosts it, and names no author. The files are kept on the
  machine in `fixtures/publisher/` with the others. Whether to commit them as fixtures, with
  attribution, so that the check runs from a clone is a decision owed.

### Found by a blind test on three more files (stage 4e), not yet fixed

Three files the rules had not been written for were run with no rule changed. They read 200 of 200
(refused, correctly), 25 of 45 and 0 of 33, and after the stage 4e rules 200, 35 and 33. The honest
number is the first one. What it shows and what it does not:

- **The five-files-100-percent result did not carry over.** Of the three new files, two needed new rules
  before they read at all, and the third was only a partial surprise because it is another chapter of a
  bank already read. Rules written from the file that needed them fit that file. The three are now fitted
  to as well, so there are eight files and none of them is a test of rules written without it. The
  acceptance criterion of three chapters the rules were not fitted to is still not met.
- **The 2002 exam has its answers in another file.** The importer reads one file. Questions that come from
  a document with no key are refused, one by one, which is right, but the instructor has the key in
  a second file next to it and the importer cannot use it. A second file as a key is a feature to decide on,
  not a bug: it needs the user to say which file, and it matches by number, so it has the repeated-number
  problem of the Answers list.
- **The explanation under an answer is a note, not feedback.** The default proposed was to make it
  feedback. The profile already refused that for `Rationale:` and `Explanation:` labels, because feedback is
  what a student is shown, so the unlabelled explanation is kept the same way, under
  `metadata.custom.Rationale`, and not shown to students. If the model grows a field for the explanation of
  an answer, both should go there.
- **A question whose stem a line wrap broke is flagged for review.** The importer joins a number that is not
  the next one to the stem above it, and says it guessed. A bank that restarts its numbers with no blank
  line and no heading between two questions that have no options (two essays, say) would have the second
  joined to the first, and flagged. Rare, and visible, but it is a guess.
- **Options that share a line are split at their letters, and a stray capital letter can be one.** `A. Vitamin
  B. Rigel` is read as two options, because B follows A and a capital letter follows the full stop. Only
  capital letters in order from A, so the cost of the mistake is a split option, which the file reports
  (how many lines were split), and not a wrong key.
- **The formatting of an option that shares a line is not read.** A question whose options share a line and
  whose key is bold has no key from formatting, and says so. Right, but it means a bold-keyed bank laid out
  like that gets no keys at all.
- **An answer at the end of a line is read only with `ANS`, `Ans`, `Answer`, `Answers` or `Correct Answer`
  and a colon.** `Key: C` or `(C)` at the end of an option is not.
- **A KEY line is read as fields only when its fields are separated by bars and each has a label.** The
  continuation across Word's paragraphs is only for such a line.
- **Matching in terms, definitions and foils is read as one exercise.** An instructor who meant ten
  separate one-pair questions gets one ten-pair exercise, flagged for review. The difficulty of the items
  goes to the exercise: the first is used and the rest are kept as a custom label with a warning.
- **`(Difficulty n)` and the other bracketed notes are metadata whenever the label is known.** A stem
  line made entirely of a known label in brackets would be read as metadata.
- **Two files could not be read at all, and are not Word files.** A publisher test generator's book file (a
  proprietary binary container) and a Blackboard question pool export (an IMS package with a QTI `.dat`, 31 questions: 22
  multiple choice, 6 true or false, 4 essay, 1 matching). The Blackboard one is plain XML and is the first
  test of a Blackboard importer.

### Found while reading three more of one instructor's banks (stage 4d), not yet fixed

A 375-question test item file, a 42-question chapter and a 30-question bank went from 0, 0 and
5 questions read to all of them, through the real harness. What that does not show:

- **Five real files is not five tests.** Every rule was written from the file that needed it, and
  each of the five reads at 100 percent because of that. There is no file yet that was read
  by rules written without it. Four of the five are one instructor's, so layouts and habits
  are shared among them. A sixth file, ideally from someone else, is the first real test of the rules.
- **The two `.doc` files reached the importer as `.docx` that Word made from them.** The importer reads
  `.docx` only, so a file that is a Word 97-2003 binary has to be saved as `.docx` first. Word read copies
  in a separate hidden Word and the originals were not touched, but a person with no Word would not have
  this route: LibreOffice and Google Docs both save `.docx`, and neither was tried.
- **The large file has two questions with no usable answer in the source.** 7.11 reads `fasle` and 10.5
  has no answer line. Both are reported and have no key, which is what the expected file says, and both
  are worth fixing in the file by hand.
- **A letter alone on a line is an answer when most of the file does it.** If a file did it for 80
  percent of its choice questions and also had a wrapped option ending in a lone letter that names an
  option, that letter would be taken for the answer of its question when it has no other. Rare, and the
  file says how many answers were read this way, but it is the nearest this comes to guessing.
- **`Textbook reference` is read as the question's section.** It names a section of the book, and
  the model has a section; that is an interpretation. Any other note on an Answer line that names a
  source is kept as a custom label, with a warning, and not as the section.
- **Page numbers are now a question's Page wherever they stand in brackets.** A bank that used a bracket
  such as `(Page 3)` in the middle of a stem on a line of its own would have it taken off the stem.
- **A matching exercise with no text of its own uses its heading as its text.** It says so, and the
  question is flagged for review. A matching table with another shape (two columns, no numbers, more
  than twenty rows) is not read as one.
- **A fill in the blank given as a finished sentence is read only for bold.** Underlined or italic
  answers, and a sentence that goes over more than one line, are not.
- **`(T)` and `(F)` are read at the end of a line only under a true or false heading.** The same letters at
  the end of a line in any other section are part of the words.
- **A chapter title is only `Chapter` and a number or word, with `Test Questions` or `Questions` after.** A
  title such as `Unit 3 Questions` is not one, and is added to the question above, as before.
- **Dotted numbers are `chapter.question` only.** `1.1.3` and `A.1` are not read.
- **`Answer: c (or d)` reads `c` and warns**, as it did before; the `(or d)` is in the warning, not in the
  key. A question this ambiguous is probably better with no key. Left alone because it is older than this stage.
- **The model's character rule now applies to the right side of a matching pair and to distractors.**
  The em dash that becomes two hyphens is still the phase 1 rule, still worth deciding about, and now
  in more places. (Decided on 6 November 2026: the rule is gone, and typography is kept.)
- **Essay and short answer questions in these banks have no model answer**, and none was expected.

### Found while reading a second real file, typed by hand (stage 4c), not yet fixed

An instructor's manual chapter, 28 questions, went from 3 of 28 to 28 of 28. What that does
not show:

- **It is the author's own bank, typed in one habit.** A star after the letter, "1)" numbers,
  options after three spaces. Another instructor will mark the key another way: a star after
  the words, "(Correct)" at the end, the answer on a line under the question, bold. Some of
  those are read and some are not, and none has been seen in a real file but this one's.
- **Only the ODT reached the importer, by way of Word.** The same chapter came as ODT, EPUB, Markdown
  and a Google Docs link. A separate hidden Word opened the ODT and saved a .docx, which is
  the file measured. A .docx that Google Docs writes itself, with its own XML, has not
  been read, and is the file this author would really have.
- **The Markdown copy reads 0 of 28.** `.md` is accepted as plain text, but a Markdown export
  escapes the bank's own characters ("1\)", "\*"), writes headings as "###" and bold as
  "**", and none of that is undone, so no line looks like a question and all 112 are reported as
  stray text. Nothing is lost and nothing is guessed, but nothing is read. EPUB and ODT are not read
  at all, and nobody has asked for them.
- **"Question numbers repeat" is said about a file that is fine.** Each section starts again at
  1, there is no Answers list, and every question carries its own mark, so a repeat cannot
  take a wrong key. It is kept on purpose (a test says so) and worth narrowing to a
  file that has an Answers list, or to repeats inside one section.
- **A typed star is not a key in a file that does it in fewer than three questions or fewer
  than 80 percent of its choice questions.** Flagged, with a file message that says why. A short
  quiz of two questions marked this way fails for lack of a key, as it did before.
- **An asterisk before every option of a question says nothing**, as a bold letter on every
  option says nothing, so that question is left as typed and fails for lack of a key.
- **Essays have no model answer in this bank**, and none was expected. The title line "TEST BANK"
  is reported as stray text, as the two title lines of the first chapter are.
- **The harness does not check the shape of an expected file.** A question whose expected
  `correct` was written as the number 0 and not the list `[0]` was not checked at all, which
  is how three questions passed unchecked until the file was fixed. A wrong number other
  than 0 is reported, but the shape is never refused.

### Found while reading the first real publisher file (stage 4b), not yet fixed

The first real chapter went from 0 of 60 to 60 of 60, and the following are what that does
not show or what was decided on one file's evidence.

- **One chapter is not three.** The 95 percent target is on three real chapters. Five real files
  have since been measured (four of them one instructor's, described above), and this one is from
  one publisher, laid out one way. The rules above were each written for a piece of that file, and
  the next publisher's file will use another. The chapter is kept only on the machine, so the
  measurement cannot be rerun from a clone.
- **The copy with the answers is found by a heading that ends in "Answer Key".** A bank whose
  answers follow a heading such as "Answers", "Instructor Version" or "Solutions", or sit in
  a separate file, is not recognised, and a fill in the blank or essay answer under its question
  is then read as more of the stem, as it always was. The questions fail honestly (no
  key), and nothing is made up, but they fail. A copy with the answers that comes
  before the copy for students is also not folded: once the heading is seen, everything
  after it is taken as the copy with the answers.
- **A fill in the blank or essay answer is read from its position and the heading, not
  from how it looks.** In the real file the answer is bold and underlined, and nothing checks
  that. A second paragraph of a stem under an answer key heading would be taken as the answer. The file
  says how many answers were read this way, but only as information.
- **Short Answer is read as an essay with a model answer.** A paragraph cannot be matched exactly,
  so it is not an auto-graded short answer in the model's sense. If a bank means the short
  answers to be exact, the instructor would need `Type: S`. A decision to confirm.
- **Several blanks are split only on semicolons**, and only when the parts are as many as the
  blanks. "one or two", "one, two" and a different count stay as one blank and are flagged.
- **The model turns an em dash into two hyphens** (`normalizeCharacters`, from phase 1), so
  a stem that has an em dash in it comes out with two hyphens in its place. It was found
  because the real file has em dashes and a comparison disagreed. It is the model's rule and
  not this stage's, and an em dash is punctuation, not noise, so it is worth deciding whether
  it should stay. (Fixed on 6 November 2026: it stays.)
- **The greyed-out letters are taken to agree, not asked.** The side that picks out fewer options
  in more questions is the key. That is right for bold on one and grey on the rest, and it would
  be wrong for a file that greys out the one right answer and bolds the others, which is not
  plausible but is not impossible. A mark and its opposite on two options is a tie and takes no key.
- **The two title lines at the top of the file** ("Chapter 07", "Communication") are reported as stray
  text. They are the chapter's number and name, and could be read as metadata.
- **The sections the heading list does not know** are not headings: "Matching" is one and gives
  the type, but matching questions in tables are still unread, so they fail with a message.
- **Word was not asked about the real file.** The sample documents Word wrote agree with the
  reader on the layout and on the formatting of the letters. The real file was checked
  against an independent reading of its XML, which is weaker evidence than Word's.

### Found while building table layouts (stage 4), not yet fixed

- **The layouts were chosen from the plan, not from banks.** A grid headed Question and
  A, B, C, rows that begin with a label, and an answer key are the shapes the plan named.
  The one real table-based bank seen so far used none of them (stage 4b, a number in one cell
  and a table for each option), so the header names, the check-mark set and the conditions
  are still a reasoned guess. Eight documents written by Word from a script read right; a
  publisher's own layout is the real test.
- **A key marked by shading is not read.** Shading a cell or a row green is a common way
  to mark an answer in a table, and `w:shd` is not looked at (the same gap is recorded for
  formatting).
- **Matching questions as a two-column table are not read**, and neither is a question that
  spreads over several rows of a grid or whose options are the rows below it with a
  stem cell merged down. Those tables are read cell by cell, and the file says so.
- **An unknown grid column makes stray text for every question.** `Column: Source file:
  chapter3.docx` is reported once for each row, which is honest and noisy. A bank with a
  `Chapter` or `Source` column should have it mapped to a metadata label, and the right
  list is something real banks will say.
- **A type column accepts only the one to three letter codes** (`MC`, `MA`, `TF`). A
  column that says "Multiple choice" is kept as stray text and the type is guessed.
- **Option columns stop at T**, like option letters everywhere, and a header such as
  "Answer A" is an option while "Answer" alone is the key, which a bank could mean the
  other way.
- **A heading-less table of a number and a letter is an answer key even when it is a
  question** whose stem is a single letter. Deliberate (see the plan), but it is a choice.

### Found while building answer keys from formatting (stage 3), not yet fixed

- **The convention is a statistical reading, and has only met files our own writer
  made.** It takes a mark as the key when at least 3 choice questions and 80 percent
  of them show it. Those numbers are a judgement, not a measurement. Real banks will
  say whether they are right: one that marks the key in only 70 percent of its
  questions is refused, and one that bolds options for another reason in 80 percent
  would be believed. The dialect pack and the real chapters are the test. Until then
  the file-level report, which names the mark and the counts, is the safeguard, and
  `keyMark` lets the author say what the mark is or turn it off.
- **A question keyed by the convention has no finding of its own.** That is the
  plan's choice (flag the outliers, report the habit once) and it is what lets such a
  file reach the 95 percent. The cost is that a wrong convention gives wrong keys that
  all look authored. The preview screen should show the file-level report first and
  make it easy to switch the mark.
- **Only the formatting of an option's own text is read.** Shading on a cell or a
  paragraph (`w:shd`), a strike-through, and a mark on the option's label are not
  marks. Highlighting by shading is common in tables, which stage 4 reads.
- **A line straight after an option is still added to the option when it has no
  label shape.** Labels are fixed (below), but `Answer B` with no colon, or a
  sentence of the author's own, directly under an option still becomes part of that
  option's text, as a wrapped option always did. It is not flagged. A line that
  starts the way a note would ("See also the next chapter") cannot be told from the
  second line of a long option by its shape. The preview should show where each
  option's text came from, and a heuristic on long, punctuated continuation lines
  would be worth trying against real chapters.
- **An `Answer:` line needs its colon (or `Ans.`) and ends at the end of its line.**
  An essay's model answer that wraps onto a second paragraph is a stray line, reported.
- **`Rationale`, `Explanation` and `Solution` are kept as notes, not as feedback, and
  that is a decision to confirm.** A question has no field for an instructor's
  explanation, and making it feedback would show it to students. If real banks use
  them as the explanation students should see, the label would map to
  `feedback.general` instead, which is one line to change. `Feedback` and `General
  Feedback` do map to `feedback.general`, which the Author spreadsheet cannot carry
  (the destination check says so).
- **Two letters in an Answer line on a question with no Type are an error, not a
  guess.** `Answer: B, D` with no `Type: MA` reads as single choice with two keys,
  where two asterisks would have made it a multiple response question. Matching the
  asterisk would be reasonable.

### Found while building Word list numbering (stage 2), not yet fixed

- **Spelled-out and non-Latin number formats are not read.** Word's "One" and
  "First" (`cardinalText`, `ordinalText`) and the many non-Latin systems are
  reported as unread and the paragraph is left unnumbered. Word reads them. Add
  the ones a real bank uses.
- **A style that Word drops is dropped without a word.** A paragraph whose style
  asks for a list level that another style holds is not numbered by Word, and is
  not here. That matches the page, but the author sees a missing number and is not
  told why. A finding could say that N paragraphs use a style that asks for a level
  another style holds.
- **A paragraph mark deleted by a tracked change, with text still in the paragraph.**
  Word joins that paragraph to the next one. Here it stays a paragraph of its own
  and keeps its number. A paragraph deleted with all its text is handled.
- **A numbered paragraph inside a text box does not advance the list.** Text boxes
  are not read until stage 5.
- **The numbering reader has been checked against Word on documents this project
  wrote.** 2,363 paragraphs agree (`npm run check:word`), but nothing a different
  program wrote has been tried: Google Docs, LibreOffice, a script, a bank that has
  been through years of editing. The dialect pack and the real chapters are for that.
- **A typed "(a) Mars" is an option label only when Word made the letter.**
  Deliberate, so that nothing read before is read differently. A typed star after the
  letter ("b. *Mars") is now read as a key when the whole file does it (stage 4c), because
  an instructor's own bank was found to do so. If instructors also type "(a) Mars" by
  hand, the scanner should accept it in a text file too.

---

## The corpus is too small to be an accuracy measurement

The gate runs on 61 questions across 21 files. At that size one wrong question
costs 1.6 points, so a 95 percent threshold still means "at most three may fail",
which makes it closer to a regression test than a measurement.

It used to run on 15 questions and exercise none of: `Type: TF`, a `T`/`F`
answer key, an unkeyed true or false, a mid-file answers block, images, `[HTML]`,
duplicate numbering, options containing `=`, or any non-ASCII content. Fixtures
06 to 11 and 92 to 94 now cover each of them. Run against the scanner before the
rewrite, the new corpus scored 68.2 percent (06, 07, 08, 92 and 94 fail), so
the gaps were real and the fixtures catch what they were written for. The
rewrite scores 100 percent. Fixtures 12, 13, 95 and 96 add the dialect
differences from the format's guides: `Type: MR`, `Type: S` with repeated
answer numbers, the types that are refused by name, and a lone `@` after the
stem.

The scorer also matches questions to expectations by array index, so one missed
question misaligns everything after it and a single structural bug reads as a
total failure rather than a localised one. Matching by source question number
would be more diagnostic.

Real publisher chapters are the missing piece. `fixtures/publisher/` is read
when present and skipped when absent, so those files can stay off the
repository without giving up the coverage.

---

## What the review found healthy

Worth recording, so nobody rewrites it on suspicion.

The zip **writer** is correct: `unzip -t`, `zipinfo` and Python's
`zipfile.testzip()` all accept its output, CRCs and both size fields and the
central-directory offsets verify, the UTF-8 name flag is set, and non-ASCII
paths round-trip. The reader handles foreign archives, directory entries,
archive comments and data-descriptor entries, and refuses zip64 with a readable
message.

The project typechecks clean under `strict`, `noUncheckedIndexedAccess`,
`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly` and
`verbatimModuleSyntax`.

The envelope and body split, the unknown-key boundary in `schema.ts` with its
`DELIVERY_SETTING_KEYS` explanations, `model/ids.ts`, `model/findings.ts`, the
container layout and the general shape of `bank/store.ts` are all worth
building on.
