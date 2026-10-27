# @openstage/assess

The OpenAssess engine. The question model, the bank container, the importers,
the quality checks and the read contract, with no dependency on Tauri, on a
window, or on any third-party package.

## Two entry points

```js
import { Bank, createQuestion } from "@openstage/assess";
import { openBank, listQuestions, toDeliveryPayload } from "@openstage/assess/read";
```

`@openstage/assess` is the whole engine and it will keep changing.

`@openstage/assess/read` is the **frozen** contract. OpenStage Author and
OpenStage Scroll depend on this and nothing else. They never read a
`.openassess` file themselves, never parse the container by hand, and never
need OpenAssess installed. When the bank format changes, this entry point
absorbs the migration and the consumers do not notice.

## The read contract, version 1.0.0

| Operation | Returns |
| --- | --- |
| `openBank(path)` | Bank metadata, folder tree, tag list, question count |
| `listQuestions(handle, query?)` | Summaries for a picker: id, type, title, stem preview, status, flags |
| `getQuestion(handle, id)` | One full question in the open question model |
| `resolveLink(link, handle?)` | A stored reference, with staleness and a missing bank handled |
| `supportedTypes(consumer)` | What that consumer can deliver, and the fallback for the rest |
| `toDeliveryPayload(question, consumer)` | The question reduced to what the consumer renders |

Adding an operation is a minor version. Changing the shape of one is a major
version and a conversation with both consumers first. Call
`assertContract("1.x.y")` in a consumer's own tests to fail loudly rather than
silently when that happens.

### Links and embeds

A course stores one of two things when it references a bank question.

A **link** is a bank id, a question id and the version seen at the time. It
keeps a shared bank authoritative, which is what a department wants for a
common exam.

An **embed** is a full copy with an origin pointer back to the bank. It keeps a
course openable on a machine that does not have the bank file, which is what an
author wants when sending a course to someone else.

`linkTo(handle, question)` produces a link that carries a snapshot, so the pair
works: `resolveLink` returns `current`, `stale`, `question-missing`,
`bank-missing` or `bank-mismatch`, with a one-line message a consumer can show
as written. A stale or missing question is never rendered silently.

### What never reaches a delivery payload

No metadata, no history, no findings, no origin, no status. A player has no
business knowing a question's Bloom level or who last edited it, and leaving
those out means a published course carries no instructor-facing data.

The reverse boundary is enforced by the validator: attempts, time limits,
feedback timing, due dates and weighting are refused on a question with an
explanation, because they are properties of a course or a quiz. Delivery
settings live in the consuming project, keyed by question id.

## Running it

Node 22.6 or later. No install step and no build step for development, because
Node strips the TypeScript types itself:

```
node --experimental-strip-types --test test/*.test.ts
node --experimental-strip-types src/cli/index.ts score ../../fixtures/standard-format
```

To produce `dist` for publishing, `npm run build` (needs TypeScript 6).
