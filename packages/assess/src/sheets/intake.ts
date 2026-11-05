/**
 * Opening a file of scans: what kind of picture it is, and what to do with it.
 *
 * A file is told by its first bytes and not by its name, since a scanner's file names say little and a phone's say less. A PNG is decoded
 * here. A JPEG (and a WebP, GIF or BMP, which the window also knows) is handed on as bytes, because the window already has a decoder
 * and the engine has none; the window gives back grey pixels. A PDF is opened page by page (pdf-page.ts), and a page that is a JPEG is
 * handed on the same way. What is refused is refused with the setting that would give something readable: an iPhone's HEIC photo, a
 * TIFF, and what is not a picture at all.
 */

import { readPng, type GreyImage } from "./image.ts";
import { readPdfPictures, type Orientation, type PictureRefusalCause } from "./pdf-page.ts";

export type PictureKind = "png" | "jpeg" | "pdf" | "webp" | "gif" | "bmp" | "heic" | "tiff" | "unknown";

/** What a file is, from its first bytes. */
export function sniffPicture(bytes: Uint8Array): PictureKind {
  const b = bytes;
  const at = (i: number): number => (b[i] as number) ?? -1;
  const text = (from: number, to: number): string => Buffer.from(b.subarray(from, to)).toString("latin1");
  if (b.length >= 8 && at(0) === 0x89 && text(1, 4) === "PNG") return "png";
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";
  if (b.length >= 5 && text(0, 5) === "%PDF-") return "pdf";
  // Some PDFs have a few bytes of junk in front of the header; the format allows the first kilobyte.
  if (b.length >= 5 && Buffer.from(b.subarray(0, 1024)).indexOf("%PDF-", 0, "latin1") !== -1) return "pdf";
  if (b.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
  if (b.length >= 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a")) return "gif";
  if (b.length >= 2 && text(0, 2) === "BM") return "bmp";
  if (b.length >= 4 && ((at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a && at(3) === 0) || (at(0) === 0x4d && at(1) === 0x4d && at(2) === 0 && at(3) === 0x2a))) return "tiff";
  if (b.length >= 12 && text(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(text(8, 12))) return "heic";
  return "unknown";
}

/** The reason a kind of file is not opened, and what to do about it. Undefined for the kinds that are. */
export function refusalFor(kind: PictureKind): string | undefined {
  switch (kind) {
    case "heic":
      return "This is an iPhone HEIC photo, which cannot be opened. On the iPhone, open Settings, Camera, Formats and choose Most Compatible, then photograph the sheets again. Photos already taken can be sent as JPG by choosing Most Compatible when sharing them.";
    case "tiff":
      return "This is a TIFF file, which cannot be opened. Set the scanner to save JPG, PNG or PDF, or save the pages as one of those.";
    case "unknown":
      return "This is not a picture or a PDF that can be opened. Scans can be JPG, PNG or PDF files.";
    default:
      return undefined;
  }
}

/** One picture the reader can be given, or what the window has to decode before it can be. */
export type Source =
  | { kind: "grey"; image: GreyImage; notes: string[]; dpi?: number }
  | { kind: "window"; format: "jpeg" | "webp" | "gif" | "bmp"; bytes: Uint8Array; orientation: Orientation; notes: string[]; dpi?: number };

export interface IntakePage {
  /** From 1: the page of a PDF, or 1 for a picture. */
  page: number;
  result: { ok: true; source: Source } | { ok: false; cause: PictureRefusalCause | "format" | "heic" | "tiff" | "unknown"; reason: string };
}

export type Intake = { ok: true; kind: PictureKind; pages: IntakePage[]; notes: string[] } | { ok: false; kind: PictureKind; cause: PictureRefusalCause | "heic" | "tiff" | "unknown" | "format"; reason: string };

const NO_TURN: Orientation = { invert: false, flip: false, quarterTurns: 0 };

/** Opens a file's bytes as pages of pictures. */
export function openScans(bytes: Uint8Array): Intake {
  const kind = sniffPicture(bytes);
  const refusal = refusalFor(kind);
  if (refusal) return { ok: false, kind, cause: kind as "heic" | "tiff" | "unknown", reason: refusal };
  if (kind === "png") {
    const png = readPng(bytes);
    if (!png.ok) return { ok: false, kind, cause: "damaged", reason: png.reason };
    return { ok: true, kind, notes: [], pages: [{ page: 1, result: { ok: true, source: { kind: "grey", image: png.image, notes: png.notes, ...(png.dpi !== undefined ? { dpi: png.dpi } : {}) } } }] };
  }
  if (kind === "pdf") {
    const pdf = readPdfPictures(bytes);
    if (!pdf.ok) return { ok: false, kind, cause: pdf.cause, reason: pdf.reason };
    return {
      ok: true,
      kind,
      notes: pdf.notes,
      pages: pdf.pages.map((p) => ({
        page: p.page,
        result: !p.result.ok
          ? p.result
          : p.result.picture.kind === "grey"
            ? { ok: true as const, source: { kind: "grey" as const, image: p.result.picture.image, notes: p.result.picture.notes, ...(p.result.picture.dpi !== undefined ? { dpi: p.result.picture.dpi } : {}) } }
            : { ok: true as const, source: { kind: "window" as const, format: "jpeg" as const, bytes: p.result.picture.bytes, orientation: p.result.picture.orientation, notes: p.result.picture.notes, ...(p.result.picture.dpi !== undefined ? { dpi: p.result.picture.dpi } : {}) } },
      })),
    };
  }
  // A JPEG, WebP, GIF or BMP: the window decodes it, and applies the camera's own turn (the EXIF flag) as it does.
  return { ok: true, kind, notes: [], pages: [{ page: 1, result: { ok: true, source: { kind: "window", format: kind as "jpeg" | "webp" | "gif" | "bmp", bytes, orientation: NO_TURN, notes: [] } } }] };
}
