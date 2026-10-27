/**
 * What happens when a bank file is not in perfect condition.
 *
 * The format is meant to be kept in a shared folder and merged there, and an
 * append-only log is the file most likely to be left half-written by a crash,
 * so damage is the expected case rather than the exotic one. Every case here
 * used to either take the whole bank down or lose a question without a word.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Bank } from "../src/bank/store.ts";
import { unzipSync, zipSync, type ZipEntry } from "../src/container/zip.ts";
import { createQuestion } from "../src/model/create.ts";

const ID_A = "q_01M5YSJYK2RG9Z7HM4ZW3KJMKC";
const ID_B = "q_01M5YSJYK2VJQWHMGPPHQVMP37";

const bytes = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

const MANIFEST = {
  format: "openassess-bank",
  formatVersion: 1,
  id: "bank_01M5YSJYK5H125KP5ZDT4T7AKD",
  title: "Probe",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  questionCount: 1,
  generator: "test",
};

function question(id: string, title: string) {
  return createQuestion({ id, type: "essay", stem: "Discuss the result.", title, body: {} });
}

function bankFile(extra: { folders?: unknown; more?: ZipEntry[] } = {}): Uint8Array {
  return zipSync([
    { name: "manifest.json", data: bytes(MANIFEST) },
    { name: "folders.json", data: bytes(extra.folders ?? { root: [], filters: [] }) },
    { name: `questions/${ID_A}.json`, data: bytes(question(ID_A, "The real one")) },
    ...(extra.more ?? []),
  ]);
}

describe("a damaged bank still opens", () => {
  it("skips an unreadable history line instead of refusing the whole file", () => {
    const opened = Bank.fromBytes(
      bankFile({ more: [{ name: "history.jsonl", data: bytes('{"at":"2026-01-01","by":"a","change":"created"}\nhalf-writ') }] }),
    );
    assert.equal(opened.bank.questions.size, 1, "the questions matter more than the log");
    assert.equal(opened.bank.history.length, 1);
    assert.ok(opened.report.invalid.some((i) => i.id === "history.jsonl"));
  });

  it("falls back to an empty folder tree when folders.json is malformed", () => {
    const opened = Bank.fromBytes(bankFile({ folders: { filters: [] } }));
    assert.equal(opened.bank.questions.size, 1);
  });
});

describe("nothing is lost to an id collision", () => {
  it("keeps the first question, reports the second, and overwrites neither", () => {
    const opened = Bank.fromBytes(
      bankFile({ more: [{ name: `questions/${ID_B}.json`, data: bytes(question(ID_A, "The impostor")) }] }),
    );

    assert.equal(opened.bank.questions.size, 1);
    assert.equal(opened.bank.questions.get(ID_A)?.title, "The real one");
    assert.ok(
      opened.report.invalid.some((i) => i.issues.some((s) => s.message.includes("already uses the id"))),
      "a collision has to be reported, not resolved quietly",
    );
  });

  it("writes one entry per name, so a re-open cannot pick the wrong copy", () => {
    const opened = Bank.fromBytes(
      bankFile({ more: [{ name: `questions/${ID_B}.json`, data: bytes(question(ID_A, "The impostor")) }] }),
    );
    const written = unzipSync(opened.bank.toBytes());
    const names = [...written.keys()].filter((n) => n.startsWith("questions/"));
    assert.equal(new Set(names).size, names.length, "duplicate names make the next open a coin toss");

    const reopened = Bank.fromBytes(opened.bank.toBytes());
    assert.equal(reopened.bank.questions.get(ID_A)?.title, "The real one");
  });
});

describe("the container refuses what it cannot vouch for", () => {
  it("catches a flipped byte rather than returning it as content", () => {
    const good = Buffer.from(zipSync([{ name: "a.json", data: bytes({ hello: "world" }), store: true }]));
    const at = good.indexOf(Buffer.from('{"hello'));
    assert.ok(at > 0, "fixture should contain the stored payload");
    good[at + 3] = (good[at + 3] as number) ^ 0xff;

    assert.throws(() => unzipSync(good), /did not survive storage intact/);
  });

  it("refuses an entry that claims more data than the file holds", () => {
    const good = Buffer.from(zipSync([{ name: "a.json", data: bytes({ hello: "world" }), store: true }]));
    // Overstate the compressed size in the central directory.
    const central = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    good.writeUInt32LE(good.length * 4, central + 20);

    assert.throws(() => unzipSync(good), /damaged/);
  });
});
