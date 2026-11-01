/**
 * The samples on the first screen, and Excel and CSV files brought in the way any other file is. A person who has nothing to
 * import must be able to see what the app does; a sample must read as it says it does; and a file the app cannot read must
 * say why in words, not read as noise.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeXlsx } from "../../assess/src/container/xlsx.ts";
import { at, buildPdf } from "../../assess/test/support/pdf-builder.ts";
import { SAMPLES, samplePath } from "../src/samples.ts";
import { rawRequest, withApp, type Client } from "./support/app.ts";

interface SessionView {
  id: string;
  file: string;
  counts: { parsed: number; needsReview: number; failed: number; orphans: number; skipped: number; total: number };
  questions: Array<{ index: number; verdict: string; title: string; type: string }>;
  orphans: Array<{ text: string }>;
  source: string[];
  fileFindings: Array<{ severity: string; message: string }>;
}

async function trySample(client: Client, id: string): Promise<SessionView> {
  const reply = await client.post<SessionView>(`/api/samples/${id}/import`);
  assert.equal(reply.status, 200, reply.text);
  return reply.json;
}

describe("the samples", () => {
  test("are listed with what each shows, and no file name or path goes to the screen", async () => {
    await withApp(async (client) => {
      const reply = await client.get<{ samples: Array<Record<string, unknown>> }>("/api/samples");
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json.samples.map((s) => s["id"]), ["word-bank", "word-bank-with-problems", "excel-table", "blank-table"]);
      for (const s of reply.json.samples) {
        assert.equal(typeof s["title"], "string");
        assert.ok(String(s["description"]).length > 30);
        assert.equal("file" in s, false);
        assert.equal("path" in s, false);
      }
      assert.deepEqual(reply.json.samples.map((s) => s["template"]), [false, false, false, true]);
    });
  });

  test("every sample is a file that is there", () => {
    for (const s of SAMPLES) assert.ok(existsSync(samplePath(s)), s.file);
    const folder = readdirSync(join(samplePath(SAMPLES[0] as (typeof SAMPLES)[number]), ".."));
    assert.deepEqual(folder.sort(), SAMPLES.map((s) => s.file).sort(), "no file sits there that the app does not offer");
  });

  test("the clean Word bank reads in full: ten questions, every answer found, nothing left over", async () => {
    await withApp(async (client) => {
      const view = await trySample(client, "word-bank");
      assert.deepEqual(view.counts, { parsed: 10, needsReview: 0, failed: 0, orphans: 0, skipped: 0, total: 10 });
      assert.deepEqual(view.questions.map((q) => q.type), ["multipleChoice", "multipleChoice", "multipleChoice", "multipleResponse", "multipleChoice", "trueFalse", "trueFalse", "shortAnswer", "shortAnswer", "essay"]);
    });
  });

  test("the Word bank with problems has the problems it says: no answer, an answer that is not there, two answers, a note", async () => {
    await withApp(async (client) => {
      const view = await trySample(client, "word-bank-with-problems");
      assert.deepEqual(view.counts, { parsed: 4, needsReview: 1, failed: 2, orphans: 3, skipped: 0, total: 7 });
      assert.deepEqual(view.questions.map((q) => q.verdict), ["parsed", "failed", "failed", "needsReview", "parsed", "parsed", "parsed"]);
      assert.ok(view.orphans.some((o) => /Note to self/.test(o.text)));
    });
  });

  test("the Excel table reads as rows: ten questions with keys, and the two mistakes it was made with", async () => {
    await withApp(async (client) => {
      const view = await trySample(client, "excel-table");
      assert.deepEqual(view.counts, { parsed: 10, needsReview: 0, failed: 2, orphans: 0, skipped: 0, total: 12 });
      assert.deepEqual(view.questions.slice(10).map((q) => q.verdict), ["failed", "failed"]);
      // The lines shown beside a question are its row, under the names of the columns, numbered as Excel numbers them.
      assert.equal(view.source[0], "Row 1: Type | Question | A | B | C | D | E | Correct | Points | Feedback if right | Feedback if wrong | Category");
      assert.match(view.source[11] ?? "", /^Row 12: Type: MC \| Question: Which planet has the shortest day\?/);
    });
  });

  test("a mistake in an Excel row is repaired on screen, and the row stays the question's source", async () => {
    await withApp(async (client) => {
      const view = await trySample(client, "excel-table");
      const base = `/api/sessions/${view.id}/questions/10`;
      const { question } = (await client.get(base)).json as { question: { version: number; stem: string; body: { options: Array<{ correct: boolean }> } } };
      assert.equal(question.stem, "Which planet has the shortest day?");
      assert.deepEqual(question.body.options.map((o) => o.correct), [false, false, false]);
      const input = JSON.parse(JSON.stringify(question));
      input.body.options[0].correct = true;
      const saved = await client.put(base, { input, expectVersion: question.version });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((saved.json as { counts: SessionView["counts"] }).counts.failed, 1);
    });
  });

  test("the blank table brings in its five examples, and says the sheet of instructions was not read", async () => {
    await withApp(async (client) => {
      const view = await trySample(client, "blank-table");
      assert.deepEqual(view.counts, { parsed: 5, needsReview: 0, failed: 0, orphans: 0, skipped: 0, total: 5 });
      const note = view.fileFindings.find((f) => /How to fill it in/.test(f.message));
      assert.equal(note?.severity, "info", "a sheet of notes is said, not warned about");
    });
  });

  test("a copy is saved into the exports folder, never over another, and its own bytes are the sample's", async () => {
    await withApp(async (client, home) => {
      const first = await client.post<{ name: string; path: string }>("/api/samples/blank-table/save");
      assert.equal(first.status, 200, first.text);
      assert.equal(first.json.name, "blank-question-table.xlsx");
      const second = await client.post<{ name: string; path: string }>("/api/samples/blank-table/save");
      assert.notEqual(second.json.name, first.json.name, "a second copy gets its own name");
      assert.deepEqual(readFileSync(join(home, "Exports", first.json.name)), readFileSync(samplePath(SAMPLES[3] as (typeof SAMPLES)[number])));
      assert.deepEqual(readdirSync(join(home, "Exports")).length, 2);
      // And what was saved is something the app can be asked to show, which it will only do inside the library.
      const shown = await client.post("/api/reveal", { path: first.json.path });
      assert.equal(shown.status, 200, shown.text);
    });
  });

  test("an id that is not a sample is not found, and no path can be asked for", async () => {
    await withApp(async (client) => {
      // (A bare ".." never reaches the server: the address is tidied first, and the tidied address is another route.)
      for (const id of ["nope", "..%2F..%2Fpackage", "solar-system-test-bank.docx", "word-bank%2F..%2F..%2Fstate", "WORD-BANK"]) {
        assert.equal((await client.post(`/api/samples/${id}/import`)).status, 404, id);
        assert.equal((await client.post(`/api/samples/${id}/save`)).status, 404, id);
      }
      assert.equal((await client.get("/api/samples/word-bank")).status, 404, "a sample is not a page of its own");
      assert.equal((await client.post("/api/samples/word-bank/other")).status, 404);
    });
  });

  test("only a change can import or save one: a plain GET, which needs no header, does neither", async () => {
    await withApp(async (client, home) => {
      for (const action of ["import", "save"]) assert.equal((await client.get(`/api/samples/blank-table/${action}`)).status, 404, action);
      assert.equal(readdirSync(join(home, "Exports")).length, 0, "nothing was written");
    });
  });

  test("saving a sample is a change, so it needs the app's own header like every change", async () => {
    await withApp(async (client, home) => {
      const reply = await rawRequest(client.server.port, "/api/samples/blank-table/save", { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie }, "POST");
      assert.equal(reply.status, 403);
      assert.equal(existsSync(join(home, "Exports", "blank-question-table.xlsx")), false);
    });
  });
});

describe("Excel and CSV files, brought in like any other", () => {
  const table = [
    ["Type", "Question", "A", "B", "Correct"],
    ["MC", "Which?", "one", "two", "B"],
    ["MC", "Which one has no key?", "one", "two", ""],
  ];

  test("an .xlsx file is read into rows, and its questions can be repaired", async () => {
    await withApp(async (client) => {
      const reply = await client.send<SessionView>("POST", "/api/import?name=my%20questions.xlsx", Buffer.from(writeXlsx([{ name: "Questions", rows: table }])));
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(reply.json.counts, { parsed: 1, needsReview: 0, failed: 1, orphans: 0, skipped: 0, total: 2 });
      assert.equal(reply.json.file, "my questions.xlsx");
      assert.equal(reply.json.source[2], "Row 3: Type: MC | Question: Which one has no key? | A: one | B: two");
    });
  });

  test("a .csv file, and an Excel Unicode text file called .txt, are tables too", async () => {
    await withApp(async (client) => {
      const csv = await client.send<SessionView>("POST", "/api/import?name=q.csv", Buffer.from(table.map((r) => r.join(",")).join("\n")));
      assert.equal(csv.status, 200, csv.text);
      assert.equal(csv.json.counts.total, 2);
      const tabs = await client.send<SessionView>("POST", "/api/import?name=q.txt", Buffer.from(table.map((r) => r.join("\t")).join("\n")));
      assert.equal(tabs.json.counts.total, 2);
      assert.match(tabs.json.source[1] ?? "", /^Row 2: /);
    });
  });

  test("an old .xls is refused with what to do, and nothing is made of it", async () => {
    await withApp(async (client) => {
      const xls = await client.send("POST", "/api/import?name=old.xls", Buffer.from("x"));
      assert.equal(xls.status, 400);
      assert.match(String(xls.json["error"]), /Excel Workbook \(\*\.xlsx\) or CSV UTF-8/);
    });
  });
});

describe("PDF files, brought in like any other", () => {
  const fonts = { F1: { kind: "simple" as const, base: "Helvetica", widths: Array.from({ length: 224 }, () => 500) } };
  const bank = [at(36, 740, 12, "1. Which planet is closest to the Sun?"), at(36, 726, 12, "a. Venus"), at(36, 712, 12, "*b. Mercury"), at(36, 698, 12, "c. Earth"), at(36, 670, 12, "2. What holds the planets in orbit?"), at(36, 656, 12, "a. Friction"), at(36, 642, 12, "b. Gravity"), at(36, 628, 12, "Answer: b. Gravity")].join("");

  test("a PDF is read into questions, each with its page, and says that it was read from the words alone", async () => {
    await withApp(async (client) => {
      const reply = await client.send<SessionView>("POST", "/api/import?name=bank.pdf", Buffer.from(buildPdf({ fonts, pages: [bank] })));
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(reply.json.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 0, skipped: 0, total: 2 });
      assert.equal(reply.json.source[0], "[p1] 1. Which planet is closest to the Sun?");
      assert.match(reply.json.fileFindings.map((f) => f.message).join("\n"), /read from the words on the pages alone/);
      const one = await client.get(`/api/sessions/${reply.json.id}/questions/0`);
      assert.equal((one.json["question"] as { origin?: { profile?: string } }).origin?.profile, "pdf");
    });
  });

  test("a PDF with no text in it (a scan) is refused, with the reason and what to do, and nothing is made of it", async () => {
    await withApp(async (client) => {
      const reply = await client.send("POST", "/api/import?name=scan.pdf", Buffer.from(buildPdf({ fonts, pages: ["0.5 g 100 100 200 200 re f\n"] })));
      assert.equal(reply.status, 422);
      assert.match(String(reply.json["error"]), /probably a scan/);
      assert.match(String(reply.json["error"]), /original document/);
    });
  });

  test("a protected PDF is refused, and a file named .pdf that is not one says so", async () => {
    await withApp(async (client) => {
      const locked = await client.send("POST", "/api/import?name=locked.pdf", Buffer.from(buildPdf({ fonts, pages: [bank], encrypted: true })));
      assert.equal(locked.status, 422);
      assert.match(String(locked.json["error"]), /protected/);
      const fake = await client.send("POST", "/api/import?name=fake.pdf", Buffer.from("this is only some text"));
      assert.equal(fake.status, 422);
      assert.match(String(fake.json["error"]), /not a PDF/);
    });
  });

  test("a PDF is found by what it begins with, whatever it is called", async () => {
    await withApp(async (client) => {
      const reply = await client.send<SessionView>("POST", "/api/import?name=bank.txt", Buffer.from(buildPdf({ fonts, pages: [bank] })));
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json.counts.total, 2);
    });
  });
});

describe("Excel and CSV files, once more", () => {

  test("an .xlsx file that is not one says so, in words, and is not read as text", async () => {
    await withApp(async (client) => {
      const reply = await client.send("POST", "/api/import?name=broken.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]));
      assert.equal(reply.status, 422);
      assert.match(String(reply.json["error"]), /could not be read/);
    });
  });
});
