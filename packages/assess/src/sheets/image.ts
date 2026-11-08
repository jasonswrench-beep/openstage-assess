/**
 * Grey images: the one kind of picture the sheet reader works on.
 *
 * A page arrives as a grid of grey values, 0 for black and 255 for white, row by row. Everything the reader does (finding the
 * corner marks, reading the code strip, measuring a bubble) is done on that grid with plain arithmetic, so it can be tested in Node
 * with the rest of the suite and needs no library. Colour is reduced to grey on the way in, and a PNG file is decoded here with
 * Node's own zlib. A JPEG is decoded by the app's page, which already knows how, and arrives as grey pixels.
 *
 * Coordinates are in pixels from the top left corner of the image, and a pixel is a square: the first pixel covers 0 to 1, so its
 * centre is at 0.5. The same convention is used by every function here, by the transform in homography.ts, and by the picture
 * writer in raster.ts, so a position means the same thing wherever it is used.
 */

import { deflateSync, inflateSync } from "node:zlib";

export interface GreyImage {
  readonly width: number;
  readonly height: number;
  /** Row by row from the top: 0 is black, 255 is white. */
  readonly data: Uint8Array;
}

/** The most pixels an image may have. A sheet at 300 dpi is about 8.4 million; this is room for a large scanner's page, not for a bomb. */
export const MAX_PIXELS = 120_000_000;

/**
 * The most bytes a PNG may need while it is unpacked: the rows as stored, the rows with their filters undone and the grey image. The
 * pixels are bounded above, but a PNG of 16 bits and four channels needs 17 bytes for each of them, and a file of 93 KB that said it was
 * 3000 by 4000 took 441 MB (and at the limit above it would take more than 2 GB). A letter page at 300 dots to the inch in colour needs 59 MB.
 */
export const MAX_PNG_WORKING_BYTES = 256 * 1048576;

export function newImage(width: number, height: number, value = 255): GreyImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("An image needs a whole number of pixels each way.");
  if (width * height > MAX_PIXELS) throw new Error("This image is larger than the reader accepts.");
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

/** The grey value of a whole pixel, with the edge repeated beyond the image. */
export function pixelAt(image: GreyImage, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= image.width ? image.width - 1 : x;
  const cy = y < 0 ? 0 : y >= image.height ? image.height - 1 : y;
  return image.data[cy * image.width + cx] as number;
}

/** The grey value at a point, blended from the four pixels around it. The edge is repeated beyond the image. */
export function sample(image: GreyImage, x: number, y: number): number {
  const { width, height, data } = image;
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 >= width ? width - 1 : x0;
  x1 = x1 < 0 ? 0 : x1 >= width ? width - 1 : x1;
  y0 = y0 < 0 ? 0 : y0 >= height ? height - 1 : y0;
  y1 = y1 < 0 ? 0 : y1 >= height ? height - 1 : y1;
  const a = data[y0 * width + x0] as number;
  const b = data[y0 * width + x1] as number;
  const c = data[y1 * width + x0] as number;
  const d = data[y1 * width + x1] as number;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** True when a point is inside the picture, with room to spare around it. */
export function inside(image: GreyImage, x: number, y: number, margin = 0): boolean {
  return x >= margin && y >= margin && x <= image.width - margin && y <= image.height - margin;
}

/** A smaller picture: every block of factor by factor pixels becomes their mean. A partial block at the edge is dropped. */
export function boxDownscale(image: GreyImage, factor: number): GreyImage {
  if (!Number.isInteger(factor) || factor < 1) throw new Error("The reduction has to be a whole number of pixels.");
  if (factor === 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const out = newImage(Math.max(1, width), Math.max(1, height));
  const area = factor * factor;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) {
        const row = (y * factor + j) * image.width + x * factor;
        for (let i = 0; i < factor; i++) sum += image.data[row + i] as number;
      }
      out.data[y * out.width + x] = Math.round(sum / area);
    }
  }
  return out;
}

/**
 * A short hash of a picture, so the same scan opened twice can be told from two different sheets. It is made from a 32 by 32 grid of
 * averages kept to 16 levels, which is the same for the same pixels and is not a way to get the picture back.
 */
export function imageFingerprint(image: GreyImage): string {
  const cells = 32;
  const sums = new Float64Array(cells * cells);
  const counts = new Uint32Array(cells * cells);
  for (let y = 0; y < image.height; y++) {
    const cy = Math.min(cells - 1, Math.floor((y * cells) / image.height));
    for (let x = 0; x < image.width; x++) {
      const cx = Math.min(cells - 1, Math.floor((x * cells) / image.width));
      const cell = cy * cells + cx;
      sums[cell] = (sums[cell] as number) + (image.data[y * image.width + x] as number);
      counts[cell] = (counts[cell] as number) + 1;
    }
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ image.width;
  const mix = (v: number): void => {
    h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + v + 0x9e3779b9, 0x85ebca6b) >>> 0;
    h2 ^= h2 >>> 13;
  };
  mix(image.width);
  mix(image.height);
  for (let i = 0; i < sums.length; i++) mix(Math.min(15, Math.floor(((sums[i] as number) / Math.max(1, counts[i] as number)) / 16)));
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

/** The value that best divides a picture into dark and light (Otsu's method), from its histogram. */
export function otsu(image: GreyImage, step = 1): number {
  const histogram = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < image.data.length; i += step) {
    const v = image.data[i] as number;
    histogram[v] = (histogram[v] as number) + 1;
    total++;
  }
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * (histogram[t] as number);
  let sumBelow = 0;
  let weightBelow = 0;
  let best = 0;
  let bestScore = -1;
  for (let t = 0; t < 256; t++) {
    weightBelow += histogram[t] as number;
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += t * (histogram[t] as number);
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sumAll - sumBelow) / weightAbove;
    const score = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------------
// PNG

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (crcTable[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type PngReading = { ok: true; image: GreyImage; notes: string[]; /** The dots to the inch the file says the picture was made at, when it says. */ dpi?: number } | { ok: false; reason: string };

/**
 * A PNG file as a grey image. Grey, colour, palette and transparency at any bit depth are read; a picture that is interlaced is
 * refused with the reason, since scanners and phones do not write them and a half-read picture would be worse than none.
 */
export function readPng(bytes: Uint8Array): PngReading {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) return { ok: false, reason: "This is not a PNG file." };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; depth: number; type: number; interlace: number } | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  let dpi: number | undefined;
  const parts: Uint8Array[] = [];
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at + 12 + length > bytes.length) return { ok: false, reason: "This PNG file is cut short." };
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (view.getUint32(at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length))) return { ok: false, reason: `This PNG file is damaged (the ${name} part does not check).` };
    if (name === "IHDR") {
      if (length !== 13) return { ok: false, reason: "This PNG file is damaged (its header is the wrong size)." };
      header = { width: view.getUint32(at + 8), height: view.getUint32(at + 12), depth: body[8] as number, type: body[9] as number, interlace: body[12] as number };
      if (body[10] !== 0 || body[11] !== 0) return { ok: false, reason: "This PNG file uses a method of compression or filtering that PNG does not define." };
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") transparency = body;
    else if (name === "pHYs" && length === 9 && body[8] === 1 && view.getUint32(at + 8) > 0) dpi = view.getUint32(at + 8) * 0.0254;
    else if (name === "IDAT") parts.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  if (!header) return { ok: false, reason: "This PNG file has no header." };
  const { width, height, depth, type, interlace } = header;
  if (width < 1 || height < 1) return { ok: false, reason: "This PNG file has no pixels." };
  if (width * height > MAX_PIXELS) return { ok: false, reason: "This picture is larger than the reader accepts." };
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  const depths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[type];
  if (channels === undefined || !depths?.includes(depth)) return { ok: false, reason: `This PNG file has a colour type and depth (${type}, ${depth}) that PNG does not define.` };
  if (interlace !== 0) return { ok: false, reason: "This PNG is interlaced. Save it again without interlacing, or save the scan as a JPG." };
  if (type === 3 && !palette) return { ok: false, reason: "This PNG file has a palette picture and no palette." };
  if (parts.length === 0) return { ok: false, reason: "This PNG file has no picture data." };

  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  // Counted in bytes before anything is unpacked, so that a header that claims a great deal is refused in words and not by memory.
  const working = (stride + 1) * height + stride * height + width * height;
  if (working > MAX_PNG_WORKING_BYTES) {
    return { ok: false, reason: `This picture would take ${Math.ceil(working / 1048576)} MB to read, which is more than the reader accepts (${MAX_PNG_WORKING_BYTES / 1048576} MB). Scan at 300 dots to the inch, or save it as a JPG.` };
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height + 1024 });
  } catch {
    return { ok: false, reason: "The picture data in this PNG file cannot be unpacked." };
  }
  if (raw.length < (stride + 1) * height) return { ok: false, reason: "This PNG file has less picture data than its size says." };

  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] as number;
      const a = i >= bpp ? (rows[out + i - bpp] as number) : 0;
      const b = y > 0 ? (rows[out - stride + i] as number) : 0;
      const c = i >= bpp && y > 0 ? (rows[out - stride + i - bpp] as number) : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return { ok: false, reason: `This PNG file has a row with a filter (${filter}) that PNG does not define.` };
      }
      rows[out + i] = value & 0xff;
    }
  }

  const image = newImage(width, height);
  const notes: string[] = [];
  const bitsAt = (row: number, index: number, bits: number): number => {
    const bit = index * bits;
    const byte = rows[row + (bit >> 3)] as number;
    return (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
  };
  const over = (value: number, alpha: number): number => Math.round(value * (alpha / 255) + 255 * (1 - alpha / 255));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      let v: number;
      if (type === 0) {
        const s = bitsAt(row, x, depth);
        v = depth === 16 ? (rows[row + x * 2] as number) : Math.round((s * 255) / ((1 << depth) - 1));
        if (transparency && transparency.length >= 2 && depth <= 8 && s === ((transparency[0] as number) << 8) + (transparency[1] as number)) v = 255;
      } else if (type === 3) {
        const index = bitsAt(row, x, depth);
        const p = (palette as Uint8Array).subarray(index * 3, index * 3 + 3);
        if (p.length < 3) return { ok: false, reason: "This PNG file uses a colour that is not in its palette." };
        v = Math.round(0.299 * (p[0] as number) + 0.587 * (p[1] as number) + 0.114 * (p[2] as number));
        if (transparency && index < transparency.length) v = over(v, transparency[index] as number);
      } else {
        const step = depth >> 3;
        const o = row + x * channels * step;
        const at = (k: number): number => rows[o + k * step] as number;
        if (type === 2) v = Math.round(0.299 * at(0) + 0.587 * at(1) + 0.114 * at(2));
        else if (type === 4) v = over(at(0), at(1));
        else v = over(Math.round(0.299 * at(0) + 0.587 * at(1) + 0.114 * at(2)), at(3));
      }
      image.data[y * width + x] = v;
    }
  }
  if (type === 6 || type === 4 || transparency) notes.push("Transparent parts of the picture were taken as white paper.");
  return { ok: true, image, notes, ...(dpi !== undefined ? { dpi } : {}) };
}

/** A grey image as a PNG file, with the dots to the inch it was made at when that is known. */
export function writePng(image: GreyImage, options: { dpi?: number } = {}): Uint8Array {
  const { width, height, data } = image;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const chunk = (name: string, body: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(name, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const physical = Buffer.alloc(9);
  if (options.dpi) {
    physical.writeUInt32BE(Math.round(options.dpi / 0.0254), 0);
    physical.writeUInt32BE(Math.round(options.dpi / 0.0254), 4);
    physical[8] = 1;
  }
  return new Uint8Array(Buffer.concat([Buffer.from(SIGNATURE), chunk("IHDR", header), ...(options.dpi ? [chunk("pHYs", physical)] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]));
}

/** The picture turned a number of quarter turns clockwise (negative turns go the other way), in whole pixels with no blending. */
export function turnQuarters(image: GreyImage, turns: number): GreyImage {
  let current = image;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    const out = newImage(current.height, current.width);
    for (let y = 0; y < current.height; y++) for (let x = 0; x < current.width; x++) out.data[x * out.width + (current.height - 1 - y)] = current.data[y * current.width + x] as number;
    current = out;
  }
  return current;
}

/** The picture as a mirror shows it: left and right changed over. */
export function flipHorizontal(image: GreyImage): GreyImage {
  const out = newImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) out.data[y * image.width + x] = image.data[y * image.width + (image.width - 1 - x)] as number;
  return out;
}

/** Black for white and white for black. */
export function invertGrey(image: GreyImage): GreyImage {
  const out = newImage(image.width, image.height);
  for (let i = 0; i < image.data.length; i++) out.data[i] = 255 - (image.data[i] as number);
  return out;
}
