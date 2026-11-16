/**
 * Written-answer boxes in the app: a test printed with boxes for its short answers, a sitting given its bubble page and its
 * written-answer page, each box cut out and put in the review queue with the question's accepted answers and worth, and a person's
 * points recorded, taken back and refused where they should be. Nothing written in a box is read by the program.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { planSheet, writePng, type TestRecord } from "../src/engine.ts";
import { SheetRaster } from "../../assess/src/sheets/raster.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

/** A bank of two choice questions and a short answer worth 2, and a test of them with one version. */
async function ready(client: Client): Promise<{ bank: string; test: Json; record: TestRecord; sid: string }> {
  const bank = "Boxes bank";
  await client.post("/api/banks", { title: bank });
  const base = `/api/banks/${encodeURIComponent(bank)}`;
  const ids: string[] = [];
  const add = async (type: string, stem: string, body: unknown, points = 1): Promise<void> => {
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...(await blank(client, type)), stem, body, points } });
    assert.equal(reply.status, 200, reply.text);
    ids.push(reply.json["question"].id);
  };
  await add("multipleChoice", "Which is two?", { shuffle: false, options: [1, 2, 3].map((n) => ({ text: String(n), correct: n === 2, feedback: "" })) });
  await add("shortAnswer", "Name the capital of France.", { caseSensitive: false, accepted: ["Paris"] }, 2);
  await add("multipleChoice", "Which is three?", { shuffle: false, options: [1, 2, 3].map((n) => ({ text: String(n), correct: n === 3, feedback: "" })) });
  const made = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests`, { name: "Quiz", questionIds: ids, versions: 1 });
  assert.equal(made.status, 200, made.text);
  const test = made.json["test"];
  const record = (await client.server.context.banks.open(bank)).getTest(test["id"]) as TestRecord;
  const opened = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`);
  return { bank, test, record, sid: opened.json["id"] };
}

const BOTH_ANSWERED = { 1: [{ place: 1, mark: { kind: "solid" as const } }], 3: [{ place: 2, mark: { kind: "solid" as const } }] };

function pages(record: TestRecord, answers: Record<number, Array<{ place: number; mark: { kind: "solid" } }>> = BOTH_ANSWERED): Uint8Array[] {
  const planned = planSheet(record, { paper: "letter", boxes: true });
  if (!planned.ok) throw new Error(planned.reason);
  const input = { title: record.name, fingerprint: record.fingerprint, versions: 1 };
  const bubbles = new SheetRaster(planned.plan, input, 1, 150).render({ answers });
  const boxes = new SheetRaster(planned.plan, input, 2, 150).render();
  return [writePng(bubbles, { dpi: 150 }), writePng(boxes, { dpi: 150 })];
}

describe("written-answer boxes in the app", () => {
  test("the print panel is told a test has short answers, and the sheet is printed with a written-answer page only when asked", async () => {
    await withApp(async (client) => {
      const { bank, test } = await ready(client);
      assert.equal(test["shortAnswers"], 1);
      const print = (boxes: boolean) => client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/print`, { boxes, booklets: false, keys: false });
      const plain = await print(false);
      assert.equal(plain.status, 200, plain.text);
      assert.equal(plain.json["written"][0].pages, 1);
      const boxed = await print(true);
      assert.equal(boxed.json["written"][0].pages, 2);
      assert.ok((boxed.json["notes"] as string[]).some((n) => /One short answer is written in a box on the written-answer page \(page 2\)/.test(n)));
      assert.equal((await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/print`, { boxes: "yes" })).status, 400);
    });
  });

  test("a written-answer page puts its box in the review queue with the rubric and a cut-out, and the person's points settle it", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const [one, two] = pages(record);
      assert.equal((await client.send("POST", `/api/scoring/${sid}/files?name=bubbles.png`, one as Uint8Array)).status, 200);
      const added = await client.send<Json>("POST", `/api/scoring/${sid}/files?name=boxes.png`, two as Uint8Array);
      assert.equal(added.status, 200, added.text);
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["queue"]["total"], 1);
      const item = view["queue"]["items"][0];
      assert.deepEqual([item.sheet, item.question, item.written], [1, 2, { worth: 2, accepted: ["Paris"], caseSensitive: false }]);
      assert.equal(item.picture, true);
      const crop = await client.get(`/api/scoring/${sid}/entries/${item.entry}/crops/q2`);
      assert.equal(crop.status, 200);
      assert.equal(crop.bytes.subarray(1, 4).toString("latin1"), "PNG");

      // Refused: points above the worth, a question with no box, a bubble answer for the box's question.
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "written", question: 2, awarded: 3 })).status, 400);
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "written", question: 1, awarded: 1 })).status, 400);
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "written", question: 2, awarded: "half" })).status, 400);

      const scored = await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "written", question: 2, awarded: 1.5 });
      assert.equal(scored.status, 200, scored.text);
      assert.equal(scored.json["queue"]["total"], 0);
      const sheet = (await client.get<Json>(`/api/scoring/${sid}/sheets/1`)).json;
      assert.deepEqual([sheet.earned, sheet.possible, sheet.complete], [3.5, 4, true]);
      const q2 = sheet.questions.find((q: Json) => q.number === 2);
      assert.deepEqual([q2.awarded, q2.of, q2.outcome, q2.decided], [1.5, 2, "partial", true]);

      const back = await client.post<Json>(`/api/scoring/${sid}/decisions/undo`, { sheet: 1, kind: "written", question: 2 });
      assert.equal(back.status, 200, back.text);
      assert.equal(back.json["queue"]["total"], 1, "taken back, it waits again");
      const blankBox = await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "written", question: 2, awarded: "blank" });
      assert.equal(blankBox.json["queue"]["total"], 0);
      assert.equal((await client.get<Json>(`/api/scoring/${sid}/sheets/1`)).json.questions.find((q: Json) => q.number === 2).outcome, "blank");

      // Saved and opened again: the points are there, and no picture.
      const saved = await client.post<Json>(`/api/scoring/${sid}/save`);
      assert.equal(saved.status, 200, saved.text);
      const reopened = await client.post<Json>("/api/scoring/open", { name: saved.json["name"] });
      assert.equal(reopened.status, 200, reopened.text);
      assert.equal(reopened.json["queue"]["total"], 0);
    });
  });

  test("points for a box are refused for a row of bubbles the reader left unsettled, which waits in the queue as a blank", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      // Question 3 left blank: unsettled until a person confirms it, as the box is, but it has no box.
      const [one, two] = pages(record, { 1: [{ place: 1, mark: { kind: "solid" } }] });
      await client.send("POST", `/api/scoring/${sid}/files?name=bubbles.png`, one as Uint8Array);
      await client.send("POST", `/api/scoring/${sid}/files?name=boxes.png`, two as Uint8Array);
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.deepEqual(view["queue"]["items"].map((i: Json) => i.question).sort(), [2, 3]);
      const refused = await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "written", question: 3, awarded: 1 });
      assert.equal(refused.status, 400, refused.text);
      assert.match(refused.text, /not written in a box/);
    });
  });
});
