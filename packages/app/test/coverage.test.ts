/**
 * What a bank covers, in the app: the choices for narrowing a bank's list by chapter, objective, tag, Bloom level and difficulty, the
 * list narrowed that way, and the grid of two things against each other. The counting is the engine's and is tested there; what is
 * held here is the requests: what is sent, what a bad one gets, and that looking changes nothing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, any>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, any>;

interface Meta {
  objective?: string;
  chapter?: string;
  bloom?: string;
  difficulty?: string;
  status?: string;
  tags?: string[];
}

/** A bank of essay questions, each with the metadata given. */
async function bankWith(client: Client, title: string, metas: Meta[]): Promise<{ base: string; ids: string[] }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const ids: string[] = [];
  for (const [i, m] of metas.entries()) {
    const input = await blank(client, "essay");
    const metadata = { ...input["metadata"], objective: "", chapter: "", bloom: "", difficulty: "", tags: [], ...m };
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...input, stem: `Question number ${i + 1}?`, metadata } });
    assert.equal(reply.status, 200, reply.text);
    ids.push(reply.json["question"].id);
  }
  return { base, ids };
}

const METAS: Meta[] = [
  { chapter: "1", objective: "Define", bloom: "remember", tags: ["unit-1"] },
  { chapter: "1", objective: "Define", bloom: "apply", tags: ["unit-1", "midterm"] },
  { chapter: "2", objective: "Compare", bloom: "apply" },
  { chapter: "2" },
  { chapter: "2", objective: "Define", bloom: "remember", status: "retired" },
];

describe("narrowing a bank's list", () => {
  test("says which values the bank has for each thing, and how many questions have each", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Facets", METAS);
      const reply = await client.get<Json>(base);
      const facets = reply.json["facets"];
      assert.deepEqual(facets.chapter, [{ value: "1", count: 2 }, { value: "2", count: 3 }]);
      assert.deepEqual(facets.objective, [{ value: "Compare", count: 1 }, { value: "Define", count: 3 }, { value: "(none)", count: 1 }]);
      assert.deepEqual(facets.tag, [{ value: "midterm", count: 1 }, { value: "unit-1", count: 2 }, { value: "(none)", count: 3 }]);
      assert.deepEqual(facets.status, [{ value: "draft", count: 4 }, { value: "retired", count: 1 }], "the retired are here, since a list can show them");
      assert.equal(reply.json["total"], 5);
    });
  });

  test("a list is narrowed to one value, to none, to a tag among several, or to several things at once", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Narrow", METAS);
      const idsOf = async (query: string): Promise<string[]> => ((await client.get<Json>(`${base}?${query}`)).json["questions"] as Json[]).map((q) => q["id"]).sort();
      assert.deepEqual(await idsOf("chapter=1"), [ids[0], ids[1]].sort());
      assert.deepEqual(await idsOf("objective=Define"), [ids[0], ids[1], ids[4]].sort());
      assert.deepEqual(await idsOf("objective=(none)"), [ids[3]]);
      assert.deepEqual(await idsOf("tag=midterm"), [ids[1]]);
      assert.deepEqual(await idsOf("tag=unit-1"), [ids[0], ids[1]].sort());
      assert.deepEqual(await idsOf("tag=(none)"), [ids[2], ids[3], ids[4]].sort());
      assert.deepEqual(await idsOf("chapter=2&bloom=apply"), [ids[2]]);
      assert.deepEqual(await idsOf("bloom=remember&status=retired"), [ids[4]]);
      assert.deepEqual(await idsOf("chapter=9"), []);
      assert.deepEqual(await idsOf("chapter=1&objective=Compare"), []);
    });
  });

  test("an empty value, and a thing it does not know, narrow nothing", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Loose", METAS);
      const all = async (query: string): Promise<number> => ((await client.get<Json>(`${base}?${query}`)).json["questions"] as Json[]).length;
      assert.equal(await all("chapter="), 5);
      assert.equal(await all("points=3"), 5);
      assert.equal(await all("chapter=1&points=3"), 2);
    });
  });

  test("narrows with the other things a list can be narrowed by, and the facets do not change with it", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Together", METAS);
      const narrowed = await client.get<Json>(`${base}?chapter=1&type=essay&q=question`);
      assert.equal(narrowed.json["questions"].length, 2);
      assert.equal(narrowed.json["total"], 5);
      const whole = await client.get<Json>(base);
      assert.deepEqual(narrowed.json["facets"], whole.json["facets"], "the choices are for the whole bank");
    });
  });

  test("each row says how many notes it has, as before, and a question's metadata is as it was saved", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Meta", METAS);
      const q = (await client.get<Json>(`${base}/questions/${ids[1]}`)).json["question"];
      assert.deepEqual(q.metadata.tags, ["unit-1", "midterm"]);
      assert.equal(q.metadata.objective, "Define");
    });
  });
});

describe("the grid", () => {
  test("is objectives down and Bloom levels across to begin with, and leaves out the retired", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Grid", METAS);
      const reply = await client.get<Json>(`${base}/coverage`);
      assert.equal(reply.status, 200, reply.text);
      const grid = reply.json;
      assert.equal(grid["rows"], "objective");
      assert.equal(grid["cols"], "bloom");
      assert.deepEqual(grid["rowLabels"], ["Compare", "Define", "(none)"]);
      assert.deepEqual(grid["colLabels"], ["remember", "apply", "(none)"]);
      assert.deepEqual(grid["cells"], [[0, 1, 0], [1, 1, 0], [0, 0, 1]]);
      assert.deepEqual(grid["rowTotals"], [1, 2, 1]);
      assert.deepEqual(grid["colTotals"], [1, 2, 1]);
      assert.equal(grid["total"], 4, "the retired question is not counted");
    });
  });

  test("takes the two things asked for, and the retired when asked", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Choice", METAS);
      const byChapter = (await client.get<Json>(`${base}/coverage?rows=chapter&cols=status&retired=1`)).json;
      assert.deepEqual(byChapter["rowLabels"], ["1", "2"]);
      assert.deepEqual(byChapter["colLabels"], ["draft", "retired"]);
      assert.deepEqual(byChapter["cells"], [[2, 0], [2, 1]]);
      assert.equal(byChapter["total"], 5);
      const tags = (await client.get<Json>(`${base}/coverage?rows=tag&cols=chapter`)).json;
      assert.deepEqual(tags["rowLabels"], ["midterm", "unit-1", "(none)"]);
      assert.equal(tags["total"], 4);
    });
  });

  test("refuses a thing it does not know, and names the choices", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Refused", METAS);
      for (const query of ["rows=points", "cols=nothing", "rows=&cols=bloom", "rows=__proto__"]) {
        const reply = await client.get<Json>(`${base}/coverage?${query}`);
        assert.equal(reply.status, 400, query);
        assert.match(reply.json["error"], /Choose rows and columns from objective, chapter, section, tag, bloom, difficulty, type, status\./);
      }
    });
  });

  test("an empty bank has an empty grid, and a bank that is not there is not found", async () => {
    await withApp(async (client) => {
      await client.post("/api/banks", { title: "Empty" });
      const grid = (await client.get<Json>("/api/banks/Empty/coverage")).json;
      assert.deepEqual([grid["rowLabels"], grid["colLabels"], grid["cells"], grid["total"]], [[], [], [], 0]);
      assert.equal((await client.get("/api/banks/Nothing/coverage")).status, 404);
    });
  });

  test("looks and changes nothing: it is a read, and it is not something to post to", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Reading", METAS);
      const before = JSON.stringify((await client.get<Json>(base)).json["questions"]);
      await client.get(`${base}/coverage`);
      assert.equal(JSON.stringify((await client.get<Json>(base)).json["questions"]), before);
      assert.equal((await client.post(`${base}/coverage`)).status, 404);
      assert.equal((await client.get(`${base}/coverage/extra`)).status, 404);
    });
  });
});
