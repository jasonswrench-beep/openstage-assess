/**
 * Readers and writers that cost far more than the file or the question is long.
 *
 * Found by an independent reader who made small inputs and ran each against the real code: `<` repeated 200,000 times is a bank of 1.3 KB
 * that took ten seconds to open and forty-six to check; `<oa-media ` repeated 40,000 times in a stem took every exporter twenty seconds; a
 * question whose text had 130,000 line breaks (130 KB) ended in "Maximum call stack size exceeded"; a line of 80,000 spaces took four
 * seconds and 200,000 quotation marks in a cell took ten. None of them is a real question. Each is a file that a damaged program, a
 * hostile page or a joke can produce, and a program that stops for a minute on a file, or fails with the words of its own call stack, has
 * not read it. Every input is read in a child process that is stopped when its time is up, so that a return of one of these faults fails
 * a test and does not hold up the others.
 *
 * The times are measured round the work alone and the limits are at least five times what the code takes on the machine this was written
 * on, and well under what the faulty code took (which is why a fault that comes back fails on the time and not on a slow day).
 * `test/linear-parity.test.ts` holds the replacements to the patterns they replaced, and `test/spread-guard.test.ts` holds the calls.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { inChild, reported, zeroPng, type ChildRun } from "./support/hostile-readers.ts";

const show = process.env["OPENASSESS_SHOW_TIMES"] !== undefined;

/** The child finished, said so, and took no longer than `limit` milliseconds of work. Returns what it reported. */
function within(run: ChildRun, label: string, limit: number): Record<string, unknown> {
  assert.equal(run.timedOut, false, `${label} did not finish in ${run.wall} ms`);
  assert.equal(run.status, 0, `${label} failed: ${run.stderr.slice(0, 400)}`);
  const out = reported(run);
  assert.ok(out !== undefined, `${label} reported nothing: ${run.stdout.slice(0, 200)}`);
  if (show) console.log(`${label}: ${String(out["ms"])} ms, ${String(out["rssMb"])} MB`);
  assert.ok((out["ms"] as number) < limit, `${label} took ${String(out["ms"])} ms, more than ${limit} ms`);
  return out;
}

describe("a text with many tags that never end", () => {
  test("a bank whose stem is 200,000 '<' opens and is checked at once", () => {
    const run = inChild(String.raw`
      const bytes2 = await bankWithStem("<".repeat(200000));
      const { Bank } = await engine("bank/store.ts");
      start();
      const opened = Bank.fromBytes(bytes2);
      const open = Math.round(performance.now() - __t0);
      opened.bank.checkQuality();
      done({ open, questions: opened.bank.questions.size, invalid: opened.report.invalid.length });
    `);
    const out = within(run, "open and check", 1500);
    assert.equal(out["questions"], 1, "the question is still there");
    assert.equal(out["invalid"], 0);
  });

  test("a stem of 200,000 '<strong>' that are never closed is checked at once", () => {
    const run = inChild(String.raw`
      const bytes2 = await bankWithStem("<strong>".repeat(200000));
      const { Bank } = await engine("bank/store.ts");
      const opened = Bank.fromBytes(bytes2);
      start();
      opened.bank.checkQuality();
      done({ questions: opened.bank.questions.size });
    `);
    within(run, "check", 1500);
  });

  test("richTextToPlain, collectRefs and the table reader take 400,000 tags with no end in a moment", () => {
    const run = inChild(String.raw`
      const { richTextToPlain, collectRefs } = await engine("model/richtext.ts");
      const { readTableHtml, replaceTables } = await engine("model/table.ts");
      const { markupTokens } = await engine("model/markup-scan.ts");
      const { withoutBlockBreaks } = await engine("export/gift.ts");
      const times = {};
      let t = 0;
      const lap = (name) => { const now = performance.now(); times[name] = Math.round(now - t); t = performance.now(); };
      start(); t = performance.now();
      richTextToPlain("<".repeat(400000)); lap("plain <");
      richTextToPlain("<oa-media ".repeat(40000)); lap("plain oa-media");
      richTextToPlain("<br" + " ".repeat(300000)); lap("plain br");
      richTextToPlain(" ".repeat(200000) + "x"); lap("plain no-break spaces");
      collectRefs("<oa-media ".repeat(40000)); lap("refs oa-media");
      collectRefs("<oa-media ref=\"x\" ".repeat(40000)); lap("refs");
      readTableHtml("<table>" + "<tr><td>x".repeat(40000)); lap("table cells never closed");
      readTableHtml("<table>" + "<td".repeat(60000)); lap("table td");
      readTableHtml("<table><tr><td>" + "\t".repeat(300000) + " | \n"); lap("table tabs");
      replaceTables("<table ".repeat(60000), (t2) => t2); lap("replaceTables");
      // These two were asked of the native search for a '>' from every start, which is quick for one and not for a million.
      markupTokens("<".repeat(1000000)); lap("tokens");
      withoutBlockBreaks("<p ".repeat(400000) + ">"); lap("block breaks");
      done({ times });
    `);
    const out = within(run, "tags", 2500);
    for (const [name, ms] of Object.entries(out["times"] as Record<string, number>)) assert.ok(ms < 600, `${name} took ${ms} ms`);
  });

  // The tags that are never closed, with nothing after them and with one '>' at the very end: the pattern has to be asked once, and not once
  // for every start that reads on to that '>'.
  for (const [fragment, end] of [["<oa-media ", ""], ["<oa-math ", ""], ["<table ", ""], ["<p", ""], ["<oa-media ", ">"]] as const) {
    test(`a stem of ${JSON.stringify(fragment)} repeated 40,000 times${end === "" ? "" : ` and then ${JSON.stringify(end)}`} goes through every exporter and both printed forms at once`, () => {
      const run = inChild(String.raw`
        const q = await makeQuestion("S?");
        q.stem = { format: "rich", content: ${JSON.stringify(fragment)}.repeat(40000) + ${JSON.stringify(end)} };
        const exporters = [["gift", "exportGift"], ["moodle-xml", "exportMoodleXml"], ["d2l-csv", "exportD2lCsv"], ["blackboard-upload", "exportBlackboardUpload"], ["qti12", "exportQti12"], ["qti21", "exportQti21"], ["common-cartridge", "exportCommonCartridge"], ["openstage-spreadsheet", "exportOpenStageSpreadsheet"]];
        const { printTest, printOptions } = await engine("print/index.ts");
        const times = {};
        start();
        for (const [file, name] of exporters) {
          const mod = await engine("export/" + file + ".ts");
          const t = performance.now();
          const tried = attempt(() => mod[name]([q]));
          times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
        }
        for (const format of ["docx", "pdf"]) {
          const t = performance.now();
          const tried = attempt(() => printTest([q], printOptions({ title: "T", kind: "student" }), format));
          times[format] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
        }
        // The check of a whole bank reads every stem for the equations written into it, and a pattern there read to the end from every start.
        const { checkBankQuality } = await engine("quality/bank.ts");
        const t = performance.now();
        const checked = attempt(() => checkBankQuality([q]));
        times.checkBankQuality = Math.round(performance.now() - t) + (checked.threw ? " " + checked.threw : "");
        done({ times });
      `);
      const out = within(run, `exporters on ${fragment}`, 6000);
      for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) {
        assert.ok(!/RangeError|TypeError|Error/.test(text), `${name} threw: ${text}`);
        assert.ok(parseInt(text, 10) < 1500, `${name} took ${text}`);
      }
    });
  }

  test("a stem of 64,000 paragraphs is laid out as a PDF at once, and not by looking at the rest of the question from every one of them", () => {
    const run = inChild(String.raw`
      const q = await makeQuestion("S?");
      q.stem = { format: "rich", content: "<p>x</p>".repeat(64000) };
      const { printTest, printOptions } = await engine("print/index.ts");
      start();
      const r = printTest([q], printOptions({ title: "T", kind: "student" }), "pdf");
      done({ pages: r.pages ?? 0, bytes: r.file.bytes.length });
    `);
    within(run, "pdf", 1500);
  });

  test("the text a printed test is made of is cut into its tags and words in one pass over any number of '<'", () => {
    const run = inChild(String.raw`
      const q = await makeQuestion("S?");
      q.stem = { format: "rich", content: "<".repeat(300000) };
      const { printTest, printOptions } = await engine("print/index.ts");
      start();
      const r = printTest([q], printOptions({ title: "T", kind: "student" }), "pdf");
      done({ bytes: r.file.bytes.length });
    `);
    within(run, "print", 2500);
  });
});

describe("a long run of marks that ends nothing", () => {
  test("a stem ending in 200,000 underscores and an option ending in 200,000 semicolons and a letter are checked at once, and so is a title of colons", () => {
    const run = inChild(String.raw`
      const q = await makeQuestion("Which is a" + "_".repeat(200000) + "x", 3);
      q.body.options[0].content = { format: "rich", content: "<p>right" + ";".repeat(200000) + "x</p>" };
      q.body.options[1].content = { format: "rich", content: "<p>" + "- ".repeat(100000) + "x</p>" };
      const titled = await makeQuestion("What is it?");
      titled.title = "t" + ": ".repeat(100000) + "x";
      const { checkItemQuality, normalForm, wordTokens } = await engine("quality/items.ts");
      const { exportGift } = await engine("export/gift.ts");
      const times = {};
      start();
      let t = performance.now();
      checkItemQuality(q);
      times.check = Math.round(performance.now() - t);
      t = performance.now();
      normalForm("a" + ".".repeat(200000) + "x");
      wordTokens("a" + "-".repeat(200000) + "x" + "+".repeat(1));
      times.forms = Math.round(performance.now() - t);
      t = performance.now();
      const gift = exportGift([titled]);
      times.gift = Math.round(performance.now() - t);
      done({ times, written: gift.files.length });
    `);
    const out = within(run, "marks", 1500);
    for (const [name, ms] of Object.entries(out["times"] as Record<string, number>)) assert.ok(ms < 500, `${name} took ${ms} ms`);
    assert.equal(out["written"], 1);
  });
});

describe("a list as long as a file is never spread into a call", () => {
  test("a Moodle XML question whose text has 130,000 line breaks (a 130 KB file) is read", () => {
    const xml = `<quiz><question type="essay"><name><text>n</text></name><questiontext format="html"><text>Q${"\n".repeat(130000)}</text></questiontext></question></quiz>`;
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      start();
      const importer = importerForContent("q.xml", bytes);
      const r = runImporter(importer, bytes, { file: "q.xml", at: "2026-11-08T00:00:00.000Z", author: "test" });
      done({ questions: r.questions.length, refused: r.fileFindings.map((f) => f.message).join(" ").slice(0, 200) });
    `, xml);
    const out = within(run, "moodle", 3000);
    assert.equal(out["questions"], 1, String(out["refused"]));
  });

  test("a QTI item with 140,000 pieces of text in one material (2.8 MB) is read", () => {
    const xml = `<questestinterop><assessment ident="a"><section ident="s"><item ident="i" title="t"><presentation><material>${"<mattext>Q</mattext>".repeat(140000)}</material></presentation></item></section></assessment></questestinterop>`;
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      start();
      const importer = importerForContent("q.xml", bytes);
      const r = runImporter(importer, bytes, { file: "q.xml", at: "2026-11-08T00:00:00.000Z", author: "test" });
      done({ questions: r.questions.length, refused: r.fileFindings.map((f) => f.message).join(" ").slice(0, 200) });
    `, xml);
    const out = within(run, "qti", 6000);
    assert.equal(out["questions"], 1, String(out["refused"]));
  });

  test("a GIFT answer with 130,000 pieces of feedback is read", () => {
    const gift = `Q?{TRUE#f${"#a".repeat(130000)}}`;
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      start();
      const importer = importerForContent("q.gift", bytes);
      const r = runImporter(importer, bytes, { file: "q.gift", at: "2026-11-08T00:00:00.000Z", author: "test" });
      done({ questions: r.questions.length });
    `, gift);
    const out = within(run, "gift", 3000);
    assert.equal(out["questions"], 1);
  });

  test("an Answer line of 130,000 words that name no option is read, and its findings are counted and not 130,000 long", () => {
    const text = `1. Q?\na) x\nb) y\nAnswer: ${"True ".repeat(130000)}\n`;
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      start();
      const r = standardTextImporter.parse(new TextDecoder().decode(bytes), {});
      const q = r.questions[0];
      const byCode = {};
      for (const f of q.findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
      done({ questions: r.questions.length, findings: q.findings.length, mostOfAKind: Math.max(0, ...Object.values(byCode)), said: q.findings.some((f) => /more findings of this kind/.test(f.message)), verdict: r.counts.parsed });
    `, text);
    const out = within(run, "answer line", 4000);
    assert.equal(out["questions"], 1);
    assert.ok((out["mostOfAKind"] as number) <= 26, `one kind of finding listed ${String(out["mostOfAKind"])} times`);
    assert.equal(out["said"], true, "the findings that were not listed are counted in one that says so");
    assert.equal(out["verdict"], 0, "a question whose key names nothing it has is not parsed");
  });

  test("a Moodle short answer with 100,000 answers that earn part credit lists no more findings of a kind than the limit", () => {
    // The cut was made in the text reader only, and a file of the other formats listed a finding for each of its entries.
    const answers = Array.from({ length: 100000 }, (_, i) => `<answer fraction="50"><text>a${i}</text></answer>`).join("");
    const moodle = `<?xml version="1.0"?><quiz><question type="shortanswer"><name><text>n</text></name><questiontext format="html"><text>Q?</text></questiontext>${answers}<answer fraction="100"><text>yes</text></answer></question></quiz>`;
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      const { Bank } = await engine("bank/store.ts");
      start();
      const r = runImporter(importerForContent("m.xml", bytes), bytes, { file: "m.xml", at: "2026-11-08T00:00:00.000Z", author: "test" });
      const q = r.questions[0];
      const byCode = {};
      for (const f of q.findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
      const bank = Bank.createEmpty("b");
      bank.add(q);
      done({ questions: r.questions.length, findings: q.findings.length, mostOfAKind: Math.max(0, ...Object.values(byCode)), said: q.findings.some((f) => /more findings of this kind/.test(f.message)), accepted: q.body.accepted ?? null, bankBytes: bank.toBytes().length });
    `, moodle);
    const out = within(run, "moodle part credit", 4000);
    assert.equal(out["questions"], 1);
    assert.ok((out["mostOfAKind"] as number) <= 26, `one kind of finding listed ${String(out["mostOfAKind"])} times`);
    assert.equal(out["said"], true, "and the rest are counted in a finding that says so");
    assert.ok((out["bankBytes"] as number) < 100000, `a bank of that question is ${String(out["bankBytes"])} bytes`);
    assert.deepEqual(out["accepted"], ["yes"], "the answer that earns the whole of the points is still the key");
  });

  test("a multiple choice question of 130,000 options is checked, exported to Brightspace, and printed as Word and as PDF", () => {
    const run = inChild(String.raw`
      const q = await makeQuestion("What?", 130000);
      const { checkItemQuality } = await engine("quality/items.ts");
      const { exportD2lCsv } = await engine("export/d2l-csv.ts");
      const { printTest, printOptions } = await engine("print/index.ts");
      const times = {};
      start();
      for (const [name, fn] of [["check", () => checkItemQuality(q)], ["d2l", () => exportD2lCsv([q])], ["docx", () => printTest([q], printOptions({ title: "T", kind: "student" }), "docx")], ["pdf", () => printTest([q], printOptions({ title: "T", kind: "key" }), "pdf")]]) {
        const t = performance.now();
        const tried = attempt(fn);
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, undefined, 60_000);
    const out = within(run, "130,000 options", 30000);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text), `${name} threw: ${text}`);
  });

  test("the check of a whole bank (copies, and how the right answers are spread) reads a question of 130,000 options, blanks, answers, pairs or items", () => {
    // Eight places in `quality/bank.ts` pushed a whole list into a call: `assess check` on such a bank ended in "Maximum call stack size exceeded".
    const run = inChild(String.raw`
      const { checkBankQuality } = await engine("quality/bank.ts");
      const big = 130000;
      const text = (i) => ({ format: "rich", content: "<p>word " + i + "</p>" });
      const kinds = {
        choices: (q) => q,
        response: (q) => { q.type = "multipleResponse"; return q; },
        blanks: (q) => { q.type = "fillInBlank"; q.body = { blanks: Array.from({ length: big }, (_, i) => ({ id: "b" + i, accepted: ["a" + i] })) }; return q; },
        accepted: (q) => { q.type = "shortAnswer"; q.body = { accepted: Array.from({ length: big }, (_, i) => "a" + i) }; return q; },
        pairs: (q) => { q.type = "matching"; q.body = { pairs: Array.from({ length: big }, (_, i) => ({ id: "p" + i, left: text(i), right: "r" + i })), distractors: Array.from({ length: big }, (_, i) => "d" + i) }; return q; },
        items: (q) => { q.type = "ordering"; q.body = { items: Array.from({ length: big }, (_, i) => ({ id: "i" + i, content: text(i), position: i })) }; return q; },
      };
      const times = {};
      start();
      for (const [name, shape] of Object.entries(kinds)) {
        const a = shape(await makeQuestion("What is it?", name === "choices" || name === "response" ? big : 2));
        const b = { ...a, id: "other" + a.id };
        const t = performance.now();
        const tried = attempt(() => checkBankQuality([a, b]));
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, undefined, 120_000, 2048);
    const out = within(run, "130,000 of each", 90_000);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text), `${name} threw: ${text}`);
    assert.equal(Object.keys(out["times"] as object).length, 6);
  });

  test("assess check on a bank with one question of 130,000 options prints its notes and not the words of a call stack", () => {
    const made = inChild(String.raw`
      const { Bank } = await engine("bank/store.ts");
      const bank = Bank.createEmpty("big", { at: "2026-01-01T00:00:00.000Z" });
      bank.add(await makeQuestion("What is it?", 130000));
      bank.add(await makeQuestion("Another?", 2));
      process.stdout.write(Buffer.from(bank.toBytes()).toString("base64"));
    `, undefined, 90_000, 2048);
    assert.equal(made.status, 0, made.stderr.slice(0, 300));
    const dir = mkdtempSync(join(tmpdir(), "openassess-bigcheck-"));
    try {
      const file = join(dir, "big.openassess");
      writeFileSync(file, Buffer.from(made.stdout, "base64"));
      const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "check", file], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1048576 });
      assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, undefined, "the command did not finish");
      assert.ok(!/call stack|RangeError/i.test(`${r.stdout}${r.stderr}`), `${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}`);
      assert.equal(r.status, 0, r.stderr.slice(0, 300));
      assert.match(r.stdout, /^Checked 2 question\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a table in a stem of 130,000 rows and a word of 130,000 letters are printed", () => {
    const run = inChild(String.raw`
      const { printTest, printOptions } = await engine("print/index.ts");
      const tall = await makeQuestion("S?");
      tall.stem = { format: "rich", content: "<table>" + "<tr><td>x</td></tr>".repeat(130000) + "</table>" };
      const wide = await makeQuestion("S?");
      wide.stem = { format: "rich", content: "<p>" + "w".repeat(130000) + "</p>" };
      const times = {};
      start();
      for (const [name, q, format] of [["table docx", tall, "docx"], ["word pdf", wide, "pdf"], ["word docx", wide, "docx"]]) {
        const t = performance.now();
        const tried = attempt(() => printTest([q], printOptions({ title: "T", kind: "student" }), format));
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, undefined, 60_000);
    const out = within(run, "tall table and long word", 30000);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text), `${name} threw: ${text}`);
  });

  test("130,000 questions are written to the OpenStage spreadsheet, and a folder of 130,000 questions lists them", () => {
    const run = inChild(String.raw`
      const q = await makeQuestion("What?");
      const many = Array.from({ length: 130000 }, (_, i) => ({ ...q, id: "q" + i }));
      const { exportOpenStageSpreadsheet } = await engine("export/openstage-spreadsheet.ts");
      const { questionsUnder } = await engine("model/bank.ts");
      const times = {};
      start();
      let t = performance.now();
      const tried = attempt(() => exportOpenStageSpreadsheet(many));
      times.spreadsheet = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      t = performance.now();
      const ids = many.map((x) => x.id);
      const listed = attempt(() => questionsUnder({ id: "f", name: "f", questionIds: ids, children: [{ id: "g", name: "g", questionIds: ids, children: [] }] }).length);
      times.folder = Math.round(performance.now() - t) + (listed.threw ? " " + listed.threw : "");
      done({ times, listed: listed.value });
    `, undefined, 60_000);
    const out = within(run, "130,000 questions", 30000);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text), `${name} threw: ${text}`);
    assert.equal(out["listed"], 260000);
  });

  test("an accepted-answers line of 130,000 answers, and 130,000 copies of an answer key entry, are read", () => {
    const accepted = `1. Q?\nAccepted answers: ${"x; ".repeat(130000)}\n`;
    const keyed = `1. Q?\na) x\nb) y\n\n1. Q?\na) x\nb) y\n\nAnswers:\n1. ${"a, ".repeat(130000)}\n`;
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      const [accepted, keyed] = new TextDecoder().decode(bytes).split("\u0000");
      const times = {};
      start();
      for (const [name, text] of [["accepted", accepted], ["keyed", keyed]]) {
        const t = performance.now();
        const tried = attempt(() => standardTextImporter.parse(text, {}).questions.length);
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, `${accepted}\u0000${keyed}`, 60_000);
    const out = within(run, "long lines of answers", 20000);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text), `${name} threw: ${text}`);
  });
});

describe("a quotation mark, a space or an angle bracket repeated in a line", () => {
  test("a cell of 200,000 quotation marks, and a text file of 400,000 bytes of '<a b=\"', are read as a table or as text at once", () => {
    const csv = `Question,A,B\nx${'"'.repeat(200000)}`;
    const txt = '<a b="'.repeat(70000);
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      const [csv, txt] = new TextDecoder().decode(bytes).split("\u0000");
      const times = {};
      start();
      for (const [name, file, text] of [["csv", "q.csv", csv], ["txt", "q.txt", txt]]) {
        const data = new TextEncoder().encode(text);
        const t = performance.now();
        const tried = attempt(() => { const importer = importerForContent(file, data); return runImporter(importer, data, { file, at: "2026-11-08T00:00:00.000Z", author: "test" }).questions.length; });
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, `${csv}\u0000${txt}`);
    const out = within(run, "quotes", 2000);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text) && parseInt(text, 10) < 800, `${name} threw or took ${text}`);
  });

  test("a Moodle text of 100,000 '<img' and one of 100,000 '<a' (written as text), and a tag with a name of 200,000 letters, are read at once", () => {
    const wrap = (format: string, text: string): string => `<quiz><question type="essay"><name><text>n</text></name><questiontext format="${format}"><text>${text}</text></questiontext></question></quiz>`;
    const files = [wrap("html", "&lt;img".repeat(100000)), wrap("moodle_auto_format", "&lt;a".repeat(100000)), wrap("html", `<![CDATA[<img src="a" ${"a".repeat(200000)}">]]>`)];
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      const files = new TextDecoder().decode(bytes).split("\u0000");
      const times = [];
      start();
      for (const text of files) {
        const data = new TextEncoder().encode(text);
        const t = performance.now();
        const tried = attempt(() => runImporter(importerForContent("q.xml", data), data, { file: "q.xml", at: "2026-11-08T00:00:00.000Z", author: "test" }).questions.length);
        times.push(Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : ""));
      }
      done({ times });
    `, files.join("\u0000"));
    const out = within(run, "moodle markup", 2500);
    for (const text of out["times"] as string[]) assert.ok(!/Error/.test(text) && parseInt(text, 10) < 800, `took or threw ${text}`);
  });

  test("an Aiken option, an Aiken answer and a GIFT category with 80,000 spaces in them are read at once", () => {
    const spaces = " ".repeat(80000);
    const aiken = `Q?\nA. x${spaces}y\nB. z\nANSWER: A\n\nQ2?\nA. x\nB. z\nANSWER:${spaces}B\n`;
    const gift = `$CATEGORY: top${spaces}sub\n\nQ?{=a ~b}\n`;
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      const [aiken, gift] = new TextDecoder().decode(bytes).split("\u0000");
      const times = {};
      start();
      for (const [name, file, text] of [["aiken", "q.aiken", aiken], ["gift", "q.gift", gift]]) {
        const data = new TextEncoder().encode(text);
        const t = performance.now();
        const tried = attempt(() => runImporter(importerForContent(file, data), data, { file, at: "2026-11-08T00:00:00.000Z", author: "test" }).questions.length);
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, `${aiken}\u0000${gift}`);
    const out = within(run, "spaces", 1500);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text) && parseInt(text, 10) < 600, `${name} threw or took ${text}`);
  });

  test("an Aiken answer and a GIFT category whose line holds a line separator (which '.' does not match and '\\s' does) after 80,000 spaces are read at once", () => {
    // `\s*((?:\S(?:.*\S)?)?)\s*$`: with nothing captured the two runs of white space meet, and a character that `.` stops at, but `\s`
    // reads (U+2028, U+2029), makes the line fail at the end so that the run is shared out in as many ways as it is long.
    const spaces = " ".repeat(80000);
    const aiken = `Q?\nA. x\nB. y\nANSWER:${spaces}x y\n\nQ2?\nA. x\nB. y\nANSWER:${spaces} \n\nQ3?\nA. x\nB. y\nANSWER:${spaces}B\n`;
    const gift = `$CATEGORY:${spaces}x y\n\nQ?{=a ~b}\n\n$CATEGORY:${spaces} \n\nQ2?{=a ~b}\n\n$CATEGORY:${spaces}sub\n\nQ3?{=a ~b}\n`;
    const run = inChild(String.raw`
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      const [aiken, gift] = new TextDecoder().decode(bytes).split("\u0000");
      const times = {};
      start();
      for (const [name, file, text] of [["aiken", "q.aiken", aiken], ["gift", "q.gift", gift]]) {
        const data = new TextEncoder().encode(text);
        const t = performance.now();
        const tried = attempt(() => runImporter(importerForContent(file, data), data, { file, at: "2026-11-08T00:00:00.000Z", author: "test" }).questions.length);
        times[name] = Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : "");
      }
      done({ times });
    `, `${aiken}\u0000${gift}`);
    const out = within(run, "line separators", 1500);
    for (const [name, text] of Object.entries(out["times"] as Record<string, string>)) assert.ok(!/Error/.test(text) && parseInt(text, 10) < 600, `${name} threw or took ${text}`);
  });

  test("a stem with 200,000 '[HTML]' that are never closed is read at once", () => {
    const text = `1. ${"[HTML]".repeat(200000)}\na) x\n*b) y\n`;
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      start();
      const r = standardTextImporter.parse(new TextDecoder().decode(bytes), {});
      done({ questions: r.questions.length });
    `, text);
    const out = within(run, "html blocks", 1500);
    assert.equal(out["questions"], 1);
  });
});

describe("the text scanner on a file with one long run of one kind of line", () => {
  test("a statement that ends in a colon, then an Answer line and no options, is read and not a TypeError", () => {
    // Found by feeding the old and the new reader the same few thousand generated texts: two lines ended the whole import in
    // "Cannot read properties of undefined (reading 'text')", because the first option of a question with none was looked for.
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      start();
      const results = [];
      for (const text of ["The following are true:\nAnswer: b\n", "The following are true:\nAnswer: b\nn/a\nFalse\n", "Fill in the blank:\nAnswer: x\n\nAnother one:\nAnswer: y\n"]) {
        const tried = attempt(() => { const r = standardTextImporter.parse(text, {}); return r.questions.length + r.orphans.length; });
        results.push(tried.threw ?? tried.value);
      }
      done({ results });
    `);
    const out = within(run, "short texts", 1000);
    for (const result of out["results"] as Array<string | number>) assert.equal(typeof result, "number", `threw ${String(result)}`);
  });

  test("the patterns of the scanner that put a run of white space between two other runs answer a line of 60,000 spaces at once", () => {
    const run = inChild(String.raw`
      const scan = await engine("import/standard-text-scan.ts");
      const relabel = await engine("import/standard-text-relabel.ts");
      const spaces = " ".repeat(60000);
      const tabs = "\t".repeat(60000);
      const times = {};
      start();
      for (const [name, re, texts] of [
        ["true or false", scan.TF_CHOICES, ["true" + spaces + "x", "true" + tabs + "x", "true" + spaces + "false", "true" + spaces + "/" + spaces + "x"]],
        ["no key", scan.NO_KEY, [spaces + "x", tabs + "x", "-" + spaces + "x"]],
        ["labelled", relabel.LABELLED, [spaces + "x", "*" + spaces + "x", tabs + "(" + tabs]],
      ]) {
        const t = performance.now();
        const answers = texts.map((text) => re.test(text));
        times[name] = Math.round(performance.now() - t) + " " + JSON.stringify(answers);
      }
      done({ times });
    `);
    const out = within(run, "patterns", 800);
    const times = out["times"] as Record<string, string>;
    assert.match(times["true or false"] as string, /\[false,false,true,false\]$/);
    assert.match(times["no key"] as string, /\[false,false,false\]$/);
    assert.match(times["labelled"] as string, /\[false,false,false\]$/);
  });

  test("the heading patterns of the scanner (a section's type, the answer key) answer a line of 80,000 spaces or tabs at once, in any tail", () => {
    // `\s*:?\s*$` is two runs of white space with an optional colon between them, and the second run is shared out in as many ways as
    // it is long when the line does not end there: "Answer Key" and 80,000 spaces and a letter took 13.5 seconds, "True/False" 8.4 and
    // "Multiple Choice" and tabs 13.6. The first fix of this kind (above) did not reach these two, which were found by a reader.
    const run = inChild(String.raw`
      const scan = await engine("import/standard-text-scan.ts");
      const spaces = " ".repeat(80000);
      const tabs = "\t".repeat(80000);
      const nbsp = " ".repeat(80000);
      const times = [];
      start();
      for (const [name, fn] of [
        ["section heading", (text) => scan.SECTION_HEADING.test(text)],
        ["answer key", (text) => scan.isAnswerKeyHeading(text)],
      ]) {
        for (const head of name === "answer key" ? ["Answer Key", "answer key:", "Chapter 7 Answer Key"] : ["True/False", "Multiple Choice", "essay", "Short Answer/Essay", "Matching Questions", "Fill in the Blank Items"]) {
          for (const tail of ["x", ":" + spaces + "x", ":" + spaces + ":", "." + spaces + "?"]) {
            for (const [kind, gap] of [["spaces", spaces], ["tabs", tabs], ["no-break", nbsp]]) {
              const t = performance.now();
              const answer = fn(head + gap + tail);
              const ms = Math.round(performance.now() - t);
              times.push({ name, head, kind, tail: tail.slice(0, 1), answer, ms });
            }
          }
        }
      }
      done({ times });
    `);
    const out = within(run, "heading patterns", 2000);
    const times = out["times"] as Array<{ name: string; head: string; kind: string; tail: string; answer: boolean; ms: number }>;
    assert.ok(times.length > 100);
    for (const t of times) {
      assert.equal(t.answer, false, `${t.name} ${JSON.stringify(t.head)} ${t.kind} ${JSON.stringify(t.tail)}`);
      assert.ok(t.ms < 150, `${t.name} ${JSON.stringify(t.head)} with a run of ${t.kind} took ${t.ms} ms`);
    }
  });

  test("a matching exercise written as an instruction and lines of pairs is still read as one, and copies without answers are folded one for one", () => {
    const pairs = "1. Match the following.\nBell = Telephone\nEdison = Light bulb\nNewton = Gravity\n";
    // Two copies without answers and one with: the one with the answer is a twin of one copy only, and the other stays as it was written.
    const copies = "1. What is it?\na) x\nb) y\n\n1. What is it?\na) x\nb) y\n\nAnswer Key\n\n1. What is it?\na) x\nb) y\nAnswer: a\n";
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      const [pairs, copies] = new TextDecoder().decode(bytes).split("\u0000");
      start();
      const matched = standardTextImporter.parse(pairs, {});
      const folded = standardTextImporter.parse(copies, {});
      done({ type: matched.questions[0]?.type, pairs: matched.questions[0]?.body?.pairs?.length, count: folded.questions.length, answered: folded.questions.filter((q) => q.body.options.some((o) => o.correct)).length });
    `, `${pairs}\u0000${copies}`);
    const out = within(run, "pairs and copies", 1000);
    assert.equal(out["type"], "matching");
    assert.equal(out["pairs"], 3);
    assert.equal(out["count"], 2, "the copy with the answer, and the second copy without one");
    assert.equal(out["answered"], 1);
  });

  test("32,000 Points lines after a question, a stem of 32,000 lines, and 40,000 copies of an option and of an answer", () => {
    const points = `1. Q?\na) x\nb) y\n${"Points: 1\n".repeat(32000)}`;
    const stem = `1. ${"word\n".repeat(32000)}a) x\nb) y\nAnswer: a\n`;
    const answers = `1. Q?\n${"a) x\n".repeat(40000)}${"Answer: a\n".repeat(40000)}`;
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      const texts = new TextDecoder().decode(bytes).split("\u0000");
      const times = [];
      start();
      for (const text of texts) {
        const t = performance.now();
        const tried = attempt(() => standardTextImporter.parse(text, {}).questions.length);
        times.push(Math.round(performance.now() - t) + (tried.threw ? " " + tried.threw : ""));
      }
      done({ times });
    `, [points, stem, answers].join("\u0000"));
    const out = within(run, "long runs", 6000);
    for (const text of out["times"] as string[]) assert.ok(!/Error/.test(text) && parseInt(text, 10) < 2000, `took or threw ${text}`);
  });

  test("40,000 questions without answers, then an answer key heading and 40,000 copies with them, are folded at once", () => {
    const one = (key: boolean): string => `1. What is it?\na) x\nb) y\n${key ? "Answer: a\n" : ""}`;
    const text = `${Array.from({ length: 40000 }, () => one(false)).join("\n")}\nAnswer Key\n\n${Array.from({ length: 40000 }, () => one(true)).join("\n")}`;
    const run = inChild(String.raw`
      const { standardTextImporter } = await engine("import/standard-text.ts");
      start();
      const r = standardTextImporter.parse(new TextDecoder().decode(bytes), {});
      done({ questions: r.questions.length, said: r.fileFindings.some((f) => /appear twice/.test(f.message)) });
    `, text, 60_000);
    const out = within(run, "folded copies", 8000);
    assert.equal(out["questions"], 40000, "each question once, from the copy with the answer");
    assert.equal(out["said"], true);
  });
});

describe("a QTI package with many items", () => {
  test("12,000 items and 12,000 files are read in a moment and not in a table of every name for every item", () => {
    const run = inChild(String.raw`
      const { textEntry, zipSync } = await engine("container/zip.ts");
      const { importerForContent, runImporter } = await engine("import/registry.ts");
      const n = 12000;
      const item = (i) => '<?xml version="1.0"?><assessmentItem xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="i' + i + '" title="t' + i + '" adaptive="false" timeDependent="false"><responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"><correctResponse><value>A</value></correctResponse></responseDeclaration><itemBody><choiceInteraction responseIdentifier="RESPONSE" shuffle="true" maxChoices="1"><prompt>Q' + i + '?</prompt><simpleChoice identifier="A">a</simpleChoice><simpleChoice identifier="B">b</simpleChoice></choiceInteraction></itemBody></assessmentItem>';
      const entries = [];
      let manifest = '<?xml version="1.0"?><manifest xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" identifier="m"><resources>';
      for (let i = 0; i < n; i++) {
        entries.push(textEntry("items/i" + i + ".xml", item(i)));
        manifest += '<resource identifier="r' + i + '" type="imsqti_item_xmlv2p1" href="items/i' + i + '.xml"><file href="items/i' + i + '.xml"/></resource>';
      }
      manifest += "</resources></manifest>";
      entries.push(textEntry("imsmanifest.xml", manifest));
      const zip = zipSync(entries);
      start();
      const importer = importerForContent("p.zip", zip);
      const r = runImporter(importer, zip, { file: "p.zip", at: "2026-11-08T00:00:00.000Z", author: "test" });
      done({ questions: r.questions.length });
    `, undefined, 60_000);
    const out = within(run, "qti package", 5000);
    assert.equal(out["questions"], 12000);
  });
});

describe("a PNG at the edge of what the readers take", () => {
  // The budget is counted in bytes from the header (what is held at once while it is unpacked), so a page's edge can be tested with a
  // PNG of zeros: a few hundred kilobytes of file for hundreds of megabytes of picture. A letter page at 600 dots to the inch is 5100 by
  // 6600 pixels. The printer holds the rows as stored, the rows as drawn and 8-bit pixels (1 byte, or 3 in colour): 96 MB for grey and
  // 289 MB for colour, which is over its 256 MB. The sheet reader keeps one grey byte for each pixel whatever the picture has: 96 MB for
  // grey, 225 MB for 8-bit colour (read), and 418 MB for 16-bit colour (refused).
  const made = new Map<string, Uint8Array>();
  const picture = (width: number, height: number, colorType: number, depth: number): Uint8Array => {
    const key = [width, height, colorType, depth].join(",");
    let bytes = made.get(key);
    if (bytes === undefined) {
      bytes = zeroPng(width, height, colorType, depth);
      made.set(key, bytes);
    }
    return bytes;
  };

  const cases: Array<{ name: string; path: string; decode: string; size: [number, number, number, number]; ok: boolean; says?: RegExp }> = [
    { name: "the printer decodes a letter page at 600 dots to the inch in grey", path: "print/png.ts", decode: "decodePng", size: [5100, 6600, 0, 8], ok: true },
    { name: "the printer refuses a letter page at 600 dots to the inch in colour, and says it needs 289 MB", path: "print/png.ts", decode: "decodePng", size: [5100, 6600, 2, 8], ok: false, says: /take 289 MB to unpack.*256 MB/ },
    { name: "the printer decodes a colour picture of 29.2 million pixels, the biggest the budget lets through to within a few percent", path: "print/png.ts", decode: "decodePng", size: [5400, 5400, 2, 8], ok: true },
    { name: "the printer refuses a colour picture of 30.3 million pixels, which needs 260 MB", path: "print/png.ts", decode: "decodePng", size: [5500, 5500, 2, 8], ok: false, says: /take 260 MB to unpack/ },
    // 9,942 by 3,000: the rows and the pixels come to 268,434,000 bytes, 1,456 under the limit, and the 3,000 filter bytes (one for each row) put it over.
    { name: "the printer counts the filter byte of every row: a colour picture that is over the limit by them alone is refused", path: "print/png.ts", decode: "decodePng", size: [9942, 3000, 2, 8], ok: false, says: /take 257 MB to unpack/ },
    { name: "the sheet reader reads a letter page at 600 dots to the inch in grey", path: "sheets/image.ts", decode: "readPng", size: [5100, 6600, 0, 8], ok: true },
    { name: "the sheet reader reads the same page in 8-bit colour, since it keeps one grey byte for each pixel", path: "sheets/image.ts", decode: "readPng", size: [5100, 6600, 2, 8], ok: true },
    { name: "the sheet reader refuses the same page in 16-bit colour, and says it needs 418 MB", path: "sheets/image.ts", decode: "readPng", size: [5100, 6600, 2, 16], ok: false, says: /take 418 MB to read.*256 MB/ },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const bytes = picture(...c.size);
      const run = inChild(String.raw`
        const mod = await engine(${JSON.stringify(c.path)});
        start();
        const result = mod.${c.decode}(bytes);
        done({ ok: result.ok, reason: result.reason ?? null });
      `, bytes, 60_000, 2048);
      const out = within(run, c.name, 30_000);
      assert.equal(out["ok"], c.ok, String(out["reason"]));
      if (!c.ok) {
        assert.match(String(out["reason"]), c.says as RegExp);
        assert.ok((out["rssMb"] as number) < 300, `the refusal held ${String(out["rssMb"])} MB`);
      }
    });
  }

  test("a Word file refuses the same colour page for the same reason, in words against the question, and prints a grey one", () => {
    // `checkForWord` decodes a PNG to be sure its data is whole, so the budget holds for the Word file too.
    const grey = picture(5100, 6600, 0, 8);
    const colour = picture(5100, 6600, 2, 8);
    const run = inChild(String.raw`
      const { createQuestion } = await engine("model/create.ts");
      const { printTest, printOptions } = await engine("print/index.ts");
      const [greyLength] = new Uint32Array(bytes.buffer, bytes.byteOffset, 1);
      const pictures = { grey: bytes.subarray(4, 4 + greyLength), colour: bytes.subarray(4 + greyLength) };
      const q = createQuestion({ type: "essay", stem: { format: "rich", content: '<p>Look <oa-media ref="m1"></oa-media></p>' }, body: {}, media: [{ id: "m1", file: "media/p-1.png", mime: "image/png", alt: "a page" }] });
      const results = {};
      start();
      for (const [name, data] of Object.entries(pictures)) for (const format of ["docx", "pdf"]) {
        const r = printTest([q], printOptions({ title: "T", kind: "student", media: new Map([["media/p-1.png", data]]) }), format);
        results[name + " " + format] = JSON.stringify(r.report.items).includes("cannot be printed") ? "refused: " + (/it would take [^)]*/.exec(JSON.stringify(r.report.items)) ?? [""])[0] : "printed";
      }
      done({ results });
    `, Buffer.concat([new Uint8Array(new Uint32Array([grey.length]).buffer), grey, colour]), 60_000, 2048);
    const out = within(run, "printed pages", 30_000);
    const results = out["results"] as Record<string, string>;
    assert.equal(results["grey docx"], "printed");
    assert.equal(results["grey pdf"], "printed");
    assert.match(results["colour docx"] as string, /^refused: it would take 289 MB/);
    assert.match(results["colour pdf"] as string, /^refused: it would take 289 MB/);
  });
});

describe("a PNG that says it is large", () => {
  // 16 bits and four channels: 17 bytes to the pixel while it is unpacked, from a file of a few hundred kilobytes. And a letter page at 300
  // dots to the inch in colour, which is what a scanner writes. Made when first asked for, in a child, since each needs room.
  let made: { hostile: Uint8Array; page: Uint8Array } | undefined;
  const pictures = (): { hostile: Uint8Array; page: Uint8Array } => (made ??= { hostile: zeroPng(5000, 5000, 6, 16), page: zeroPng(2550, 3300, 2, 8) });

  for (const [name, path, decode] of [
    ["the printer's", "print/png.ts", "decodePng"],
    ["the sheet reader's", "sheets/image.ts", "readPng"],
  ] as const) {
    test(`${name} reader refuses it in words before unpacking, and reads a letter page`, () => {
      const { hostile, page } = pictures();
      const run = inChild(String.raw`
        const mod = await engine(${JSON.stringify(path)});
        const [hostileLength] = new Uint32Array(bytes.buffer, bytes.byteOffset, 1);
        const hostile = bytes.subarray(4, 4 + hostileLength);
        const page = bytes.subarray(4 + hostileLength);
        start();
        const refused = mod.${decode}(hostile);
        const refusedMs = Math.round(performance.now() - __t0);
        const rss = Math.round(process.resourceUsage().maxRSS / 1024);
        const read = mod.${decode}(page);
        done({ refusedOk: refused.ok, reason: refused.reason, refusedMs, rssAfterRefusal: rss, pageOk: read.ok, pageReason: read.reason });
      `, Buffer.concat([new Uint8Array(new Uint32Array([hostile.length]).buffer), hostile, page]), 60_000);
      const out = within(run, `${name} reader`, 20000);
      assert.equal(out["refusedOk"], false, "a picture that needs hundreds of megabytes is refused");
      assert.match(String(out["reason"]), /\d+ MB/, "and the reason says how much");
      assert.ok((out["refusedMs"] as number) < 300, `the refusal took ${String(out["refusedMs"])} ms`);
      assert.ok((out["rssAfterRefusal"] as number) < 400, `it held ${String(out["rssAfterRefusal"])} MB`);
      assert.equal(out["pageOk"], true, String(out["pageReason"]));
    });
  }
});
