# Requests to the shared core

What OpenAssess needs from `openstage-core` that the core does not offer yet. Nothing here is built in OpenAssess in its place:
each is waiting on the core. Read the core's `CORE-NOTES.md` for what it offers now. Newest first.

## 1. The item results profile: carry the letters, the key and the item details, keyed to bank question ids (for list item 3)

**Asked 15 November 2026. Core state when asked: PSTAT-1 revision 1.0, profile `OpenAssess item results 1` (section 7.1), locked.**

OpenAssess now writes profile 7.1 exactly (`packages/assess/src/sheets/pstat-export.ts`), and every case of the item-analysis test set
comes out as the set's own file. The development list asks the export for more than 7.1 holds:

| Part the list asks for | In profile 7.1 | What is missing |
|---|---|---|
| Responses: the letter or letters marked, per question, blank kept as empty | No | The letters, which PrismStatistics needs for distractor analysis (on its list) |
| Scores: points per question after adjustments | Yes (`q01` and on) | Nothing |
| Key: per question, the right options, points, option labels and any adjustment (dropped, also right, credit all) | No | All of it |
| Item details: objective, chapter, Bloom level, difficulty label, question type, version history number | No | All of it; the list wants them as variable labels so items can be grouped by objective or Bloom level |
| Test details: format version, test id, date given, source (scanned sheets or an LMS export), counts left out | Partly (`source.report.notes` says what was left out) | A test id, the date and the source |
| Everything keyed to bank question ids, not positions on a version | No: `q01` is the question's number on version A | The bank question id |

Section 1 of PSTAT-1 allows "a new optional entry in the archive" and "a new profile" within format 1. Either would do. What would
help OpenAssess most:

1. A **profile version 2** (or optional members of version 1) that names, for each `q` variable, the bank question id, so a file can
   be matched to the bank and to an earlier semester's file even when the question moved.
2. A **responses dataset or entry**: one text column per question holding the letters marked in version A's lettering (or the bank's
   option ids), empty for blank. Letters in each version's own order are what the scores sheet has now, and nothing outside
   OpenAssess can match them, which is the reason item 3 is on the list.
3. A **key and item-details entry** (a JSON part beside `project.json`, which a reader of format 1 ignores), with the fields in the
   table. Item details are not secret in the way question text is; question text stays out, as 7.1 says.
4. Test set cases for the new parts, so PrismStatistics and OpenAssess are held to the same files.

**Answered in PSTAT-1 revision 1.1 (core commit 13b210c):** profile `OpenAssess item results 2` (section 7.2) carries the letters and
`assessment.json` (the key, the item details, the test details, bank ids), with the case `letters-60`; and the numbering is settled as
version A's numbers with gaps (case `omitted-25`), which OpenAssess writes again. Profile 2 is not written by OpenAssess yet, and the
core asks that `student_id` is not written until the author decides whether profile 2 carries one at all.

**Still open in 7.2 (15 November 2026), as `CORE-HANDOFF.md` section 2c says:** an answer cell for a question that has no letters on
scanned sheets (a short answer written in its box and scored by a person). The checker wants an `r` variable for each `q` variable and
keeps null for where the points are null, so OpenAssess writes `""`, which the spec means as left blank, and says so in the file's
notes. A ruling (no `r` variable for type `other`, or a value for "no letters") would let a blank count from the letters be trusted.

## 2. C7, the source ledger (for list item 7)

**Asked 15 November 2026. Core state: not started (CORE-NOTES lists C1, C2 and C4 in progress, nothing for C7).**

Item 7 links each question to the passage of a textbook it was written from, so that a new edition flags exactly the questions to
check. The development list says the link is C7 and is specified once in the core. OpenAssess needs from it:

- the shape of a **passage reference** (a source document's identity and edition, a place in it that survives re-pagination, and the
  passage's text or a fingerprint of it), as a format with a spec, like PSTAT-1;
- the **comparison** of two editions of a source (.docx and PDF), which says for each reference whether its passage is unchanged,
  changed (with the old and new text) or gone;
- a **test set** of two editions with the expected result for each reference.

OpenAssess would then store references on a question (its `metadata`, a field the schema checks), show them in the editor and on the
bank screen, and run the comparison when a new edition is chosen. It has a reader for .docx and PDF already, but the comparison and the
reference format are the core's to define, so nothing is built until they exist.

## 3. C8, the local AI runtime and assistant server (for list items 8 and 9)

**Asked 15 November 2026. Core state: not started.**

Item 8 is AI drafting, import rescue and an assistant server. C8 is one model download and runtime per machine, one settings page for
bring-your-own keys, and one pattern for each tool's assistant server. OpenAssess needs, before it builds any of item 8:

- how a tool asks whether a local model or a key is present, and calls it (the runtime's interface), with no model meaning every
  feature still works without it;
- the assistant server pattern (transport, tool descriptions, how a call is approved by the person);
- where the settings page lives, so OpenAssess does not keep keys of its own.

Item 9 (short-answer boxes photographed and scored against a rubric, as suggestions a person confirms) waits on the same piece: a
suggestion needs the handwriting read, which plain code cannot do and a model can, and the list names handwriting recognition as the
risk. What OpenAssess would add itself, once C8 says how a model is called: a new sheet layout with a box for each short answer (a new
layout number, since the code strip of a printed sheet never changes meaning), the box cut out upright through the reader's own
transform as the review's pictures are now, and the suggestion shown beside the rubric for a person to accept or change. No score from
a model counts until a person confirms it, and a box the model cannot read is a flag, as a faint bubble is. Without a model the boxes
would still be printed, cut out and scored by a person against the rubric; say if that is worth building before C8. (Answered in the
core's notes, and built on 15 November 2026: layout 3, a page of boxes after the bubbles, each box scored by a person. What still waits
on C8 is only the model's suggestion beside the rubric.)

The rules OpenAssess keeps whatever C8 says: a model never writes an answer key without a person choosing it ("never guess an answer
key"), an AI suggestion is a finding a person accepts or dismisses, and nothing is sent off the machine unless the person turned that
on.
