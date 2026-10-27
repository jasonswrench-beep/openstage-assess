# Working in this repository

OpenAssess is a free desktop tool for writing, importing, organising and
exporting assessment questions, so an instructor can turn a Word test bank into
an LMS-ready quiz without retyping anything. It is part of the OpenStage suite
and is licensed Apache 2.0.

The build plan runs nine phases across four releases. Phase 1 is done. Phase 2
is the Word import engine. `docs/review-findings.md` is the current agenda:
read it before starting work, because it records what is already known to be
broken and why two delivery fallbacks were deleted rather than repaired.

## Rules that are easy to break by accident

**Never guess an answer key.** This is the rule the product rests on. A missing
or ambiguous key is flagged with an error finding and the field is left unset.
A wrong answer that looks authored is worse than a parse failure, because a
parse failure gets looked at. Four separate bugs in phase 1 came from code that
filled in a key rather than admitting it did not have one.

**Nothing is dropped silently.** Text no question claimed becomes an orphan
with its source location. A question that cannot be built is reported and kept,
not discarded. A file that cannot be read is kept in the bank as passthrough.

**Checks warn, they do not block.** A half-written question has to be saveable,
and an imported question with no key has to be storable so it can be shown
beside its source text and repaired. Findings carry severity; the schema is for
structural validity only.

**No runtime dependencies.** The engine has none and should keep none. It runs
on Node's native type stripping, so it installs by copying and works offline.
Dev dependencies are the type checker only. If something seems to need a
library, that is worth a conversation first.

**Delivery settings are not part of a question.** Attempts, feedback timing,
time limits and scoring weight belong to the course that uses the question, not
to the item. `schema.ts` rejects them by name with an explanation.

## Commands

```
npm test                       # 185 tests, Node's own runner
npm run typecheck              # strict, and it currently passes clean
npm run assess -- score        # the 95 percent import gate
npm run assess -- perf         # the speed budget on a 500-question bank
npm run assess -- contract     # the read contract and consumer capabilities
```

`Check OpenAssess.cmd` runs the first three together by double-click, which is
how this gets verified on a Windows machine with nothing installed but Node.

## The accuracy gate

`fixtures/standard-format/` holds source files with a `.expected.json` beside
each. An expected question declares the `verdict` it should come out with, and
absent means `parsed`. A fixture that deliberately withholds an answer key
declares `failed`, so the parser flagging it is the pass.

The score counts a question only when its type, stem, options, key **and**
verdict all match. Orphan mismatches and invented questions are in the
denominator. Do not loosen this: scoring on text agreement alone is how the
gate once reported 100 percent on questions nobody could use.

The corpus is only 42 questions across 16 files and should grow alongside the
parser. Real publisher chapters go in `fixtures/publisher/`, which is
gitignored and read when present.

## The read contract

`src/read/` is consumed by OpenStage Author and OpenStage Scroll. It is frozen
at 1.0.0: six operations, and the shapes they return are a promise to two other
programs. Adding is fine, changing is not, without a version bump.

An open design question before it is treated as settled: the delivery payload
currently includes the full answer key, which for Scroll means the key is in a
web page. See `docs/review-findings.md`.

## Style

Comments explain why, not what, and they are worth writing where a reader would
otherwise assume the obvious thing was simply forgotten. Several comments in
this codebase record a bug that used to live on that line; leave them there.

Prose in documentation and in commit messages: no em dashes.
