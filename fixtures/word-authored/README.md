# Documents that Word wrote

These seven `.docx` files were written by Microsoft Word itself, through its own object
model, by `packages/assess/test/tools/word-authored-check.ts`. The other Word tests read
documents made by the writer in `packages/assess/test/support`, which is not Word. These
are the XML Word really writes: its table grids, merged cells, list definitions and styles.

Everything in them is a sample sentence. The name Word puts in a document's properties
has been taken out, and nothing else in them has been changed.

| File | What it holds |
| --- | --- |
| `A-question-per-table` | One question in a table, a label in the first cell, a check mark beside the right option |
| `B-grid` | A grid with a header row, a question to a row, the answer in a column |
| `C-answer-key-table` | Questions as paragraphs and an answer key in a table with a header row |
| `D-outline-list-bold-key` | An outline list, questions at level 1 and options at level 2, the right options in bold |
| `E-merged-title-row` | A table whose first row is one cell merged across the width, then labelled rows |
| `F-typed-bold-and-answer-line` | Typed labels, the right option in bold, and an `Answer:` line |
| `G-numbered-and-lettered-lists` | Word's numbered list for the questions, a lettered list for the options, and an Answers list |

`packages/assess/test/word-authored.test.ts` reads them in `npm test`, on any machine. To make
them again, on a Windows machine with Word:

```
npm run update:word-authored --workspace packages/assess
```

That starts a separate, hidden Word, has it write the documents, checks that they read as
intended and that the list labels agree with what Word shows, and keeps them here.

They are a few documents of a few lines each. They are not a substitute for the dialect
pack in `docs/word-import-plan.md`, which is real banks written by real people.
