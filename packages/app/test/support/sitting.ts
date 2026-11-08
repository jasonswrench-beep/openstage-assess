/**
 * A bank with a test made from it and a scoring sitting that has one drawn answer sheet in it, for the tests that need something to
 * save or to write results for.
 */

import { drawn } from "../../../assess/test/support/sheet-fixtures.ts";
import { versionQuestions, writePng, type TestRecord, type VersionLabel } from "../../src/engine.ts";
import type { Client } from "./app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

export async function sitting(client: Client, bank = "Bank"): Promise<{ bank: string; sid: string; testId: string }> {
  await client.post("/api/banks", { title: bank });
  const base = `/api/banks/${encodeURIComponent(bank)}`;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const body = { shuffle: true, options: [0, 1, 2, 3].map((k) => ({ text: `Option ${k + 1}`, correct: k === i % 4, feedback: "" })) };
    const r = await client.post<Json>(`${base}/questions`, { input: { ...(await blank(client, "multipleChoice")), stem: `Question ${i + 1}?`, body } });
    ids.push(r.json["question"].id);
  }
  const made = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests`, { name: "Midterm", questionIds: ids, versions: 2 });
  const test = made.json["test"];
  const record = (await client.server.context.banks.open(bank)).getTest(test.id) as TestRecord;
  const opened = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test.id}/score`);
  const sid = opened.json["id"] as string;
  const places = versionQuestions(record, "A" as VersionLabel).map((q) => (q.body as { options: Array<{ correct: boolean }> }).options.flatMap((o, i) => (o.correct ? [i] : [])));
  const marks = { versions: [{ version: 1, mark: { kind: "solid" as const } }], answers: Object.fromEntries(places.map((p, i) => [i + 1, p.map((place) => ({ place, mark: { kind: "solid" as const } }))])) };
  await client.send("POST", `/api/scoring/${sid}/files?name=a.png`, writePng(drawn(record).render(marks)));
  return { bank, sid, testId: test.id as string };
}
