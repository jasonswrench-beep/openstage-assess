/**
 * Opening a file of scans: told by its first bytes, decoded or handed on, and refused with what to do.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { writePng } from "../src/sheets/image.ts";
import { openScans, refusalFor, sniffPicture } from "../src/sheets/intake.ts";
import { drawn, mixed, solid } from "./support/sheet-fixtures.ts";
import { scanPdf } from "./support/pdf-scan.ts";

const sheet = drawn(mixed(12), { dpi: 100 }).render(solid([1, 0, 2]));
const bytes = (...values: Array<number | string>): Uint8Array => new Uint8Array(values.flatMap((v) => (typeof v === "number" ? [v] : [...Buffer.from(v, "latin1")])));

describe("telling a file by its first bytes", () => {
  test("knows a PNG, a JPEG, a PDF, and the pictures the window decodes", () => {
    assert.equal(sniffPicture(writePng(sheet)), "png");
    assert.equal(sniffPicture(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16)), "jpeg");
    assert.equal(sniffPicture(bytes("%PDF-1.4\n")), "pdf");
    assert.equal(sniffPicture(bytes("junk\n\n", "%PDF-1.7\n")), "pdf", "a few bytes before the header, as the format allows");
    assert.equal(sniffPicture(bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8 ")), "webp");
    assert.equal(sniffPicture(bytes("GIF89a", 1, 0, 1, 0)), "gif");
    assert.equal(sniffPicture(bytes("BM", 0, 0, 0, 0, 0, 0)), "bmp");
  });

  test("knows a TIFF either way round, and an iPhone's HEIC photo by its brand", () => {
    assert.equal(sniffPicture(bytes(0x49, 0x49, 0x2a, 0)), "tiff");
    assert.equal(sniffPicture(bytes(0x4d, 0x4d, 0, 0x2a)), "tiff");
    for (const brand of ["heic", "heix", "mif1"]) assert.equal(sniffPicture(bytes(0, 0, 0, 24, "ftyp", brand, 0, 0, 0, 0)), "heic", brand);
    assert.equal(sniffPicture(bytes(0, 0, 0, 24, "ftyp", "mp42", 0, 0, 0, 0)), "unknown", "a video is not a photo");
  });

  test("takes anything else, and anything too short to tell, for something that is not a picture", () => {
    assert.equal(sniffPicture(bytes("hello, this is a text file")), "unknown");
    assert.equal(sniffPicture(new Uint8Array(0)), "unknown");
    assert.equal(sniffPicture(bytes(0xff)), "unknown");
  });

  test("says what to do about the ones that are refused, and nothing about the ones that are not", () => {
    assert.match(refusalFor("heic") as string, /iPhone HEIC photo.*Settings, Camera, Formats and choose Most Compatible/);
    assert.match(refusalFor("tiff") as string, /TIFF.*save JPG, PNG or PDF/);
    assert.match(refusalFor("unknown") as string, /not a picture or a PDF.*JPG, PNG or PDF/);
    for (const kind of ["png", "jpeg", "pdf", "webp", "gif", "bmp"] as const) assert.equal(refusalFor(kind), undefined, kind);
  });
});

describe("opening a file", () => {
  test("decodes a PNG itself, with the dots to the inch it says", () => {
    const opened = openScans(writePng(sheet, { dpi: 100 }));
    assert.ok(opened.ok);
    assert.equal(opened.kind, "png");
    assert.equal(opened.pages.length, 1);
    const page = opened.pages[0];
    assert.equal(page?.page, 1);
    assert.ok(page?.result.ok && page.result.source.kind === "grey");
    if (page?.result.ok && page.result.source.kind === "grey") {
      assert.deepEqual(Array.from(page.result.source.image.data), Array.from(sheet.data));
      assert.ok(Math.abs((page.result.source.dpi ?? 0) - 100) < 0.05);
    }
  });

  test("says why a PNG that is damaged cannot be opened", () => {
    const damaged = writePng(sheet).slice(0, 200);
    const opened = openScans(damaged);
    assert.equal(opened.ok, false);
    assert.equal(!opened.ok && opened.cause, "damaged");
  });

  test("hands a JPEG, WebP, GIF or BMP to the window to decode, as its bytes", () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, "JFIF", 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9);
    const opened = openScans(jpeg);
    assert.ok(opened.ok);
    const result = opened.pages[0]?.result;
    assert.ok(result?.ok && result.source.kind === "window");
    if (result?.ok && result.source.kind === "window") {
      assert.equal(result.source.format, "jpeg");
      assert.deepEqual(Array.from(result.source.bytes), Array.from(jpeg));
      assert.deepEqual(result.source.orientation, { invert: false, flip: false, quarterTurns: 0 });
    }
    for (const [kind, head] of [["webp", bytes("RIFF", 0, 0, 0, 0, "WEBP")], ["gif", bytes("GIF89a", 1, 0, 1, 0)], ["bmp", bytes("BM", 0, 0, 0, 0, 0, 0)]] as const) {
      const o = openScans(head);
      assert.ok(o.ok && o.kind === kind, kind);
    }
  });

  test("opens a scanned PDF a page at a time, decoding what it can and handing on a JPEG with how it is to be turned", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const opened = openScans(scanPdf([{ picture: { image: sheet, encoding: "flate" } }, { picture: { image: sheet, encoding: "jpeg", jpeg }, rotate: 90 }, { picture: { image: sheet, encoding: "ccitt" } }]));
    assert.ok(opened.ok);
    assert.equal(opened.kind, "pdf");
    assert.deepEqual(opened.pages.map((p) => p.page), [1, 2, 3]);
    const [a, b, c] = opened.pages.map((p) => p.result);
    assert.ok(a?.ok && a.source.kind === "grey");
    assert.ok(b?.ok && b.source.kind === "window" && b.source.orientation.quarterTurns === 1);
    assert.ok(c && !c.ok && c.cause === "format" && /fax compression/.test(c.reason));
  });

  test("refuses a TIFF, an iPhone photo, something that is not a picture, and a protected PDF, each with its reason", () => {
    const tiff = openScans(bytes(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0));
    assert.ok(!tiff.ok && tiff.cause === "tiff" && /TIFF/.test(tiff.reason));
    const heic = openScans(bytes(0, 0, 0, 24, "ftyp", "heic", 0, 0, 0, 0));
    assert.ok(!heic.ok && heic.cause === "heic" && /Most Compatible/.test(heic.reason));
    const text = openScans(bytes("a list of names"));
    assert.ok(!text.ok && text.cause === "unknown");
    const locked = openScans(scanPdf([{ picture: { image: sheet, encoding: "flate" } }], { encrypt: true }));
    assert.ok(!locked.ok && locked.cause === "protected" && /protected/.test(locked.reason));
  });
});
