/**
 * A learning system's results report in the app: the menu names each system and its report, a report is read against a bank and
 * answered with its figures, a .pstat is written only when asked and the class figures kept only on `confirm=true`, and nothing about
 * a student comes back, is written or is kept. The reading itself is the engine's (`lms-results.test.ts` there).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { unzipSync } from "../src/engine.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

async function seeded(client: Client): Promise<string> {
  await client.post("/api/banks", { title: "Quiz bank" });
  const base = "/api/banks/Quiz%20bank";
  const mc = (await client.get<Json>("/api/blank?type=multipleChoice")).json["input"];
  for (const [stem, options, right] of [["What is 2 + 2?", ["3", "4", "5"], 1], ["Which city is the capital of France?", ["Lyon", "Paris"], 1]] as const) {
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...mc, stem, body: { shuffle: false, options: options.map((text, i) => ({ text, correct: i === right, feedback: "" })) } } });
    assert.equal(reply.status, 200, reply.text);
  }
  return "/api/sheets/Quiz%20bank/lms-results";
}

const report = new TextEncoder().encode(
  [
    "name,id,sis_id,section,section_id,section_sis_id,submitted,attempt,101: What is 2 + 2?,1.0,102: Which city is the capital of France?,1.0,103: Not in this bank,1.0,n correct,n incorrect,score",
    "Ana Lopez,9001,S1,Sec 1,1,,2026-10-01,1,4,1,Paris,1,x,1,3,0,3",
    "Bo Chan,9002,S2,Sec 1,1,,2026-10-01,1,5,0,Paris,1,y,0,1,2,1",
  ].join("\r\n"),
);
const PERSONAL = ["Ana Lopez", "Bo Chan", "9001", "Sec 1"];

describe("results from a learning system", () => {
  test("the menu names each system and the report to download", async () => {
    await withApp(async (client) => {
      const r = await client.get<Json>("/api/lms-reports");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json["reports"].map((x: Json) => x.lms), ["Canvas", "Brightspace (D2L)", "Blackboard"]);
      assert.ok(r.json["reports"].every((x: Json) => x.report && x.how));
    });
  });

  test("reads a report against the bank and answers with the figures, the questions not matched, and nothing about a student", async () => {
    await withApp(async (client) => {
      const path = await seeded(client);
      const r = await client.post<Json>(`${path}?lms=canvas&name=Quiz%203&date=2026-10-02`, report);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json["attempts"], 2);
      assert.equal(r.json["matched"].length, 2);
      assert.deepEqual(r.json["unmatched"].map((u: Json) => u.text), ["Not in this bank"]);
      assert.equal(r.json["stats"]["sheets"], 2);
      assert.equal(r.json["stats"]["items"][0]["difficulty"], 0.5);
      assert.deepEqual(r.json["written"], []);
      assert.equal(r.json["kept"], undefined);
      for (const p of PERSONAL) assert.ok(!r.text.includes(p), p);
      const bank = await client.get<Json>("/api/sheets/Quiz%20bank/tests");
      assert.deepEqual(bank.json["figures"], [], "nothing is kept by reading");
    });
  });

  test("writes a .pstat into Exports only when asked, and keeps the figures only on confirm=true", async () => {
    await withApp(async (client, home) => {
      const path = await seeded(client);
      const w = await client.post<Json>(`${path}?lms=canvas&name=Quiz%203&date=2026-10-02&write=statistics`, report);
      assert.equal(w.status, 200, w.text);
      const [file] = w.json["written"] as Json[];
      assert.equal(file?.["name"], "Quiz 3 - Results for statistics 2026-10-02.pstat");
      const text = new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(join(home, "Exports", file?.["name"])))).get("project.json"));
      assert.match(text, /From Canvas's Student Analysis report/);
      for (const p of PERSONAL) assert.ok(!text.includes(p), p);

      assert.equal((await client.post<Json>(`${path}?lms=canvas&confirm=yes`, report)).status, 400);
      const k = await client.post<Json>(`${path}?lms=canvas&name=Quiz%203&date=2026-10-02&confirm=true`, report);
      assert.equal(k.status, 200, k.text);
      assert.equal(k.json["kept"]["sheets"], 2);
      const figures = (await client.get<Json>("/api/sheets/Quiz%20bank/tests")).json["figures"];
      assert.deepEqual(figures.map((f: Json) => [f.test, f.date, f.sheets]), [["Quiz 3", "2026-10-02", 2]]);

      // The figures kept are read back as each question's history, with no note on two attempts.
      const history = await client.get<Json>("/api/sheets/Quiz%20bank/history");
      assert.equal(history.status, 200, history.text);
      assert.equal(history.json["classes"], 1);
      assert.deepEqual(history.json["questions"].map((q: Json) => [q.stem, q.runs.length, q.runs[0].current, q.notes.length]), [["What is 2 + 2?", 1, true, 0], ["Which city is the capital of France?", 1, true, 0]]);
    });
  });

  test("refuses what it should, in words", async () => {
    await withApp(async (client) => {
      const path = await seeded(client);
      assert.match((await client.post<Json>(`${path}?lms=moodle`, report)).json["error"], /Say which learning system/);
      assert.match((await client.post<Json>(`${path}?lms=canvas`, new Uint8Array())).json["error"] ?? "", /Send the report|request/i);
      const wrong = await client.post<Json>(`${path}?lms=blackboard`, report);
      assert.equal(wrong.status, 422);
      assert.match(wrong.json["error"], /not Blackboard's Download Results/);
      assert.equal((await client.post<Json>(`${path}?lms=canvas&write=zip`, report)).status, 400);
      assert.equal((await client.post<Json>(`${path}?lms=canvas&date=yesterday`, report)).status, 400);
      const none = await client.post<Json>(`${path}?lms=canvas`, new TextEncoder().encode("1: Something else,1.0\r\nx,1"));
      assert.equal(none.status, 422);
      assert.match(none.json["error"], /None of the 1 questions of the report is in this bank/);
    });
  });
});
