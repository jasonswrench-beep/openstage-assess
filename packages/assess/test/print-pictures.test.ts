/**
 * Pictures on a printed test.
 *
 * A picture in a question used to be printed as the words "[Picture: its description]" with a note that it could not be printed.
 * When the bank's files are offered it is drawn: in the Word file as an embedded picture with its description for a screen reader,
 * and in the PDF as an image. What a PDF can draw is less than what Word can (no GIF, no CMYK JPEG, no interlaced PNG), and what it
 * cannot is printed as words, with the reason against the question, never left out. The files are taken apart here; how they look
 * on a page is for a person to say.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { unzipSync } from "../src/container/zip.ts";
import { parseXml } from "../src/import/docx/xml.ts";
import { wordImporter } from "../src/import/word.ts";
import { createQuestion } from "../src/model/create.ts";
import { mediaPlaceholder, plainToRich, rich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";
import { layoutTest, printOptions, printTest } from "../src/print/index.ts";
import { decodePng } from "../src/print/png.ts";
import { gif, gradientAt, jpeg, png, pngGradient } from "./support/images.ts";

const AT = new Date("2026-02-03T04:05:06Z");
const BLUE = png(40, 30);
const FILE = "media/p-aaaaaaaaaaaaaaaa.png";

function figure(bytes: Uint8Array, file = FILE, alt = "A blue box", more: Partial<Parameters<typeof createQuestion>[0]> = {}): { question: Question; media: Map<string, Uint8Array> } {
  const question = createQuestion({
    type: "multipleChoice",
    stem: rich(`<p>Look at the figure. Which colour is it?</p><p>${mediaPlaceholder("m1")}</p>`),
    body: { shuffle: false, options: ["Blue", "Red"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never,
    media: [{ id: "m1", file, mime: "image/png", alt }],
    by: "test",
    at: "2026-01-01T00:00:00.000Z",
    ...more,
  });
  return { question, media: new Map([[file, bytes]]) };
}

const opts = (media: Map<string, Uint8Array>, more: Record<string, unknown> = {}) => printOptions({ title: "Figures", kind: "student", media, ...more });
const docxParts = (bytes: Uint8Array) => unzipSync(bytes);
const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? new Uint8Array()).toString("utf8");

describe("a picture in the Word file", () => {
  const { question, media } = figure(BLUE);
  const made = printTest([question], opts(media), "docx", AT);
  const parts = docxParts(made.file.bytes);
  const document = text(parts.get("word/document.xml"));

  test("is embedded as the bytes it was, under a relationship the document names", () => {
    assert.deepEqual(parts.get("word/media/image1.png"), BLUE);
    assert.match(text(parts.get("word/_rels/document.xml.rels")), /Id="rIdPic1"[^>]*relationships\/image"[^>]*Target="media\/image1.png"/);
    assert.match(text(parts.get("[Content_Types].xml")), /<Default Extension="png" ContentType="image\/png"\/>/);
    assert.match(document, /<a:blip r:embed="rIdPic1"\/>/);
  });

  test("is drawn at the size of its pixels at 96 to the inch, with its description for a screen reader", () => {
    // 40 by 30 pixels is 30 by 22.5 points, which is 381000 by 285750 English metric units.
    assert.match(document, /<wp:extent cx="381000" cy="285750"\/>/);
    assert.match(document, /<wp:docPr id="1" name="Picture 1" descr="A blue box"\/>/);
  });

  test("stands under the words it was in and above the choices", () => {
    const at = (needle: string) => document.indexOf(needle);
    assert.ok(at("Look at the figure") < at("<w:drawing>") && at("<w:drawing>") < at("Blue"), "stem, picture, choices");
  });

  test("is well formed, and reads back as the picture it was, with its description", () => {
    assert.doesNotThrow(() => parseXml(document));
    const back = wordImporter.parseBytes(made.file.bytes, { file: "printed.docx" });
    // The printed test is a document like any other: the question comes back with its picture, byte for byte, and its description.
    const first = back.questions[0] as Question | undefined;
    assert.ok(first, "the printed test reads back as a question");
    assert.equal(first.media.length, 1);
    assert.equal(first.media[0]!.alt, "A blue box");
    assert.deepEqual(back.media?.get(first.media[0]!.file), BLUE);
  });

  test("is one file when it is used twice, with a drawing for each use, and says nothing was lost", () => {
    const second = figure(BLUE, FILE, "A blue box").question;
    const twice = printTest([question, { ...second, id: "q_other" }], opts(media), "docx", AT);
    const files = docxParts(twice.file.bytes);
    assert.deepEqual([...files.keys()].filter((n) => n.startsWith("word/media/")), ["word/media/image1.png"]);
    const doc = text(files.get("word/document.xml"));
    assert.deepEqual([...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]), ["1", "2"], "each drawing has an id of its own");
    assert.ok(!twice.report.items.some((i) => i.notes.length > 0));
  });

  test("a JPEG and a GIF are embedded under their own types", () => {
    const j = jpeg(64, 48);
    const g = gif(10, 12);
    const one = figure(j, "media/p-bbbbbbbbbbbbbbbb.jpg", "A photo");
    const two = figure(g, "media/p-cccccccccccccccc.gif", "A gif");
    const both = printTest([one.question, two.question], opts(new Map([...one.media, ...two.media])), "docx", AT);
    const files = docxParts(both.file.bytes);
    assert.deepEqual(files.get("word/media/image1.jpeg"), j);
    assert.deepEqual(files.get("word/media/image2.gif"), g);
    const types = text(files.get("[Content_Types].xml"));
    assert.match(types, /Extension="jpeg" ContentType="image\/jpeg"/);
    assert.match(types, /Extension="gif" ContentType="image\/gif"/);
  });

  test("a file with no picture has none of this", () => {
    const plain = createQuestion({ type: "essay", stem: plainToRich("Say something."), body: {}, by: "test" });
    const files = docxParts(printTest([plain], opts(new Map()), "docx", AT).file.bytes);
    assert.deepEqual([...files.keys()].filter((n) => n.startsWith("word/media/")), []);
    assert.doesNotMatch(text(files.get("[Content_Types].xml")), /image\//);
  });
});

describe("a picture in the PDF", () => {
  const png3 = png(40, 30, { colorType: 2 });
  const { question, media } = figure(png3);
  const made = printTest([question], opts(media), "pdf", AT);
  const raw = Buffer.from(made.file.bytes);
  const body = raw.toString("latin1");

  /** The stream of an object, taken out by the length it says. */
  function stream(id: number): { dict: string; data: Buffer } {
    const at = body.indexOf(`\n${id} 0 obj\n`) + 1;
    const dict = body.slice(at, body.indexOf("stream\n", at));
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
    const from = body.indexOf("stream\n", at) + 7;
    return { dict, data: raw.subarray(from, from + length) };
  }
  const imageIds = [...body.matchAll(/\n(\d+) 0 obj\n<< \/Type \/XObject \/Subtype \/Image/g)].map((m) => Number(m[1]));

  test("is an image object the page draws by name, the size it is printed", () => {
    assert.equal(imageIds.length, 1);
    const { dict, data } = stream(imageIds[0]!);
    assert.match(dict, /\/Width 40 \/Height 30 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode/);
    assert.equal(inflateSync(data).length, 40 * 30 * 3);
    assert.match(body, /\/XObject << \/Im1 \d+ 0 R >>/);
    const contents = [...body.matchAll(/stream\n/g)].map((m) => {
      try {
        return inflateSync(raw.subarray(m.index! + 7, body.indexOf("endstream", m.index!))).toString("latin1");
      } catch {
        return "";
      }
    });
    assert.ok(contents.some((c) => /q 30 0 0 22\.5 100 [\d.]+ cm \/Im1 Do Q/.test(c)), "drawn 30 by 22.5 points, where the text of the question starts");
  });

  test("the table of objects still points at every object", () => {
    const xref = body.indexOf("xref\n0 ") + 5;
    const count = Number(/^0 (\d+)\n/.exec(body.slice(xref))?.[1]);
    const entries = [...body.slice(xref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    assert.equal(entries.length, count - 1);
    entries.forEach((offset, i) => assert.ok(body.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1} is where the table says`));
  });

  test("a JPEG is handed on as it is, in its own colour space", () => {
    const j = jpeg(64, 48);
    const one = figure(j, "media/p-bbbbbbbbbbbbbbbb.jpg", "A photo");
    const pdf = printTest([one.question], opts(one.media), "pdf", AT);
    const bytes = Buffer.from(pdf.file.bytes);
    const text2 = bytes.toString("latin1");
    const id = Number(/\n(\d+) 0 obj\n<< \/Type \/XObject \/Subtype \/Image/.exec(text2)?.[1]);
    const at = text2.indexOf(`\n${id} 0 obj\n`) + 1;
    const dict = text2.slice(at, text2.indexOf("stream\n", at));
    assert.match(dict, /\/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
    const from = text2.indexOf("stream\n", at) + 7;
    assert.deepEqual(new Uint8Array(bytes.subarray(from, from + length)), j);
  });

  test("a grey picture is drawn in grey, and the page count and the report still hold", () => {
    const grey = figure(png(20, 20, { colorType: 0, color: [128, 128, 128] }), "media/p-dddddddddddddddd.png", "Grey");
    const pdf = printTest([grey.question], opts(grey.media), "pdf", AT);
    assert.match(Buffer.from(pdf.file.bytes).toString("latin1"), /\/ColorSpace \/DeviceGray/);
    assert.equal(pdf.report.items[0]?.outcome, "exported");
  });
});

describe("what a PDF cannot draw is printed as words, with the reason", () => {
  const cases: Array<[string, Uint8Array, RegExp]> = [
    ["a GIF", gif(10, 10), /a GIF cannot be drawn in a PDF here \(the Word file can\)/],
    ["a CMYK JPEG", jpeg(10, 10, { components: 4 }), /a CMYK JPEG cannot be drawn in a PDF here/],
    ["an interlaced PNG", png(10, 10, { interlaced: true }), /a PNG that it is interlaced/],
  ];
  for (const [label, bytes, reason] of cases) {
    test(`${label}: words and a note in the PDF, and the picture itself in the Word file`, () => {
      const f = figure(bytes, "media/p-eeeeeeeeeeeeeeee.png", "Described");
      const pdf = printTest([f.question], opts(f.media), "pdf", AT);
      assert.equal(pdf.report.items[0]?.outcome, "exportedWithLosses");
      assert.match(pdf.report.items[0]?.notes.join(" ") ?? "", reason);
      assert.match(pdf.report.items[0]?.notes.join(" ") ?? "", /printed as \[Picture: its alternative text\]/);
      assert.doesNotMatch(Buffer.from(pdf.file.bytes).toString("latin1"), /\/Subtype \/Image/);
      const word = printTest([f.question], opts(f.media), "docx", AT);
      assert.equal(word.report.items[0]?.outcome, "exported", "Word can hold it");
      assert.equal([...docxParts(word.file.bytes).keys()].filter((n) => n.startsWith("word/media/")).length, 1);
    });
  }

  test("a PNG whose header is whole and whose data is damaged is words in both files, and not a broken picture in Word", () => {
    const bad = new Uint8Array(png(40, 30));
    for (let at = 40; at < bad.length - 20; at++) bad[at] = (bad[at] ?? 0) ^ 0xff;
    const f = figure(bad);
    for (const format of ["docx", "pdf"] as const) {
      const result = printTest([f.question], opts(f.media), format, AT);
      assert.equal(result.report.items[0]?.outcome, "exportedWithLosses", format);
      assert.match(result.report.items[0]?.notes.join(" ") ?? "", /a PNG that (its picture data is damaged|it holds no picture data|the file is cut short)/);
    }
    assert.equal([...docxParts(printTest([f.question], opts(f.media), "docx", AT).file.bytes).keys()].filter((n) => n.startsWith("word/media/")).length, 0);
  });

  test("an interlaced PNG is fine for Word, which draws it, and only the PDF turns it away", () => {
    const f = figure(png(10, 10, { interlaced: true }));
    // (The test's own interlaced PNG has the header flag and plain rows, so Word-side it is only checked for the flag.)
    assert.equal(printTest([f.question], opts(f.media), "docx", AT).report.items[0]?.outcome, "exported");
  });

  test("a picture whose file the bank does not hold, and a file that is not a picture", () => {
    const f = figure(BLUE);
    const missing = printTest([f.question], opts(new Map()), "docx", AT);
    assert.match(missing.report.items[0]?.notes.join(" ") ?? "", /the bank does not hold its file/);
    const junk = printTest([f.question], opts(new Map([[FILE, new TextEncoder().encode("<script>")]])), "docx", AT);
    assert.match(junk.report.items[0]?.notes.join(" ") ?? "", /its file is not a PNG, JPEG or GIF/);
    assert.equal([...docxParts(junk.file.bytes).keys()].filter((n) => n.startsWith("word/media/")).length, 0);
  });

  test("when no pictures are offered the words and the note are as they always were", () => {
    const f = figure(BLUE);
    const printed = printTest([f.question], printOptions({ title: "Figures", kind: "student" }), "docx", AT);
    assert.equal(printed.report.items[0]?.notes[0], "1 picture cannot be printed. Each is printed as [Picture: its alternative text], so that the question still reads; add it back by hand.");
  });
});

describe("the size and the place of a picture on the page", () => {
  const blocksOf = (width: number, height: number, extra: Record<string, unknown> = {}) => {
    const f = figure(png(width, height), FILE, "x", extra);
    return layoutTest([f.question], opts(f.media)).document.blocks;
  };

  test("a large picture is scaled down to the width of the text and 4 inches tall, keeping its shape", () => {
    const picture = blocksOf(3000, 2000).find((b) => b.kind === "picture");
    assert.ok(picture && picture.kind === "picture");
    assert.ok(picture.h <= 288 + 0.001 && picture.w <= 612 - 144 - 28 + 0.001);
    assert.ok(Math.abs(picture.w / picture.h - 1.5) < 0.001, "the shape is kept");
  });

  test("a small picture is not made larger than its pixels", () => {
    const picture = blocksOf(20, 20).find((b) => b.kind === "picture");
    assert.ok(picture && picture.kind === "picture");
    assert.deepEqual([picture.w, picture.h], [15, 15]);
  });

  test("an option that is only a picture keeps its letter, and the picture stands under it", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Which is the blue one?"),
      body: { shuffle: false, options: [{ id: "o0", content: rich(`<p>${mediaPlaceholder("m1")}</p>`), correct: true }, { id: "o1", content: plainToRich("None") }] } as never,
      media: [{ id: "m1", file: FILE, mime: "image/png", alt: "blue" }],
      by: "test",
    });
    const blocks = layoutTest([q], opts(new Map([[FILE, BLUE]]))).document.blocks;
    const at = blocks.findIndex((b) => b.kind === "picture");
    const before = blocks[at - 1];
    assert.ok(before && before.kind === "para" && before.marker === "A." && before.runs.length === 0, "the letter, alone");
    const picture = blocks[at];
    assert.ok(picture && picture.kind === "picture" && picture.indent === 58, "under the letter, where an option's text starts");
  });

  test("the question stays together: the words, the picture and the choices chain to each other", () => {
    const blocks = blocksOf(40, 30);
    const picture = blocks.find((b) => b.kind === "picture");
    assert.ok(picture && picture.kind === "picture" && picture.keepNext === true);
  });
});

describe("reading a PNG for the PDF", () => {
  test("every row filter is undone, to the pixels that were written", () => {
    for (const filter of [0, 1, 2, 3, 4] as const) {
      const decoded = decodePng(pngGradient(23, 17, filter));
      assert.ok(decoded.ok, `filter ${filter}`);
      const { pixels } = decoded;
      assert.equal(pixels.channels, 1);
      for (let y = 0; y < 17; y++) for (let x = 0; x < 23; x++) assert.equal(pixels.data[y * 23 + x], gradientAt(x, y), `filter ${filter} at ${x},${y}`);
    }
  });

  test("grey, colour, palette and the ones with alpha come out as the colour they are on white paper", () => {
    const at = (bytes: Uint8Array) => {
      const d = decodePng(bytes);
      assert.ok(d.ok);
      return [...d.pixels.data.subarray(0, d.pixels.channels)];
    };
    assert.deepEqual(at(png(4, 4, { colorType: 0, color: [100, 0, 0] })), [100]);
    assert.deepEqual(at(png(4, 4, { colorType: 2, color: [10, 20, 30] })), [10, 20, 30]);
    assert.deepEqual(at(png(4, 4, { colorType: 3, color: [10, 20, 30] })), [10, 20, 30]);
    assert.deepEqual(at(png(4, 4, { colorType: 6, color: [10, 20, 30], alpha: 255 })), [10, 20, 30]);
    assert.deepEqual(at(png(4, 4, { colorType: 6, color: [10, 20, 30], alpha: 0 })), [255, 255, 255], "fully clear is white");
    assert.deepEqual(at(png(4, 4, { colorType: 6, color: [0, 0, 0], alpha: 128 })), [127, 127, 127], "half clear black is mid grey");
    assert.deepEqual(at(png(4, 4, { colorType: 4, color: [0, 0, 0], alpha: 0 })), [255]);
    assert.deepEqual(at(png(4, 4, { colorType: 3, color: [10, 20, 30], alpha: 0 })), [255, 255, 255], "a palette entry marked clear");
  });

  test("a picture of 1, 2 and 4 bits to a pixel is read to full black and white", () => {
    for (const bitDepth of [1, 2, 4] as const) {
      const black = decodePng(png(9, 3, { colorType: 0, bitDepth }));
      const white = decodePng(png(9, 3, { colorType: 0, bitDepth, ones: true }));
      assert.ok(black.ok && white.ok);
      assert.ok(black.pixels.data.every((v) => v === 0), `${bitDepth} bits, zeros`);
      assert.ok(white.pixels.data.every((v) => v === 255), `${bitDepth} bits, ones`);
    }
  });

  test("what is damaged, cut short or not a PNG is refused with a reason and never throws", () => {
    const good = png(30, 20);
    for (let n = 0; n < good.length; n += 3) {
      const d = decodePng(good.subarray(0, n));
      if (!d.ok) assert.ok(d.reason.length > 0);
    }
    assert.equal(decodePng(new Uint8Array(100)).ok, false);
    const flipped = new Uint8Array(good);
    flipped[good.length - 20] = (flipped[good.length - 20] ?? 0) ^ 0xff;
    assert.doesNotThrow(() => decodePng(flipped));
    const interlaced = decodePng(png(5, 5, { interlaced: true }));
    assert.ok(!interlaced.ok && /interlaced/.test(interlaced.reason));
  });
});
