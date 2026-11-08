/**
 * The same button pressed twice. Saving an import into a bank, and saving a scoring sitting, are buttons a person can press again
 * before the first answer comes back, and a request that asks for the same thing while the first is still being done must wait for it
 * and get what it made, not make a second one. An independent reader found that eight saves of one import made eight banks and eight
 * saves of one sitting made eight scores files (alpha 21 made one of the second).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { scoringRoute } from "../src/scoring-routes.ts";
import { changed } from "../src/scoring.ts";
import { withApp } from "./support/app.ts";
import { sitting } from "./support/sitting.ts";

type Json = Record<string, any>;

const TEXT = ["1. What is the capital of France?", "a. Berlin", "*b. Paris", "c. Rome", "", "2. What is the capital of Spain?", "a. Lisbon", "b. Madrid", "c. Paris", ""].join("\n");

describe("an import saved by requests that overlap", () => {
  test("makes one bank, and every request is told which", async () => {
    await withApp(async (client, home) => {
      const imported = await client.send<Json>("POST", "/api/import?name=bank.txt", Buffer.from(TEXT, "utf8"));
      assert.equal(imported.status, 200, imported.text);
      const id = imported.json["id"] as string;
      const replies = await Promise.all(Array.from({ length: 8 }, () => client.post<Json>(`/api/sessions/${id}/save`, { title: "Double submit" })));
      assert.deepEqual(replies.map((r) => r.status), Array(8).fill(200), replies.map((r) => r.text).join(" "));
      assert.deepEqual([...new Set(replies.map((r) => r.json["bank"]))], ["Double submit"], "one bank, and the same one for everybody");
      assert.deepEqual(readdirSync(join(home, "Banks")), ["Double submit.openassess"]);
      const bank = (await client.get<Json>("/api/banks/Double%20submit")).json;
      assert.equal(bank["total"], 2, "and the questions are in it once");
      // After they are done, saving again is what it always was: refused, with the bank it went to.
      const later = await client.post<Json>(`/api/sessions/${id}/save`, { title: "Double submit" });
      assert.equal(later.status, 409);
      assert.match(String(later.json["error"]), /already saved to "Double submit"/);
    });
  });

  test("a save that failed can be tried again, and the waiting requests are told it failed", async () => {
    await withApp(async (client, home) => {
      const imported = await client.send<Json>("POST", "/api/import?name=bank.txt", Buffer.from(TEXT, "utf8"));
      const id = imported.json["id"] as string;
      const bad = await Promise.all(Array.from({ length: 3 }, () => client.post<Json>(`/api/sessions/${id}/save`, { bank: "Nowhere" })));
      assert.deepEqual(bad.map((r) => r.status), [404, 404, 404]);
      const good = await client.post<Json>(`/api/sessions/${id}/save`, { title: "Second try" });
      assert.equal(good.status, 200, good.text);
      assert.deepEqual(readdirSync(join(home, "Banks")), ["Second try.openassess"]);
    });
  });
});

describe("a scoring sitting saved by requests that overlap", () => {
  test("writes one scores file, and every request is told its name", async () => {
    await withApp(async (client, home) => {
      const { sid } = await sitting(client);
      const replies = await Promise.all(Array.from({ length: 8 }, () => client.post<Json>(`/api/scoring/${sid}/save`)));
      assert.deepEqual(replies.map((r) => r.status), Array(8).fill(200), replies.map((r) => r.text).join(" "));
      assert.equal(new Set(replies.map((r) => r.json["name"])).size, 1, "one name");
      assert.equal(readdirSync(join(home, "Scores")).length, 1, `${readdirSync(join(home, "Scores")).join(", ")}`);
      const later = await client.post<Json>(`/api/scoring/${sid}/save`);
      assert.equal(later.json["name"], replies[0]?.json["name"], "and a later save updates that file");
      assert.equal(readdirSync(join(home, "Scores")).length, 1);
    });
  });

  // The routes are called directly, so that the change can be made at a moment the test chooses: after the first save has worked out
  // what it will write, and before it has written it.
  test("a change made while a save is being done is not marked as saved by it, and the next save waits for it and writes the same file", async () => {
    await withApp(async (client, home) => {
      const { sid } = await sitting(client);
      const ctx = client.server.context;
      const session = ctx.scoring.get(sid);
      const save = (): ReturnType<typeof scoringRoute> => scoringRoute(ctx, { method: "POST", segments: ["scoring", sid, "save"], query: new URLSearchParams(), body: Buffer.alloc(0) });
      const first = save();
      await Promise.resolve();
      await Promise.resolve(); // the first save has worked out what it writes
      const before = session.revision;
      changed(session); // something is decided in the meantime
      assert.equal(session.revision, before + 1);
      const second = save(); // a state that has changed: a save of its own, after the first
      const a = await first;
      assert.equal(session.revision !== session.savedRevision, true, "the change the first save did not hold is still unsaved");
      const b = await second;
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal((a.json as Json)["name"], (b.json as Json)["name"], "one file");
      assert.equal(readdirSync(join(home, "Scores")).length, 1);
      assert.equal(session.revision, session.savedRevision, "and the second save held the change");
    });
  });

  test("two saves of a state that has not changed are one save", async () => {
    await withApp(async (client) => {
      const { sid } = await sitting(client);
      const ctx = client.server.context;
      const save = (): ReturnType<typeof scoringRoute> => scoringRoute(ctx, { method: "POST", segments: ["scoring", sid, "save"], query: new URLSearchParams(), body: Buffer.alloc(0) });
      const first = save();
      const second = save();
      assert.equal(await second, await first, "the second is told what the first made");
    });
  });
});
