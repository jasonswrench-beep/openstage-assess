/**
 * The picture on each page of a scanned PDF.
 *
 * A scanner or a phone's scanning program writes a PDF whose every page is one picture drawn over the whole page. That picture is what
 * the reader needs, and nothing else on the page: a text layer put there by character recognition is ignored. This finds the picture,
 * decodes it when it can (an image with no compression, or with Flate, which is zlib: Node's own), hands a JPEG on as bytes for the
 * window to decode (a program with no library does not write a JPEG decoder; the window has one), and works out from where and how the
 * picture is drawn what has to be done to it to make it the page as a person sees it: a mirror, a turn, and a decode setting that swaps
 * black and white, which black and white scans often have.
 *
 * Anything else is refused with the page, the reason, and the setting to change on the scanner: fax compression (CCITT) and JBIG2, which
 * copiers use for black and white and for "compact" or "high compression" PDFs; JPEG 2000; a page made of several pictures, which is how
 * those compact modes split a page into layers; a page with no picture at all. A page that is refused does not stop the others being read.
 */

import { PdfDocument } from "../import/pdf/document.ts";
import { fromToken, Lexer, PdfError, PdfName, PdfStream, PdfString, type PdfDict, type PdfObject } from "../import/pdf/objects.ts";
import { boxDownscale, flipHorizontal, invertGrey, MAX_PIXELS, newImage, turnQuarters, type GreyImage } from "./image.ts";

/** What has to be done to the pixels of the picture to make the page as a person sees it, in this order: invert, mirror, then turn. */
export interface Orientation {
  /** Black and white swapped by the image's decode setting. */
  invert: boolean;
  /** Mirrored by the way the picture is drawn. */
  flip: boolean;
  /** Quarter turns clockwise the page shows the picture turned by, applied after the mirror. */
  quarterTurns: number;
}

export type PagePicture =
  | { kind: "grey"; image: GreyImage; notes: string[]; dpi?: number }
  | { kind: "jpeg"; bytes: Uint8Array; width: number; height: number; components: number; orientation: Orientation; notes: string[]; dpi?: number };

export type PictureRefusalCause = "protected" | "unreadable" | "no-picture" | "several" | "format" | "layered" | "size" | "colour" | "damaged";

export type PagePictureResult = { ok: true; picture: PagePicture } | { ok: false; cause: PictureRefusalCause; reason: string };

export interface PdfPagePicture {
  /** From 1. */
  page: number;
  result: PagePictureResult;
}

export type PdfPictures = { ok: true; pages: PdfPagePicture[]; notes: string[] } | { ok: false; cause: PictureRefusalCause; reason: string };

/** The long side the picture is reduced to, as the window does for a picture it decodes. */
export const LONG_SIDE = 3300;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

interface Drawn {
  stream: PdfStream;
  ctm: Matrix;
}

const MAX_OPERATORS = 400_000;
const MAX_FORM_DEPTH = 4;

const refusal = (cause: PictureRefusalCause, reason: string): PagePictureResult => ({ ok: false, cause, reason });

/** Every picture a page draws, with the transform it is drawn by, and whether the page uses an inline picture. */
function findPictures(doc: PdfDocument, content: Uint8Array, resources: PdfDict | undefined): { drawn: Drawn[]; inline: number } {
  const drawn: Drawn[] = [];
  let inline = 0;
  let operators = 0;

  const run = (data: Uint8Array, res: PdfDict | undefined, start: Matrix, depth: number): void => {
    const lex = new Lexer(data, 0);
    let ctm = start;
    const stack: Matrix[] = [];
    let operands: PdfObject[] = [];
    for (;;) {
      const token = lex.next();
      if (token.t === "eof") break;
      if (token.t !== "kw") {
        operands.push(fromToken(lex, token, 0));
        if (operands.length > 4096) operands = operands.slice(-64);
        continue;
      }
      if (++operators > MAX_OPERATORS) return;
      const num = (i: number): number => (typeof operands[i] === "number" ? (operands[i] as number) : 0);
      switch (token.v) {
        case "q":
          stack.push(ctm);
          if (stack.length > 256) stack.shift();
          break;
        case "Q":
          if (stack.length > 0) ctm = stack.pop() as Matrix;
          break;
        case "cm":
          ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], ctm);
          break;
        case "Do": {
          const name = operands[0];
          if (!(name instanceof PdfName)) break;
          const xobjects = res ? doc.dict(res.get("XObject")) : undefined;
          const object = doc.resolve(xobjects?.get(name.name));
          if (!(object instanceof PdfStream)) break;
          const subtype = doc.name(object.dict.get("Subtype"));
          if (subtype === "Image") drawn.push({ stream: object, ctm });
          else if (subtype === "Form" && depth < MAX_FORM_DEPTH) {
            try {
              const matrix = doc.array(object.dict.get("Matrix"))?.map((n) => doc.number(n));
              const m: Matrix = matrix && matrix.length === 6 ? (matrix as Matrix) : IDENTITY;
              run(doc.streamData(object), doc.dict(object.dict.get("Resources")) ?? res, multiply(m, ctm), depth + 1);
            } catch {
              // A form that cannot be read is a form that draws no picture we can use.
            }
          }
          break;
        }
        case "BI": {
          inline++;
          for (;;) {
            const t = lex.next();
            if (t.t === "eof" || (t.t === "kw" && t.v === "ID")) break;
          }
          const d = lex.buf;
          let p = lex.pos + 1;
          for (; p < d.length - 1; p++) {
            if (d[p] === 0x45 && d[p + 1] === 0x49 && (p === 0 || d[p - 1] === 10 || d[p - 1] === 13 || d[p - 1] === 32) && (p + 2 >= d.length || d[p + 2] === 10 || d[p + 2] === 13 || d[p + 2] === 32)) break;
          }
          lex.pos = Math.min(d.length, p + 2);
          break;
        }
        default:
          break;
      }
      operands = [];
    }
  };
  run(content, resources, IDENTITY, 0);
  return { drawn, inline };
}

/** The filter names of a stream, in the order they were applied. */
function filtersOf(doc: PdfDocument, stream: PdfStream): string[] {
  const f = doc.resolve(stream.dict.get("Filter") ?? stream.dict.get("F"));
  return (Array.isArray(f) ? f : f === null || f === undefined ? [] : [f]).map((x) => doc.name(x) ?? "").filter((n) => n !== "");
}

interface ColourSpace {
  /** Samples to a pixel. */
  components: number;
  /** For an indexed picture: the palette, as grey levels. */
  palette?: Uint8Array;
  /** A kind of conversion to grey: gray, rgb or cmyk. */
  kind: "gray" | "rgb" | "cmyk";
}

function colourSpaceOf(doc: PdfDocument, object: PdfObject | undefined, depth = 0): ColourSpace | undefined {
  const r = doc.resolve(object);
  if (depth > 4) return undefined;
  if (r instanceof PdfName) {
    if (r.name === "DeviceGray" || r.name === "G" || r.name === "CalGray") return { components: 1, kind: "gray" };
    if (r.name === "DeviceRGB" || r.name === "RGB" || r.name === "CalRGB") return { components: 3, kind: "rgb" };
    if (r.name === "DeviceCMYK" || r.name === "CMYK") return { components: 4, kind: "cmyk" };
    return undefined;
  }
  if (!Array.isArray(r) || r.length === 0) return undefined;
  const head = doc.name(r[0]);
  if (head === "ICCBased") {
    const profile = doc.resolve(r[1]);
    const n = profile instanceof PdfStream ? doc.number(profile.dict.get("N"), 0) : 0;
    return n === 1 ? { components: 1, kind: "gray" } : n === 3 ? { components: 3, kind: "rgb" } : n === 4 ? { components: 4, kind: "cmyk" } : undefined;
  }
  if (head === "CalGray") return { components: 1, kind: "gray" };
  if (head === "CalRGB") return { components: 3, kind: "rgb" };
  if (head === "Indexed" || head === "I") {
    const base = colourSpaceOf(doc, r[1], depth + 1);
    const hival = doc.number(r[2], 255);
    const table = doc.resolve(r[3]);
    const bytes = table instanceof PdfString ? table.bytes : table instanceof PdfStream ? doc.streamData(table) : undefined;
    if (!base || !bytes || base.palette) return undefined;
    const palette = new Uint8Array(256);
    for (let i = 0; i <= Math.min(hival, 255); i++) palette[i] = toGrey(base.kind, bytes.subarray(i * base.components, (i + 1) * base.components), 255);
    return { components: 1, kind: "gray", palette };
  }
  return undefined;
}

/** One pixel's samples (each 0 to the maximum) as a grey level, 0 to 255. */
function toGrey(kind: ColourSpace["kind"], s: ArrayLike<number>, max: number): number {
  const f = 255 / max;
  if (kind === "gray") return Math.round((s[0] ?? 0) * f);
  if (kind === "rgb") return Math.round(0.299 * (s[0] ?? 0) * f + 0.587 * (s[1] ?? 0) * f + 0.114 * (s[2] ?? 0) * f);
  const k = 1 - (s[3] ?? 0) / max;
  return Math.round((0.299 * (1 - (s[0] ?? 0) / max) + 0.587 * (1 - (s[1] ?? 0) / max) + 0.114 * (1 - (s[2] ?? 0) / max)) * k * 255);
}

/** The matrix, as a place and a turn: what the picture needs to be the page as a person sees it. */
function orientationOf(ctm: Matrix, pageRotate: number): { flip: boolean; quarterTurns: number; skew: number } {
  const [a, b, c, d] = ctm;
  // One step across and one step down the picture, as they land on the page (y up), then turned with the page and made y down.
  const turn = (x: number, y: number): [number, number] => {
    const r = ((pageRotate % 360) + 360) % 360;
    const t = (r * Math.PI) / 180;
    return [x * Math.cos(t) + y * Math.sin(t), -(-x * Math.sin(t) + y * Math.cos(t))];
  };
  const across = turn(a, b);
  const down = turn(-c, -d);
  const flip = across[0] * down[1] - across[1] * down[0] < 0;
  const dx: [number, number] = flip ? [-across[0], -across[1]] : across;
  const angle = (Math.atan2(dx[1], dx[0]) * 180) / Math.PI;
  const turns = Math.round(angle / 90);
  return { flip, quarterTurns: (((turns % 4) + 4) % 4), skew: Math.abs(angle - turns * 90) };
}

/** Applies what a picture's drawing needs to it. */
export function orient(image: GreyImage, o: Orientation): GreyImage {
  let out = image;
  if (o.invert) out = invertGrey(out);
  if (o.flip) out = flipHorizontal(out);
  // The page shows the picture turned clockwise by `quarterTurns`, so that is what a person sees (a sideways scan marked to be turned upright is upright).
  if (o.quarterTurns) out = turnQuarters(out, o.quarterTurns);
  return out;
}

function decodeFlat(doc: PdfDocument, stream: PdfStream, notes: string[]): PagePictureResult {
  const width = doc.number(stream.dict.get("Width") ?? stream.dict.get("W"));
  const height = doc.number(stream.dict.get("Height") ?? stream.dict.get("H"));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return refusal("damaged", "the picture on this page has no size");
  if (width * height > MAX_PIXELS) return refusal("size", `the picture on this page is ${width} by ${height} pixels, which is more than can be read. Scan at 300 dots to the inch, not more.`);
  const mask = doc.resolve(stream.dict.get("ImageMask") ?? stream.dict.get("IM")) === true;
  const bpc = mask ? 1 : doc.number(stream.dict.get("BitsPerComponent") ?? stream.dict.get("BPC"), 8);
  if (![1, 2, 4, 8, 16].includes(bpc)) return refusal("damaged", `the picture on this page has ${bpc} bits to a sample, which is not a size a picture has`);
  const space = mask ? ({ components: 1, kind: "gray" } as ColourSpace) : colourSpaceOf(doc, stream.dict.get("ColorSpace") ?? stream.dict.get("CS"));
  if (!space) return refusal("colour", "the picture on this page uses a colour space this reader does not read. Set the scanner to save grey or colour (RGB), not a special colour mode.");
  const decodeArray = doc.array(stream.dict.get("Decode") ?? stream.dict.get("D"))?.map((n) => doc.number(n));
  const inverted = decodeArray !== undefined && decodeArray.length >= 2 && (decodeArray[0] as number) > (decodeArray[1] as number);

  let data: Uint8Array;
  try {
    // Not counted in the document's total of unpacked bytes: its size was held to MAX_PIXELS above (`PdfDocument.streamData`).
    data = doc.streamData(stream, { picture: true });
  } catch (error) {
    const message = error instanceof PdfError ? error.message : "it could not be unpacked";
    return /does not read/.test(message) ? refusal("format", `the picture on this page is compressed in a way this reader does not read (${message.replace(/^.*filter, ([A-Za-z0-9]+),.*$/, "$1")}). Set the scanner to save a standard PDF (JPEG), or save the pages as JPG.`) : refusal("damaged", `the picture on this page is damaged: ${message}`);
  }
  const stride = Math.ceil((width * space.components * bpc) / 8);
  if (data.length < stride * height) return refusal("damaged", `the picture on this page is cut short: ${data.length} bytes of the ${stride * height} it should have`);

  const out = newImage(width, height);
  const max = bpc === 16 ? 65535 : (1 << bpc) - 1;
  const sample = (row: number, index: number): number => {
    if (bpc === 8) return data[row + index] as number;
    if (bpc === 16) return ((data[row + index * 2] as number) << 8) | (data[row + index * 2 + 1] as number);
    const bit = index * bpc;
    return ((data[row + (bit >> 3)] as number) >> (8 - bpc - (bit & 7))) & max;
  };
  const px = new Array<number>(space.components).fill(0);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      let v: number;
      if (mask) {
        // A stencil paints black where its sample is 0 (or 1, when the decode setting is swapped) and leaves the paper where it is not.
        const s = sample(row, x);
        v = (inverted ? s === 1 : s === 0) ? 0 : 255;
      } else if (space.palette) {
        v = space.palette[sample(row, x)] as number;
        if (inverted) v = 255 - v;
      } else {
        for (let c = 0; c < space.components; c++) px[c] = sample(row, x * space.components + c);
        v = toGrey(space.kind, px, max);
        if (inverted) v = 255 - v;
      }
      out.data[y * width + x] = v;
    }
  }
  if (space.kind === "cmyk") notes.push("The picture is in CMYK colour, and was turned to grey by a plain conversion.");
  return { ok: true, picture: { kind: "grey", image: out, notes } };
}

/** The picture of one page: found, decoded or passed on, and turned the way the page is seen. */
function pictureOfPage(doc: PdfDocument, page: ReturnType<PdfDocument["pages"]>[number]): PagePictureResult {
  let found: { drawn: Drawn[]; inline: number };
  try {
    found = findPictures(doc, doc.pageContent(page), page.resources);
  } catch (error) {
    return refusal("unreadable", `the page could not be read: ${error instanceof PdfError ? error.message : "it is damaged"}`);
  }
  const area = Math.abs((page.mediaBox[2] - page.mediaBox[0]) * (page.mediaBox[3] - page.mediaBox[1]));
  // A logo or a stamp is not the scan: a picture much smaller than the page is left out of the count.
  const placed = found.drawn.filter((d) => Math.abs(d.ctm[0] * d.ctm[3] - d.ctm[1] * d.ctm[2]) >= 0.05 * area);
  if (found.inline > 0 && placed.length === 0) return refusal("format", "this page's picture is written inside the page's own instructions (an inline image), which a scanner does not do. Set the scanner to save a standard PDF, or save the pages as JPG.");
  if (placed.length === 0) {
    return refusal("no-picture", found.drawn.length > 0 ? "the only pictures on this page are small ones, and none is the page." : "there is no picture on this page. It may be a PDF made from a program (the sheet itself, not a scan of it), or a page of text only. Scan the paper copy.");
  }
  if (placed.length > 1 || found.inline > 0) {
    return refusal("several", `this page is made of ${placed.length + found.inline} pictures (strips or layers), which is how a "compact", "high compression" or "searchable" PDF setting splits a page. Set the scanner to save one picture to a page (a standard PDF), or save the pages as JPG.`);
  }
  const { stream, ctm } = placed[0] as Drawn;
  if (stream.dict.has("SMask") || stream.dict.has("Mask")) return refusal("layered", "the picture on this page has a mask over it (it is in layers). Set the scanner to save a standard PDF, or save the pages as JPG.");

  const notes: string[] = [];
  const o = orientationOf(ctm, page.rotate);
  // The dots to the inch the scan was made at: the picture's pixels across the length of page it is drawn over.
  const pixelsAcross = doc.number(stream.dict.get("Width") ?? stream.dict.get("W"));
  const inchesAcross = Math.hypot(ctm[0], ctm[1]) / 72;
  const dpi = pixelsAcross > 0 && inchesAcross > 0 ? pixelsAcross / inchesAcross : undefined;
  if (o.skew > 8) notes.push(`The picture is drawn on the page at ${o.skew.toFixed(0)} degrees from square; it is read as it is.`);
  const filters = filtersOf(doc, stream);
  const decodeArray = doc.array(stream.dict.get("Decode") ?? stream.dict.get("D"))?.map((n) => doc.number(n));
  const inverted = decodeArray !== undefined && decodeArray.length >= 2 && (decodeArray[0] as number) > (decodeArray[1] as number);

  if (filters.includes("CCITTFaxDecode") || filters.includes("CCF")) {
    return refusal("format", "this page is a black and white picture saved with fax compression (CCITT), which a copier uses for black and white scans. Set the scanner to save in grey or colour, or to a PDF with JPEG compression, or save the pages as JPG.");
  }
  if (filters.includes("JBIG2Decode")) {
    return refusal("format", "this page is saved with JBIG2 compression, which a copier uses for its \"compact\" or \"high compression\" PDF. Set the scanner to save in grey or colour in a standard PDF (JPEG), or save the pages as JPG.");
  }
  if (filters.includes("JPXDecode")) {
    return refusal("format", "this page is saved as JPEG 2000. Set the scanner to save a standard PDF (JPEG), or save the pages as JPG.");
  }
  if (filters.includes("DCTDecode") || filters.includes("DCT")) {
    if (filters.length !== 1) return refusal("format", "this page's picture is a JPEG wrapped in another compression, which a scanner does not usually do. Set the scanner to save a standard PDF, or save the pages as JPG.");
    const width = doc.number(stream.dict.get("Width") ?? stream.dict.get("W"));
    const height = doc.number(stream.dict.get("Height") ?? stream.dict.get("H"));
    if (width < 1 || height < 1) return refusal("damaged", "the picture on this page has no size");
    if (width * height > MAX_PIXELS) return refusal("size", `the picture on this page is ${width} by ${height} pixels, which is more than can be read. Scan at 300 dots to the inch, not more.`);
    const space = colourSpaceOf(doc, stream.dict.get("ColorSpace") ?? stream.dict.get("CS"));
    return { ok: true, picture: { kind: "jpeg", bytes: stream.raw, width, height, components: space?.components ?? 3, orientation: { invert: inverted, flip: o.flip, quarterTurns: o.quarterTurns }, notes, ...(dpi !== undefined ? { dpi } : {}) } };
  }

  const decoded = decodeFlat(doc, stream, notes);
  if (!decoded.ok) return decoded;
  if (decoded.picture.kind !== "grey") return decoded;
  // The decode setting was applied while decoding; what is left is how the picture is drawn.
  let image = orient(decoded.picture.image, { invert: false, flip: o.flip, quarterTurns: o.quarterTurns });
  const long = Math.max(image.width, image.height);
  let reducedBy = 1;
  if (long > LONG_SIDE) {
    reducedBy = Math.ceil(long / LONG_SIDE);
    image = boxDownscale(image, reducedBy);
    decoded.picture.notes.push(`The picture was ${long} pixels on its long side and was reduced to ${Math.max(image.width, image.height)}.`);
  }
  return { ok: true, picture: { kind: "grey", image, notes: decoded.picture.notes, ...(dpi !== undefined ? { dpi: dpi / reducedBy } : {}) } };
}

/** The picture on every page of a PDF. A page that cannot be used is refused on its own and the rest are still given. */
export function readPdfPictures(bytes: Uint8Array): PdfPictures {
  let doc: PdfDocument;
  try {
    doc = new PdfDocument(bytes);
  } catch (error) {
    const message = error instanceof PdfError ? error.message : "it could not be opened";
    if (/protected/.test(message)) return { ok: false, cause: "protected", reason: "This PDF is protected, so its pages cannot be read. If you may use it, open it in a PDF program and save a copy that is not protected (or print it to PDF), and bring that in." };
    return { ok: false, cause: "unreadable", reason: message };
  }
  let pages: ReturnType<PdfDocument["pages"]>;
  try {
    pages = doc.pages();
  } catch (error) {
    return { ok: false, cause: "unreadable", reason: error instanceof PdfError ? error.message : "This PDF has no pages that can be found." };
  }
  if (pages.length === 0) return { ok: false, cause: "unreadable", reason: "This PDF has no pages." };
  return {
    ok: true,
    notes: [...doc.notes],
    pages: pages.map((page) => {
      const result = pictureOfPage(doc, page);
      // The reasons say "this page"; the page number is carried beside them for whoever shows them.
      return { page: page.number, result: result.ok ? result : { ...result, reason: result.reason.charAt(0).toUpperCase() + result.reason.slice(1) } };
    }),
  };
}
