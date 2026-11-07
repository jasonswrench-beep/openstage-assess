/**
 * A file of a kind this program does not read is said to be that kind, with what to do instead, wherever a file is chosen.
 *
 * Before this, an .odt (a zip) was decoded as text and came out as seven orphan blocks of junk with "the layout is not read", and a
 * Google Drive shortcut (a few lines of JSON with a web address) as one block of text: nothing said the file was the wrong kind, so a
 * person looked for what was wrong with their questions. Only the name is looked at, so a name that is read (.docx, .txt, .csv, .zip,
 * .imscc, .pdf, .xlsx, .gift, .aiken, .xml, .rtf, which the Word reader refuses in its own words) must never be caught by it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cannotRead } from "../src/import/cannot-read.ts";
import { IMPORTERS } from "../src/import/registry.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts");

describe("a file of a kind that is not read", () => {
  const cases: Array<[string, RegExp]> = [
    ["bank.doc", /older Word file.*Save As.*\.docx/],
    ["bank.xls", /older Excel file.*Save As.*\.xlsx/],
    ["bank.odt", /OpenDocument text.*LibreOffice.*Save As.*\.docx/],
    ["bank.ods", /OpenDocument spreadsheet.*LibreOffice.*\.xlsx.*\.csv/],
    ["bank.pages", /Pages.*Export To.*Word/],
    ["bank.numbers", /Numbers.*Export To.*Excel or CSV/],
    ["bank.gdoc", /shortcut.*holds no questions.*Google Docs.*Download.*\.docx/],
    ["bank.gsheet", /shortcut.*holds no questions.*Google Sheets.*Download.*\.xlsx/],
    ["bank.html", /web page.*Word document.*\.docx/],
    ["bank.htm", /web page.*Word document/],
    ["bank.ppt", /PowerPoint.*slides, not a list of questions/],
    ["bank.pptx", /PowerPoint.*slides, not a list of questions/],
  ];
  for (const [name, message] of cases) {
    test(`${name} is said to be what it is, and what to do instead`, () => {
      const said = cannotRead(name);
      assert.ok(said, `no message for ${name}`);
      assert.match(said as string, message);
    });
  }

  test("the name is told apart without regard to case, and whatever folder it is in", () => {
    assert.ok(cannotRead("QUESTIONS.ODT"));
    assert.ok(cannotRead("C:\\Users\\Someone\\My Documents\\final exam.Gdoc"));
    assert.ok(cannotRead("/home/someone/exam.v2.pages"));
  });

  test("a name that is read, or has no extension, is never caught", () => {
    for (const name of ["a.docx", "a.txt", "a.csv", "a.tsv", "a.xlsx", "a.xlsm", "a.zip", "a.imscc", "a.pdf", "a.gift", "a.aiken", "a.xml", "a.rtf", "a.openassess", "a", "", "a.", ".docx.bak", "docx"]) {
      assert.equal(cannotRead(name), undefined, name);
    }
  });

  test("an extension that is a property of every object is not a message", () => {
    for (const name of ["a.constructor", "a.__proto__", "a.toString", "a.hasOwnProperty"]) assert.equal(cannotRead(name), undefined, name);
  });

  test("no importer claims a name that is refused, so the refusal never hides a reader", () => {
    for (const importer of IMPORTERS) {
      for (const extension of importer.extensions) assert.equal(cannotRead(`file${extension}`), undefined, `${importer.id} reads ${extension}`);
    }
  });

  test("the command line says so for `import` and for `review`, and exits without reading the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-cannot-"));
    try {
      const odt = join(dir, "bank.odt");
      writeFileSync(odt, "PK\u0003\u0004 not read at all");
      for (const command of ["import", "review"]) {
        assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, command, odt], { encoding: "utf8", stdio: "pipe" }), /OpenDocument text.*LibreOffice/s, command);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
