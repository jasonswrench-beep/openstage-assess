/**
 * Word and Excel files that are small and ask a great deal.
 *
 * A reader of the Word and spreadsheet readers went looking for a count, a step or a repeated word that the file chooses, and found
 * that a few kilobytes could hold the program for half a minute or fill its memory: eighty thousand text elements in one run, a style
 * based on the next one twenty thousand times, a list that starts at 1e12 or sits at level 20 million, a table cell of 130,000
 * paragraphs, a shared string that every cell of a table names, and two sheets that are one part. Each file here is read in a process
 * of its own with a time limit, so that a fault that returns fails its test in twenty seconds and does not freeze the rest.
 *
 * The numbers are chosen so that the fault takes more than the limit (or more memory than the test allows) and the fixed reader takes
 * a small part of it. A time is the whole of a child process, which takes about a third of a second to start and load the engine.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  bigCellDocx,
  columnLetters,
  emptyParagraphsDocx,
  listDocx,
  longEquationDocx,
  manyRunsInCellDocx,
  manyTextDocx,
  readTableInChild,
  readWordInChild,
  sharedStringHeaders,
  sharedStringTable,
  sheetXml,
  styleChainDocx,
  wideRows,
  workbook,
} from "./support/hostile-office.ts";

/**
 * What a reader that does its work once takes, with a wide margin: every fixed file here reads in two or three seconds at the most on
 * a quiet machine, and the faults these files were made for took 13 to 30 seconds and more. A reader found that the first margin
 * (six seconds) failed four of these tests on a machine with half as many processors as busy loops, with nothing wrong in the code.
 */
const QUICK = 12_000;

describe("Word: a run with a very large number of text elements", () => {
  test("80,000 text elements in one run (3 KB) are read in a moment, not 25 seconds", () => {
    const { child, read } = readWordInChild(manyTextDocx(80_000));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.orphanLength, 80_000, "and every one of them is in the text");
  });
});

describe("Word: a chain of styles", () => {
  test("20,000 styles each based on the next, with 100 paragraphs (168 KB), are read in a moment, not 28 seconds", () => {
    const { child, read } = readWordInChild(styleChainDocx(20_000, 100));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.refused, undefined);
    assert.equal(read?.orphans, 100);
  });

  test("the same chain closed into a loop is read in a moment too", () => {
    const { child, read } = readWordInChild(styleChainDocx(20_000, 100, { loop: true }));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.orphans, 100);
  });

  test("20,000 paragraphs each in a style of its own on one chain of 20,000 are read in a moment, not 30 seconds (how they look)", () => {
    const { child, read } = readWordInChild(styleChainDocx(20_000, 20_000, { each: true }), { importer: false });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.blocks, 20_000);
  });

  test("4,500 styles that each name a list (27 KB at 3,000) are read in a moment, not minutes", () => {
    const { child, read } = readWordInChild(styleChainDocx(4_500, 1, { numbered: true }));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.refused, undefined);
    assert.equal(read?.listItems, 1, "the one paragraph is still numbered by the style it is in");
  });
});

describe("Word: a list that asks for a number nobody could write", () => {
  test("a lettered list that starts at 1e12 is a list whose number is not worked out, and not 'Invalid string length'", () => {
    const { child, read } = readWordInChild(listDocx({ start: 1e12, items: 3 }));
    assert.equal(child.timedOut, false);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    const reasons = Object.keys(read?.unreadLists ?? {});
    assert.equal(reasons.length, 1, `unread reasons: ${reasons.join(" | ")}`);
    assert.match(reasons[0] as string, /start/i);
    assert.equal(read?.listItems, 0, "no label was made up for any of them");
    assert.match((read?.findings ?? []).join("\n"), /number could not be worked out/);
  });

  test("a lettered list that starts at 1e9, twenty paragraphs of it, does not take 1.5 GB", () => {
    const { child, read } = readWordInChild(listDocx({ start: 1e9, items: 20 }), { heapMb: 700 });
    assert.equal(child.timedOut, false);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused} ${child.stderr.slice(-300)}`);
    assert.equal(read?.listItems, 0);
    assert.ok((child.rssMb ?? 0) < 400, `held ${child.rssMb} MB`);
  });

  test("a start that is 32,767 and a label that would be over three hundred letters long is not made", () => {
    const { child, read } = readWordInChild(listDocx({ start: 32_767, items: 2 }), { heapMb: 700 });
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.listItems, 0);
    assert.match(Object.keys(read?.unreadLists ?? {}).join(" | "), /long/);
    assert.ok(child.ms < QUICK);
  });

  test("a level text that names the count 200,000 times does not make a label of 200,000 numbers", () => {
    const { child, read } = readWordInChild(listDocx({ format: "decimal", start: 12345, items: 5, text: "%1".repeat(200_000) }), { heapMb: 700 });
    assert.equal(child.timedOut, false);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.listItems, 0);
    assert.ok((child.rssMb ?? 0) < 400, `held ${child.rssMb} MB`);
  });

  test("a paragraph at level 20,000,000 of a list that has such a level is unread, and does not fill a map of 20 million places", () => {
    const { child, read } = readWordInChild(listDocx({ format: "decimal", start: 1, items: 1, ilvl: 20_000_000 }), { heapMb: 900 });
    assert.equal(child.timedOut, false);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused} ${child.stderr.slice(-200)}`);
    assert.equal(read?.listItems, 0);
    assert.match(Object.keys(read?.unreadLists ?? {}).join(" | "), /level/);
    assert.ok((child.rssMb ?? 0) < 400, `held ${child.rssMb} MB`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
  });
});

describe("Word: a table cell of 130,000 paragraphs (14 KB) is read, and not 'Maximum call stack size exceeded'", () => {
  const layouts = [
    ["numbered content", "numbered cells"],
    ["numbered extras", "numbered cells"],
    ["grid stem", "grid"],
    ["grid option", "grid"],
    ["labelled only", "labelled rows"],
    ["labelled rest", "labelled rows"],
  ] as const;
  for (const [shape, layout] of layouts) {
    test(`${shape}: read as ${layout}, every line kept`, () => {
      const { child, read } = readWordInChild(bigCellDocx(shape, 130_000), { timeoutMs: 40_000, importer: false });
      assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
      assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
      assert.equal(read?.layouts?.[layout], 1, `layouts: ${JSON.stringify(read?.layouts)}`);
      assert.ok((read?.blocks ?? 0) >= 130_000, `${read?.blocks} blocks`);
    });
  }

  test("a grid with 130,000 columns the profile does not know keeps a line for each", () => {
    const { child, read } = readWordInChild(bigCellDocx("grid strays", 130_000), { timeoutMs: 60_000, importer: false });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.layouts?.grid, 1, `layouts: ${JSON.stringify(read?.layouts)}`);
    assert.ok((read?.blocks ?? 0) >= 130_000, `${read?.blocks} blocks`);
  });

  test("an answer key of 130,000 rows is one Answers list", () => {
    const { child, read } = readWordInChild(bigCellDocx("key", 130_000), { timeoutMs: 40_000, importer: false });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.layouts?.["answer key"], 1, `layouts: ${JSON.stringify(read?.layouts)}`);
    assert.ok((read?.blocks ?? 0) >= 130_000, `${read?.blocks} blocks`);
  });

  test("a paragraph of 130,000 runs that alternate bold and plain, in the cell of a question, is read", () => {
    const { child, read } = readWordInChild(manyRunsInCellDocx(130_000), { timeoutMs: 40_000, importer: false });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.layouts?.["numbered cells"], 1, `layouts: ${JSON.stringify(read?.layouts)}`);
  });
});

describe("Word: an equation of a very large number of parts", () => {
  test("a run of 130,000 signs in an equation is an equation that is not read, with the marker, and no call stack error", () => {
    const { child, read } = readWordInChild(longEquationDocx(130_000));
    assert.equal(child.timedOut, false);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.match((read?.findings ?? []).join("\n"), /equation/i);
  });
});

describe("a part with more nodes than a document of any size has", () => {
  test("3,200,000 empty paragraphs (19 MB of XML, 25 KB of file) are refused in words, and did not take 1.7 GB", () => {
    const { child, read } = readWordInChild(emptyParagraphsDocx(3_200_000), { timeoutMs: 40_000 });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.match(read?.refused ?? "", /more than 3000000 parts/);
    assert.match(read?.refused ?? "", /more than this reader takes.*Split the test bank/s, "and says what to do");
    assert.doesNotMatch(read?.refused ?? "", /not valid XML/, "a good file that is too big is not called damaged");
    assert.ok((child.rssMb ?? 0) < 1100, `held ${child.rssMb} MB`);
  });

  test("a sheet of 3,200,000 empty cells is refused in words as well", () => {
    const { child, read } = readTableInChild(workbook({ sheets: [sheetXml(`<row r="1">${"<c/>".repeat(3_200_000)}</row>`)] }), { timeoutMs: 40_000 });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.match(read?.refused ?? "", /more than 3000000 parts/);
    assert.match(read?.refused ?? "", /more than this reader takes.*Split the questions/s, "and says what to do");
    assert.doesNotMatch(read?.refused ?? "", /not valid XML/, "a good file that is too big is not called damaged");
    assert.ok((child.rssMb ?? 0) < 1100, `held ${child.rssMb} MB`);
  });
});

describe("Excel: one shared string named by many cells", () => {
  test("a string of a megabyte named by 300 cells is cut to the 32,767 characters a cell has, and the cut is said", () => {
    const { child, read } = readTableInChild(sharedStringTable(100, 1_000_000), { importer: true });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.sheets?.[0]?.longest, 32_767);
    assert.match((read?.notes ?? []).join("\n"), /300 cells.*32,767 characters/);
    assert.ok((child.rssMb ?? 0) < 500, `held ${child.rssMb} MB`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.questions, 100, "and every row is still a question");
  });

  test("a cell of exactly 32,767 characters is not cut, and says nothing", () => {
    const { read } = readTableInChild(sharedStringTable(2, 32_767));
    assert.equal(read?.sheets?.[0]?.longest, 32_767);
    assert.doesNotMatch((read?.notes ?? []).join("\n"), /32,767/);
  });

  test("a string of 32,767 spaces named by 450,000 empty-looking cells (a few hundred KB of file) is tidied once, in a moment, not 20 seconds", () => {
    let rows = "";
    for (let r = 1; r <= 750; r++) {
      let cells = "";
      for (let c = 0; c < 600; c++) cells += `<c r="${columnLetters(c)}${r}" t="s"><v>0</v></c>`;
      rows += `<row r="${r}">${cells}</row>`;
    }
    const { child, read } = readTableInChild(workbook({ sheets: [sheetXml(rows)], shared: [" ".repeat(32_767)] }), { timeoutMs: 40_000 });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.equal(read?.sheets?.[0]?.rows, 0, "and every cell of it is empty");
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
  });

  test("three thousand cells of 32,767 characters are more text than a workbook of questions has, and are refused in words", () => {
    const { child, read } = readTableInChild(sharedStringHeaders(12, 256, 32_767));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.match(read?.refused ?? "", /characters/);
    assert.match(read?.refused ?? "", /question/i, "and says what a table of questions is like");
  });

  test("1,792 cells of 32,000 characters in the first rows are looked at for their names in a moment, not 25 seconds", () => {
    const { child, read } = readTableInChild(sharedStringHeaders(7, 256, 32_000), { importer: true });
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.equal(read?.refused, undefined, `ended with: ${read?.refused}`);
    assert.ok(child.ms < QUICK, `read in ${child.ms} ms`);
    assert.equal(read?.questions, 0, "no row of it is read as a question");
  });
});

describe("Excel: sheets and rows the workbook as a whole has", () => {
  test("two sheets that are one part are refused in words, before either is read", () => {
    const { child, read } = readTableInChild(workbook({ sheets: [wideRows(200_000, 255)], again: [1] }));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.match(read?.refused ?? "", /Sheet1.*Again1.*one part/s);
    assert.ok((child.rssMb ?? 0) < 400, `held ${child.rssMb} MB`);
  });

  test("sixteen sheets that are one part are refused too, and not read sixteen times", () => {
    const { child, read } = readTableInChild(workbook({ sheets: [wideRows(20_000, 255)], again: Array.from({ length: 15 }, () => 1) }));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.match(read?.refused ?? "", /one part/);
  });

  test("200,000 rows that are each 256 places wide (1 MB of file) are refused in words, and did not take 960 MB", () => {
    const { child, read } = readTableInChild(workbook({ sheets: [wideRows(200_000, 255)] }));
    assert.equal(child.timedOut, false, `still reading after ${child.ms} ms`);
    assert.match(read?.refused ?? "", /places/);
    assert.ok((child.rssMb ?? 0) < 900, `held ${child.rssMb} MB`);
  });

  test("two sheets that really are two parts are both read", () => {
    const { read } = readTableInChild(workbook({ sheets: [wideRows(10, 3), wideRows(20, 5)] }));
    assert.deepEqual(read?.sheets?.map((s) => s.rows), [10, 20]);
  });
});
