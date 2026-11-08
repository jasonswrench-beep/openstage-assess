/**
 * PDFs that are small and ask a great deal.
 *
 * Two readers who went looking for a loop whose count or step comes from the file found that a few kilobytes could hold the program
 * for minutes or fill its memory, in places no damaged-file run reaches because each needs one number or one repeated word to be
 * exactly wrong: a table of objects whose entries are 0 wide, a font whose widths are listed in thousands of ranges, a character map
 * that is never closed, an object stream whose objects all run to its end, runs that unpack to far more than they say, and a row
 * width that underflows to 0. Each file here is read in a process of its own with a time limit (`support/hostile-pdf.ts`), so that a
 * fault that returns fails its test in twenty seconds and does not freeze the rest.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PdfError } from "../src/import/pdf/objects.ts";
import { runLength } from "../src/import/pdf/document.ts";
import { fontWidthsPdf, inChild, objectStreamPdf, readTextInChild, toUnicodePdf, xrefStreamPdf } from "./support/hostile-pdf.ts";
import { scanPdf } from "./support/pdf-scan.ts";

const TINY = `0.${"0".repeat(200)}1`;

describe("a cross-reference stream whose entries have no width", () => {
  for (const [what, w, index] of [
    ["a negative width and a count past counting", "[-1 0 0]", "[0 99999999999999999999]"],
    ["every width 0 and a count of a billion", "[0 0 0]", "[0 1000000000]"],
    ["widths that add up to 1 and are 1e12 and minus 1e12 apart", "[1000000000000 -999999999999 0]", "[0 1]"],
    ["widths that are not numbers", "[(a) (b) (c)]", "[0 1000000000]"],
  ] as const) {
    test(`with ${what} is refused as a table, and the objects are found by searching`, () => {
      const read = readTextInChild(xrefStreamPdf(w, index));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      // A width of 0 took 5 seconds and 1.2 GB before it ended; refusing the table takes a few milliseconds, and a process starts in 150.
      assert.ok(read.ms < 3000, `read in ${read.ms} ms`);
      assert.deepEqual(read.lines, [["Hello"]], "the page is read all the same");
      assert.match((read.notes ?? []).join("\n"), /table of objects in this PDF was damaged/, "and the person is told how it was found");
    });
  }
});

describe("fonts and maps that ask for hours", () => {
  test("a font whose widths are 30,000 ranges of 70,000 codes is read in less than the time it takes to list them", () => {
    const read = readTextInChild(fontWidthsPdf(30_000));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.lines?.length, 1);
  });

  test("a character map made of one word that is never closed, 2 MB of it, is read at once", () => {
    const read = readTextInChild(toUnicodePdf(2));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.lines?.length, 1);
  });

  test("an object stream of 2000 objects that all run to the end of 50,000 numbers is read once, and not once for each", () => {
    const read = readTextInChild(objectStreamPdf(2000, 50_000));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
  });

  // Each of 2000 objects begins at a place of its own and is an array that never closes, and the page tree asks for every one. Read to
  // the end of the data, each is 50,000 numbers and the whole is 50 million; read to where the next begins, it is 50,000 in all.
  test("an object stream whose objects all begin at different places and never close is read in the length of the stream, however many are asked for", () => {
    const read = readTextInChild(objectStreamPdf(2000, 25, true));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });
});

describe("a scanned sheet whose picture describes rows of no width", () => {
  for (const [what, parms] of [
    ["columns and colours that underflow to 0", `/DecodeParms << /Predictor 2 /Columns ${TINY} /Colors ${TINY} >>`],
    ["a width of 0 under the predictor that most scanners use", "/DecodeParms << /Predictor 12 /Columns 0 >>"],
  ] as const) {
    test(`with ${what} is refused for that page in the reader's own words, and does not hold the program`, () => {
      const image = { width: 20, height: 20, data: new Uint8Array(400).fill(255) };
      const bytes = scanPdf([{ picture: { image, encoding: "flate", extra: parms } }]);
      const run = inChild(
        bytes,
        `const { readPdfPictures } = await engine("sheets/pdf-page.ts"); const r = readPdfPictures(bytes); console.log(JSON.stringify(r.ok ? r.pages.map((p) => (p.result.ok ? "ok" : p.result.reason)) : r.reason));`,
      );
      assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
      assert.equal(run.status, 0, run.stderr);
      // The words are the PDF reader's own (a PdfError's message), not the general "it could not be unpacked".
      assert.match(run.stdout, /cannot be right/);
    });
  }
});

describe("runs that unpack to more than they should", () => {
  test("a run-length stream is decoded right: literals, repeats, and an end mark that stops it", () => {
    const encoded = Uint8Array.from([2, 65, 66, 67, 254, 90, 0, 68, 128, 99, 99]);
    assert.deepEqual([...runLength(encoded)], [65, 66, 67, 90, 90, 90, 68]);
    assert.deepEqual([...runLength(Uint8Array.from([5, 1, 2]))], [1, 2], "a literal run cut short gives what is there");
    assert.equal(runLength(new Uint8Array(0)).length, 0);
  });

  // 2 KB of runs of 128 once made 2 GB, because every byte of output was a number in an array, and the limit was looked at after each
  // run; at 2.2 million runs it ended in "Invalid array length". The limit is looked at before a run is written now.
  test("a stream that would unpack past the limit is stopped at the limit, in the PDF reader's words, before it is made", () => {
    const pairs = 20_000;
    const encoded = new Uint8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      encoded[i * 2] = 129; // 128 copies of the next byte
      encoded[i * 2 + 1] = 32;
    }
    assert.equal(runLength(encoded, 3_000_000).length, 2_560_000, "within the limit it is all there");
    assert.equal(runLength(encoded, 2_560_000).length, 2_560_000, "and so it is at exactly the limit");
    assert.throws(() => runLength(encoded, 2_559_999), PdfError, "and one byte over is stopped before the last run is written, not after");
    assert.throws(() => runLength(encoded, 1_000_000), (error: unknown) => {
      assert.ok(error instanceof PdfError, "and the words are the reader's own, not a RangeError's");
      assert.match(error.message, /unpacks to more than a test bank could hold/);
      return true;
    });
  });
});
