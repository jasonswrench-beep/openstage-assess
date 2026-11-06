/**
 * Pictures in the app: a Word file's pictures come in with the questions, are shown from the import and from the bank, are written
 * into the bank only for the questions saved, are described and moved by editing, and are reported when a bank is missing one.
 * What the engine does to a Word file is the engine's test (`pictures.test.ts` there); this is the requests.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { docx, paragraph, run } from "../../assess/test/support/docx-writer.ts";
import { drawing, emf, gif, jpeg, pictureParts, png } from "../../assess/test/support/images.ts";
import { Bank } from "../src/engine.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;
const BLUE = png(40, 30);
const RED = png(20, 20, { color: [200, 30, 30] });
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const nameOf = (bytes: Uint8Array, ext = "png"): string => `p-${sha(bytes)}.${ext}`;

/** Two figure questions, then a plain one. The first picture has a description and the second has none. */
function figures(): Uint8Array {
  const lines: Array<string | { draw: string }> = [
    "1. Look at the figure. Which colour is it?",
    { draw: drawing("rId10", { alt: "A solid blue rectangle" }) },
    "a) Blue",
    "b) Red",
    "Answer: a",
    "2. Look at this one. Which colour is it?",
    { draw: drawing("rId11", { id: 2 }) },
    "a) Blue",
    "b) Red",
    "Answer: b",
    "3. What is two plus two?",
    "a) Three",
    "b) Four",
    "Answer: b",
  ];
  const body = lines.map((l) => (typeof l === "string" ? paragraph(run(l)) : paragraph(`<w:r>${l.draw}</w:r>`))).join("");
  return docx({
    body,
    ...pictureParts([
      { rId: "rId10", part: "word/media/image1.png", bytes: BLUE },
      { rId: "rId11", part: "word/media/image2.png", bytes: RED },
    ]),
  });
}

const importFigures = async (client: Client): Promise<Json> => {
  const reply = await client.send<Json>("POST", "/api/import?name=figures.docx", Buffer.from(figures()));
  assert.equal(reply.status, 200, reply.text);
  return reply.json;
};

const question = async (client: Client, sessionId: string, at: number): Promise<Json> => (await client.get<Json>(`/api/sessions/${sessionId}/questions/${at}`)).json["question"];

describe("a Word file's pictures in the import", () => {
  test("are shown as the bytes they were, typed by what they are, from the import", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const q = await question(client, view["id"], 0);
      assert.equal(q.pictures.length, 1);
      const picture = q.pictures[0];
      assert.deepEqual([picture.number, picture.file, picture.alt, picture.decorative, picture.placed], [1, nameOf(BLUE), "A solid blue rectangle", false, true]);
      const reply = await client.get(`/api/sessions/${view["id"]}/media/${picture.file}`);
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get("content-type"), "image/png");
      assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(new Uint8Array(reply.bytes), BLUE);
    });
  });

  test("are asked for by a name that is checked, and what is not a picture is not served", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const base = `/api/sessions/${view["id"]}/media`;
      // (A name of ".." never reaches the server: the address is tidied first, as any browser does.)
      for (const name of ["p-0000000000000000.png", "..%2F..%2Fsecret", ".hidden", "a%2Fb.png", "x".repeat(200), "nothing", "a..b.png"]) {
        const reply = await client.get(`${base}/${name}`);
        assert.ok([400, 404].includes(reply.status), `${name}: ${reply.status}`);
      }
      assert.equal((await client.get(base)).status, 404, "the folder itself is not a picture");
    });
  });

  test("the text shows where each picture stands, as a token, and the picture is not locked away", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const q = await question(client, view["id"], 0);
      assert.match(q.stem, /Look at the figure\. Which colour is it\?\n?\[picture 1\]/);
      assert.deepEqual(q.locked, [], "a picture does not lock the text it is in");
      assert.equal(q.media, 1);
      const plain = await question(client, view["id"], 2);
      assert.deepEqual(plain.pictures, []);
    });
  });

  test("a picture with no description is flagged, and a question with a description is clean", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      assert.deepEqual(view["questions"].map((x: Json) => x.verdict), ["parsed", "needsReview", "parsed"]);
      const second = await question(client, view["id"], 1);
      assert.ok(second.findings.some((f: Json) => f.code === "a11y.missing-alt-text"));
    });
  });
});

describe("editing a question that has a picture", () => {
  const edit = async (client: Client, sessionId: string, at: number, change: (input: Json) => void): Promise<{ status: number; json: Json }> => {
    const q = await question(client, sessionId, at);
    const input: Json = { type: q.type, title: q.title, stem: q.stem, points: q.points, feedback: q.feedback, metadata: q.metadata, body: q.body };
    if (q.pictures.length > 0) input["pictures"] = q.pictures.map((p: Json) => ({ id: p.id, alt: p.alt, decorative: p.decorative }));
    change(input);
    const reply = await client.put<Json>(`/api/sessions/${sessionId}/questions/${at}`, { input, expectVersion: q.version });
    return { status: reply.status, json: reply.json };
  };

  test("changing the words keeps the picture where the token stays", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = i["stem"].replace("Which colour is it?", "What colour is the rectangle?")));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      const q = reply.json["question"];
      assert.match(q.stem, /What colour is the rectangle\?\n?\[picture 1\]/);
      assert.equal(q.pictures.length, 1);
      assert.equal(q.pictures[0].placed, true);
      assert.equal(q.version, 2);
    });
  });

  test("moving a token moves the picture, and taking it out leaves the picture kept and not shown", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const moved = await edit(client, view["id"], 0, (i) => (i["stem"] = "[picture 1] Look at the figure. Which colour is it?"));
      assert.equal(moved.status, 200);
      assert.match(moved.json["question"].stem, /^\[picture 1\] Look at the figure/);
      assert.equal(moved.json["question"].pictures[0].placed, true);
      const removed = await edit(client, view["id"], 0, (i) => (i["stem"] = "Look at the figure. Which colour is it?"));
      assert.equal(removed.status, 200);
      assert.equal(removed.json["question"].pictures.length, 1, "the picture is still the question's");
      assert.equal(removed.json["question"].pictures[0].placed, false, "and it says it is not in the text");
    });
  });

  test("a token for a picture the question does not have is refused in words, and nothing is changed", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = "Which colour is [picture 2]?"));
      assert.equal(reply.status, 400);
      assert.match(reply.json["error"], /has \[picture 2\], and this question has one picture/);
      assert.equal((await question(client, view["id"], 0)).version, 1);
    });
  });

  test("a question without pictures keeps the words [picture 1] as words", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const reply = await edit(client, view["id"], 2, (i) => (i["stem"] = "What is two plus two? (see [picture 1] in your book)"));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.match(reply.json["question"].stem, /\[picture 1\] in your book/);
      assert.deepEqual(reply.json["question"].pictures, []);
    });
  });

  test("writing the description clears the note that there was none, and marking decoration does too", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const described = await edit(client, view["id"], 1, (i) => (i["pictures"][0].alt = "  A solid  red\nsquare "));
      assert.equal(described.status, 200, JSON.stringify(described.json));
      const q = described.json["question"];
      assert.equal(q.pictures[0].alt, "A solid red square", "spaces are tidied");
      assert.ok(!q.findings.some((f: Json) => f.code === "a11y.missing-alt-text"));
      assert.equal(q.verdict, "parsed");

      // The second view of the same: decoration instead of a description.
      const other = await importFigures(client);
      const decorative = await edit(client, other["id"], 1, (i) => (i["pictures"][0].decorative = true));
      assert.equal(decorative.status, 200);
      assert.equal(decorative.json["question"].pictures[0].decorative, true);
      assert.equal(decorative.json["question"].pictures[0].alt, "");
      assert.ok(!decorative.json["question"].findings.some((f: Json) => f.code === "a11y.missing-alt-text"));
    });
  });

  test("a save that changes nothing about a picture does not touch it, and a picture the question lacks is refused", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const same = await edit(client, view["id"], 0, () => undefined);
      assert.equal(same.status, 200);
      assert.equal(same.json["question"].version, 1, "no change, no new version");
      const wrong = await edit(client, view["id"], 0, (i) => i["pictures"].push({ id: "nothing", alt: "x", decorative: false }));
      assert.equal(wrong.status, 400);
      assert.match(wrong.json["error"], /no picture with the id nothing/);
      const bad = await edit(client, view["id"], 0, (i) => (i["pictures"][0].alt = "x".repeat(1001)));
      assert.equal(bad.status, 400);
      assert.match(bad.json["error"], /longer than 1000 characters/);
    });
  });
});

describe("saving into a bank", () => {
  async function saved(client: Client, skip: number[] = []): Promise<{ bank: string; sessionId: string }> {
    const view = await importFigures(client);
    for (const at of skip) {
      const reply = await client.post(`/api/sessions/${view["id"]}/questions/${at}/skip`, { skipped: true });
      assert.equal(reply.status, 200);
    }
    const reply = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Figures" });
    assert.equal(reply.status, 200, reply.text);
    return { bank: reply.json["bank"], sessionId: view["id"] };
  }

  test("writes the pictures of the questions kept into the bank file, and serves them from it", async () => {
    await withApp(async (client, home) => {
      const { bank } = await saved(client);
      const file = join(home, "Banks", `${bank}.openassess`);
      const { bank: opened } = await Bank.open(file);
      assert.deepEqual([...opened.media.keys()].sort(), [`media/${nameOf(BLUE)}`, `media/${nameOf(RED)}`].sort());
      assert.deepEqual(opened.media.get(`media/${nameOf(BLUE)}`), BLUE);
      assert.deepEqual(opened.missingMedia(), []);

      const reply = await client.get(`/api/banks/${encodeURIComponent(bank)}/media/${nameOf(RED)}`);
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get("content-type"), "image/png");
      assert.deepEqual(new Uint8Array(reply.bytes), RED);
    });
  });

  test("leaves out the picture of a question that was not saved", async () => {
    await withApp(async (client, home) => {
      const { bank } = await saved(client, [1]);
      const { bank: opened } = await Bank.open(join(home, "Banks", `${bank}.openassess`));
      assert.deepEqual([...opened.media.keys()], [`media/${nameOf(BLUE)}`], "the red picture belongs to the question that was skipped");
    });
  });

  test("keeps a description written in the review, and a question is edited in the bank with its picture still in place", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const q = await question(client, view["id"], 1);
      const input = { type: q.type, title: q.title, stem: q.stem, points: q.points, feedback: q.feedback, metadata: q.metadata, body: q.body, pictures: [{ id: q.pictures[0].id, alt: "A red square", decorative: false }] };
      assert.equal((await client.put(`/api/sessions/${view["id"]}/questions/1`, { input, expectVersion: q.version })).status, 200);
      const reply = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Described" });
      const base = `/api/banks/${encodeURIComponent(reply.json["bank"])}`;
      const listing = await client.get<Json>(base);
      const stored = (listing.json["questions"] as Json[]).find((x) => /Look at this one/.test(x.snippet));
      assert.ok(stored);
      const open = (await client.get<Json>(`${base}/questions/${stored.id}`)).json["question"];
      assert.equal(open.pictures[0].alt, "A red square");
      assert.match(open.stem, /\[picture 1\]/);
      const changed = { type: open.type, title: open.title, stem: open.stem.replace("this one", "the second figure"), points: open.points, feedback: open.feedback, metadata: open.metadata, body: open.body, pictures: open.pictures.map((p: Json) => ({ id: p.id, alt: p.alt, decorative: p.decorative })) };
      const saved2 = await client.put<Json>(`${base}/questions/${stored.id}`, { input: changed, expectVersion: open.version });
      assert.equal(saved2.status, 200, saved2.text);
      assert.match(saved2.json["question"].stem, /the second figure/);
      assert.equal(saved2.json["question"].pictures[0].placed, true);
    });
  });

  test("a bank saved twice from the same file stores each picture once", async () => {
    await withApp(async (client, home) => {
      const a = await saved(client);
      const b = await saved(client);
      assert.notEqual(a.bank, b.bank);
      for (const name of [a.bank, b.bank]) {
        const { bank } = await Bank.open(join(home, "Banks", `${name}.openassess`));
        assert.equal(bank.media.size, 2);
      }
    });
  });
});

describe("a bank missing a picture a question names", () => {
  test("opens, says so in words, keeps the question and its description, and serves nothing for the lost picture", async () => {
    await withApp(async (client, home) => {
      const view = await importFigures(client);
      const reply = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Lost" });
      const name = reply.json["bank"];
      const file = join(home, "Banks", `${name}.openassess`);
      const { bank } = await Bank.open(file);
      bank.media.delete(`media/${nameOf(BLUE)}`);
      await bank.save(file);

      const listing = await client.get<Json>(`/api/banks/${encodeURIComponent(name)}`);
      assert.equal(listing.status, 200);
      assert.equal(listing.json["questions"].length, 3, "every question is still there");
      assert.match(listing.json["problems"].pictures, /^One picture that a question refers to is not in this bank file/);
      assert.equal((await client.get(`/api/banks/${encodeURIComponent(name)}/media/${nameOf(BLUE)}`)).status, 404);
      assert.equal((await client.get(`/api/banks/${encodeURIComponent(name)}/media/${nameOf(RED)}`)).status, 200);
    });
  });

  test("a bank with every picture says nothing", async () => {
    await withApp(async (client) => {
      const view = await importFigures(client);
      const reply = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Whole" });
      const listing = await client.get<Json>(`/api/banks/${encodeURIComponent(reply.json["bank"])}`);
      assert.equal(listing.json["problems"].pictures, null);
    });
  });
});

describe("what is served as a picture", () => {
  test("is told by its bytes: a file named .png that is not one is not served, and a JPEG is a JPEG", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Odd" });
      const file = join(home, "Banks", "Odd.openassess");
      const { bank } = await Bank.open(file);
      bank.media.set("media/liar.png", new TextEncoder().encode("<script>alert(1)</script>"));
      bank.media.set("media/photo.png", jpeg(30, 20));
      bank.media.set("media/drawing.png", emf());
      bank.media.set("media/real.gif", gif(8, 8));
      await bank.save(file);
      const get = (n: string) => client.get(`/api/banks/Odd/media/${n}`);
      assert.equal((await get("liar.png")).status, 404);
      assert.equal((await get("drawing.png")).status, 404);
      const photo = await get("photo.png");
      assert.equal(photo.headers.get("content-type"), "image/jpeg", "the type is the bytes', not the name's");
      assert.equal((await get("real.gif")).headers.get("content-type"), "image/gif");
      assert.ok(readdirSync(home).length > 0);
    });
  });
});
