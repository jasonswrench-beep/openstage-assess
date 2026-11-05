/**
 * The grey image and the transform under the sheet reader: pixels in, pixels out, and where a point of the sheet falls in the picture.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { boxDownscale, imageFingerprint, newImage, otsu, pixelAt, readPng, sample, writePng, type GreyImage } from "../src/sheets/image.ts";
import { applyHomography, homographyFrom, invertHomography, type Point } from "../src/sheets/homography.ts";
import { seededRandom } from "../src/model/random.ts";

const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance;

describe("a grey image", () => {
  test("holds pixels row by row, and repeats its edge beyond itself", () => {
    const image = newImage(3, 2, 0);
    image.data.set([10, 20, 30, 40, 50, 60]);
    assert.equal(pixelAt(image, 1, 0), 20);
    assert.equal(pixelAt(image, 2, 1), 60);
    assert.equal(pixelAt(image, -5, 0), 10);
    assert.equal(pixelAt(image, 9, 9), 60);
    assert.throws(() => newImage(0, 4));
    assert.throws(() => newImage(1.5, 4));
    assert.throws(() => newImage(20000, 20000), /larger than the reader accepts/);
  });

  test("blends the four pixels round a point, with a pixel's centre at half a pixel in", () => {
    const image = newImage(2, 2, 0);
    image.data.set([0, 100, 200, 40]);
    assert.equal(sample(image, 0.5, 0.5), 0);
    assert.equal(sample(image, 1.5, 0.5), 100);
    assert.equal(sample(image, 0.5, 1.5), 200);
    assert.equal(sample(image, 1.5, 1.5), 40);
    assert.equal(sample(image, 1, 0.5), 50, "halfway between the two pixels of the top row");
    assert.equal(sample(image, 0.5, 1), 100, "halfway down the first column");
    assert.equal(sample(image, 1, 1), (0 + 100 + 200 + 40) / 4, "the middle of all four");
    assert.equal(sample(image, -3, -3), 0, "the corner pixel is repeated outside");
    assert.equal(sample(image, 9, 9), 40);
  });

  test("reduces by whole blocks, taking the mean, and drops a partial block at the edge", () => {
    const image = newImage(5, 4, 0);
    image.data.set([0, 10, 100, 100, 7, 20, 30, 100, 100, 7, 40, 50, 0, 0, 7, 60, 70, 0, 0, 7]);
    const small = boxDownscale(image, 2);
    assert.deepEqual([small.width, small.height], [2, 2]);
    assert.deepEqual(Array.from(small.data), [15, 100, 55, 0]);
    assert.equal(boxDownscale(image, 1), image);
    assert.throws(() => boxDownscale(image, 0));
    assert.throws(() => boxDownscale(image, 1.5));
  });

  test("finds the level between dark and light, and the same fingerprint for the same pixels only", () => {
    const image = newImage(40, 40, 230);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 15; x++) image.data[y * 40 + x] = 30;
    const level = otsu(image);
    assert.ok(level >= 30 && level < 230, `between the two: ${level}`);
    const again = { ...image, data: new Uint8Array(image.data) };
    assert.equal(imageFingerprint(image), imageFingerprint(again));
    assert.match(imageFingerprint(image), /^[0-9a-f]{16}$/);
    const different = { ...image, data: new Uint8Array(image.data) };
    for (let y = 0; y < 40; y++) for (let x = 15; x < 25; x++) different.data[y * 40 + x] = 30;
    assert.notEqual(imageFingerprint(image), imageFingerprint(different));
    const wider = newImage(80, 20, 230);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) wider.data[y * 80 + x] = 30;
    assert.notEqual(imageFingerprint(image), imageFingerprint(wider), "the same pattern at another shape is another picture");
  });
});

describe("a PNG file", () => {
  const crcTable = Array.from({ length: 256 }, (_x, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, body: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(name, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  /** A PNG written here from the format's definition, with the filter each row is given, so the reader is checked against another writer. */
  const png = (width: number, height: number, type: number, depth: number, rows: number[][], more: { filters?: number[]; palette?: number[]; trns?: number[]; interlace?: number; damage?: boolean } = {}): Uint8Array => {
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type] as number;
    const bpp = Math.max(1, (channels * depth) >> 3);
    const stride = rows[0]!.length;
    const raw: number[] = [];
    rows.forEach((row, y) => {
      const f = more.filters?.[y % more.filters.length] ?? 0;
      raw.push(f);
      row.forEach((x, i) => {
        const a = i >= bpp ? (row[i - bpp] as number) : 0;
        const prev = y > 0 ? (rows[y - 1] as number[]) : undefined;
        const b = prev ? (prev[i] as number) : 0;
        const c = prev && i >= bpp ? (prev[i - bpp] as number) : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        raw.push((x - predictor) & 0xff);
      });
    });
    assert.equal(raw.length, (stride + 1) * height);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = depth;
    header[9] = type;
    header[12] = more.interlace ?? 0;
    const idat = deflateSync(Buffer.from(raw));
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header)];
    if (more.palette) parts.push(chunk("PLTE", Buffer.from(more.palette)));
    if (more.trns) parts.push(chunk("tRNS", Buffer.from(more.trns)));
    parts.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
    const out = Buffer.concat(parts);
    if (more.damage) out[out.length - 20] = (out[out.length - 20] as number) ^ 0xff;
    return new Uint8Array(out);
  };
  const values = (r: ReturnType<typeof readPng>): number[] => (r.ok ? Array.from(r.image.data) : []);

  test("is written and read back as the same picture", () => {
    const random = seededRandom("png");
    const image = newImage(37, 21);
    for (let i = 0; i < image.data.length; i++) image.data[i] = Math.floor(random() * 256);
    const read = readPng(writePng(image));
    assert.ok(read.ok);
    assert.deepEqual([read.ok && read.image.width, read.ok && read.image.height], [37, 21]);
    assert.deepEqual(read.ok && Array.from(read.image.data), Array.from(image.data));
  });

  test("says how many dots to the inch it was made at, when it says, and is silent when it does not", () => {
    const image = newImage(4, 4, 200);
    const with150 = readPng(writePng(image, { dpi: 150 }));
    assert.ok(with150.ok && with150.dpi !== undefined && Math.abs(with150.dpi - 150) < 0.05, `${with150.ok && with150.dpi}`);
    const without = readPng(writePng(image));
    assert.ok(without.ok && without.dpi === undefined);
    // a physical size in an unknown unit says nothing about dots to the inch
    const odd = png(2, 1, 0, 8, [[1, 2]]);
    assert.equal(readPng(odd).ok && (readPng(odd) as { dpi?: number }).dpi, undefined);
  });

  test("reads every filter a row can have, written by another writer", () => {
    const random = seededRandom("filters");
    const rows = Array.from({ length: 10 }, () => Array.from({ length: 9 }, () => Math.floor(random() * 256)));
    for (const filter of [0, 1, 2, 3, 4]) {
      const read = readPng(png(9, 10, 0, 8, rows, { filters: [filter] }));
      assert.deepEqual(values(read), rows.flat(), `filter ${filter}`);
    }
    assert.deepEqual(values(readPng(png(9, 10, 0, 8, rows, { filters: [0, 1, 2, 3, 4] }))), rows.flat(), "a different filter on each row");
    const colour = Array.from({ length: 6 }, () => Array.from({ length: 4 * 3 }, () => Math.floor(random() * 256)));
    for (const filter of [1, 2, 3, 4]) assert.equal(readPng(png(4, 6, 2, 8, colour, { filters: [filter] })).ok, true, `colour, filter ${filter}`);
  });

  test("breaks a tie in the Paeth filter the way the format says: left, then above, then above and to the left", () => {
    // left 6, above 0, above and to the left 2: the left and the upper left are equally near the estimate (2 from it), and the left wins
    assert.deepEqual(values(readPng(png(2, 2, 0, 8, [[2, 0], [6, 100]], { filters: [0, 4] }))), [2, 0, 6, 100]);
  });

  test("reads grey at every depth, colour, palette and transparency, taking what is transparent as white", () => {
    assert.deepEqual(values(readPng(png(4, 1, 0, 1, [[0b10100000]]))), [255, 0, 255, 0]);
    assert.deepEqual(values(readPng(png(4, 1, 0, 2, [[0b00011011]]))), [0, 85, 170, 255]);
    assert.deepEqual(values(readPng(png(2, 1, 0, 4, [[0x0f]]))), [0, 255]);
    assert.deepEqual(values(readPng(png(2, 1, 0, 16, [[0x12, 0x34, 0xff, 0xff]]))), [0x12, 255], "the high byte of 16 bits");
    assert.deepEqual(values(readPng(png(2, 1, 2, 8, [[255, 0, 0, 0, 255, 0]]))), [76, 150], "red and green, by their weights");
    assert.deepEqual(values(readPng(png(2, 1, 3, 2, [[0b00100000]], { palette: [0, 0, 0, 255, 255, 255, 255, 0, 0] }))), [0, 76], "index 0 is black and index 2 is red, by its weight");
    assert.deepEqual(values(readPng(png(2, 1, 4, 8, [[0, 255, 0, 0]]))), [0, 255], "grey with alpha: transparent is white");
    const rgba = readPng(png(2, 1, 6, 8, [[0, 0, 0, 255, 0, 0, 0, 0]]));
    assert.deepEqual(values(rgba), [0, 255]);
    assert.ok(rgba.ok && rgba.notes.some((n) => /transparent/i.test(n)));
    const palette = readPng(png(2, 1, 3, 8, [[0, 1]], { palette: [0, 0, 0, 0, 0, 0], trns: [255, 0] }));
    assert.deepEqual(values(palette), [0, 255], "a transparent palette entry is white");
    assert.deepEqual(values(readPng(png(1, 1, 0, 8, [[7]], { trns: [0, 7] }))), [255], "a grey the file marks transparent is white");
  });

  test("refuses what it cannot read, with the reason", () => {
    const reason = (bytes: Uint8Array): string => {
      const r = readPng(bytes);
      return r.ok ? "" : r.reason;
    };
    const good = png(2, 2, 0, 8, [[1, 2], [3, 4]]);
    assert.match(reason(new Uint8Array([1, 2, 3])), /not a PNG file/);
    assert.match(reason(good.subarray(0, good.length - 30)), /cut short|no header|no picture data|less picture data/);
    assert.match(reason(png(2, 2, 0, 8, [[1, 2], [3, 4]], { damage: true })), /damaged/);
    assert.match(reason(png(2, 2, 0, 8, [[1, 2], [3, 4]], { interlace: 1 })), /interlaced/);
    assert.match(reason(png(2, 2, 0, 3, [[1, 2], [3, 4]])), /colour type and depth/);
    assert.match(reason(png(2, 2, 3, 8, [[1, 2], [3, 4]])), /no palette/);
    assert.match(reason(png(2, 2, 3, 8, [[5, 2], [3, 4]], { palette: [0, 0, 0] })), /not in its palette/);
    assert.match(reason(png(2, 2, 0, 8, [[1, 2], [3, 4]], { filters: [9] })), /filter \(9\)/);
    // a header that claims a size the data cannot fill
    const lie = Buffer.from(good);
    lie.writeUInt32BE(50, 16);
    lie.writeUInt32BE(crc(lie.subarray(12, 29)), 29);
    assert.match(reason(new Uint8Array(lie)), /less picture data|cannot be unpacked/);
    // a picture that claims to be enormous is refused before anything is allocated for it
    const huge = Buffer.from(good);
    huge.writeUInt32BE(100000, 16);
    huge.writeUInt32BE(100000, 20);
    huge.writeUInt32BE(crc(huge.subarray(12, 29)), 29);
    assert.match(reason(new Uint8Array(huge)), /larger than the reader accepts/);
  });
});

describe("the transform from the sheet to the picture", () => {
  const unit: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  test("takes each of four points to where it was told to, exactly", () => {
    const sheet: Point[] = [{ x: 16, y: 16 }, { x: 199.9, y: 16 }, { x: 199.9, y: 263.4 }, { x: 16, y: 263.4 }];
    const picture: Point[] = [{ x: 212.5, y: 140.25 }, { x: 1820.1, y: 96.8 }, { x: 1880.4, y: 2301.9 }, { x: 160.2, y: 2260.7 }];
    const h = homographyFrom(sheet, picture);
    assert.ok(h);
    sheet.forEach((p, i) => {
      const q = applyHomography(h, p);
      assert.ok(near(q.x, (picture[i] as Point).x, 1e-6) && near(q.y, (picture[i] as Point).y, 1e-6), `corner ${i}`);
    });
  });

  test("is a plain scale and shift when the four points are a scaled and shifted rectangle", () => {
    const h = homographyFrom(unit, unit.map((p) => ({ x: 100 + p.x * 40, y: 50 + p.y * 20 })));
    assert.ok(h);
    const q = applyHomography(h, { x: 0.25, y: 0.5 });
    assert.ok(near(q.x, 110) && near(q.y, 60), `${q.x}, ${q.y}`);
  });

  test("leans a rectangle the way a page photographed at an angle leans, keeping straight lines straight", () => {
    const h = homographyFrom(unit, [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 90, y: 110 }, { x: 5, y: 90 }]);
    assert.ok(h);
    // three points on one line of the sheet are on one line of the picture
    const [a, b, c] = [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }, { x: 0.7, y: 0.8 }].map((p) => applyHomography(h, p)) as [Point, Point, Point];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    assert.ok(Math.abs(cross) < 1e-6, `collinear: ${cross}`);
    // the middle of the sheet is not the middle of the picture's quadrilateral's sides, as it is not in a perspective view
    const centre = applyHomography(h, { x: 0.5, y: 0.5 });
    const mean = { x: (0 + 100 + 90 + 5) / 4, y: (0 + 10 + 110 + 90) / 4 };
    assert.ok(Math.abs(centre.x - mean.x) + Math.abs(centre.y - mean.y) > 0.01);
  });

  test("inverts, so a point goes to the picture and back", () => {
    const random = seededRandom("homography");
    for (let t = 0; t < 50; t++) {
      const sheet = [{ x: 16, y: 16 }, { x: 200, y: 16 }, { x: 200, y: 263 }, { x: 16, y: 263 }];
      const jitter = (): number => (random() - 0.5) * 200;
      const picture = [{ x: 100 + jitter(), y: 100 + jitter() }, { x: 1700 + jitter(), y: 100 + jitter() }, { x: 1700 + jitter(), y: 2200 + jitter() }, { x: 100 + jitter(), y: 2200 + jitter() }];
      const h = homographyFrom(sheet, picture);
      assert.ok(h);
      const inverse = invertHomography(h);
      assert.ok(inverse);
      const p = { x: 20 + random() * 150, y: 20 + random() * 200 };
      const back = applyHomography(inverse, applyHomography(h, p));
      assert.ok(near(back.x, p.x, 1e-6) && near(back.y, p.y, 1e-6));
    }
  });

  test("says when four points cannot be mapped: three in a line, or two on top of each other", () => {
    assert.equal(homographyFrom([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 1 }], unit), undefined);
    assert.equal(homographyFrom(unit, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]), undefined);
    assert.equal(homographyFrom(unit, [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]), undefined);
    assert.equal(invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 1]), undefined);
    assert.throws(() => homographyFrom(unit.slice(0, 3), unit.slice(0, 3)));
  });
});

/** A GreyImage type check, so the interface stays what the tests assume. */
export type { GreyImage };
