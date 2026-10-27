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

---

## Open, and roughly in the order I would take them

### 1. The Standard Format scanner needs rewriting, not patching

Six separate data-loss findings come from one cause: `scan` in
`src/import/standard-text.ts` is a single mutable `target` state machine whose
pattern checks run before any context check.

- **A question following a mid-file answer key is destroyed.** `inAnswers` is
  set once and never cleared, and the answer-entry pattern matches a question
  line, so the next question's text is appended to an answer entry. Two
  questions with a key block after each parse as one, with no orphan and only a
  generic warning. Per-chapter answer keys are a normal publisher layout.
- **Multiple-choice options containing `=` become a matching question** and the
  key is destroyed. `a. x = 1 / *b. x = 3` turns into matching pairs whose left
  sides all collapse to `x`, the `*b` is dropped because the matching branch
  never reads `correct`, and the verdict is only `needsReview`. Algebraic
  options are common.
- **A stem line reading exactly `Points: 20` is eaten** and resets the sticky
  point value for every later question. Same for a bare `Title:` or `Type:`.
- **Content after the options is silently relocated into the stem** rather than
  orphaned.
- **Duplicate publisher labels overwrite each other**, and the warning does not
  say anything was lost.
- **Duplicate question numbers share one answer key**, so one question gets a
  key belonging to another. Nothing detects duplicate numbering.

The shape that fixes these structurally: an explicit state machine, an answer
key section that can close, a per-question block range that must be fully
accounted for, and a rule that every consumed line is either attributed to a
question or emitted as an orphan.

### 2. An unkeyed import can refuse to save the whole bank

A keyless fill-in-the-blank produces `accepted: [""]`, which the schema
rejects, so `openassess import file.txt --out bank.openassess` prints the
verdicts and then aborts with nothing written. This contradicts the design rule
that an unkeyed question must be storable so it can be repaired beside its
source text. `Points: 5000` fails the same way at `Bank.add`.

The rule to adopt: the importer may only emit questions that pass
`validateQuestion`, with placeholders chosen to satisfy the schema rather than
to look like placeholders.

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
- `FindingCode.PointsAssumed` is defined and never raised.

---

## The corpus is too small to be an accuracy measurement

The gate runs on 15 questions across 7 files, about 105 lines. At that size one
wrong question costs 6.7 points, so a 95 percent threshold really means "all 15
must pass", which makes it a regression test rather than a measurement.

Nothing in it exercises `Type: TF`, a `T`/`F` answer key, an unkeyed true or
false, a mid-file answers block, images, `[HTML]`, duplicate numbering, options
containing `=`, or any non-ASCII content. **Every finding in sections 1 and 2
above lives in a gap in this corpus.** Unit tests now cover the fixed ones, but
the corpus itself should grow alongside the scanner rewrite.

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
