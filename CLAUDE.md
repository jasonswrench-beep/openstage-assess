# Working in this repository

OpenAssess is a free desktop tool for writing, importing, organising and
exporting assessment questions, so an instructor can turn a Word test bank into
an LMS-ready quiz without retyping anything. It is one of the OpenStage suite of
tools, stands on its own, and is licensed Apache 2.0. The other tools do not
depend on it and it does not depend on them.

The build plan runs nine phases across four releases. Phase 1 is done. Phase 2
is the Word import engine, planned in `docs/word-import-plan.md`.
`docs/design-plan.md` records what is intended and why: read it first. `docs/review-findings.md` is the list of known defects:
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
npm test                       # 599 tests, Node's own runner
npm run typecheck              # strict, and it currently passes clean
npm run assess -- score        # the 95 percent import gate
npm run assess -- perf         # the speed budget on a 500-question bank
npm run assess -- export <bank>  # the destination check, and the Author/Scroll CSV with --out
npm run assess -- contract     # the read contract and consumer capabilities
npm run check:word --workspace packages/assess   # asks Word itself what its lists show (Windows with Word)
npm run check:word-formatting --workspace packages/assess   # asks Word itself how text looks
npm run check:word-authored --workspace packages/assess   # has Word write sample documents and reads them
```

The last three are not part of `npm test`. Run the first after any change to
`import/docx/numbering.ts`: a list number is what an Answers list matches a key
to, so a number that is off by one gives a wrong key without a word, and Word is
the only judge of what the number should be. Run the second after any change to
`import/docx/formatting.ts`: a run read as bold that Word shows as plain is a wrong
key when the file marks its answers with bold. Run the third after a change to how tables
or lists are read: it has Word write the documents, so it is the only check that reads
XML Word, and not our test writer, produced. `npm run update:word-authored` keeps what it
writes in `fixtures/word-authored`, where `npm test` reads them on any machine.

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

The corpus is only 61 questions across 21 files and should grow alongside the
parser. Real publisher chapters go in `fixtures/publisher/`, which is
gitignored and read when present.

## The read API

`src/read/` was built so OpenStage Author and OpenStage Scroll could read banks
through six operations. They do not: each OpenStage tool stands alone, and the
only link between them is a file that a person carries across (for Author and
Scroll, the question spreadsheet OpenAssess will export). Nothing depends on
this code, so its shapes are not a promise to anyone. It is kept and tested for
now and may be removed once the desktop app exists. Do not build on it. See
`docs/design-plan.md`.

## Style

Comments explain why, not what, and they are worth writing where a reader would
otherwise assume the obvious thing was simply forgotten. Several comments in
this codebase record a bug that used to live on that line; leave them there.

Prose in documentation and in commit messages: no em dashes.
