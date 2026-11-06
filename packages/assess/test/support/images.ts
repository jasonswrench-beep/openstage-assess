/**
 * Small real pictures, and the Word XML that places one, for the tests of pictures.
 *
 * The PNG is a valid file (signature, IHDR, PLTE when needed, IDAT, IEND, each with its checksum), so a browser, Word or a PDF reader
 * would take it. The JPEG and the GIF have the headers and the markers a reader looks at to find the size and no picture data worth
 * showing, which is all the tests of reading, storing and packing need. Where a test needs something a viewer draws, it says so.
 */

import { crc32, deflateSync } from "node:zlib";

import type { ZipEntry } from "../../src/container/zip.ts";

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

export interface PngOptions {
  /** 0 grey, 2 colour, 3 palette, 4 grey with alpha, 6 colour with alpha. Default 2. */
  colorType?: 0 | 2 | 3 | 4 | 6;
  /** A solid colour as r, g, b. Default a blue. */
  color?: [number, number, number];
  /** Written as an interlaced file (the header says so; the data is not interlaced, so it is for the header's tests only). */
  interlaced?: boolean;
  /** How opaque a picture with alpha is, 0 to 255. Default 255. For a palette picture, the opacity of its one colour (a tRNS chunk). */
  alpha?: number;
  /** For grey and palette pictures: 1, 2, 4 or 8. The pixels are all set to the lowest value (0), or all to the highest with `ones`. */
  bitDepth?: 1 | 2 | 4 | 8;
  ones?: boolean;
}

/** A solid-colour PNG of the given size. */
export function png(width: number, height: number, options: PngOptions = {}): Uint8Array {
  const colorType = options.colorType ?? 2;
  const [r, g, b] = options.color ?? [30, 90, 200];
  const alpha = options.alpha ?? 255;
  const depth = (colorType === 0 || colorType === 3) && options.bitDepth ? options.bitDepth : 8;
  let raw: Buffer;
  if (depth < 8) {
    // Every sample the same, packed: all bits clear, or all bits set.
    const rowBytes = Math.ceil((width * depth) / 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(rowBytes, options.ones ? 0xff : 0)]);
    raw = Buffer.concat(Array.from({ length: height }, () => row));
  } else {
    const pixel = colorType === 2 ? [r, g, b] : colorType === 6 ? [r, g, b, alpha] : colorType === 4 ? [r, alpha] : colorType === 3 ? [0] : [r];
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => pixel).flat())]);
    raw = Buffer.concat(Array.from({ length: height }, () => row));
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([depth, colorType, 0, 0, options.interlaced ? 1 : 0])]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...(colorType === 3 ? [chunk("PLTE", Buffer.from([r, g, b, 255, 255, 255]))] : []),
      ...(colorType === 3 && alpha < 255 ? [chunk("tRNS", Buffer.from([alpha]))] : []),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** The value of the grey pixel at x, y in `pngGradient`. */
export const gradientAt = (x: number, y: number): number => (x * 7 + y * 13) & 255;

/** A grey PNG whose pixels are `gradientAt`, with every row written with the given filter (0 to 4), so that each filter is undone by the reader. */
export function pngGradient(width: number, height: number, filter: 0 | 1 | 2 | 3 | 4): Uint8Array {
  const rows: number[][] = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => gradientAt(x, y)));
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    out.push(filter);
    for (let x = 0; x < width; x++) {
      const v = rows[y]![x]!;
      const left = x > 0 ? rows[y]![x - 1]! : 0;
      const up = y > 0 ? rows[y - 1]![x]! : 0;
      const upLeft = x > 0 && y > 0 ? rows[y - 1]![x - 1]! : 0;
      const predicted =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : (() => {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        })();
      out.push((v - predicted) & 255);
    }
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 0, 0, 0, 0])]);
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(out))), chunk("IEND", Buffer.alloc(0))]),
  );
}

/** A JPEG with the markers a reader finds the size from: start, JFIF, frame, scan header, end. */
export function jpeg(width: number, height: number, options: { components?: 1 | 3 | 4; progressive?: boolean } = {}): Uint8Array {
  const components = options.components ?? 3;
  const frame = Buffer.concat([
    Buffer.from([0xff, options.progressive ? 0xc2 : 0xc0, 0x00, 8 + 3 * components, 0x08, height >> 8, height & 255, width >> 8, width & 255, components]),
    Buffer.from(Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0]).flat()),
  ]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
      frame,
      Buffer.from([0xff, 0xda, 0x00, 2 + 1 + 2 * components + 3, components, ...Array.from({ length: components }, (_, i) => [i + 1, 0]).flat(), 0, 63, 0]),
      Buffer.from([0x00, 0x00, 0xff, 0xd9]),
    ]),
  );
}

/** A GIF with a header, a one-colour table, and a trailer. */
export function gif(width: number, height: number): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("GIF89a", "latin1"),
      Buffer.from([width & 255, width >> 8, height & 255, height >> 8, 0x80, 0, 0]),
      Buffer.from([0, 0, 0, 255, 255, 255]),
      Buffer.from([0x3b]),
    ]),
  );
}

/** A Windows enhanced metafile header, which is a drawing and not a picture this program reads. */
export function emf(): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([1, 0, 0, 0, 88, 0, 0, 0]), Buffer.alloc(80)]));
}

export interface PictureSpec {
  /** The id the document's relationship is given. */
  rId: string;
  /** The part name inside the package, for example word/media/image1.png. */
  part: string;
  bytes: Uint8Array;
}

export interface DrawingOptions {
  /** Word's description of the picture. Omitted means the attribute is not there. */
  alt?: string;
  title?: string;
  /** Sizes in EMU; 914400 to the inch. */
  cx?: number;
  cy?: number;
  id?: number;
  /** Cropping as thousandths of a percent from each side. */
  crop?: { l?: number; t?: number; r?: number; b?: number };
  rotation?: number;
  flipH?: boolean;
  /** Something extra inside the drawing, such as a shape or text. */
  inside?: string;
  /** Mark it anchored (floating) and not inline. */
  anchor?: boolean;
  /** Mark it as decoration, as Word's "Mark as decorative" does (an extension of the drawing's properties). */
  decorative?: boolean;
}

/** The run content for a picture placed in the text: a w:drawing that holds one image. */
export function drawing(rId: string, options: DrawingOptions = {}): string {
  const cx = options.cx ?? 1828800;
  const cy = options.cy ?? 1371600;
  const id = options.id ?? 1;
  const crop = options.crop ? `<a:srcRect ${Object.entries(options.crop).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` : "";
  const xfrm = `<a:xfrm${options.rotation ? ` rot="${options.rotation}"` : ""}${options.flipH ? ' flipH="1"' : ""}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const tag = options.anchor ? "wp:anchor" : "wp:inline";
  const attrs = options.alt !== undefined ? ` descr="${options.alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"` : "";
  const title = options.title !== undefined ? ` title="${options.title}"` : "";
  return (
    `<w:drawing><${tag}${options.anchor ? ' simplePos="0" relativeHeight="0" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"' : ""}>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"${attrs}${title}${options.decorative ? `><a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst></wp:docPr>` : "/>"}` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>${options.inside ?? ""}` +
    `</a:graphicData></a:graphic></${tag}></w:drawing>`
  );
}

/** The relationships and parts a document needs for its pictures: pass these to `docx` as `relationships` and `extra`. */
export function pictureParts(pictures: readonly PictureSpec[]): { relationships: string[]; extra: ZipEntry[] } {
  return {
    relationships: pictures.map(
      (p) => `<Relationship Id="${p.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${p.part.replace(/^word\//, "")}"/>`,
    ),
    extra: pictures.map((p) => ({ name: p.part, data: p.bytes, store: true })),
  };
}
