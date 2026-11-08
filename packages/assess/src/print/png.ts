/**
 * A PNG as the pixels a printer draws.
 *
 * A PDF takes a JPEG as it is, but a PNG has to be given as pixels, and a PNG's transparency has no meaning on paper: it is laid on
 * white, which is what the page is. Every colour type and depth a PNG can have is read (grey, colour, palette, each with or without
 * alpha, 1 to 16 bits), a palette's transparency and a colour that is marked as transparent included, and the result is 8 bits of
 * grey or of red, green and blue. An interlaced PNG is refused, since the Word file can hold it and the PDF writer would have to
 * undo the passes, and a damaged one is refused with a reason; nothing here throws on bytes that are not a PNG.
 */

import { inflateSync } from "node:zlib";

export interface PngPixels {
  width: number;
  height: number;
  /** 1 for grey, 3 for red, green and blue. */
  channels: 1 | 3;
  /** Row by row from the top, `channels` bytes to a pixel. */
  data: Uint8Array;
}

export type PngDecoded = { ok: true; pixels: PngPixels } | { ok: false; reason: string };

/** The most pixels a printed picture may have. A PDF page holds no use for more, and a larger one is a memory risk. */
export const MAX_PRINT_PIXELS = 50_000_000;

/** The most bytes a picture may need while it is unpacked: the rows as stored, the rows as drawn and the pixels. A letter page at 600 dots to the inch in colour needs 236 MB, inside it. */
export const MAX_PRINT_WORKING_BYTES = 256 * 1048576;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): PngDecoded {
  if (bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v)) return { ok: false, reason: "it is not a PNG" };

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const parts: Uint8Array[] = [];

  let at = 8;
  let sawHeader = false;
  let ended = false;
  while (at + 12 <= bytes.length && !ended) {
    const length = be32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const start = at + 8;
    if (length > bytes.length - start - 4) return { ok: false, reason: "the file is cut short" };
    const body = bytes.subarray(start, start + length);
    if (type === "IHDR") {
      if (length !== 13) return { ok: false, reason: "its header is damaged" };
      width = be32(body, 0);
      height = be32(body, 4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      if (body[10] !== 0 || body[11] !== 0) return { ok: false, reason: "it uses a method this reader does not know" };
      if (body[12] === 1) return { ok: false, reason: "it is interlaced, which a PDF cannot draw here (the Word file can)" };
      if (body[12] !== 0) return { ok: false, reason: "its header is damaged" };
      sawHeader = true;
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      transparency = body;
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      ended = true;
    }
    at = start + length + 4;
  }

  if (!sawHeader) return { ok: false, reason: "it has no header" };
  const channelsIn = CHANNELS[colorType];
  if (channelsIn === undefined || ![1, 2, 4, 8, 16].includes(bitDepth)) return { ok: false, reason: "its colour type or depth is not one a PNG has" };
  if (width < 1 || height < 1 || width * height > MAX_PRINT_PIXELS) return { ok: false, reason: "its size is too large to print" };
  if (colorType === 3 && (palette === undefined || palette.length < 3)) return { ok: false, reason: "it is a palette picture with no palette" };
  if (parts.length === 0) return { ok: false, reason: "it holds no picture data" };

  const bitsPerPixel = channelsIn * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expected = (rowBytes + 1) * height;
  // What is held at once is the unpacked rows, the rows with their filters undone and the pixels to draw. The pixels alone are bounded
  // above, but a picture of 16 bits and four channels needs 17 bytes for each of them: a file of 93 KB that said it was 3000 by 4000 took
  // 383 MB, and at the limit above it would take 2 GB. It is counted in bytes, before anything is unpacked.
  const pixelBytes = width * height * (colorType === 0 || colorType === 4 ? 1 : 3);
  if (expected + rowBytes * height + pixelBytes > MAX_PRINT_WORKING_BYTES) {
    return { ok: false, reason: `it would take more than ${MAX_PRINT_WORKING_BYTES / 1048576} MB to unpack, which is more than a printed page needs` };
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected + 1024 });
  } catch {
    return { ok: false, reason: "its picture data is damaged" };
  }
  if (raw.length < expected) return { ok: false, reason: "its picture data is cut short" };

  // Undo the row filters.
  const step = Math.max(1, bitsPerPixel >> 3);
  const rows = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!;
    const source = y * (rowBytes + 1) + 1;
    const target = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[source + x]!;
      const left = x >= step ? rows[target + x - step]! : 0;
      const up = y > 0 ? rows[target - rowBytes + x]! : 0;
      const upLeft = y > 0 && x >= step ? rows[target - rowBytes + x - step]! : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: return { ok: false, reason: "its picture data is damaged" };
      }
      rows[target + x] = out & 255;
    }
  }

  const grey = colorType === 0 || colorType === 4;
  const channelsOut = grey ? 1 : 3;
  const out = new Uint8Array(width * height * channelsOut);
  const maxValue = (1 << Math.min(bitDepth, 16)) - 1;

  /** The nth sample of a row, at the picture's depth. */
  const sampleAt = (target: number, n: number): number => {
    if (bitDepth === 8) return rows[target + n]!;
    if (bitDepth === 16) return (rows[target + 2 * n]! << 8) | rows[target + 2 * n + 1]!;
    const bit = n * bitDepth;
    return (rows[target + (bit >> 3)]! >> (8 - bitDepth - (bit & 7))) & maxValue;
  };
  const to8 = (value: number): number => (bitDepth === 8 ? value : bitDepth === 16 ? value >> 8 : Math.round((value * 255) / maxValue));

  // A colour marked as transparent (grey and colour pictures) is compared at the picture's own depth.
  const keyGrey = transparency && colorType === 0 && transparency.length >= 2 ? (transparency[0]! << 8) | transparency[1]! : -1;
  const keyRgb = transparency && colorType === 2 && transparency.length >= 6 ? [(transparency[0]! << 8) | transparency[1]!, (transparency[2]! << 8) | transparency[3]!, (transparency[4]! << 8) | transparency[5]!] : undefined;
  const onWhite = (colour: number, alpha: number): number => Math.round((colour * alpha + 255 * (255 - alpha)) / 255);

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channelsOut;
      switch (colorType) {
        case 0: {
          const v = sampleAt(row, x);
          const g = to8(v);
          out[o] = v === keyGrey ? 255 : g;
          break;
        }
        case 2: {
          const r = sampleAt(row, 3 * x);
          const g = sampleAt(row, 3 * x + 1);
          const b = sampleAt(row, 3 * x + 2);
          const clear = keyRgb !== undefined && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2];
          out[o] = clear ? 255 : to8(r);
          out[o + 1] = clear ? 255 : to8(g);
          out[o + 2] = clear ? 255 : to8(b);
          break;
        }
        case 3: {
          const index = sampleAt(row, x);
          const p = index * 3;
          const alpha = transparency && index < transparency.length ? transparency[index]! : 255;
          const entry = palette!;
          // An index past the palette is not a colour: white, as a reader that cannot find it would show.
          const inside = p + 2 < entry.length;
          out[o] = inside ? onWhite(entry[p]!, alpha) : 255;
          out[o + 1] = inside ? onWhite(entry[p + 1]!, alpha) : 255;
          out[o + 2] = inside ? onWhite(entry[p + 2]!, alpha) : 255;
          break;
        }
        case 4: {
          out[o] = onWhite(to8(sampleAt(row, 2 * x)), to8(sampleAt(row, 2 * x + 1)));
          break;
        }
        default: {
          const alpha = to8(sampleAt(row, 4 * x + 3));
          out[o] = onWhite(to8(sampleAt(row, 4 * x)), alpha);
          out[o + 1] = onWhite(to8(sampleAt(row, 4 * x + 1)), alpha);
          out[o + 2] = onWhite(to8(sampleAt(row, 4 * x + 2)), alpha);
        }
      }
    }
  }
  return { ok: true, pixels: { width, height, channels: channelsOut as 1 | 3, data: out } };
}
