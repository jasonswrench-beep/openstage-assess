/**
 * Putting a picture in a question by hand: the requests the editor makes to add one, give one other bytes, or take one away, for a
 * question in a bank and for one in an import under review. The rules themselves are the engine's (`picture-edit.test.ts` there); what
 * is held here is that the bytes are stored only with a question that is kept, that a file that is not a picture is refused in words,
 * and that a picture may be large where other requests may not.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { docx, paragraph, run } from "../../assess/test/support/docx-writer.ts";
import { drawing, emf, pictureParts, png } from "../../assess/test/support/images.ts";
import { Bank } from "../src/engine.ts";
import { uploadLimit } from "../src/server.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;
const BLUE = png(40, 30);
const RED = png(20, 20, { color: [200, 30, 30] });
const nameOf = (bytes: Uint8Array): string => `p-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.png`;
const bytes = (b: Uint8Array): Uint8Array => new Uint8Array(b);

/** A bank with one essay question, and the addresses of the question and of its pictures. */
async function withEssay(client: Client): Promise<{ base: string; question: string; pictures: string }> {
  await client.post("/api/banks", { title: "Hand" });
  const base = "/api/banks/Hand";
  const blank = (await client.get<Json>("/api/blank?type=essay")).json["input"] as Json;
  const made = await client.post<Json>(`${base}/questions`, { input: { ...blank, stem: "Describe the figure." } });
  assert.equal(made.status, 200, made.text);
  const id = made.json["question"].id;
  return { base, question: `${base}/questions/${id}`, pictures: `${base}/questions/${id}/pictures` };
}

/** Saves a question with its text and the description of its first picture, as the editor does. */
async function save(client: Client, address: string, q: Json, change: { stem?: string; alt?: string }): Promise<void> {
  const input = {
    type: q.type,
    title: q.title,
    stem: change.stem ?? q.stem,
    points: q.points,
    feedback: q.feedback,
    metadata: q.metadata,
    body: q.body,
    pictures: q.pictures.map((p: Json, i: number) => ({ id: p.id, alt: i === 0 && change.alt !== undefined ? change.alt : p.alt, decorative: p.decorative })),
  };
  const reply = await client.put(address, { input, expectVersion: q.version });
  assert.equal(reply.status, 200, reply.text);
}

describe("putting a picture in a question in a bank", () => {
  test("adds it at the end of the text, with no description and a note that it has none, and serves it from the bank", async () => {
    await withApp(async (client, home) => {
      const { base, question, pictures } = await withEssay(client);
      const reply = await client.send<Json>("POST", pictures, bytes(BLUE));
      assert.equal(reply.status, 200, reply.text);
      const q = reply.json["question"];
      assert.deepEqual([q.pictures.length, q.pictures[0].number, q.pictures[0].placed, q.pictures[0].alt, q.version], [1, 1, true, "", 2]);
      assert.match(q.stem, /Describe the figure\.\n?\[picture 1\]/);
      assert.ok(q.findings.some((f: Json) => f.code === "a11y.missing-alt-text"));
      assert.equal(reply.json["summary"].verdict, "needsReview");
      const served = await client.get(`${base}/media/${q.pictures[0].file}`);
      assert.equal(served.headers.get("content-type"), "image/png");
      assert.deepEqual(new Uint8Array(served.bytes), BLUE);
      const { bank } = await Bank.open(join(home, "Banks", "Hand.openassess"));
      assert.deepEqual(bank.media.get(`media/${q.pictures[0].file}`), BLUE);
      assert.deepEqual(bank.missingMedia(), []);
      assert.equal((await client.get<Json>(question)).json["question"].pictures.length, 1);
    });
  });

  test("the same picture twice is one picture, and a second picture is the second", async () => {
    await withApp(async (client) => {
      const { pictures } = await withEssay(client);
      await client.send("POST", pictures, bytes(BLUE));
      const again = await client.send<Json>("POST", pictures, bytes(BLUE));
      assert.equal(again.json["question"].pictures.length, 1);
      assert.equal(again.json["question"].version, 2, "no change, no new version");
      const second = await client.send<Json>("POST", pictures, bytes(RED));
      assert.deepEqual(second.json["question"].pictures.map((p: Json) => p.number), [1, 2]);
      assert.match(second.json["question"].stem, /\[picture 1\]\n?\[picture 2\]/);
    });
  });

  test("what is not a picture is refused in words, and nothing is stored or changed", async () => {
    await withApp(async (client, home) => {
      const { pictures, question } = await withEssay(client);
      for (const body of [new TextEncoder().encode("<script>alert(1)</script>"), emf(), new Uint8Array(0)]) {
        const reply = await client.send<Json>("POST", pictures, body);
        assert.equal(reply.status, 400);
        assert.match(reply.json["error"], /not a PNG, JPEG or GIF picture/);
      }
      assert.equal((await client.get<Json>(question)).json["question"].version, 1);
      const { bank } = await Bank.open(join(home, "Banks", "Hand.openassess"));
      assert.equal(bank.media.size, 0);
    });
  });

  test("puts it in without showing it when asked, and shows it the next time it is added", async () => {
    await withApp(async (client) => {
      const { pictures } = await withEssay(client);
      const carried = await client.send<Json>("POST", `${pictures}?place=0`, bytes(BLUE));
      assert.equal(carried.json["question"].pictures[0].placed, false);
      assert.doesNotMatch(carried.json["question"].stem, /\[picture 1\]/);
      const placed = await client.send<Json>("POST", pictures, bytes(BLUE));
      assert.equal(placed.json["question"].pictures[0].placed, true);
      assert.equal(placed.json["question"].pictures.length, 1);
    });
  });

  test("replaces the bytes of a picture and keeps its place and its description, and the old file stays in the bank", async () => {
    await withApp(async (client, home) => {
      const { pictures, question } = await withEssay(client);
      const added = (await client.send<Json>("POST", pictures, bytes(BLUE))).json["question"];
      await save(client, question, added, { alt: "A blue box" });
      const replaced = await client.send<Json>("POST", `${pictures}/${added.pictures[0].id}/replace`, bytes(RED));
      assert.equal(replaced.status, 200, replaced.text);
      const q = replaced.json["question"];
      assert.equal(q.pictures[0].file, nameOf(RED));
      assert.deepEqual([q.pictures[0].alt, q.pictures[0].placed], ["A blue box", true]);
      assert.match(q.stem, /\[picture 1\]/);
      const { bank } = await Bank.open(join(home, "Banks", "Hand.openassess"));
      assert.deepEqual([...bank.media.keys()].sort(), [`media/${nameOf(BLUE)}`, `media/${nameOf(RED)}`].sort());
      assert.equal((await client.send<Json>("POST", `${pictures}/nothing/replace`, bytes(RED))).status, 400);
    });
  });

  test("removes a picture no text shows, refuses one the text shows and says what to do, and the file stays", async () => {
    await withApp(async (client, home) => {
      const { pictures, question } = await withEssay(client);
      const added = (await client.send<Json>("POST", pictures, bytes(BLUE))).json["question"];
      const id = added.pictures[0].id;
      const refused = await client.send<Json>("DELETE", `${pictures}/${id}`);
      assert.equal(refused.status, 400);
      assert.match(refused.json["error"], /Take its \[picture\] words out of the text and save/);
      await save(client, question, added, { stem: "Describe the figure.", alt: "x" });
      const removed = await client.send<Json>("DELETE", `${pictures}/${id}`);
      assert.equal(removed.status, 200, removed.text);
      assert.deepEqual(removed.json["question"].pictures, []);
      assert.ok(!removed.json["question"].findings.some((f: Json) => f.code === "a11y.missing-alt-text"));
      const { bank } = await Bank.open(join(home, "Banks", "Hand.openassess"));
      assert.equal(bank.media.has(`media/${nameOf(BLUE)}`), true, "the file stays, since another question may use it");
    });
  });
});

describe("putting a picture in a question under review", () => {
  const cropped = (): Uint8Array => {
    const lines: Array<string | { draw: string }> = ["1. Look at the figure. Which colour is it?", { draw: drawing("rId10", { alt: "x", crop: { l: 20000 } }) }, "a) Blue", "b) Red", "Answer: a"];
    return docx({
      body: lines.map((l) => (typeof l === "string" ? paragraph(run(l)) : paragraph(`<w:r>${l.draw}</w:r>`))).join(""),
      ...pictureParts([{ rId: "rId10", part: "word/media/image1.png", bytes: BLUE }]),
    });
  };

  test("can put back a picture that the import would not keep: a cropped one is added by hand, and saved with the bank", async () => {
    await withApp(async (client, home) => {
      const view = (await client.send<Json>("POST", "/api/import?name=cropped.docx", Buffer.from(cropped()))).json;
      assert.match(view["fileFindings"].map((f: Json) => f.message).join(" "), /picture cropped in Word/);
      const before = (await client.get<Json>(`/api/sessions/${view["id"]}/questions/0`)).json["question"];
      assert.deepEqual(before.pictures, []);
      assert.match(before.stem, /\[picture\]/, "the marker stands where the picture was");

      const added = await client.send<Json>("POST", `/api/sessions/${view["id"]}/questions/0/pictures`, bytes(RED));
      assert.equal(added.status, 200, added.text);
      assert.equal(added.json["question"].pictures.length, 1);
      assert.ok(added.json["counts"]);
      const saved = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Fixed" });
      const { bank } = await Bank.open(join(home, "Banks", `${saved.json["bank"]}.openassess`));
      assert.deepEqual([...bank.media.keys()], [`media/${nameOf(RED)}`]);
      assert.deepEqual(bank.missingMedia(), []);
    });
  });

  test("a picture added to a question that is then skipped is not stored, and a file that is not a picture is refused", async () => {
    await withApp(async (client, home) => {
      const view = (await client.send<Json>("POST", "/api/import?name=cropped.docx", Buffer.from(cropped()))).json;
      const address = `/api/sessions/${view["id"]}/questions/0`;
      assert.equal((await client.send<Json>("POST", `${address}/pictures`, bytes(emf()))).status, 400);
      const extra = png(33, 21);
      assert.equal((await client.send<Json>("POST", `${address}/pictures`, bytes(extra))).status, 200);
      await client.post(`${address}/skip`, { skipped: true });
      const saved = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Skipped" });
      const { bank } = await Bank.open(join(home, "Banks", `${saved.json["bank"]}.openassess`));
      assert.ok(!bank.media.has(`media/${nameOf(extra)}`));
    });
  });
});

describe("what a picture request is allowed to be", () => {
  test("it has to come from the app, and a picture may be large where other requests may not", async () => {
    await withApp(async (client) => {
      const { pictures, base } = await withEssay(client);
      const foreign = await fetch(new URL(pictures, client.server.url), { method: "POST", headers: { cookie: client.cookie }, body: bytes(BLUE) });
      assert.ok(foreign.status >= 400, `no app header: ${foreign.status}`);
      const huge = await client.send<Json>("POST", pictures, new Uint8Array(27 * 1024 * 1024));
      assert.equal(huge.status, 413);
      const dismiss = await client.send<Json>("POST", `${base}/questions/anything/dismiss`, new Uint8Array(5 * 1024 * 1024));
      assert.equal(dismiss.status, 413, "an ordinary request is still held to a few megabytes");
    });
  });

  test("the limit is for the picture routes only, bank and review alike", () => {
    const big = uploadLimit(["banks", "b", "questions", "q", "pictures"]);
    assert.equal(uploadLimit(["sessions", "s", "questions", "0", "pictures", "m1", "replace"]), big);
    assert.ok(big > uploadLimit(["banks", "b", "questions", "q", "dismiss"]));
    assert.equal(uploadLimit(["banks", "b", "questions", "q"]), uploadLimit(["banks", "b", "questions", "q", "dismiss"]));
  });
});
