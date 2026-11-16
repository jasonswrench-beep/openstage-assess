# OpenAssess to the shared core: handoff

**From the OpenAssess session, 15 November 2026. For whoever works in `openstage-core` next.** It says what OpenAssess now does
with the core, what it found, and what it is waiting for. The requests themselves, with their full reasoning, are in
`CORE-REQUESTS.md` in the OpenAssess repository; this is the short version to act on.

Built on core commit 6c0b84b (PSTAT-1 revision 1.0, test set 1.0.0, `@openstage/pstat` 1.0.0). Nothing of the core is copied
into OpenAssess.

## 1. What OpenAssess did with the core

| Core piece | What OpenAssess does now | Result |
|---|---|---|
| PSTAT-1, profile `OpenAssess item results 1` | Writes it with its own code (`packages/assess/src/sheets/pstat-export.ts`), because the engine keeps no runtime dependency. Offered on the Score screen ("A file for PrismStatistics"), by `sheets score --out`, and from a learning system's results report | All seven test-set cases come out equal to the set's own `.pstat` files (everything but `app_version`), read with the core's `readPstat`; `checkPstat` finds nothing wrong with any; a file with a total that is not the sum of its questions is refused by it, so the check can fail |
| C3 item-analysis test set | `item-analysis-reference.test.ts` runs `check/check_openassess.mjs` from the core folder (beside the repository, or `OPENSTAGE_CORE`), and runs it again against a `reference.json` with one figure changed, which must fail. Skipped, and said, when the core is not there. Added to the release checklist | Every figure matches |
| Point-biserial label | "Point-biserial (total includes the question)" in the app, the workbook and the item analysis page. The SD says "of this class, divided by the number of sheets" | As the set's README asks |

Two things in OpenAssess changed that the checker touches, and neither moved a figure:

- The 27 percent group is now `floor((27n + 50) / 100)`, as the README defines it, in place of `Math.round(0.27 * n)`. They agree for
  every class size from 1 to 100,000.
- `stats.ts` exports two new constants (`POINT_BISERIAL_LABEL`, `SD_LABEL`). `itemStatistics` and its result are unchanged.

`app_version` is `OpenAssess <release>` with the release the installer records (the one Check for updates uses), or
`OpenAssess 0.1.0 (run from the source)` for a copy run from source. Alpha 28 will be the first release that writes the file.

## 2. What OpenAssess needs from the core (in order)

1. **A richer item results profile (PSTAT-1 revision 1.1 or a profile version 2).** The OpenAssess development list asks the `.pstat`
   for parts profile 7.1 does not have:
   - the **bank question id** of each `q` variable, so files match the bank and each other across semesters;
   - the **letters marked** (responses), for distractor analysis, in one lettering (version A's or the bank's option ids);
   - a **key and item details** part (right options, points, option labels, adjustments; objective, chapter, Bloom level, difficulty
     label, type, version number), as an extra archive entry a format 1 reader ignores;
   - **test details**: test id, date given, and source (scanned sheets or a learning system's report).
   Plus test-set cases for each, so both tools are held to the same files. OpenAssess will not put any of this in an unknown member,
   since PrismStatistics drops members it does not know when it saves.
2. **A sentence in 7.1 on numbering when a question is left out.** It says the `q` variables are in assembled order and labelled with
   the version A number. Those agree in OpenAssess, but when a question counts on no sheet it is left out and the names skip
   (`q01`, `q03`), so a name and its label always agree. No test-set case has a question left out. Please say which is meant, and
   add a case.
3. **C7, the source ledger** (OpenAssess list item 7): a passage-reference format with a spec, the comparison of two editions of a
   .docx or PDF source (unchanged, changed with old and new text, or gone), and a test set of two editions.
4. **C8, the local AI runtime and assistant server** (OpenAssess items 8 and 9): how a tool asks whether a model or key is there and
   calls it, the assistant-server pattern, and where keys are kept. Item 9 (handwritten short answers scored against a rubric) needs
   it to read handwriting. OpenAssess's rules whatever C8 says: a model never sets an answer key, a suggestion is something a person
   accepts, and nothing leaves the machine unless the person turned that on.

## 3. For PrismStatistics (passed on through the core, since the two tools share files and not code)

- **Keep the `profile` member when saving** a project that has one. Today it is dropped, which the spec allows, but then a file
  OpenAssess wrote no longer says what it is after one save.
- **Recognise `OpenAssess item results 1` when opening**, and offer Reliability on the `q` variables and Descriptives on `total`.
- **Label the item column "Corrected item-total r (total leaves the item out)"**, so the two tools' correlations are told apart.
- **The newer-file message** reads "saved by PrismStatistics OpenAssess ..." when OpenAssess wrote the file. Put "PrismStatistics"
  only where PrismStatistics wrote it.
- Nobody has yet opened an OpenAssess `.pstat` in PrismStatistics by double-click. That is on OpenAssess's own testing list; if the
  PrismStatistics session can open one of the test-set files and one written by `npm run assess -- sheets score <bank> <scans> --out
  <folder>`, that settles it sooner.

## 4. Where to look in OpenAssess

- `CORE-REQUESTS.md`: the requests above in full.
- `packages/assess/src/sheets/pstat-export.ts`, `packages/assess/test/pstat-export.test.ts`: the writer and its checks against the core.
- `packages/assess/test/item-analysis-reference.test.ts`: the C3 run.
- `TESTING-TODO.md`, "Item statistics and the PrismStatistics link": what only a person can check.
