/**
 * Answer sheets in the app: assembling a test from a bank, printing its paper, and scoring a class from pictures, through the
 * server as the window uses it. The pictures are drawn by the engine's own raster (a sheet with pencil on it), so what is read is
 * what a scanner would give, and what the reader makes of it is the engine's; what is tested here is the app's part: the requests,
 * what is kept, what is written and what is never written.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scanPdf } from "../../assess/test/support/pdf-scan.ts";
import { drawn } from "../../assess/test/support/sheet-fixtures.ts";
import { createTest, openScans, orient, unzipSync, versionQuestions, writePng, type GreyImage, type TestRecord, type VersionLabel } from "../src/engine.ts";
import { quarterTurn as turn } from "../../assess/src/sheets/damage.ts";
import { flipHorizontal } from "../../assess/src/sheets/image.ts";
import { chunkedPost, rawRequest, withApp, type Client } from "./support/app.ts";


type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

/** A bank of eight questions: five of choice, a true or false, one with several answers, and an essay the sheet cannot carry. */
async function seeded(client: Client, title = "Midterm bank"): Promise<{ bank: string; base: string; ids: string[] }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const ids: string[] = [];
  const add = async (type: string, stem: string, body: unknown): Promise<void> => {
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...(await blank(client, type)), stem, body } });
    assert.equal(reply.status, 200, reply.text);
    ids.push(reply.json["question"].id);
  };
  const choice = (n: number, right: number): unknown => ({ shuffle: true, options: Array.from({ length: n }, (_x, i) => ({ text: `Option ${i + 1}`, correct: i === right, feedback: "" })) });
  for (let i = 0; i < 5; i++) await add("multipleChoice", `Question number ${i + 1}?`, choice(4, i % 4));
  await add("trueFalse", "The Moon is made of cheese.", { correct: false });
  await add("multipleResponse", "Which of these are even?", { shuffle: true, partialCredit: false, options: [2, 3, 4, 5].map((n) => ({ text: String(n), correct: n % 2 === 0, feedback: "" })) });
  await add("essay", "Explain why the sky is blue.", { modelAnswer: "Scattering." });
  return { bank: title, base, ids };
}

async function assemble(client: Client, bank: string, ids: string[], more: Record<string, unknown> = {}): Promise<Json> {
  const reply = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests`, { name: "Midterm", questionIds: ids, versions: 2, ...more });
  assert.equal(reply.status, 200, reply.text);
  return reply.json["test"];
}

/** The record the server holds, so that a picture of its sheet can be drawn. */
async function recordOf(client: Client, bank: string, id: string): Promise<TestRecord> {
  const held = await client.server.context.banks.open(bank);
  return held.getTest(id) as TestRecord;
}

/** Where the right answer sits in a question as one version prints it: the places to fill for a student who knows it. */
function rightPlaces(record: TestRecord, label: VersionLabel): number[][] {
  return versionQuestions(record, label).map((q) => {
    if (q.type === "multipleChoice" || q.type === "multipleResponse") return (q.body as { options: Array<{ correct: boolean }> }).options.flatMap((o, i) => (o.correct ? [i] : []));
    if (q.type === "trueFalse") return [(q.body as { correct: boolean }).correct ? 0 : 1];
    return [];
  });
}

const marksFor = (places: number[][], version: number, overrides: Record<number, number[]> = {}): Parameters<ReturnType<typeof drawn>["render"]>[0] => ({
  versions: [{ version, mark: { kind: "solid" as const } }],
  answers: Object.fromEntries(
    places.flatMap((p, i) => {
      const chosen = overrides[i + 1] ?? p;
      return chosen.length === 0 ? [] : [[i + 1, chosen.map((place) => ({ place, mark: { kind: "solid" as const } }))]];
    }),
  ),
});

const post = (client: Client, path: string, bytes: Uint8Array): ReturnType<Client["send"]> => client.send("POST", path, bytes);
const pixels = (client: Client, sid: string, image: GreyImage, file: string, extra = ""): ReturnType<Client["send"]> =>
  post(client, `/api/scoring/${sid}/pages?file=${encodeURIComponent(file)}&page=1&width=${image.width}&height=${image.height}${extra}`, image.data);

describe("assembling a test", () => {
  test("keeps a test in the bank with a copy of its questions, and lists it with what the sheet can and cannot carry", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const made = await assemble(client, bank, ids);
      assert.equal(made["questions"].length, 8);
      assert.equal(made["versions"].join(""), "AB");
      assert.equal(made["sheet"].ok, true);
      const essay = made["questions"][7];
      assert.equal(essay.onSheet, false);
      assert.match(essay.notOnSheetBecause, /bubble|answer in the booklet|cannot/i);
      assert.equal(made["questions"][0].scored, true);

      const listed = await client.get<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests`);
      assert.equal(listed.json["tests"].length, 1);
      assert.equal(listed.json["tests"][0].name, "Midterm");
      const again = await client.get<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${made["id"]}`);
      assert.equal(again.json["test"].id, made["id"]);

      // The record survives being saved and opened again, so it is on disk and not only in memory.
      const record = await recordOf(client, bank, made["id"]);
      assert.equal(record.questions.length, 8);
    });
  });

  test("refuses what it does not understand, and a question that is not in the bank, with words", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests`;
      for (const [body, pattern] of [
        [{ name: "", questionIds: ids }, /name/i],
        [{ name: "T", questionIds: [] }, /Choose the questions/],
        [{ name: "T", questionIds: ["q_nope"] }, /not in this bank/],
        [{ name: "T", questionIds: [ids[0], ids[0]] }, /twice/],
        [{ name: "T", questionIds: ids, versions: 5 }, /from 1 to 4/],
        [{ name: "T", questionIds: ids, versions: 1.5 }, /whole number/],
        [{ name: "T", questionIds: ids, questionOrder: "random" }, /kept, shuffled/],
        [{ name: "T", questionIds: ids, response: "x" }, /not part of it/],
        [{ name: "T", questionIds: "all" }, /list of question ids/],
      ] as Array<[Json, RegExp]>) {
        const reply = await client.post<Json>(url, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.match(String(reply.json["error"]), pattern);
      }
      assert.equal((await client.get<Json>(url)).json["tests"].length, 0, "nothing was kept");
    });
  });

  test("removes a test, and says so when it is not there", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const made = await assemble(client, bank, ids);
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${made["id"]}`;
      assert.equal((await client.del(url)).status, 200);
      assert.equal((await client.get(url)).status, 404);
      assert.equal((await client.del(url)).status, 404);
    });
  });
});

describe("printing the paper for a test", () => {
  test("writes the answer sheet, a booklet and a key for each version, named for the test, and serves them", async () => {
    await withApp(async (client, home) => {
      const { bank, ids } = await seeded(client);
      const made = await assemble(client, bank, ids);
      const reply = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${made["id"]}/print`, { paper: "letter", sheet: "shared", booklets: true, keys: true, formats: ["pdf"] });
      assert.equal(reply.status, 200, reply.text);
      const written = reply.json["written"] as Array<{ name: string; kind: string; version?: string; pages?: number }>;
      assert.deepEqual(written.map((w) => w.kind).sort(), ["booklet", "booklet", "key", "key", "sheet"]);
      assert.ok(written.some((w) => w.name === "Midterm - Answer sheet.pdf"));
      for (const w of written) assert.ok(existsSync(join(home, "Exports", w.name)), w.name);
      const served = await client.get(`/files/${encodeURIComponent("Midterm - Answer sheet.pdf")}`);
      assert.equal(served.status, 200);
      assert.equal(served.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
      assert.ok((reply.json["notes"] as string[]).some((n) => /essay|booklet/i.test(n)), "says what the sheet cannot carry");
    });
  });

  test("prints a sheet for each version when asked, and never writes over an earlier file", async () => {
    await withApp(async (client, home) => {
      const { bank, ids } = await seeded(client);
      const made = await assemble(client, bank, ids);
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${made["id"]}/print`;
      const first = await client.post<Json>(url, { sheet: "each", booklets: false, keys: false });
      assert.deepEqual((first.json["written"] as Array<{ name: string }>).map((w) => w.name), ["Midterm - Answer sheet - Version A.pdf", "Midterm - Answer sheet - Version B.pdf"]);
      const again = await client.post<Json>(url, { sheet: "each", booklets: false, keys: false });
      assert.deepEqual((again.json["written"] as Array<{ name: string }>).map((w) => w.name), ["Midterm - Answer sheet - Version A 2.pdf", "Midterm - Answer sheet - Version B 2.pdf"]);
      assert.equal(readdirSync(join(home, "Exports")).length, 4);
    });
  });

  test("makes Word booklets as well when asked, and refuses a request that asks for nothing or for what it does not know", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const made = await assemble(client, bank, ids, { versions: 1 });
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${made["id"]}/print`;
      const word = await client.post<Json>(url, { sheet: "none", booklets: true, keys: true, formats: ["docx", "pdf"] });
      assert.deepEqual((word.json["written"] as Array<{ format: string }>).map((w) => w.format).sort(), ["docx", "docx", "pdf", "pdf"]);
      assert.equal((await client.post<Json>(url, { sheet: "none", booklets: false, keys: false })).status, 400);
      assert.equal((await client.post<Json>(url, { paper: "legal" })).status, 400);
      assert.equal((await client.post<Json>(url, { formats: ["exe"] })).status, 400);
      assert.equal((await client.post<Json>(url, { shell: "x" })).status, 400);
    });
  });

  test("checks a scan of a blank printed copy and writes nothing", async () => {
    await withApp(async (client, home) => {
      const { bank, ids } = await seeded(client);
      const made = await assemble(client, bank, ids);
      const record = await recordOf(client, bank, made["id"]);
      const picture = drawn(record).render({});
      const before = readdirSync(join(home, "Exports")).length;
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${made["id"]}/printing-check`;
      const viaFile = await post(client, url, writePng(picture, { dpi: 150 }));
      assert.equal(viaFile.status, 200, viaFile.text);
      assert.equal((viaFile.json as Json)["ok"], true, JSON.stringify(viaFile.json));
      const viaPixels = await post(client, `${url}?width=${picture.width}&height=${picture.height}`, picture.data);
      assert.equal((viaPixels.json as Json)["ok"], true, JSON.stringify(viaPixels.json));
      assert.match(((viaPixels.json as Json)["found"] as string[]).join(" "), /does not say how many dots/);
      assert.equal(readdirSync(join(home, "Exports")).length, before);
      assert.equal((await post(client, url, new Uint8Array([1, 2, 3]))).status, 400);
    });
  });
});

describe("scoring a class", () => {
  async function ready(client: Client): Promise<{ bank: string; test: Json; record: TestRecord; sid: string; ids: string[]; base: string }> {
    const { bank, ids, base } = await seeded(client);
    const test = await assemble(client, bank, ids);
    const record = await recordOf(client, bank, test["id"]);
    const opened = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`);
    assert.equal(opened.status, 200, opened.text);
    return { bank, test, record, sid: opened.json["id"], ids, base };
  }

  test("reads a PNG file, a page the window decoded and a page of a scanned PDF into sheets in the order they came, and scores them", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const sheet = drawn(record);
      const aRight = rightPlaces(record, "A");
      const bRight = rightPlaces(record, "B");

      // Student 1, version A, a PNG file sent as it is; question 2 is answered wrongly.
      const wrong = aRight[1]![0] === 0 ? 1 : 0;
      const one = await post(client, `/api/scoring/${sid}/files?name=${encodeURIComponent("Jane Doe period 3.png")}`, writePng(sheet.render(marksFor(aRight, 1, { 2: [wrong] }))));
      assert.equal(one.status, 200, one.text);
      // Student 2, version B, decoded by the window and sent as grey pixels; everything right.
      const two = await pixels(client, sid, sheet.render(marksFor(bRight, 2)), "IMG_0042.jpg");
      assert.equal(two.status, 200, two.text);
      // Student 3 is on the first page of a scanned PDF.
      const pdf = scanPdf([{ picture: { image: sheet.render(marksFor(aRight, 1)), encoding: "flate" } }]);
      const three = await post(client, `/api/scoring/${sid}/files?name=scan.pdf`, pdf);
      assert.equal(three.status, 200, three.text);

      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["sheets"].length, 3);
      assert.deepEqual(view["sheets"].map((s: Json) => s.version), ["A", "B", "A"]);
      assert.deepEqual(view["sheets"].map((s: Json) => s.earned), [view["sheets"][0].possible - 1, view["sheets"][1].possible, view["sheets"][2].possible]);
      assert.ok(view["sheets"].every((s: Json) => s.complete));
      assert.equal(view["queue"].total, 0);
      assert.equal(view["stats"].sheets, 3);
      assert.equal(view["stats"].unstable, true);
      assert.deepEqual(view["pages"].map((p: Json) => p.ok), [true, true, true]);
      // The questions as version A prints them, in words, for an adjustment to name (a regex once ate every letter s in these).
      const items = view["test"].items as Json[];
      assert.equal(items.length, 8);
      assert.equal(items[0]!.stem, "Question number 1?");
      assert.deepEqual(items[0]!.options.map((o: Json) => `${o.letter}=${o.text}`), ["A=Option 1", "B=Option 2", "C=Option 3", "D=Option 4"]);
      assert.deepEqual(items[5]!.options, [{ letter: "A", text: "True" }, { letter: "B", text: "False" }]);
      assert.equal(items[6]!.stem, "Which of these are even?");
      assert.deepEqual(items[7]!.options, [], "an essay has no answers to name");
      const detail = (await client.get<Json>(`/api/scoring/${sid}/sheets/1`)).json;
      assert.equal(detail["questions"].length, 7, "the essay is not on the sheet");
      assert.equal(detail["questions"][1].outcome, "wrong");
      assert.equal(detail["questions"][0].outcome, "right");
      assert.equal(detail["questions"][0].stem, "Question number 1?");
      assert.deepEqual(detail["questions"][0].labels, ["A", "B", "C", "D"]);
      assert.equal(detail["questions"][6].multiple, true);
    });
  });

  test("keeps a faint mark in the queue with a piece of the picture, settles it by a person's decision, and takes the decision back", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const sheet = drawn(record);
      const right = rightPlaces(record, "A");
      const marks = marksFor(right, 1);
      // A faint mark in question 3 and nothing in question 4.
      (marks as { answers: Record<number, unknown[]> }).answers[3] = [{ place: right[2]![0], mark: { kind: "light" } }];
      delete (marks as { answers: Record<number, unknown> }).answers[4];
      await pixels(client, sid, sheet.render(marks), "scan 1.png");

      let view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      const items = view["queue"].items as Json[];
      const faint = items.find((i) => i.question === 3);
      const empty = items.find((i) => i.question === 4);
      assert.ok(faint && empty, JSON.stringify(items.map((i) => [i.question, i.why])));
      assert.equal(faint["picture"], true);
      assert.equal(faint["labels"].length, 4);
      assert.equal(view["sheets"][0].complete, false);
      assert.equal(view["sheets"][0].unsettled, 2);

      // The piece of the picture is a small PNG of that row of bubbles.
      const crop = await client.get(`/api/scoring/${sid}/entries/${faint["entry"]}/crops/q3`);
      assert.equal(crop.status, 200);
      assert.equal(crop.headers.get("content-type"), "image/png");
      assert.equal(crop.bytes.subarray(1, 4).toString("latin1"), "PNG");
      assert.ok(crop.bytes.length < 60_000, "a row of bubbles, not a page");

      // A person looks: the faint mark was an answer, and the empty row is blank.
      const settled = await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "answer", question: 3, places: right[2] });
      assert.equal(settled.status, 200, settled.text);
      await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "answer", question: 4, places: "blank" });
      view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["queue"].total, 0);
      assert.equal(view["sheets"][0].complete, true);
      assert.equal(view["sheets"][0].earned, view["sheets"][0].possible - 1, "the blank earned nothing");
      const detail = (await client.get<Json>(`/api/scoring/${sid}/sheets/1`)).json;
      assert.equal(detail["questions"][2].by, "person");
      assert.equal(detail["questions"][2].decided, true);

      // Undo puts it back in the queue with the reader's own reason.
      const undone = await client.post<Json>(`/api/scoring/${sid}/decisions/undo`, { sheet: 1, kind: "answer", question: 3 });
      assert.equal(undone.json["queue"].total, 1);
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/decisions/undo`, { sheet: 1, kind: "answer", question: 3 })).status, 400, "there is nothing left to take back");
    });
  });

  test("refuses a decision that makes no sense: a place the question does not have, two answers to a single-answer question, a sheet that is not there", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const sheet = drawn(record);
      await pixels(client, sid, sheet.render({ ...marksFor(rightPlaces(record, "A"), 1), answers: {} }), "blank.png");
      const url = `/api/scoring/${sid}/decisions`;
      for (const [body, status, pattern] of [
        [{ sheet: 1, kind: "answer", question: 1, places: [4] }, 400, /Choose the bubbles/],
        [{ sheet: 1, kind: "answer", question: 7, places: [0, 0] }, 400, /Choose the bubbles/],
        [{ sheet: 1, kind: "answer", question: 1, places: [0, 1] }, 400, /takes one answer/],
        [{ sheet: 1, kind: "answer", question: 1, places: [] }, 400, /Choose the bubbles/],
        [{ sheet: 1, kind: "answer", question: 8, places: [0] }, 400, /does not carry question 8/],
        [{ sheet: 1, kind: "answer", question: 99, places: [0] }, 400, /from 1 to 8/],
        [{ sheet: 9, kind: "answer", question: 1, places: [0] }, 404, /no sheet 9/],
        [{ sheet: 1, kind: "answer", question: 1, places: [0], note: "x" }, 400, /not part of it/],
        [{ sheet: 1, kind: "version", version: 3 }, 400, /from 1 to 2/],
      ] as Array<[Json, number, RegExp]>) {
        const reply = await client.post<Json>(url, body);
        assert.equal(reply.status, status, JSON.stringify(body));
        assert.match(String(reply.json["error"]), pattern);
      }
      // The one that takes several accepts several.
      assert.equal((await client.post<Json>(url, { sheet: 1, kind: "answer", question: 7, places: [0, 2] })).status, 200);
    });
  });

  test("holds a JPEG page of a scanned PDF in its place until the window sends what it decoded, and turns it as the PDF says", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const sheet = drawn(record);
      const upright = sheet.render(marksFor(rightPlaces(record, "A"), 1));
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
      // The page is marked to be shown turned a quarter, so the picture inside it lies sideways. Which way it has to lie is worked out
      // from what the engine says the page needs.
      const probe = openScans(scanPdf([{ picture: { image: upright, encoding: "jpeg", jpeg: jpegBytes }, rotate: 90 }]));
      assert.ok(probe.ok);
      const source = (probe.pages[0] as { result: { ok: true; source: { orientation: Parameters<typeof orient>[1] } } }).result.source;
      const lying = [0, 1, 2, 3].map((k) => turn(upright, k)).find((candidate) => {
        const back = orient(candidate, source.orientation);
        return back.width === upright.width && back.data.every((v, i) => Math.abs(v - (upright.data[i] as number)) < 3);
      });
      assert.ok(lying, "some turn of the picture is the one that shows upright");

      const pdf = scanPdf([{ picture: { image: lying, encoding: "jpeg", jpeg: jpegBytes }, rotate: 90 }]);
      const sent = await post(client, `/api/scoring/${sid}/files?name=phone.pdf`, pdf);
      assert.equal(sent.status, 200, sent.text);
      const waiting = (sent.json as Json)["waiting"] as Array<{ entry: number; format: string }>;
      assert.equal(waiting.length, 1);
      assert.equal(waiting[0]!.format, "jpeg");
      let view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["pages"][0].ok, false, "held, not read, and not dropped");
      assert.equal(view["pages"][0].waiting, "jpeg");

      // The window asks for the picture's bytes, decodes them, and sends the pixels back for the same place.
      const bytes = await client.get(`/api/scoring/${sid}/waiting/${waiting[0]!.entry}`);
      assert.equal(bytes.status, 200);
      assert.deepEqual(Array.from(bytes.bytes), Array.from(jpegBytes));
      const back = await pixels(client, sid, lying, "phone.pdf", `&replace=${waiting[0]!.entry}`);
      assert.equal(back.status, 200, back.text);
      view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["pages"].length, 1, "it replaced the held page");
      assert.equal(view["pages"][0].ok, true, JSON.stringify(view["pages"][0]));
      assert.equal(view["sheets"][0].complete, true);
      // It is no longer waiting, so it cannot be replaced again.
      assert.equal((await pixels(client, sid, lying, "phone.pdf", `&replace=${waiting[0]!.entry}`)).status, 400);
    });
  });

test("turns a mirrored page of a PDF back, as the PDF says, before it is read, and does not let a refusal replace a page that was read", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const upright = drawn(record).render(marksFor(rightPlaces(record, "A"), 1));
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
      // A scanner that saved the page as seen from the back: the picture inside is mirrored, and the page is drawn mirrored to show it right.
      const mirrored = flipHorizontal(upright);
      const pdf = scanPdf([{ picture: { image: mirrored, encoding: "jpeg", jpeg: jpegBytes }, matrix: [-mirrored.width * 0.36, 0, 0, mirrored.height * 0.36, mirrored.width * 0.36, 0] }]);
      const sent = await post(client, `/api/scoring/${sid}/files?name=back.pdf`, pdf);
      const waiting = (sent.json as Json)["waiting"] as Array<{ entry: number }>;
      assert.equal(waiting.length, 1);
      // The window decodes the picture as it is inside the file, mirrored, and the server puts it right.
      const back = await pixels(client, sid, mirrored, "back.pdf", `&replace=${waiting[0]!.entry}`);
      assert.equal(back.status, 200, back.text);
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["pages"][0].ok, true, JSON.stringify(view["pages"][0]));
      assert.equal(view["sheets"][0].complete, true);

      // The page is read now. A refusal that says it replaces it is not allowed to, and the page stands.
      const stray = await client.post<Json>(`/api/scoring/${sid}/refused`, { page: 1, reason: "Could not be opened.", replace: waiting[0]!.entry });
      assert.equal(stray.status, 400);
      assert.equal(((await client.get<Json>(`/api/scoring/${sid}`)).json["pages"][0] as Json).ok, true, "still read");
    });
  });

  test("takes a whole page of pixels at 300 dots to the inch and a scanner's uncompressed PDF, which are larger than an ordinary request, and refuses a picture with more pixels than a page can have", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const marks = marksFor(rightPlaces(record, "A"), 1);
      const big = drawn(record, { dpi: 300 }).render(marks);
      assert.ok(big.width * big.height > 8_000_000, "a page of grey pixels at 300 dots to the inch is about 8 MB");
      const sent = await pixels(client, sid, big, "300 dpi.png");
      assert.equal(sent.status, 200, sent.text);
      // An uncompressed scan is as big as its pixels.
      const raw = scanPdf([{ picture: { image: drawn(record, { dpi: 300 }).render(marksFor(rightPlaces(record, "B"), 2)), encoding: "raw" } }]);
      assert.ok(raw.length > 8_000_000);
      const viaPdf = await post(client, `/api/scoring/${sid}/files?name=uncompressed.pdf`, raw);
      assert.equal(viaPdf.status, 200, viaPdf.text);
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.deepEqual(view["pages"].map((p: Json) => p.ok), [true, true]);

      // More pixels than a page of a scan can have, inside what a request may carry: refused for its size and not read.
      const huge = await post(client, `/api/scoring/${sid}/pages?width=4100&height=4100`, new Uint8Array(4100 * 4100));
      assert.equal(huge.status, 400);
      assert.match(String((huge.json as Json)["error"]), /too large to read/);
      // A scores file too is more than an ordinary request: this is refused as not being one, which is to say it was read.
      const junk = await post(client, "/api/scoring/open?upload=1", new Uint8Array(5 * 1024 * 1024).fill(65));
      assert.equal(junk.status, 422, junk.text);
    });
  });

  test("keeps a page the window could not open as a refused page in its place, with the reason", async () => {
    await withApp(async (client) => {
      const { sid } = await ready(client);
      const reply = await client.post<Json>(`/api/scoring/${sid}/refused`, { file: "broken.jpg", page: 1, reason: "This picture could not be opened." });
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["pages"], 1);
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["pages"][0].ok, false);
      assert.match(view["pages"][0].reason, /could not be opened/);
      assert.equal(view["batchFlags"].length, 1, "and the batch says it was not read");
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/refused`, { reason: "" })).status, 400);
    });
  });

  test("shows a sheet's page that is a duplicate or missing as a flag on the batch, and never counts it twice", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const picture = drawn(record).render(marksFor(rightPlaces(record, "A"), 1));
      await pixels(client, sid, picture, "a.png");
      await pixels(client, sid, picture, "b.png");
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["sheets"].length, 1);
      assert.deepEqual(view["duplicates"], [1]);
      assert.equal(view["batchFlags"][0].kind, "duplicate");
    });
  });

  test("works out an adjustment's effect before it is made, applies it, and takes it away", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const sheet = drawn(record);
      const right = rightPlaces(record, "A");
      const wrong = right[0]![0] === 0 ? 1 : 0;
      await pixels(client, sid, sheet.render(marksFor(right, 1, { 1: [wrong] })), "a.png");
      await pixels(client, sid, sheet.render(marksFor(right, 1)), "b.png");
      const base = `/api/scoring/${sid}/adjustments`;

      const check = await client.post<Json>(`${base}/check`, { kind: "credit", question: 1 });
      assert.equal(check.status, 200, check.text);
      assert.equal(check.json["changed"].length, 1, "only the sheet that had it wrong changes");
      assert.equal(check.json["sheets"], 2);
      assert.equal((await client.get<Json>(`/api/scoring/${sid}`)).json["adjustments"].length, 0, "a check applies nothing");

      const applied = await client.post<Json>(base, { kind: "credit", question: 1, note: "Misprinted option" });
      assert.equal(applied.json["adjustments"].length, 1);
      assert.equal(applied.json["adjustments"][0].question, 1);
      assert.equal(applied.json["sheets"][0].earned, applied.json["sheets"][1].earned);

      const drop = await client.post<Json>(base, { kind: "drop", question: 2, versions: [1] });
      assert.equal(drop.json["adjustments"].length, 2);
      assert.equal(drop.json["sheets"][0].possible, 6, "one fewer counts, of the seven the sheet carries");
      const id = drop.json["adjustments"][1].id as string;
      const removed = await client.del<Json>(`${base}/${id}`);
      assert.equal(removed.json["adjustments"].length, 1);
      assert.equal((await client.del(`${base}/${id}`)).status, 404);

      // Another answer counts as right, by the letter in version A; a letter the question does not have is refused.
      const also = await client.post<Json>(`${base}/check`, { kind: "alsoRight", question: 1, answer: "D" });
      assert.equal(also.status, 200, also.text);
      assert.equal(also.json["words"], "Another answer counts as right (D: Option 4)", "named as a person reads it, not by the bank's id for the answer");
      assert.equal((await client.post<Json>(`${base}/check`, { kind: "alsoRight", question: 1, answer: "Z" })).status, 400);
      assert.equal((await client.post<Json>(`${base}/check`, { kind: "points", question: 1, points: -1 })).status, 400);
      assert.equal((await client.post<Json>(`${base}/check`, { kind: "drop", question: 40 })).status, 400);
      assert.equal((await client.post<Json>(`${base}/check`, { kind: "drop", question: 1, versions: [3] })).status, 400);
      assert.equal((await client.post<Json>(`${base}/check`, { kind: "drop", question: 1, secret: 1 })).status, 400);
    });
  });

  test("asks which version a sheet is when no version bubble is marked, with a piece of the picture, and settles every row once it is told", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const marks = { ...marksFor(rightPlaces(record, "A"), 1), versions: [] };
      await pixels(client, sid, drawn(record).render(marks), "no version.png");

      let view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["sheets"][0].version, null);
      assert.equal(view["queue"].total, 1, "only the version is asked about: which answers are meant depends on it");
      const item = view["queue"].items[0] as Json;
      assert.equal(item.kind, "version");
      assert.deepEqual(item.labels, ["A", "B"]);
      assert.equal(item.picture, true);
      const entry = item.entry as number;
      assert.equal((await client.get(`/api/scoring/${sid}/entries/${entry}/crops/version`)).status, 200);
      // Every row was kept too, since any may need a look once the version is known.
      assert.equal((await client.get(`/api/scoring/${sid}/entries/${entry}/crops/q3`)).status, 200);

      // An answer cannot be settled before the version is.
      const early = await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "answer", question: 1, places: [0] });
      assert.equal(early.status, 400);
      assert.match(String(early.json["error"]), /Settle the version/);

      const told = await client.post<Json>(`/api/scoring/${sid}/decisions`, { sheet: 1, kind: "version", version: 1 });
      assert.equal(told.status, 200, told.text);
      view = told.json;
      assert.equal(view["sheets"][0].version, "A");
      assert.equal(view["queue"].total, 0, "the answers are decided from what was read, with no rescan");
      assert.equal(view["sheets"][0].complete, true);
      assert.equal(view["sheets"][0].earned, view["sheets"][0].possible);
    });
  });

  test("lets a second decision on a question replace the first, and a decision taken back leaves the reader's reading", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const marks = marksFor(rightPlaces(record, "A"), 1);
      delete (marks as { answers: Record<number, unknown> }).answers[4];
      await pixels(client, sid, drawn(record).render(marks), "blank four.png");
      const url = `/api/scoring/${sid}/decisions`;
      await client.post(url, { sheet: 1, kind: "answer", question: 4, places: [0] });
      const second = await client.post<Json>(url, { sheet: 1, kind: "answer", question: 4, places: [1] });
      assert.equal(second.json["decisions"], 1, "one decision for one question");
      const detail = (await client.get<Json>(`/api/scoring/${sid}/sheets/1`)).json;
      assert.equal(detail["questions"][3].marked, "B", "the later one stands");
      const undone = await client.post<Json>(`${url}/undo`, { sheet: 1, kind: "answer", question: 4 });
      assert.equal(undone.json["decisions"], 0);
      assert.equal(undone.json["queue"].total, 1, "back to what the reader said: this row was blank, and not yet confirmed");
    });
  });

  test("sends the queue from where it is asked to start", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      const marks = marksFor(rightPlaces(record, "A"), 1);
      for (const q of [2, 3, 4]) delete (marks as { answers: Record<number, unknown> }).answers[q];
      await pixels(client, sid, drawn(record).render(marks), "three blanks.png");
      const all = (await client.get<Json>(`/api/scoring/${sid}`)).json["queue"];
      assert.equal(all.total, 3);
      const later = (await client.get<Json>(`/api/scoring/${sid}?after=1`)).json["queue"];
      assert.equal(later.total, 3, "the total is of the whole queue");
      assert.deepEqual(later.items.map((i: Json) => i.question), all.items.slice(1).map((i: Json) => i.question));
      assert.equal((await client.get(`/api/scoring/${sid}?after=-1`)).status, 400);
    });
  });

  test("does not record an adjustment for every version as a list of them, and refuses a worth no question has", async () => {
    await withApp(async (client) => {
      const { record, sid } = await ready(client);
      await pixels(client, sid, drawn(record).render(marksFor(rightPlaces(record, "A"), 1)), "a.png");
      const base = `/api/scoring/${sid}/adjustments`;
      const both = await client.post<Json>(base, { kind: "drop", question: 1, versions: [1, 2] });
      assert.equal(both.json["adjustments"][0].versions, undefined, "all the versions is the same as saying nothing");
      assert.equal((await client.post<Json>(base, { kind: "points", question: 2, points: 1001 })).status, 400);
      assert.equal((await client.post<Json>(base, { kind: "points", question: 2, points: 1000 })).status, 200);
      assert.equal((await client.post<Json>(base, { kind: "points", question: 2, points: "2" })).status, 400);
    });
  });

  test("keeps no figures and writes no results for a sitting with nothing scored, and says a refused page that is not waiting is not", async () => {
    await withApp(async (client) => {
      const { sid } = await ready(client);
      const none = await client.post<Json>(`/api/scoring/${sid}/statistics`, { confirm: true });
      assert.equal(none.status, 400);
      assert.match(String(none.json["error"]), /no complete sheets/);
      const written = await client.post<Json>(`/api/scoring/${sid}/export`, {});
      assert.equal(written.status, 400);
      assert.match(String(written.json["error"]), /no sheets/);
      const stray = await client.post<Json>(`/api/scoring/${sid}/refused`, { page: 1, reason: "x", replace: 0 });
      assert.equal(stray.status, 400);
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/save`)).status, 200, "an empty sitting can be saved, and is a scores file of no sheets");
    });
  });
});

describe("what is kept and what is written", () => {
  async function scored(client: Client): Promise<{ bank: string; base: string; sid: string; test: Json; record: TestRecord; labels: string[] }> {
    const { bank, ids, base } = await seeded(client);
    const test = await assemble(client, bank, ids);
    const record = await recordOf(client, bank, test["id"]);
    const opened = await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`);
    const sid = opened.json["id"] as string;
    const sheet = drawn(record);
    const labels = ["Jane Doe period 3.png", "Sam Smith 8841.png"];
    await post(client, `/api/scoring/${sid}/files?name=${encodeURIComponent(labels[0]!)}`, writePng(sheet.render(marksFor(rightPlaces(record, "A"), 1))));
    await post(client, `/api/scoring/${sid}/files?name=${encodeURIComponent(labels[1]!)}`, writePng(sheet.render(marksFor(rightPlaces(record, "B"), 2))));
    return { bank, base, sid, test, record, labels };
  }

  test("saves a scores file that holds no file name and no picture, and opens it again with the same scores and decisions", async () => {
    await withApp(async (client, home) => {
      const { sid, labels } = await scored(client);
      await client.post(`/api/scoring/${sid}/adjustments`, { kind: "credit", question: 2 });
      const saved = await client.post<Json>(`/api/scoring/${sid}/save`);
      assert.equal(saved.status, 200, saved.text);
      const name = saved.json["name"] as string;
      assert.match(name, /^Midterm - Scores \d{4}-\d{2}-\d{2}\.openassess-scores$/);
      assert.equal(saved.json["view"].unsaved, false);

      // Everything in the file, read as text: no label the pictures came with, and no picture.
      const entries = unzipSync(new Uint8Array(readFileSync(join(home, "Scores", name))));
      const everything = [...entries.entries()].map(([n, b]) => `${n}\n${Buffer.from(b).toString("latin1")}`).join("\n");
      for (const label of labels) assert.ok(!everything.includes(label.replace(/\.png$/, "")), `${label} is not in the file`);
      assert.ok(!everything.includes("Jane") && !everything.includes("Sam") && !everything.includes("8841"));
      assert.ok(![...entries.values()].some((b) => Buffer.from(b).subarray(1, 4).toString("latin1") === "PNG"), "no picture");

      // A later save updates this sitting's own file and does not make another.
      await client.post(`/api/scoring/${sid}/adjustments`, { kind: "drop", question: 3 });
      assert.equal((await client.get<Json>(`/api/scoring/${sid}`)).json["unsaved"], true);
      const again = await client.post<Json>(`/api/scoring/${sid}/save`);
      assert.equal(again.json["name"], name);
      assert.equal(readdirSync(join(home, "Scores")).length, 1);

      // The list names it, and opening it brings back the sheets and the adjustments, with no pictures to show.
      const listed = await client.get<Json>("/api/scores");
      assert.equal(listed.json["files"][0].name, name);
      assert.equal(listed.json["files"][0].test, "Midterm");
      assert.equal(listed.json["files"][0].sheets, 2);
      const reopened = await client.post<Json>("/api/scoring/open", { name });
      assert.equal(reopened.status, 200, reopened.text);
      assert.equal(reopened.json["opened"], true);
      assert.equal(reopened.json["sheets"].length, 2);
      assert.equal(reopened.json["adjustments"].length, 2);
      assert.equal(reopened.json["unsaved"], false);
      const first = (await client.get<Json>(`/api/scoring/${sid}`)).json["sheets"];
      assert.deepEqual(reopened.json["sheets"].map((s: Json) => [s.earned, s.possible, s.version]), first.map((s: Json) => [s.earned, s.possible, s.version]));
      // No more scans can be put into scores that were opened, and no picture is there to show.
      const more = await post(client, `/api/scoring/${reopened.json["id"]}/files?name=x.png`, new Uint8Array([1]));
      assert.equal(more.status, 409);
      assert.equal((await client.get(`/api/scoring/${reopened.json["id"]}/entries/0/crops/q1`)).status, 404);
    });
  });

  test("opens a scores file only against the test it was made for, and says why when it cannot", async () => {
    await withApp(async (client, home) => {
      const { sid, bank, test } = await scored(client);
      const saved = await client.post<Json>(`/api/scoring/${sid}/save`);
      const name = saved.json["name"] as string;
      // The test removed from its bank: the scores have nothing to be read against.
      await client.del(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}`);
      const reply = await client.post<Json>("/api/scoring/open", { name });
      assert.equal(reply.status, 409);
      assert.match(String(reply.json["error"]), /none of your banks holds/);
      // A file that is not a scores file is said to be damaged and is not opened.
      const bad = join(home, "Scores", "Not scores.openassess-scores");
      writeFileSync(bad, "nonsense");
      const damaged = await client.post<Json>("/api/scoring/open", { name: "Not scores.openassess-scores" });
      assert.equal(damaged.status, 422);
      const listed = await client.get<Json>("/api/scores");
      assert.ok(listed.json["files"].some((f: Json) => f.name === "Not scores.openassess-scores" && f.problem), "listed, with what is wrong with it");
    });
  });

test("will not open scores against a test whose record has changed since, even under the same id", async () => {
    await withApp(async (client) => {
      const { sid, bank, record } = await scored(client);
      const name = ((await client.post<Json>(`/api/scoring/${sid}/save`)).json["name"]) as string;
      // The same id and the same questions, made again with another seed: the versions come out differently, so the sheets printed from the first
      // would be read against the wrong answers.
      await client.server.context.banks.change(bank, (b) => {
        b.removeTest(record.id);
        b.addTest(createTest({ id: record.id, name: record.name, questions: record.questions, versions: 2, seed: "another seed", at: record.created }));
      });
      const reply = await client.post<Json>("/api/scoring/open", { name });
      assert.equal(reply.status, 409);
      assert.match(String(reply.json["error"]), /fingerprint/);
    });
  });

  test("writes the workbook, the CSV and the item analysis into the exports folder, with an empty Name column and no file name, and never over an earlier file", async () => {
    await withApp(async (client, home) => {
      const { sid, labels } = await scored(client);
      const done = await client.post<Json>(`/api/scoring/${sid}/export`, { date: "2026-11-04" });
      assert.equal(done.status, 200, done.text);
      const written = done.json["written"] as Array<{ name: string; kind: string }>;
      assert.deepEqual(written.map((w) => w.kind).sort(), ["analysis", "csv", "workbook"]);
      const csv = readFileSync(join(home, "Exports", written.find((w) => w.kind === "csv")!.name), "utf8");
      assert.ok(csv.startsWith("﻿Sheet,Version,Name,"), "Excel opens it with the byte order mark, and the Name column is there for the instructor to fill");
      for (const label of labels) assert.ok(!csv.includes(label.replace(/\.png$/, "")));
      const html = readFileSync(join(home, "Exports", written.find((w) => w.kind === "analysis")!.name), "utf8");
      assert.match(html, /item analysis/i);
      const second = await client.post<Json>(`/api/scoring/${sid}/export`, { what: ["csv"], date: "2026-11-04" });
      assert.notEqual((second.json["written"] as Array<{ name: string }>)[0]!.name, written.find((w) => w.kind === "csv")!.name);
      const served = await client.get(`/files/${encodeURIComponent(written.find((w) => w.kind === "workbook")!.name)}`);
      assert.equal(served.bytes.subarray(0, 2).toString("latin1"), "PK", "a real zip");
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/export`, { what: ["zip"] })).status, 400);
      assert.equal((await client.post<Json>(`/api/scoring/${sid}/export`, { date: "yesterday" })).status, 400);
    });
  });

  test("keeps the class figures in the bank only when asked, once, and the bank holds no sheet and no response", async () => {
    await withApp(async (client, home) => {
      const { sid, bank } = await scored(client);
      const url = `/api/scoring/${sid}/statistics`;
      assert.equal((await client.post<Json>(url, {})).status, 400, "it has to be asked for");
      assert.equal((await client.get<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests`)).json["figures"].length, 0);
      const kept = await client.post<Json>(url, { confirm: true, date: "2026-11-04" });
      assert.equal(kept.status, 200, kept.text);
      assert.equal(kept.json["sheets"], 2);
      assert.equal((await client.post<Json>(url, { confirm: true })).status, 409, "not twice by accident");
      const figures = (await client.get<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests`)).json["figures"];
      assert.equal(figures.length, 1);
      assert.equal(figures[0].sheets, 2);
      // The bank on disk holds the figures and nothing that names a sheet.
      const file = readFileSync(join(home, "Banks", `${bank}.openassess`));
      const entries = unzipSync(new Uint8Array(file));
      const stats = [...entries.keys()].filter((n) => n.startsWith("statistics/"));
      assert.equal(stats.length, 1);
      const text = Buffer.from(entries.get(stats[0]!) as Uint8Array).toString("utf8");
      assert.ok(!/sheet\s*\d|Jane|Sam|file/i.test(text.replace(/"sheets":\d+/g, "").replace(/"sheets"/g, "")), "no sheet, no name, no file");
    });
  });

  test("keeps nothing on disk until a person saves, not the pictures and not the readings", async () => {
    await withApp(async (client, home) => {
      await scored(client);
      assert.deepEqual(readdirSync(join(home, "Scores")), []);
      assert.deepEqual(readdirSync(join(home, "Exports")), []);
    });
  });

  test("lets go of a sitting that is closed, and says so for one that is not open", async () => {
    await withApp(async (client) => {
      const { sid } = await scored(client);
      assert.equal((await client.del<Json>(`/api/scoring/${sid}`)).json["closed"], true);
      const gone = await client.get<Json>(`/api/scoring/${sid}`);
      assert.equal(gone.status, 404);
      assert.match(String(gone.json["error"]), /no longer open/);
    });
  });

  test("lets go of the sitting used least when more than eight are open", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const test = await assemble(client, bank, ids);
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`;
      const first = (await client.post<Json>(url)).json["id"] as string;
      for (let i = 0; i < 8; i++) await client.post<Json>(url);
      assert.equal((await client.get(`/api/scoring/${first}`)).status, 404);
    });
  });
});

describe("who may ask, and how much", () => {
  test("turns away a request with no key or no mark of being the app's own, or from another page", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const test = await assemble(client, bank, ids);
      const sid = (await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`)).json["id"] as string;
      const port = client.server.port;
      const host = `127.0.0.1:${port}`;
      assert.equal((await rawRequest(port, `/api/scoring/${sid}`, { host })).status, 401, "no key");
      assert.equal((await rawRequest(port, `/api/scoring/${sid}/decisions`, { host, cookie: client.cookie }, "POST")).status, 403, "no mark of the app");
      assert.equal((await rawRequest(port, `/api/scoring/${sid}/save`, { host, cookie: client.cookie, "x-openassess": "1", origin: "https://evil.example" }, "POST")).status, 403, "another page");
      assert.equal((await rawRequest(port, `/api/scoring/${sid}/entries/0/crops/q1`, { host: "evil.example", cookie: client.cookie })).status, 421, "another name for this machine");
      const seen = await client.get<Json>(`/api/scoring/${sid}`);
      assert.equal(seen.status, 200);
      assert.equal(seen.json["unsaved"], false, "none of that changed anything");
    });
  });

  test("refuses a name that tries to climb out of a folder, a session that is not one, and a piece of picture that is not named like one", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const test = await assemble(client, bank, ids);
      const sid = (await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`)).json["id"] as string;
      for (const name of ["..\\x.openassess-scores", "../x.openassess-scores", "a/b.openassess-scores", "CON.openassess-scores", "plain.txt"]) {
        const reply = await client.post<Json>("/api/scoring/open", { name });
        assert.equal(reply.status, 400, name);
      }
      assert.equal((await client.post<Json>("/api/scoring/open", { name: "../x.openassess-scores" })).status, 400);
      for (const id of ["..", "x", "%2e%2e", "0123456789abcdef0123"]) assert.equal((await client.get(`/api/scoring/${id}`)).status, 404, id);
      for (const key of ["q1.png", "..%2fq1", "q", "q99999", "version2", "Q1"]) assert.equal((await client.get(`/api/scoring/${sid}/entries/0/crops/${key}`)).status, 404, key);
      assert.equal((await client.get(`/api/scoring/${sid}/entries/x/crops/q1`)).status, 404);
      assert.equal((await client.get(`/api/scoring/${sid}/sheets/x`)).status, 404);
      assert.equal((await client.get(`/api/scoring/${sid}/waiting/0`)).status, 404);
      // These go as written: a client that tidies "..%2f.." into a path would never send them.
      const port = client.server.port;
      const asked = (path: string): Promise<{ status: number; text: string }> => rawRequest(port, path, { host: `127.0.0.1:${port}`, cookie: client.cookie });
      assert.equal((await asked("/api/sheets/..%2f../tests")).status, 400);
      assert.equal((await asked("/api/sheets/a%5Cb/tests")).status, 400);
      assert.equal((await asked(`/api/sheets/${encodeURIComponent(bank)}/tests/..%2f..`)).status, 404);
      assert.equal((await asked("/api/scoring/..%2f..")).status, 404);
    });
  });

  test("refuses a picture whose bytes are not its size, one that is too large, and a request too big for what it is", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const test = await assemble(client, bank, ids);
      const sid = (await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`)).json["id"] as string;
      const pages = `/api/scoring/${sid}/pages`;
      assert.equal((await post(client, `${pages}?width=100&height=100`, new Uint8Array(99))).status, 400, "short");
      assert.equal((await post(client, `${pages}?width=100&height=100`, new Uint8Array(10_001))).status, 400, "long");
      assert.equal((await post(client, `${pages}?width=4&height=4`, new Uint8Array(16))).status, 400, "too small to be a page");
      assert.equal((await post(client, `${pages}?width=abc&height=100`, new Uint8Array(1))).status, 400);
      assert.equal((await post(client, `${pages}?width=100000&height=100000`, new Uint8Array(1))).status, 400);
      assert.equal((await post(client, `${pages}?width=5000&height=5000`, new Uint8Array(25_000_000))).status, 413, "more than a page of a scan is refused before it is read");
      assert.equal(await chunkedPost(client.server.port, `/api/scoring/${sid}/decisions`, { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "x-openassess": "1" }, 6), 413, "a decision is small");
      assert.equal((await client.get<Json>(`/api/scoring/${sid}`)).json["pages"].length, 0, "none of them was kept");
    });
  });

  test("answers a file it cannot read as a refused page with what to do, and keeps it", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const test = await assemble(client, bank, ids);
      const sid = (await client.post<Json>(`/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}/score`)).json["id"] as string;
      const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
      const reply = await post(client, `/api/scoring/${sid}/files?name=photo.heic`, heic);
      assert.equal(reply.status, 200, reply.text);
      const view = (await client.get<Json>(`/api/scoring/${sid}`)).json;
      assert.equal(view["pages"][0].ok, false);
      assert.match(view["pages"][0].reason, /HEIC/);
      assert.equal((await post(client, `/api/scoring/${sid}/files?name=empty.png`, new Uint8Array(0))).status, 400);
    });
  });
});

// Found by a reader of the file-name fix: the paper, the saved scores and the results of a test were named for the test, and a test
// whose name is longer than about 40 characters made names that were refused when the person came to download or open them.
describe("a test with a long name", () => {
  const LONG = "Introduction to Psychology Chapter Three Midterm Examination Fall Section 002 more words here";

  test("prints its paper twice, saves its scores and opens them again, and writes its results twice, under names that can all be used", async () => {
    await withApp(async (client) => {
      const { bank, ids } = await seeded(client);
      const test = await assemble(client, bank, ids, { name: LONG });
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${test["id"]}`;

      for (let round = 1; round <= 2; round++) {
        const printed = await client.post<Json>(`${url}/print`, { paper: "letter", sheet: "shared", booklets: true, keys: true, formats: ["pdf", "docx"] });
        assert.equal(printed.status, 200, printed.text);
        const names = (printed.json["written"] as Json[]).map((f) => f["name"] as string);
        assert.ok(names.length >= 4, "a booklet and a key in two formats, and the sheet");
        for (const name of names) {
          assert.ok(name.length <= 80, name);
          assert.equal((await client.get(`/files/${encodeURIComponent(name)}`)).status, 200, `${name} (${name.length}) downloads, round ${round}`);
        }
      }

      const record = await recordOf(client, bank, test["id"]);
      const opened = await client.post<Json>(`${url}/score`);
      const sid = opened.json["id"] as string;
      assert.equal((await post(client, `/api/scoring/${sid}/files?name=a.png`, writePng(drawn(record).render(marksFor(rightPlaces(record, "A"), 1))))).status, 200);

      const saved = await client.post<Json>(`/api/scoring/${sid}/save`);
      assert.equal(saved.status, 200, saved.text);
      const scoresName = saved.json["name"] as string;
      assert.ok(scoresName.length <= 80 && scoresName.endsWith(".openassess-scores"), scoresName);
      const reopened = await client.post<Json>("/api/scoring/open", { name: scoresName });
      assert.equal(reopened.status, 200, `${scoresName} (${scoresName.length}) opens again: ${reopened.text}`);

      for (let round = 1; round <= 2; round++) {
        const results = await client.post<Json>(`/api/scoring/${sid}/export`, {});
        assert.equal(results.status, 200, results.text);
        for (const file of results.json["written"] as Json[]) {
          assert.ok((file["name"] as string).length <= 80, file["name"]);
          assert.equal((await client.get(`/files/${encodeURIComponent(file["name"] as string)}`)).status, 200, `${file["name"]} downloads, round ${round}`);
        }
      }
    });
  });
});
