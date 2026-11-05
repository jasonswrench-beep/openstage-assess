/**
 * Folders in the app: made, renamed, moved and taken away through the server as the window uses it, questions filed in them, and the
 * list narrowed to one. The folder rules themselves are the engine's (`folders.test.ts` there); what is held here is the requests: what
 * is sent, what a wrong one gets, that a folder is never a place a question is lost, and that filing is not an edit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { Bank, type Question } from "../src/engine.ts";
import { rawRequest, withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, any>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, any>;

/** A bank of essay questions with the stems given. */
async function bankWith(client: Client, title: string, stems: string[]): Promise<{ base: string; ids: string[] }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const ids: string[] = [];
  for (const stem of stems) {
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...(await blank(client, "essay")), stem } });
    assert.equal(reply.status, 200, reply.text);
    ids.push(reply.json["question"].id);
  }
  return { base, ids };
}

const folderOf = async (client: Client, base: string, name: string, parentId?: string): Promise<string> => {
  const reply = await client.post<Json>(`${base}/folders`, parentId ? { name, parentId } : { name });
  assert.equal(reply.status, 200, reply.text);
  return reply.json["folder"];
};

const listed = async (client: Client, base: string, query = ""): Promise<Json> => (await client.get<Json>(query ? `${base}?${query}` : base)).json;
const idsOf = async (client: Client, base: string, query: string): Promise<string[]> => ((await listed(client, base, query))["questions"] as Json[]).map((q) => q["id"]).sort();

describe("making folders", () => {
  test("a bank starts with none, and a folder made is listed with its place and its count", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Folders", ["One?", "Two?"]);
      const empty = await listed(client, base);
      assert.deepEqual([empty["folders"], empty["unfiled"]], [[], 2]);
      const a = await folderOf(client, base, "Chapter 1");
      const b = await folderOf(client, base, "Quizzes", a);
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: b });
      const shown = await listed(client, base);
      assert.deepEqual(shown["folders"], [
        { id: a, name: "Chapter 1", depth: 0, own: 0, total: 1 },
        { id: b, name: "Quizzes", depth: 1, parentId: a, own: 1, total: 1 },
      ]);
      assert.equal(shown["unfiled"], 1);
    });
  });

  test("a name is cleaned, and one with nothing in it, too long, or already beside it is refused in words", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Names", []);
      const made = await client.post<Json>(`${base}/folders`, { name: "  Unit   1 " });
      assert.equal(made.json["folders"][0].name, "Unit 1");
      for (const [body, pattern] of [
        [{ name: "" }, /needs a name/],
        [{ name: "   " }, /needs a name/],
        [{}, /needs a name/],
        [{ name: 7 }, /needs a name/],
        [{ name: "x".repeat(81) }, /at most 80 characters/],
        [{ name: "unit 1" }, /already a folder called "unit 1"/],
        [{ name: "Inside", parentId: "nothing" }, /No folder with the id nothing/],
      ] as Array<[Json, RegExp]>) {
        const reply = await client.post<Json>(`${base}/folders`, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.match(reply.json["error"], pattern);
      }
      assert.equal((await listed(client, base))["folders"].length, 1, "and a refused one was not made");
    });
  });

  test("markup in a name is kept as the text it is, and is not run", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Markup", []);
      const made = await client.post<Json>(`${base}/folders`, { name: "<img src=x onerror=alert(1)> & \"quotes\"" });
      assert.equal(made.status, 200, made.text);
      assert.equal((await listed(client, base))["folders"][0].name, "<img src=x onerror=alert(1)> & \"quotes\"");
    });
  });

  test("the request has to say it is the app's own, and the bank has to be there", async () => {
    await withApp(async (client) => {
      await bankWith(client, "Guarded", []);
      const bare = await rawRequest(client.server.port, "/api/banks/Guarded/folders", { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "content-type": "application/json" }, "POST");
      assert.equal(bare.status, 403);
      assert.equal((await client.post("/api/banks/Nothing/folders", { name: "A" })).status, 404);
    });
  });
});

describe("renaming and moving folders", () => {
  test("a folder can be renamed, put inside another, and put back at the top", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Moves", []);
      const a = await folderOf(client, base, "A");
      const b = await folderOf(client, base, "B");
      const renamed = await client.put<Json>(`${base}/folders/${a}`, { name: "Alpha" });
      assert.equal(renamed.status, 200, renamed.text);
      assert.deepEqual(renamed.json["folders"].map((f: Json) => f["name"]), ["Alpha", "B"]);
      const inside = await client.put<Json>(`${base}/folders/${b}`, { parentId: a });
      assert.deepEqual(inside.json["folders"].map((f: Json) => [f["name"], f["depth"]]), [["Alpha", 0], ["B", 1]]);
      const top = await client.put<Json>(`${base}/folders/${b}`, { parentId: null });
      assert.deepEqual(top.json["folders"].map((f: Json) => [f["name"], f["depth"]]), [["Alpha", 0], ["B", 0]]);
    });
  });

  test("a folder cannot go inside itself, and a refused change leaves the folder as it was, whole", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Refused", []);
      const a = await folderOf(client, base, "A");
      const b = await folderOf(client, base, "B", a);
      const into = await client.put<Json>(`${base}/folders/${a}`, { parentId: b });
      assert.equal(into.status, 400);
      assert.match(into.json["error"], /cannot be moved into itself or into a folder inside it/);
      // A rename and a move asked together, the move refused: neither is kept.
      const both = await client.put<Json>(`${base}/folders/${a}`, { name: "Renamed", parentId: b });
      assert.equal(both.status, 400);
      assert.deepEqual((await listed(client, base))["folders"].map((f: Json) => f["name"]), ["A", "B"]);
      assert.equal((await client.put(`${base}/folders/${a}`, {})).status, 400, "nothing to change");
      assert.equal((await client.put(`${base}/folders/${a}`, { name: 5 })).status, 400);
      assert.equal((await client.put(`${base}/folders/${a}`, { parentId: 5 })).status, 400);
      // An empty place is not the top of the bank: only null is, so that a request that lost its value does not move a folder.
      const b2 = await folderOf(client, base, "B2", a);
      assert.equal((await client.put(`${base}/folders/${b2}`, { parentId: "" })).status, 400);
      assert.equal((await listed(client, base))["folders"].find((f: Json) => f["id"] === b2).depth, 1, "and it was not moved");
      assert.equal((await client.put(`${base}/folders/nothing`, { name: "X" })).status, 404);
      assert.equal((await client.put(`${base}/folders/__proto__`, { name: "X" })).status, 404, "an id is looked up and never used as a key");
    });
  });
});

describe("filing questions", () => {
  test("a question is put in a folder and taken out of it, and that is not an edit of the question", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Filing", ["One?", "Two?"]);
      const a = await folderOf(client, base, "A");
      const before = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json;
      assert.equal(before["folderId"], null);
      const filed = await client.post<Json>(`${base}/questions/${ids[0]}/folder`, { folderId: a });
      assert.equal(filed.status, 200, filed.text);
      const after = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json;
      assert.equal(after["folderId"], a);
      assert.deepEqual(after["question"], before["question"], "the question is as it was: version, notes and all");
      assert.equal((await listed(client, base))["questions"].find((q: Json) => q["id"] === ids[0]).folderId, a);
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: null });
      assert.equal((await client.get<Json>(`${base}/questions/${ids[0]}`)).json["folderId"], null);
    });
  });

  test("a folder that is not there, a bad value, and a question that is not there are refused", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Refusals", ["One?"]);
      const missing = await client.post<Json>(`${base}/questions/${ids[0]}/folder`, { folderId: "nothing" });
      assert.equal(missing.status, 400);
      assert.match(missing.json["error"], /No folder with the id nothing/);
      for (const folderId of [undefined, "", 7, {}]) {
        const reply = await client.post<Json>(`${base}/questions/${ids[0]}/folder`, folderId === undefined ? {} : { folderId });
        assert.equal(reply.status, 400);
        assert.match(reply.json["error"], /Say which folder, or null for none/, "a value that is not a folder is said so, and is not looked up");
      }
      assert.equal((await client.post(`${base}/questions/nothing/folder`, { folderId: null })).status, 404);
    });
  });

  test("a question written while a folder is open goes into it, and a wrong folder adds nothing", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Written", []);
      const a = await folderOf(client, base, "A");
      const input = { ...(await blank(client, "essay")), stem: "Written into a folder?" };
      const made = await client.post<Json>(`${base}/questions`, { input, folderId: a });
      assert.equal(made.status, 200, made.text);
      assert.equal((await client.get<Json>(`${base}/questions/${made.json["question"].id}`)).json["folderId"], a);
      const wrong = await client.post<Json>(`${base}/questions`, { input, folderId: "nothing" });
      assert.equal(wrong.status, 400);
      assert.equal((await listed(client, base))["total"], 1, "and nothing was added");
    });
  });

  test("a copy of a question is in the same folder", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Copies", ["One?"]);
      const a = await folderOf(client, base, "A");
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: a });
      const copy = await client.post<Json>(`${base}/questions/${ids[0]}/duplicate`);
      assert.equal(copy.status, 200, copy.text);
      assert.equal((await client.get<Json>(`${base}/questions/${copy.json["question"].id}`)).json["folderId"], a);
    });
  });
});

describe("narrowing the list to a folder", () => {
  test("shows the questions in a folder and in the folders inside it, or those in none, or nothing for a folder that is gone", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Narrow", ["One?", "Two?", "Three?", "Four?"]);
      const a = await folderOf(client, base, "A");
      const b = await folderOf(client, base, "B", a);
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: a });
      await client.post(`${base}/questions/${ids[1]}/folder`, { folderId: b });
      assert.deepEqual(await idsOf(client, base, `folder=${b}`), [ids[1]]);
      assert.deepEqual(await idsOf(client, base, `folder=${a}`), [ids[0], ids[1]].sort(), "a folder holds what is inside it");
      assert.deepEqual(await idsOf(client, base, "folder=(none)"), [ids[2], ids[3]].sort());
      assert.deepEqual(await idsOf(client, base, "folder=nothing"), []);
      assert.deepEqual(await idsOf(client, base, "folder=__proto__"), []);
      assert.deepEqual(await idsOf(client, base, `folder=${a}&q=two`), [ids[1]], "and it narrows with the other things");
      assert.equal((await listed(client, base, `folder=${a}`))["total"], 4, "the total is the bank's");
    });
  });
});

describe("taking a folder away", () => {
  test("leaves its questions in the bank, in no folder, moves the folders inside it up, and says how many", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Away", ["One?", "Two?"]);
      const a = await folderOf(client, base, "A");
      const b = await folderOf(client, base, "B", a);
      await folderOf(client, base, "C", b);
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: b });
      await client.post(`${base}/questions/${ids[1]}/folder`, { folderId: a });
      const removed = await client.del<Json>(`${base}/folders/${b}`);
      assert.equal(removed.status, 200, removed.text);
      assert.equal(removed.json["unfiled"], 1);
      assert.equal(removed.json["movedUp"], 1);
      assert.deepEqual(removed.json["folders"].map((f: Json) => [f["name"], f["depth"]]), [["A", 0], ["C", 1]]);
      const shown = await listed(client, base);
      assert.equal(shown["total"], 2, "no question was lost");
      assert.equal(shown["unfiled"], 1);
      assert.equal((await client.del(`${base}/folders/${b}`)).status, 404, "a second time it is not there");
    });
  });

  test("is kept on disk, read afresh and not through the server", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Disk", ["One?"]);
      const a = await folderOf(client, base, "Kept");
      await client.post(`${base}/questions/${ids[0]}/folder`, { folderId: a });
      const folder = client.server.context.library.banks;
      const file = readdirSync(folder).find((name) => name.endsWith(".openassess")) as string;
      const { bank } = await Bank.open(join(folder, file));
      assert.deepEqual(bank.folderList().map((f) => [f.name, f.own]), [["Kept", 1]]);
      assert.equal((bank.get(ids[0] as string) as Question).version, 1);
    });
  });
});
