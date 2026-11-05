/**
 * The picture on each page of a scanned PDF: found, decoded or handed on, turned the way the page is seen, or refused with the setting to
 * change. The PDFs are written by test/support/pdf-scan.ts from the format's description, as scanners write them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { toBilevel } from "../src/sheets/damage.ts";
import { flipHorizontal, newImage, turnQuarters, type GreyImage } from "../src/sheets/image.ts";
import { LONG_SIDE, orient, readPdfPictures, type PagePicture, type PdfPagePicture } from "../src/sheets/pdf-page.ts";
import { SheetReader } from "../src/sheets/read.ts";
import { drawn, mixed, solid } from "./support/sheet-fixtures.ts";
import { scanPdf, type Encoding, type PageSpec } from "./support/pdf-scan.ts";

const record = mixed(20, { versions: 1 });
const d = drawn(record, { dpi: 100 });
const marks = solid([1, 0, 2, 3, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1]);
const sheet = d.render(marks);
const reader = new SheetReader(record);

/** Fills that are the same to a millionth: a picture turned a quarter is sampled on the same pixels, but the sums are added in another order. */
const sameFills = (a: Record<number, number[]>, b: Record<number, number[]>): boolean => Object.keys(b).length === Object.keys(a).length && Object.entries(b).every(([q, fills]) => (a[Number(q)] ?? []).length === fills.length && fills.every((f, i) => Math.abs(f - ((a[Number(q)] as number[])[i] as number)) < 1e-6));
const same = (a: GreyImage, b: GreyImage): boolean => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);
const flipVertical = (image: GreyImage): GreyImage => {
  const out = newImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) out.data.set(image.data.subarray((image.height - 1 - y) * image.width, (image.height - y) * image.width), y * image.width);
  return out;
};

const pages = (spec: PageSpec[], more: Parameters<typeof scanPdf>[1] = {}): PdfPagePicture[] => {
  const r = readPdfPictures(scanPdf(spec, more));
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.pages;
};
const grey = (p: PdfPagePicture | undefined): GreyImage => {
  assert.ok(p?.result.ok, p?.result.ok ? "" : (p?.result as { reason: string }).reason);
  const picture = (p as PdfPagePicture & { result: { ok: true; picture: PagePicture } }).result.picture;
  assert.equal(picture.kind, "grey");
  return (picture as Extract<PagePicture, { kind: "grey" }>).image;
};
const refused = (p: PdfPagePicture | undefined): { cause: string; reason: string } => {
  assert.equal(p?.result.ok, false, "the page should have been refused");
  return p?.result.ok === false ? { cause: p.result.cause, reason: p.result.reason } : { cause: "", reason: "" };
};
const one = (spec: PageSpec): PdfPagePicture => pages([spec])[0] as PdfPagePicture;

describe("a scanned PDF page that is one picture", () => {
  test("gives the picture exactly, whether it is stored plain, with Flate, or with Flate and a row predictor", () => {
    for (const encoding of ["raw", "flate", "flate-predictor"] as Encoding[]) {
      const image = grey(one({ picture: { image: sheet, encoding } }));
      assert.ok(same(image, sheet), encoding);
    }
  });

  test("gives a page the same reading as the picture inside it", () => {
    const direct = reader.read(sheet);
    assert.ok(direct.ok);
    for (const encoding of ["raw", "flate", "flate-predictor", "rgb", "icc-gray"] as Encoding[]) {
      const viaPdf = reader.read(grey(one({ picture: { image: sheet, encoding } })));
      assert.ok(viaPdf.ok, encoding);
      assert.deepEqual(viaPdf.questions.map((q) => [q.number, q.status, q.marked]), direct.questions.map((q) => [q.number, q.status, q.marked]), encoding);
      assert.deepEqual(viaPdf.fills, direct.fills, encoding);
    }
    const answered = direct.questions.filter((q) => q.status === "answered").length;
    assert.ok(answered >= 14, `${answered} answered`);
  });

  test("turns colour to grey by the usual weights, and a decode setting that swaps black and white is undone", () => {
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "rgb" } })), sheet), "grey in three samples is the same grey");
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "decode-inverted" } })), sheet), "Decode [1 0] with the data swapped is the same picture");
    const cmyk = one({ picture: { image: sheet, encoding: "cmyk" } });
    const image = grey(cmyk);
    assert.ok(image.data.every((v, i) => Math.abs(v - (sheet.data[i] as number)) <= 1), "black ink only is the same grey");
    assert.match((cmyk.result as { picture: { notes: string[] } }).picture.notes.join(" "), /CMYK/);
  });

  test("weighs red, green and blue as the eye does, and looks a palette up and does not take an index for a grey", () => {
    const tinted = grey(one({ picture: { image: sheet, encoding: "rgb-tint" } }));
    assert.ok(tinted.data.every((v, i) => v === Math.round(0.299 * (sheet.data[i] as number) + 0.587 * (sheet.data[i] as number))));
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "indexed-1-reversed" } })), toBilevel(sheet, 128)), "index 1 is black here");
  });

  test("reads a black and white scan whether it is an indexed picture or a stencil, with the decode setting either way", () => {
    const bilevel = toBilevel(sheet, 128);
    for (const encoding of ["indexed-1", "mask", "mask-swapped"] as Encoding[]) assert.ok(same(grey(one({ picture: { image: sheet, encoding } })), bilevel), encoding);
    const viaPdf = reader.read(grey(one({ picture: { image: sheet, encoding: "mask" } })));
    assert.ok(viaPdf.ok && viaPdf.quality.bilevel);
  });

  test("ignores a text layer put there by character recognition, a small logo, and a picture drawn from inside a form", () => {
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "flate" }, text: true })), sheet));
    const logo = newImage(20, 20, 0);
    const withLogo = one({ picture: { image: sheet, encoding: "flate" }, more: [{ picture: { image: logo, encoding: "flate" }, at: [10, 10, 20, 20] }] });
    assert.ok(same(grey(withLogo), sheet));
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "flate" }, form: true })), sheet));
    // a form with a matrix of its own, which mirrors it
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "flate" }, form: true, formMatrix: [-1, 0, 0, 1, 1, 0] })), flipHorizontal(sheet)), "the form's matrix is applied before the page's");
  });

  test("says how many dots to the inch the scan was made at, from the picture's pixels and the length of page it covers", () => {
    // the builder draws a pixel as 0.36 point, which is 200 dots to the inch
    const result = one({ picture: { image: sheet, encoding: "flate" } });
    assert.ok(result.result.ok);
    assert.ok(Math.abs(((result.result as { picture: { dpi: number } }).picture.dpi) - 200) < 0.01);
    const jpeg = one({ picture: { image: sheet, encoding: "jpeg" }, points: 0.72 });
    assert.ok(Math.abs(((jpeg.result as { picture: { dpi: number } }).picture.dpi) - 100) < 0.01);
    const turned = one({ picture: { image: sheet, encoding: "flate" }, rotate: 90 });
    assert.ok(Math.abs(((turned.result as { picture: { dpi: number } }).picture.dpi) - 200) < 0.01, "a page turned for viewing is the same scan");
  });

  test("reduces a picture of more than 3300 pixels on its long side, and says so", () => {
    const big = newImage(2400, 3500, 255);
    big.data.fill(0, 0, 2400 * 40);
    const result = one({ picture: { image: big, encoding: "flate" } });
    const image = grey(result);
    assert.equal(Math.max(image.width, image.height) <= LONG_SIDE, true);
    assert.deepEqual([image.width, image.height], [1200, 1750]);
    assert.ok(Math.abs(((result.result as { picture: { dpi: number } }).picture.dpi) - 100) < 0.01, "reduced by half, the dots to the inch are half");
    assert.match((result.result as { picture: { notes: string[] } }).picture.notes.join(" "), /3500 pixels on its long side and was reduced to 1750/);
    assert.equal(image.data[0], 0);
  });
});

describe("turning a picture the way the page is seen", () => {
  const w = sheet.width;
  const h = sheet.height;
  const s = 0.36;

  test("honours the page's own rotation", () => {
    for (const rotate of [90, 180, 270]) {
      const page = one({ picture: { image: sheet, encoding: "flate" }, rotate, size: rotate === 180 ? [w * s, h * s] : [w * s, h * s] });
      assert.ok(same(grey(page), turnQuarters(sheet, rotate / 90)), `rotated ${rotate}`);
    }
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "flate" }, rotate: -90 })), turnQuarters(sheet, 3)), "a negative rotation");
    assert.ok(same(grey(one({ picture: { image: sheet, encoding: "flate" }, rotate: 450 })), turnQuarters(sheet, 1)), "more than a turn");
  });

  test("honours a picture drawn mirrored, upside down, or turned a quarter, which some scanners do", () => {
    const mirrored = one({ picture: { image: sheet, encoding: "flate" }, matrix: [-w * s, 0, 0, h * s, w * s, 0] });
    assert.ok(same(grey(mirrored), flipHorizontal(sheet)), "mirrored");
    const upsideDown = one({ picture: { image: sheet, encoding: "flate" }, matrix: [w * s, 0, 0, -h * s, 0, h * s] });
    assert.ok(same(grey(upsideDown), flipVertical(sheet)), "turned over");
    const counter = one({ picture: { image: sheet, encoding: "flate" }, size: [h * s, w * s], matrix: [0, w * s, -h * s, 0, h * s, 0] });
    assert.ok(same(grey(counter), turnQuarters(sheet, 3)), "a quarter turn the other way");
    const clockwise = one({ picture: { image: sheet, encoding: "flate" }, size: [h * s, w * s], matrix: [0, -w * s, h * s, 0, 0, w * s] });
    assert.ok(same(grey(clockwise), turnQuarters(sheet, 1)), "a quarter turn");
  });

  test("the sheet reads the same upside down, sideways or mirrored-and-turned-back as upright", () => {
    const direct = reader.read(sheet);
    assert.ok(direct.ok);
    for (const rotate of [90, 180, 270]) {
      const viaPdf = reader.read(grey(one({ picture: { image: sheet, encoding: "flate" }, rotate })));
      assert.ok(viaPdf.ok, `rotate ${rotate}`);
      assert.ok(sameFills(viaPdf.fills, direct.fills), `rotate ${rotate}`);
    }
    // a scanner that stores the picture mirrored and draws it mirrored back shows a sheet that reads
    const mirrored = flipHorizontal(sheet);
    const back = one({ picture: { image: mirrored, encoding: "flate" }, matrix: [-w * 0.36, 0, 0, h * 0.36, w * 0.36, 0] });
    const viaPdf = reader.read(grey(back));
    assert.ok(viaPdf.ok);
    assert.ok(sameFills(viaPdf.fills, direct.fills));
  });

  test("applies an orientation to pixels in the order invert, mirror, turn", () => {
    const a = newImage(3, 2, 0);
    a.data.set([10, 20, 30, 40, 50, 60]);
    assert.deepEqual(Array.from(orient(a, { invert: true, flip: false, quarterTurns: 0 }).data), [245, 235, 225, 215, 205, 195]);
    assert.deepEqual(Array.from(orient(a, { invert: false, flip: true, quarterTurns: 0 }).data), [30, 20, 10, 60, 50, 40]);
    const turned = orient(a, { invert: false, flip: false, quarterTurns: 1 });
    assert.deepEqual([turned.width, turned.height], [2, 3]);
    assert.deepEqual(Array.from(turned.data), Array.from(turnQuarters(a, 1).data), "a picture the page shows turned a quarter clockwise is that");
    assert.deepEqual(Array.from(orient(a, { invert: true, flip: true, quarterTurns: 2 }).data), Array.from(turnQuarters(orient(a, { invert: true, flip: true, quarterTurns: 0 }), 2).data));
  });

  test("says when a picture is drawn at an angle", () => {
    const page = one({ picture: { image: sheet, encoding: "flate" }, matrix: [w * s * Math.cos(0.3), w * s * Math.sin(0.3), -h * s * Math.sin(0.3), h * s * Math.cos(0.3), 50, 0], size: [w * s * 1.4, h * s * 1.4] });
    assert.ok(page.result.ok);
    assert.match((page.result as { picture: { notes: string[] } }).picture.notes.join(" "), /drawn on the page at 17 degrees from square/);
  });
});

describe("a JPEG on the page", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

  test("is handed on as its bytes, for the window to decode, with what has to be done to it", () => {
    const result = one({ picture: { image: sheet, encoding: "jpeg", jpeg }, rotate: 90 });
    assert.ok(result.result.ok);
    const picture = (result.result as { picture: PagePicture }).picture;
    assert.equal(picture.kind, "jpeg");
    if (picture.kind !== "jpeg") return;
    assert.deepEqual(Array.from(picture.bytes), Array.from(jpeg));
    assert.deepEqual([picture.width, picture.height, picture.components], [sheet.width, sheet.height, 1]);
    assert.deepEqual(picture.orientation, { invert: false, flip: false, quarterTurns: 1 });
    const mirrored = one({ picture: { image: sheet, encoding: "jpeg", jpeg }, matrix: [-sheet.width * 0.36, 0, 0, sheet.height * 0.36, sheet.width * 0.36, 0] });
    assert.equal(((mirrored.result as { picture: Extract<PagePicture, { kind: "jpeg" }> }).picture).orientation.flip, true);
  });

  test("keeps a decode setting that swaps black and white, to be applied after the window has decoded it", () => {
    const result = one({ picture: { image: sheet, encoding: "jpeg", jpeg, extra: "/Decode [1 0]" } });
    assert.equal(((result.result as { picture: Extract<PagePicture, { kind: "jpeg" }> }).picture).orientation.invert, true);
  });
});

describe("a page that cannot be used", () => {
  test("is refused for fax compression, JBIG2 and JPEG 2000, naming the setting to change on the scanner", () => {
    const ccitt = refused(one({ picture: { image: sheet, encoding: "ccitt" } }));
    assert.equal(ccitt.cause, "format");
    assert.match(ccitt.reason, /^This page is a black and white picture saved with fax compression \(CCITT\)/);
    assert.match(ccitt.reason, /Set the scanner to save in grey or colour/);
    const jbig2 = refused(one({ picture: { image: sheet, encoding: "jbig2" } }));
    assert.match(jbig2.reason, /JBIG2 compression, which a copier uses for its "compact" or "high compression" PDF/);
    const jpx = refused(one({ picture: { image: sheet, encoding: "jpx" } }));
    assert.match(jpx.reason, /saved as JPEG 2000\. Set the scanner to save a standard PDF \(JPEG\), or save the pages as JPG/);
    const wrapped = refused(one({ picture: { image: sheet, encoding: "jpeg-wrapped" } }));
    assert.equal(wrapped.cause, "format");
    assert.match(wrapped.reason, /a JPEG wrapped in another compression/);
    const lab = refused(one({ picture: { image: sheet, encoding: "lab" } }));
    assert.equal(lab.cause, "colour");
    assert.match(lab.reason, /colour space this reader does not read\. Set the scanner to save grey or colour \(RGB\)/);
    const lzw = refused(one({ picture: { image: sheet, encoding: "lzw" } }));
    assert.equal(lzw.cause, "format");
    assert.match(lzw.reason, /compressed in a way this reader does not read \(LZWDecode\)/);
  });

  test("is refused when the page is made of several pictures, which is how a compact PDF splits it", () => {
    const strips = refused(one({ picture: { image: sheet, encoding: "flate" }, matrix: [306, 0, 0, 200, 0, 196], more: [{ picture: { image: sheet, encoding: "flate" }, at: [0, 0, 306, 196] }] }));
    assert.equal(strips.cause, "several");
    assert.match(strips.reason, /This page is made of 2 pictures \(strips or layers\)/);
    assert.match(strips.reason, /one picture to a page/);
    const masked = refused(one({ picture: { image: sheet, encoding: "flate", smask: true } }));
    assert.equal(masked.cause, "layered");
    assert.match(masked.reason, /has a mask over it \(it is in layers\)/);
  });

  test("is refused when it holds no picture, or only an inline one, or only a small one", () => {
    const text = refused(one({ text: true }));
    assert.equal(text.cause, "no-picture");
    assert.match(text.reason, /There is no picture on this page\. It may be a PDF made from a program/);
    const inline = refused(one({ picture: { image: sheet, encoding: "flate" }, inline: true }));
    assert.equal(inline.cause, "format");
    assert.match(inline.reason, /inline image/);
    const small = refused(one({ picture: { image: newImage(20, 20, 0), encoding: "flate" }, size: [612, 792], matrix: [20, 0, 0, 20, 5, 5] }));
    assert.equal(small.cause, "no-picture");
    assert.match(small.reason, /only pictures on this page are small ones/);
  });

  test("is refused when its picture is damaged, claims a size it does not have, or is too large", () => {
    const cut = refused(one({ picture: { image: sheet, encoding: "raw", cut: true } }));
    assert.equal(cut.cause, "damaged");
    assert.match(cut.reason, /is cut short: \d+ bytes of the \d+ it should have/);
    const lie = refused(one({ picture: { image: sheet, encoding: "raw", claimSize: [sheet.width * 3, sheet.height] } }));
    assert.equal(lie.cause, "damaged");
    const huge = refused(one({ picture: { image: newImage(8, 8), encoding: "raw", claimSize: [20000, 20000] } }));
    assert.equal(huge.cause, "size");
    assert.match(huge.reason, /20000 by 20000 pixels, which is more than can be read\. Scan at 300 dots to the inch/);
    const odd = refused(one({ picture: { image: sheet, encoding: "raw", extra: "/BitsPerComponent 3" } }));
    assert.ok(odd.cause === "damaged" || odd.cause === "colour");
  });

  test("refuses one page and gives the others, in order", () => {
    const result = pages([{ picture: { image: sheet, encoding: "flate" } }, { picture: { image: sheet, encoding: "ccitt" } }, { picture: { image: sheet, encoding: "raw" } }, { picture: { image: sheet, encoding: "jpeg" } }]);
    assert.deepEqual(result.map((p) => p.page), [1, 2, 3, 4]);
    assert.deepEqual(result.map((p) => (p.result.ok ? p.result.picture.kind : p.result.cause)), ["grey", "format", "grey", "jpeg"]);
  });
});

describe("a file that is not a usable PDF", () => {
  test("says when it is protected, empty, not a PDF, or has no pages", () => {
    const protectedFile = readPdfPictures(scanPdf([{ picture: { image: sheet, encoding: "flate" } }], { encrypt: true }));
    assert.equal(protectedFile.ok, false);
    assert.equal(!protectedFile.ok && protectedFile.cause, "protected");
    assert.match(!protectedFile.ok ? protectedFile.reason : "", /This PDF is protected, so its pages cannot be read\. If you may use it/);
    const empty = readPdfPictures(new Uint8Array(0));
    assert.equal(!empty.ok && empty.reason, "This file is empty.");
    const text = readPdfPictures(new TextEncoder().encode("hello, this is not a PDF"));
    assert.match(!text.ok ? text.reason : "", /does not begin with %PDF-/);
    const none = readPdfPictures(scanPdf([]));
    assert.equal(none.ok, false);
    assert.match(!none.ok ? none.reason : "", /has no pages/);
  });
});
