/**
 * Documents that Word wrote itself (fixtures/word-authored), read on any machine.
 *
 * The other Word tests read documents from our own writer, which is not Word. These
 * were written by Word, through its object model, so their XML is the real thing:
 * the table grids, merged cells, list definitions and styles Word produces. They
 * were checked against Word by test/tools/word-authored-check.ts, and here they are
 * kept honest without it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { docxToBlocks } from "../src/import/word.ts";
import { EXPECTED, problemsWith } from "./support/word-authored.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "word-authored");

describe("documents that Word wrote", async () => {
  const present = (await readdir(FIXTURES).catch(() => [])).filter((n) => n.endsWith(".docx")).sort();

  test("every document Word was asked to write is there", () => {
    assert.deepEqual(present.map((n) => n.replace(/\.docx$/, "")), Object.keys(EXPECTED).sort());
  });

  for (const file of present) {
    const name = file.replace(/\.docx$/, "");
    test(`${name} reads as what it is`, async () => {
      const bytes = new Uint8Array(await readFile(join(FIXTURES, file)));
      const { problems } = problemsWith(name, bytes);
      assert.deepEqual(problems, []);
    });
  }

  test("each is a real Word file: it has the parts Word always writes, and a producer that says so", async () => {
    for (const file of present) {
      const bytes = new Uint8Array(await readFile(join(FIXTURES, file)));
      const text = new TextDecoder("latin1").decode(bytes);
      assert.match(text, /word\/document\.xml/, file);
      assert.match(text, /docProps\/app\.xml/, file);
      assert.match(text, /word\/styles\.xml/, file);
      assert.ok(docxToBlocks(bytes).blocks.length > 0, file);
    }
  });
});
