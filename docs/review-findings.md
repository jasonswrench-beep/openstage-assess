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

---

## Open, and roughly in the order I would take them

Items 1 and 2 were the scanner and the importer's output, and are fixed above.
The numbers are kept so that references to the others stay valid.

### 3. Decide what the delivery payload may carry

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

### 5. Search does not scale and ignores accents

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

- `checkReferences` covers 4 fields out of about a dozen: matching lefts,
  hotspot alternatives, option feedback, blank labels and essay model answers
  are unchecked, and the promised orphaned-sidecar check is not implemented.
- `Bank.add` leaves the bank partially mutated when the folder id is wrong.
- A zip whose archive comment contains the EOCD signature is rejected with the
  wrong diagnosis; a truncated file reports "not a zip".
- Entry names are returned unsanitized, so `../../etc/evil.json` round-trips.
  Harmless while everything stays in a Map, but media extraction is coming.
- `isEmptyRichText` ignores math refs, so a stem that is only an equation
  reports empty.
- A link whose stored version is **ahead** of the bank is reported as behind it,
  with advice that would overwrite newer course content. This is the restored
  from backup case and needs its own status.
- Migrations are a mechanism with no content and no tests, and a migration that
  throws midway leaves a partially migrated bank that `toBytes` will stamp with
  the current format version.
- `toBytes()` mutates the manifest, so it is not idempotent. `save()` has no
  fsync before the rename and leaves a stray `.writing` file if the rename
  fails. `rebuildIndex()` never clears. `manifest.questionCount` is written but
  never checked on open.
- Five of the eleven types have no import path, and `shortAnswer` is in
  `RELEASE_1_TYPES`.

### 8. Found while rewriting the scanner, not yet fixed

- **A key list that disagrees with the asterisks is ignored silently.** When a
  question has asterisks, its Answers entry is never read, so `*b` against
  `1. C` produces a clean question. The asterisks win, which is a reasonable
  rule, but the disagreement should be a finding.
- **A true or false question keeps only its answer.** `Type: TF` with options
  that are not True and False (Yes and No, say) is flagged for having no key.
  The option words are now quoted in an `OptionNotKept` warning rather than
  vanishing, but they are still not stored.
- **A matching question padded with `(missing)` pairs loses its error on the next
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

---

## The corpus is too small to be an accuracy measurement

The gate runs on 42 questions across 16 files. At that size one wrong question
costs 2.4 points, so a 95 percent threshold still means "at most one may fail",
which makes it closer to a regression test than a measurement.

It used to run on 15 questions and exercise none of: `Type: TF`, a `T`/`F`
answer key, an unkeyed true or false, a mid-file answers block, images, `[HTML]`,
duplicate numbering, options containing `=`, or any non-ASCII content. Fixtures
06 to 11 and 92 to 94 now cover each of them. Run against the scanner before the
rewrite, the new corpus scored 68.2 percent (06, 07, 08, 92 and 94 fail), so
the gaps were real and the fixtures catch what they were written for. The
rewrite scores 100 percent.

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
