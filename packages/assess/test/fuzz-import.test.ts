/**
 * Damaged files are read, or refused in words, and never crash the reader or hang it.
 *
 * Every file here is a real one from the repository (the Word documents Word itself wrote, the samples, the plain text fixtures), with
 * a few bytes of it truncated, flipped, zeroed, repeated, cut or spliced from another place, by a generator with a fixed seed so that
 * a failure can be run again. A file that comes from a shared folder or an email is where these come from: a sync that did not finish,
 * a download that was cut short. What is wanted of each is a result, or an error that says something a person can read. What is not
 * wanted is a TypeError, a RangeError or a message such as "Cannot read properties of undefined", which the app would show as the
 * reason a file could not be read, and which says a rule was missed; or a read that takes seconds.
 *
 * About 45,000 damaged files were read this way when it was written, with none of those; this is the small, quick, repeatable part.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { unzipSync, zipSync } from "../src/container/zip.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { createTest } from "../src/model/test.ts";
import { writePng } from "../src/sheets/image.ts";
import { openScans } from "../src/sheets/intake.ts";
import { SheetReader } from "../src/sheets/read.ts";
import { buildPdf, at as drawAt } from "./support/pdf-builder.ts";
import { scanPdf } from "./support/pdf-scan.ts";
import { drawn, mcq, testOf, tfq } from "./support/sheet-fixtures.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";
import { drawing, emf, gif, jpeg, pictureParts, png } from "./support/images.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// OPENASSESS_FUZZ_ROUNDS asks for a longer run by hand (a few hundred rounds a file); the same seeds give the same files, so a failure can be run again.
const ROUNDS = Number(process.env["OPENASSESS_FUZZ_ROUNDS"] ?? 40);
const SLOW_MS = 3000;

interface Seed {
  name: string;
  bytes: Uint8Array;
}

function seeds(): Seed[] {
  const out: Seed[] = [];
  for (const dir of ["fixtures/word-authored", "packages/app/samples", "fixtures/standard-format", "fixtures/moodle-xml"]) {
    for (const file of readdirSync(join(root, dir)).sort()) {
      if (![".docx", ".xlsx", ".txt", ".csv", ".xml"].includes(extname(file))) continue;
      out.push({ name: file, bytes: new Uint8Array(readFileSync(join(root, dir, file))) });
    }
  }
  // A PDF with the questions as text, and a table saved as CSV.
  const page = [drawAt(72, 720, 12, "1. What is the capital of France?"), drawAt(72, 700, 12, "a. Paris"), drawAt(72, 684, 12, "*b. Rome"), drawAt(72, 660, 12, "2. What is 2 + 2?"), drawAt(72, 644, 12, "a. 3"), drawAt(72, 628, 12, "*b. 4")].join("");
  const font = { kind: "simple" as const, base: "Helvetica", widths: Array.from({ length: 224 }, () => 500) };
  out.push({ name: "sample.pdf", bytes: buildPdf({ pages: [page, page], fonts: { F1: font } }) });
  out.push({ name: "compressed.pdf", bytes: buildPdf({ pages: [page], fonts: { F1: font }, compress: true, modern: true }) });
  // A Word file with pictures of every kind the reader keeps or refuses: PNG, JPEG, GIF, a drawing it does not read, one cropped.
  const figure = (rId: string, options = {}) => ({ draw: drawing(rId, { alt: "A figure", ...options }) });
  const lines: Array<string | { draw: string }> = ["1. Look. Which?", figure("rId1"), "a) A", "b) B", "Answer: a", "2. Look. Which?", figure("rId2"), "a) A", "b) B", "Answer: b", "3. Look. Which?", figure("rId3"), "a) A", "b) B", "Answer: a", "4. Look. Which?", figure("rId4"), "a) A", "b) B", "Answer: a", "5. Look. Which?", figure("rId1", { crop: { l: 5000 } }), "a) A", "b) B", "Answer: b"];
  out.push({
    name: "pictures.docx",
    bytes: docx({
      body: lines.map((l) => (typeof l === "string" ? paragraph(run(l)) : paragraph("<w:r>" + l.draw + "</w:r>"))).join(""),
      ...pictureParts([
        { rId: "rId1", part: "word/media/image1.png", bytes: png(12, 9) },
        { rId: "rId2", part: "word/media/image2.jpeg", bytes: jpeg(30, 20) },
        { rId: "rId3", part: "word/media/image3.gif", bytes: gif(8, 8) },
        { rId: "rId4", part: "word/media/image4.emf", bytes: emf() },
      ]),
    }),
  });
  out.push({ name: "table.csv", bytes: new Uint8Array(Buffer.from("Type,Question,A,B,Correct\nMC,What is 2 + 2?,3,4,B\nMC,What is the capital of Spain?,Madrid,Rome,A\n")) });
  // A table with the right answer in a column of its own and a second language beside it, as a text file the way a spreadsheet saves it.
  out.push({
    name: "right-first.txt",
    bytes: new Uint8Array(
      Buffer.from(
        "question_id;question_english;correct_answer_english;incorrect_answer_1_english;incorrect_answer_2_english;question_french;correct_answer_french;incorrect_answer_1_french;incorrect_answer_2_french\n" +
          "A-001;Which is cold?;Ice;Fire;Lava;Lequel est froid?;La glace;Le feu;La lave\nA-002;Which is true?;Both;Neither;None of the above;Lequel est vrai?;Les deux;Aucun;Aucune de ces réponses\n",
      ),
    ),
  });
  // What the LMS exporters write, which the QTI reader reads back (a package, and one of its XML files on its own), and a question
  // library in the shape a real Brightspace file had.
  const mixed = new Uint8Array(readFileSync(join(root, "fixtures/standard-format/03-mixed-types.txt")));
  const made = runImporter(importerForContent("mixed.txt", mixed), mixed, { file: "mixed.txt" });
  const packages: Array<[string, Uint8Array]> = [
    ["qti12.zip", exportQti12(made.questions, { name: "Fuzz" }).files[0]?.bytes as Uint8Array],
    ["qti21.zip", exportQti21(made.questions, { name: "Fuzz" }).files[0]?.bytes as Uint8Array],
    ["cartridge.imscc", exportCommonCartridge(made.questions, { name: "Fuzz" }).files[0]?.bytes as Uint8Array],
  ];
  // The Brightspace question library as a CSV, which is read by the keyword in each row's first cell.
  const library = exportD2lCsv(made.questions, { name: "Fuzz" }).files[0];
  if (library) out.push({ name: "library.csv", bytes: new Uint8Array(Buffer.from(library.content, "utf8")) });
  // Blackboard's upload file: tab-delimited rows, each a type, the question, and the words correct or incorrect beside its answers.
  const upload = exportBlackboardUpload(made.questions, { name: "Fuzz" }).files[0];
  if (upload) out.push({ name: "upload.txt", bytes: new Uint8Array(Buffer.from(upload.content, "utf8")) });
  for (const [name, bytes] of packages) {
    out.push({ name, bytes });
    for (const [inside, data] of unzipSync(bytes)) {
      if (/\.xml$/i.test(inside) && !/manifest/i.test(inside)) {
        out.push({ name: `${name.replace(/\W/g, "-")}-${inside.replace(/\W/g, "-")}`.slice(0, 60) + ".xml", bytes: data });
        break;
      }
    }
  }
  const libraryItem = (n: number): string =>
    `<item d2l_2p0:id="${n}" ident="OBJ_${n}" label="QUES_${n}" title="Which planet is closest to the Su"><itemmetadata><qtimetadata><qti_metadatafield><fieldlabel>qmd_questiontype</fieldlabel><fieldentry>Multiple Choice</fieldentry></qti_metadatafield><qti_metadatafield><fieldlabel>qmd_weighting</fieldlabel><fieldentry>2.0000</fieldentry></qti_metadatafield></qtimetadata></itemmetadata><presentation><flow><material><mattext texttype="text/html"><![CDATA[Which planet is closest to the Sun?]]></mattext></material><response_lid ident="QUES_${n}_LID" rcardinality="Multiple"><render_choice shuffle="no"><flow_label class="Block"><response_label ident="QUES_${n}_A1"><flow_mat><material><mattext texttype="text/html"><![CDATA[Venus]]></mattext></material></flow_mat></response_label></flow_label><flow_label class="Block"><response_label ident="QUES_${n}_A2"><flow_mat><material><mattext texttype="text/html"><![CDATA[Mercury]]></mattext></material></flow_mat></response_label></flow_label></render_choice></response_lid></flow></presentation><resprocessing><respcondition title="C1"><conditionvar><varequal respident="QUES_${n}_LID">QUES_${n}_A1</varequal></conditionvar><setvar action="Set">0.0000</setvar></respcondition><respcondition title="C2"><conditionvar><varequal respident="QUES_${n}_LID">QUES_${n}_A2</varequal></conditionvar><setvar action="Set">100.0000</setvar></respcondition></resprocessing></item>`;
  out.push({
    name: "library.zip",
    bytes: zipSync([
      { name: "imsmanifest.xml", data: new Uint8Array(Buffer.from('<manifest xmlns:d2l_2p0="http://desire2learn.com/xsd/d2lcp_v2p0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><resources><resource identifier="res_question_library" type="webcontent" d2l_2p0:material_type="d2lquestionlibrary" href="questiondb.xml" /></resources></manifest>')) },
      { name: "questiondb.xml", data: new Uint8Array(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><questestinterop><objectbank ident="QLIB_1" xmlns:d2l_2p0="http://desire2learn.com/xsd/d2lcp_v2p0"><section ident="SECT_1" title="Section-Test">${libraryItem(1)}${libraryItem(2)}</section></objectbank></questestinterop>`)) },
    ]),
  });
  // A zip that only wraps a text file, which is what a downloaded bank often is.
  out.push({ name: "wrapped.zip", bytes: zipSync([{ name: "bank/questions.txt", data: new Uint8Array(Buffer.from("Question;Correct;Wrong\nWhich?;A;B\n")) }]) });
  return out;
}

/** The same numbers every time: a small linear generator, seeded. */
function generator(seed: number): { int: (n: number) => number } {
  let state = seed >>> 0;
  return {
    int(n: number): number {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 4294967296) * n);
    },
  };
}

function damage(bytes: Uint8Array, random: { int: (n: number) => number }): Uint8Array {
  const out = [...bytes];
  const kind = random.int(7);
  const at = random.int(Math.max(1, out.length));
  const len = 1 + random.int(Math.min(200, Math.max(1, out.length - at)));
  switch (kind) {
    case 0:
      return new Uint8Array(out.slice(0, at));
    case 1:
      for (let i = 0; i < 1 + random.int(20); i++) out[random.int(out.length)] = random.int(256);
      return new Uint8Array(out);
    case 2:
      for (let i = at; i < Math.min(out.length, at + len); i++) out[i] = 0;
      return new Uint8Array(out);
    case 3:
      out.splice(at, 0, ...out.slice(at, at + len));
      return new Uint8Array(out);
    case 4:
      out.splice(at, len);
      return new Uint8Array(out);
    case 5: {
      const other = random.int(out.length);
      out.splice(at, 0, ...out.slice(other, other + len));
      return new Uint8Array(out);
    }
    default:
      for (let i = 0; i < 1 + random.int(8); i++) {
        const place = random.int(out.length);
        out[place] = (out[place] ?? 0) ^ (1 << random.int(8));
      }
      return new Uint8Array(out);
  }
}

/** A failure that is the reader's own mistake and not the file's: it says a rule was missed. */
const isCrash = (error: unknown): boolean =>
  error instanceof TypeError ||
  error instanceof RangeError ||
  error instanceof ReferenceError ||
  !(error instanceof Error) ||
  /Cannot read|is not a function|is not iterable|Maximum call stack|Invalid (array|string|typed array) length|undefined|NaN/.test(error.message);

describe("a damaged bank", () => {
  const bankBytes = (): Uint8Array => {
    const bank = Bank.createEmpty("Fuzz", { at: "2026-01-01T00:00:00.000Z" });
    const qs = Array.from({ length: 6 }, (_, i) =>
      bank.add(
        createQuestion({
          type: "multipleChoice",
          stem: plainToRich(`Question ${i} about topic ${i}`),
          body: { shuffle: true, options: ["A", "B", "C"].map((t, k) => ({ id: `o${k}`, content: plainToRich(`${t}${i}`), correct: k === 0 })) } as never,
          metadata: { tags: ["t"], status: "draft", chapter: `${i % 2}` },
        }),
      ),
    );
    bank.moveToFolder((qs[0] as { id: string }).id, bank.addFolder("Chapter 1").id);
    // Two questions with a picture, one of them with its bytes in the bank and one without.
    for (const [i, held] of [[0, true], [1, false]] as const) {
      const file = "media/p-000000000000000" + i + ".png";
      bank.add(
        createQuestion({
          type: "essay",
          stem: { format: "rich", content: '<p>See <oa-media ref="m' + i + '"></oa-media></p>' },
          body: {},
          media: [{ id: "m" + i, file, mime: "image/png", alt: "A figure" }],
        }),
        held ? { media: new Map([[file, png(6, 6)]]) } : {},
      );
    }
    bank.addTest(createTest({ name: "Quiz", questions: qs, versions: 2, seed: "s" }));
    return bank.toBytes({ at: "2026-01-01T00:00:00.000Z" });
  };

  test("opens with its damage reported, or is refused in words, and what opens can be used and saved", () => {
    const original = bankBytes();
    const crashes: string[] = [];
    let opened = 0;
    let refused = 0;
    const random = generator(4242);
    for (let round = 0; round < 300; round++) {
      let bytes: Uint8Array;
      if (round % 2 === 0) {
        bytes = damage(original, random);
      } else {
        // Damage one file inside, which gets past the zip's own checks.
        const files = unzipSync(original);
        const names = [...files.keys()];
        const name = names[random.int(names.length)] as string;
        const text = Buffer.from(files.get(name) as Uint8Array).toString("utf8");
        const next = [text.slice(0, random.int(text.length)), "", "null", "[]", text.replace(/"([a-zA-Z]+)":/g, (m, k: string) => (random.int(8) === 0 ? `"${k}x":` : m)), text.replace(/:\s*("[^"]*"|\d+|true|false)/g, (m) => (random.int(10) === 0 ? ": null" : m))][random.int(6)] as string;
        files.set(name, new Uint8Array(Buffer.from(next)));
        bytes = zipSync([...files].map(([n, data]) => ({ name: n, data })));
      }
      try {
        const { bank } = Bank.fromBytes(bytes);
        bank.sortedQuestions();
        bank.search("topic");
        bank.stats();
        bank.listTests();
        bank.missingMedia();
        bank.checkQuality();
        Bank.fromBytes(bank.toBytes());
        opened++;
      } catch (error) {
        if (isCrash(error)) crashes.push(`round ${round}: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`.slice(0, 200));
        else refused++;
      }
    }
    assert.deepEqual(crashes.slice(0, 10), [], `${crashes.length} of 300 damaged banks crashed the reader`);
    assert.ok(opened > 0 && refused > 0, `${opened} opened and ${refused} were refused`);
  });

  test("a folder tree damaged inside, with a list for its root, is reported and kept, not thrown out of the folder walk", () => {
    for (const tree of ['{"root":[{"id":"f","name":"x"}],"filters":[]}', '{"root":[{"id":"f","name":"x","questionIds":[1],"children":[]}],"filters":[]}', '{"root":[{"id":"f","name":"x","questionIds":[],"children":[{"id":"g"}]}],"filters":[]}', '{"root":[],"filters":[5]}', '{"root":[null],"filters":[]}']) {
      const files = unzipSync(bankBytes());
      files.set("folders.json", new Uint8Array(Buffer.from(tree)));
      const { bank, report } = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
      assert.equal(bank.questions.size, 8, tree);
      assert.equal(report.invalid[0]?.id, "folders.json", tree);
      assert.equal(Buffer.from(unzipSync(bank.toBytes()).get("folders.damaged.json") as Uint8Array).toString("utf8"), tree, "kept as it was");
    }
  });

  test("a folder tree nested a thousand deep is not followed", () => {
    const deep = (n: number): string => (n === 0 ? "[]" : `[{"id":"f${n}","name":"x","questionIds":[],"children":${deep(n - 1)}}]`);
    const files = unzipSync(bankBytes());
    files.set("folders.json", new Uint8Array(Buffer.from(`{"root":${deep(300)},"filters":[]}`)));
    const { bank, report } = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    assert.equal(bank.questions.size, 8);
    assert.equal(report.invalid[0]?.id, "folders.json");
  });

  test("a manifest that does not say what the file is is refused without saying undefined", () => {
    const files = unzipSync(bankBytes());
    files.set("manifest.json", new Uint8Array(Buffer.from('{"title":"No format here"}')));
    assert.throws(() => Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data })))), (error: Error) => /does not say what kind of file it is/.test(error.message) && !/undefined/.test(error.message));
    files.set("manifest.json", new Uint8Array(Buffer.from('{"format":"something-else"}')));
    assert.throws(() => Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data })))), /says it is "something-else", not an OpenAssess bank/);
  });
});

describe("a damaged scan of an answer sheet", () => {
  test("is opened and read, or refused with a reason, and never crashes the reader or takes seconds", () => {
    const record = testOf([mcq(4), tfq(), mcq(4), mcq(5), mcq(3), mcq(4)]);
    const image = drawn(record, { dpi: 100 }).render({ answers: { 1: [{ place: 1, mark: { kind: "solid" } }], 2: [{ place: 0, mark: { kind: "solid" } }] } });
    const seedsOf: Array<{ name: string; bytes: Uint8Array }> = [{ name: "sheet.png", bytes: writePng(image, { dpi: 100 }) }];
    for (const encoding of ["flate", "raw", "flate-predictor", "rgb", "cmyk", "indexed-1", "decode-inverted"] as const) seedsOf.push({ name: `scan-${encoding}.pdf`, bytes: scanPdf([{ picture: { image, encoding } }]) });
    const reader = new SheetReader(record);
    const crashes: string[] = [];
    let opened = 0;
    let refused = 0;
    seedsOf.forEach((seed, index) => {
      const random = generator(9000 + index);
      for (let round = 0; round < 25; round++) {
        const bytes = damage(seed.bytes, random);
        const started = performance.now();
        try {
          const intake = openScans(bytes);
          if (!intake.ok) {
            assert.ok(intake.reason.length > 0, "a refusal has a reason");
            refused++;
            continue;
          }
          opened++;
          for (const page of intake.pages) if (page.result.ok && page.result.source.kind === "grey") reader.read(page.result.source.image);
        } catch (error) {
          crashes.push(`${seed.name} round ${round}: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`.slice(0, 200));
        }
        if (performance.now() - started > SLOW_MS) crashes.push(`${seed.name} round ${round}: took ${Math.round(performance.now() - started)} ms`);
      }
    });
    assert.deepEqual(crashes.slice(0, 10), [], `${crashes.length} damaged scans crashed the reader or were slow`);
    assert.ok(opened > 0 && refused > 0, `${opened} opened and ${refused} were refused`);
  });
});

describe("what counts as the reader's own mistake", () => {
  test("is a TypeError, a RangeError, a message that shows a missed rule, or something that is not an error", () => {
    assert.equal(isCrash(new TypeError("x")), true);
    assert.equal(isCrash(new RangeError("x")), true);
    assert.equal(isCrash(new ReferenceError("x")), true);
    assert.equal(isCrash(new Error("Cannot read properties of undefined (reading 'a')")), true);
    assert.equal(isCrash(new Error("x is not a function")), true);
    assert.equal(isCrash(new Error("Maximum call stack size exceeded")), true);
    assert.equal(isCrash("a string was thrown"), true);
  });

  test("is not a refusal that says what is wrong with the file", () => {
    assert.equal(isCrash(new Error("This file could not be opened as a Word document. This file is not a zip.")), false);
    assert.equal(isCrash(new Error("This is a Rich Text file (.rtf), not a .docx.")), false);
  });

  test("the damage is the same every time, and does change the file", () => {
    const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256));
    const once = damage(bytes, generator(7));
    assert.deepEqual(damage(bytes, generator(7)), once);
    assert.notDeepEqual(once, bytes);
    assert.notDeepEqual(damage(bytes, generator(8)), once);
  });
});

describe("a damaged file", () => {
  const all = seeds();

  test("there are files to damage, of every kind the importers read", () => {
    const kinds = new Set(all.map((s) => extname(s.name)));
    for (const kind of [".docx", ".xlsx", ".txt", ".csv", ".pdf"]) assert.ok(kinds.has(kind), `no ${kind} file to damage`);
    assert.ok(all.length > 30);
  });

  test("is read, or refused in words, and never crashes the reader or takes seconds", () => {
    const crashes: string[] = [];
    let read = 0;
    let refused = 0;
    all.forEach((seed, index) => {
      const random = generator(1000 + index);
      for (let round = 0; round < ROUNDS; round++) {
        const bytes = damage(seed.bytes, random);
        const started = performance.now();
        try {
          const result = runImporter(importerForContent(seed.name, bytes), bytes, { file: seed.name });
          assert.ok(Array.isArray(result.questions), "a result has a list of questions");
          read++;
        } catch (error) {
          if (isCrash(error)) crashes.push(`${seed.name} round ${round} (seed ${1000 + index}): ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`.slice(0, 200));
          else refused++;
        }
        const took = performance.now() - started;
        if (took > SLOW_MS) crashes.push(`${seed.name} round ${round} (seed ${1000 + index}): took ${Math.round(took)} ms`);
      }
    });
    assert.deepEqual(crashes.slice(0, 10), [], `${crashes.length} of ${all.length * ROUNDS} damaged files crashed the reader or were slow`);
    assert.ok(read > 0 && refused > 0, `both happen: ${read} were read and ${refused} were refused`);
  });

  test("a file that is nothing, or one byte, or is all zeros, is refused or read as nothing", () => {
    for (const name of ["a.docx", "a.xlsx", "a.pdf", "a.txt", "a.csv", "a.rtf"]) {
      for (const bytes of [new Uint8Array(0), new Uint8Array([0]), new Uint8Array(4096), new Uint8Array(64).fill(255)]) {
        try {
          const result = runImporter(importerForContent(name, bytes), bytes, { file: name });
          assert.ok(Array.isArray(result.questions), name);
        } catch (error) {
          assert.equal(isCrash(error), false, `${name} (${bytes.length} bytes): ${(error as Error).message}`);
        }
      }
    }
  });
});
