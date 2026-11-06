/**
 * Filing several questions at once, as the bank screen does it: the questions the list shows are sent with a folder (or none), in one
 * request that is all or nothing and is not an edit of any question. The rules are the engine's (`folders.test.ts` there); this is what
 * is sent, what a wrong request gets, and that a list narrowed by a search or a folder is filed as it was narrowed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

async function bankWith(client: Client, title: string, stems: string[]): Promise<{ base: string; ids: string[] }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const blank = ((await client.get<Json>("/api/blank?type=essay")).json["input"]) as Json;
  const ids: string[] = [];
  for (const stem of stems) {
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...blank, stem } });
    assert.equal(reply.status, 200, reply.text);
    ids.push(reply.json["question"].id);
  }
  return { base, ids };
}

const folder = async (client: Client, base: string, name: string): Promise<string> => (await client.post<Json>(`${base}/folders`, { name })).json["folder"];
const listing = async (client: Client, base: string, query = ""): Promise<Json> => (await client.get<Json>(query ? `${base}?${query}` : base)).json;

describe("filing several questions at once", () => {
  test("files the questions sent, says how many moved and how many were there, and updates the folder counts", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Filing", ["Cells?", "Atoms?", "Planets?", "Moons?"]);
      const a = await folder(client, base, "Biology");
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: a });
      const reply = await client.post<Json>(`${base}/filing`, { folderId: a, questionIds: [ids[0], ids[1], ids[2]] });
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual([reply.json["filed"], reply.json["alreadyThere"], reply.json["unfiled"]], [2, 1, 1]);
      assert.deepEqual(reply.json["folders"], [{ id: a, name: "Biology", depth: 0, own: 3, total: 3 }]);
      const shown = await listing(client, base, `folder=${a}`);
      assert.deepEqual((shown["questions"] as Json[]).map((q) => q.id).sort(), [ids[0], ids[1], ids[2]].sort());
    });
  });

  test("files a list that was searched, as it was narrowed, and nothing else", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Narrow", ["Cells divide", "Atoms bond", "Cells grow", "Moons orbit"]);
      const a = await folder(client, base, "Cells");
      const found = ((await listing(client, base, "q=cells"))["questions"] as Json[]).map((q) => q.id);
      assert.equal(found.length, 2);
      await client.post(`${base}/filing`, { folderId: a, questionIds: found });
      const inFolder = ((await listing(client, base, `folder=${a}`))["questions"] as Json[]).map((q) => q.id).sort();
      assert.deepEqual(inFolder, [...found].sort());
      assert.equal((await listing(client, base))["unfiled"], 2);
      assert.ok(!inFolder.includes(ids[1] as string) && !inFolder.includes(ids[3] as string));
    });
  });

  test("takes them out of their folders when the folder is null", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Out", ["One?", "Two?"]);
      const a = await folder(client, base, "Box");
      await client.post(`${base}/filing`, { folderId: a, questionIds: ids });
      const out = await client.post<Json>(`${base}/filing`, { folderId: null, questionIds: ids });
      assert.deepEqual([out.json["filed"], out.json["alreadyThere"], out.json["unfiled"]], [2, 0, 2]);
      assert.equal((await listing(client, base))["unfiled"], 2);
    });
  });

  test("is all or nothing: one question the bank does not have, or a folder it does not have, moves none, and says so", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Whole", ["One?", "Two?"]);
      const a = await folder(client, base, "Box");
      const ghost = await client.post<Json>(`${base}/filing`, { folderId: a, questionIds: [ids[0], "q_ghost"] });
      assert.equal(ghost.status, 400);
      assert.match(ghost.json["error"], /No question with the id q_ghost is in this bank/);
      const nowhere = await client.post<Json>(`${base}/filing`, { folderId: "f_nothing", questionIds: ids });
      assert.equal(nowhere.status, 400);
      assert.match(nowhere.json["error"], /No folder with the id f_nothing/);
      assert.equal((await listing(client, base))["unfiled"], 2, "nothing was moved");
    });
  });

  test("asks in words for what is missing, and moves nothing for a request that makes no sense", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Words", ["One?"]);
      const a = await folder(client, base, "Box");
      for (const [body, pattern] of [
        [{ questionIds: ids }, /Say which folder/],
        [{ folderId: "", questionIds: ids }, /Say which folder/],
        [{ folderId: 5, questionIds: ids }, /Say which folder/],
        [{ folderId: a }, /Say which questions/],
        [{ folderId: a, questionIds: [] }, /Say which questions/],
        [{ folderId: a, questionIds: "all" }, /Say which questions/],
        [{ folderId: a, questionIds: [5] }, /Say which questions/],
      ] as Array<[Json, RegExp]>) {
        const reply = await client.post<Json>(`${base}/filing`, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.match(reply.json["error"], pattern);
      }
      assert.equal((await listing(client, base))["unfiled"], 1);
    });
  });

  test("is not an edit of a question: the version and the history are as they were, and it is only for a request from the app", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Quiet", ["One?", "Two?"]);
      const a = await folder(client, base, "Box");
      const before = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json["question"];
      await client.post(`${base}/filing`, { folderId: a, questionIds: ids });
      const after = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json["question"];
      assert.deepEqual([after.version, after.findings.length], [before.version, before.findings.length]);
      const foreign = await fetch(new URL(`${base}/filing`, client.server.url), { method: "POST", headers: { cookie: client.cookie, "content-type": "application/json" }, body: JSON.stringify({ folderId: null, questionIds: ids }) });
      assert.ok(foreign.status >= 400);
      assert.equal((await listing(client, base))["unfiled"], 0, "and the request without the app's header changed nothing");
    });
  });
});
