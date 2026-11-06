/**
 * What a picture is, read from its own bytes.
 *
 * A picture's name and the type a file claims for it are not trusted: a part called `image1.png` in a Word file can hold anything, and
 * a browser, a Word printer and a PDF each do something different with bytes that are not what they say. The three formats a question
 * can hold are PNG, JPEG and GIF, because they are what browsers, Word and PDF all take without a decoder in this program, and each is
 * recognised here by its signature and read for its size. Anything else (a damaged file, an EMF or WMF drawing, a TIFF) is refused
 * by the caller, who says which format it was and keeps the marker where the picture stood.
 *
 * Nothing here throws on bad bytes: a truncated header, a size of zero or a length that runs off the end all give `undefined`.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/gif";

export interface ImageInfo {
  mime: ImageMime;
  /** The extension to store it under, without the dot. */
  ext: "png" | "jpg" | "gif";
  width: number;
  height: number;
  /** Only for a PNG: what a PDF has to be told to draw it. */
  png?: { bitDepth: number; colorType: number; interlaced: boolean };
  /** Only for a JPEG: the number of colour channels (1 grey, 3 colour, 4 CMYK) and whether the scan order is progressive. */
  jpeg?: { components: number; progressive: boolean };
}

/** The most pixels a side may have. Larger is a damaged header or something no page can show. */
export const MAX_SIDE = 30000;

/** The largest picture kept, in bytes. A phone photograph is a few megabytes; more than this is not a figure in a test question. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);

const sane = (width: number, height: number): boolean => width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE;

function readPng(b: Uint8Array): ImageInfo | undefined {
  // Signature, then the first chunk, which has to be IHDR with 13 bytes.
  if (b.length < 33 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) return undefined;
  if (be32(b, 8) !== 13 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return undefined;
  const width = be32(b, 16);
  const height = be32(b, 20);
  if (!sane(width, height)) return undefined;
  const bitDepth = b[24]!;
  const colorType = b[25]!;
  if (![0, 2, 3, 4, 6].includes(colorType) || ![1, 2, 4, 8, 16].includes(bitDepth)) return undefined;
  if (b[26] !== 0 || b[27] !== 0 || (b[28] !== 0 && b[28] !== 1)) return undefined;
  return { mime: "image/png", ext: "png", width, height, png: { bitDepth, colorType, interlaced: b[28] === 1 } };
}

function readGif(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 10) return undefined;
  const head = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!);
  if (head !== "GIF87a" && head !== "GIF89a") return undefined;
  const width = le16(b, 6);
  const height = le16(b, 8);
  return sane(width, height) ? { mime: "image/gif", ext: "gif", width, height } : undefined;
}

function readJpeg(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return undefined;
  let at = 2;
  // Walk the marker segments until a start-of-frame says the size. Each segment is 0xFF, a marker, a length that counts itself.
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return undefined;
    let marker = b[at + 1]!;
    while (marker === 0xff && at + 2 < b.length) {
      at++;
      marker = b[at + 1]!;
    }
    at += 2;
    // Markers with no length: the standalone ones.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined; // the end, or the scan, with no frame before it
    if (at + 2 > b.length) return undefined;
    const length = be16(b, at);
    if (length < 2) return undefined;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 8 || at + 8 > b.length) return undefined;
      const height = be16(b, at + 3);
      const width = be16(b, at + 5);
      const components = b[at + 7]!;
      if (!sane(width, height) || ![1, 3, 4].includes(components)) return undefined;
      return { mime: "image/jpeg", ext: "jpg", width, height, jpeg: { components, progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce } };
    }
    at += length;
  }
  return undefined;
}

/** The picture the bytes are, or `undefined` when they are not a PNG, a JPEG or a GIF that has a size. */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length > MAX_PICTURE_BYTES) return undefined;
  return readPng(bytes) ?? readJpeg(bytes) ?? readGif(bytes);
}

/** What a format is called when a person is told it was not read, from the first bytes or failing that the part's own name. */
export function describeUnreadImage(bytes: Uint8Array | undefined, name: string): string {
  if (bytes && bytes.length > MAX_PICTURE_BYTES) return `larger than ${MAX_PICTURE_BYTES / (1024 * 1024)} MB`;
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "BMP";
    if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) return "TIFF";
    if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a) return "TIFF";
    if (bytes[0] === 0xd7 && bytes[1] === 0xcd && bytes[2] === 0xc6 && bytes[3] === 0x9a) return "WMF";
    if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00) return "EMF";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "WebP";
  }
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1).toUpperCase();
  const known = ["EMF", "WMF", "BMP", "TIFF", "TIF", "SVG", "WEBP", "WDP", "JXR", "PNG", "JPG", "JPEG", "GIF"];
  if (ext === "PNG" || ext === "JPG" || ext === "JPEG" || ext === "GIF") return `${ext}, but damaged`;
  return known.includes(ext) ? ext : "an unknown format";
}
