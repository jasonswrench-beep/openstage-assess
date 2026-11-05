/**
 * Picking questions for a test, through the server as the Make a test screen uses it. The choosing is the engine's and is tested
 * there; what is held here is the request: what is read from it and refused, what comes back, and that nothing is changed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { rawRequest, withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, any>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, any>;

/** Essays in two chapters, with an unkeyed multiple choice question among the first. */
async function seeded(client: Client, title = "Pick"): Promise<{ pick: string; base: string; ids: Record<string, string[]> }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const ids: Record<string, string[]> = { "1": [], "2": [], unkeyed: [] };
  const add = async (input: Record<string, any>, into: string): Promise<void> => {
    const reply = await client.post<Json>(`${base}/questions`, { input });
    assert.equal(reply.status, 200, reply.text);
    (ids[into] as string[]).push(reply.json["question"].id);
  };
  const essay = await blank(client, "essay");
  for (let i = 0; i < 8; i++) await add({ ...essay, stem: `Discuss topic number ${i + 1} of chapter one at some length.`, metadata: { ...essay["metadata"], chapter: "1" } }, "1");
  for (let i = 0; i < 4; i++) await add({ ...essay, stem: `Explain subject number ${i + 1} of chapter two in detail.`, metadata: { ...essay["metadata"], chapter: "2" } }, "2");
  const mc = await blank(client, "multipleChoice");
  await add({ ...mc, stem: "Which one is right, with no answer marked at all?", body: { shuffle: true, options: [{ text: "One", correct: false, feedback: "" }, { text: "Two", correct: false, feedback: "" }] }, metadata: { ...mc["metadata"], chapter: "1" } }, "unkeyed");
  return { pick: `/api/sheets/${encodeURIComponent(title)}/pick`, base, ids };
}

describe("pick for me", () => {
  test("picks the number asked for from the value asked for, and says how many could have been", async () => {
    await withApp(async (client) => {
      const { pick, ids } = await seeded(client);
      const reply = await client.post<Json>(pick, { axis: "chapter", value: "1", count: 5 });
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["ids"].length, 5);
      assert.equal(new Set(reply.json["ids"]).size, 5);
      for (const id of reply.json["ids"]) assert.ok((ids["1"] as string[]).includes(id), "all from chapter one");
      assert.equal(reply.json["wanted"], 5);
      assert.equal(reply.json["candidates"], 8);
      assert.deepEqual(reply.json["left"], { retired: 0, chosen: 0, noKey: 1, alike: 0 });
      assert.match(reply.json["seed"], /^[0-9a-f]{12}$/);
    });
  });

  test("does not pick what is already chosen, and gets what there is when it asks for more", async () => {
    await withApp(async (client) => {
      const { pick, ids } = await seeded(client);
      const chosen = (ids["1"] as string[]).slice(0, 6);
      const reply = await client.post<Json>(pick, { axis: "chapter", value: "1", count: 10, chosen });
      assert.deepEqual([...reply.json["ids"]].sort(), (ids["1"] as string[]).slice(6).sort());
      assert.equal(reply.json["left"].chosen, 6);
      assert.equal(reply.json["wanted"], 10);
    });
  });

  test("another press picks others: the seed is new each time", async () => {
    await withApp(async (client) => {
      const { pick } = await seeded(client);
      const seen = new Set<string>();
      const seeds = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const reply = await client.post<Json>(pick, { axis: "chapter", value: "1", count: 2 });
        seeds.add(reply.json["seed"]);
        for (const id of reply.json["ids"]) seen.add(id);
      }
      assert.equal(seeds.size, 6);
      assert.ok(seen.size > 2, "six presses reach more than two questions");
    });
  });

  test("picks by another thing, and none of a value nothing has", async () => {
    await withApp(async (client) => {
      const { pick } = await seeded(client);
      assert.equal((await client.post<Json>(pick, { axis: "type", value: "essay", count: 3 })).json["ids"].length, 3);
      assert.equal((await client.post<Json>(pick, { axis: "chapter", value: "9", count: 3 })).json["ids"].length, 0);
      assert.equal((await client.post<Json>(pick, { axis: "tag", value: "(none)", count: 100 })).json["ids"].length, 12, "all that have no tag and a usable key");
    });
  });

  test("changes nothing: it is not kept anywhere", async () => {
    await withApp(async (client) => {
      const { pick, base } = await seeded(client);
      const before = JSON.stringify((await client.get<Json>(base)).json);
      await client.post(pick, { axis: "chapter", value: "1", count: 3 });
      assert.equal(JSON.stringify((await client.get<Json>(base)).json), before);
    });
  });
});

describe("what a request may say", () => {
  test("is refused when it is not what it should be", async () => {
    await withApp(async (client) => {
      const { pick } = await seeded(client);
      const bad: Array<[string, unknown, RegExp]> = [
        ["an axis it does not know", { axis: "points", value: "1", count: 3 }, /Say what to pick by, from objective, chapter/],
        ["no axis", { value: "1", count: 3 }, /Say what to pick by/],
        ["no value", { axis: "chapter", count: 3 }, /The value to pick is needed/],
        ["a value that is not text", { axis: "chapter", value: 1, count: 3 }, /must be text/],
        ["a value that is too long", { axis: "chapter", value: "x".repeat(201), count: 3 }, /at most 200 characters/],
        ["no count", { axis: "chapter", value: "1" }, /How many to pick is needed/],
        ["a count of nothing", { axis: "chapter", value: "1", count: 0 }, /whole number from 1 to 1000/],
        ["a count of too many", { axis: "chapter", value: "1", count: 1001 }, /whole number from 1 to 1000/],
        ["a count that is not whole", { axis: "chapter", value: "1", count: 2.5 }, /whole number/],
        ["a count that is text", { axis: "chapter", value: "1", count: "3" }, /whole number/],
        ["a field it does not know", { axis: "chapter", value: "1", count: 3, seed: "mine" }, /field, seed, that is not part of it/],
        ["chosen that is not a list", { axis: "chapter", value: "1", count: 3, chosen: "abc" }, /list of question ids/],
        ["chosen with an id that is not text", { axis: "chapter", value: "1", count: 3, chosen: [1] }, /list of question ids/],
        ["chosen with an id that is too long", { axis: "chapter", value: "1", count: 3, chosen: ["x".repeat(81)] }, /list of question ids/],
        ["chosen with too many", { axis: "chapter", value: "1", count: 3, chosen: Array(1001).fill("a") }, /list of question ids/],
      ];
      for (const [what, body, message] of bad) {
        const reply = await client.post<Json>(pick, body);
        assert.equal(reply.status, 400, what);
        assert.match(reply.json["error"], message, what);
      }
    });
  });

  test("a bank that is not there is not found, and a name is checked before it is used", async () => {
    await withApp(async (client) => {
      assert.equal((await client.post("/api/sheets/Nothing/pick", { axis: "chapter", value: "1", count: 1 })).status, 404);
      const sneaky = await client.post("/api/sheets/..%2f..%2fx/pick", { axis: "chapter", value: "1", count: 1 });
      assert.ok(sneaky.status === 400 || sneaky.status === 404, `status ${sneaky.status}`);
    });
  });

  test("is a post that has to say it is the app's own, and is not a page to read", async () => {
    await withApp(async (client) => {
      const { pick } = await seeded(client);
      const bare = await rawRequest(client.server.port, pick, { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "content-type": "application/json" }, "POST");
      assert.equal(bare.status, 403);
      assert.equal((await client.get(pick)).status, 404);
    });
  });
});
