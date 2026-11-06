/**
 * The pictures in a Word document.
 *
 * A picture used to be replaced by the text "[picture]" and its bytes were never looked at, so a test bank with figures came in with
 * the figures gone. A picture that this reader can show exactly as the author placed it is now kept: its bytes are read, named by what
 * they are (so the same picture twice is one file, and two questions can never collide on a name), and the text where it stood is the
 * standard format's own image tag, with the description Word holds for it, so the scanner and the question builder treat it like one
 * typed by hand.
 *
 * A picture that cannot be shown exactly as placed is not kept, and says why, and the marker "[picture]" stays where it stood. Showing
 * a cropped, rotated or flipped picture as its whole self, or leaving off the arrows drawn over it, would put in front of a student
 * something the author did not write (the part cropped away may be the answer), and a wrong figure that looks authored is worse than a
 * missing one that is reported.
 */

import { createHash } from "node:crypto";

import { describeUnreadImage, sniffImage, type ImageInfo } from "../../model/image.ts";
import type { DocxPackage } from "./package.ts";
import { holdsWords, type XmlElement } from "./xml.ts";

export interface ReadPicture {
  /** The path inside a bank: media/p-<sixteen hex>.<ext>. */
  file: string;
  info: ImageInfo;
  bytes: Uint8Array;
}

export interface PictureReader {
  /**
   * The text to put where an object stood when it holds a picture that can be kept: the image tag, naming the file and carrying the
   * description. Undefined for an object that holds none, or one that cannot be shown as placed (the reason is counted in `refused`).
   */
  tagFor(object: XmlElement): string | undefined;
  /** Every picture kept, by its file path. */
  readonly pictures: Map<string, ReadPicture>;
  /** Pictures that were there and were not kept, by the reason in words. */
  readonly refused: Record<string, number>;
}

/** The longest description kept. A description is a sentence or two; the rest is a paste. */
const MAX_ALT = 1000;

function descendants(root: XmlElement, test: (e: XmlElement) => boolean, out: XmlElement[] = []): XmlElement[] {
  for (const child of root.children) {
    if (typeof child === "string") continue;
    if (test(child)) out.push(child);
    descendants(child, test, out);
  }
  return out;
}

/** The description for a screen reader, made safe to sit inside the image tag's quotation marks. */
function tidyAlt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  return flat.length > MAX_ALT ? flat.slice(0, MAX_ALT).trimEnd() : flat;
}

/** Whether a drawing floats on the page (Word's anchored form) and not stands in the line of text. */
export function isFloating(object: XmlElement): boolean {
  return descendants(object, (e) => e.name === "wp:anchor").length > 0;
}

export function pictureReader(pkg: DocxPackage): PictureReader {
  const pictures = new Map<string, ReadPicture>();
  const refused: Record<string, number> = {};
  // What each image part turned out to be, so a picture used ten times is read once.
  const parts = new Map<string, ReadPicture | string>();

  const refuse = (reason: string): undefined => {
    refused[reason] = (refused[reason] ?? 0) + 1;
    return undefined;
  };

  const readPart = (id: string): ReadPicture | string => {
    const part = pkg.imagePart(id);
    if (part === undefined) return "linked from outside the file, or missing from it";
    const known = parts.get(part);
    if (known !== undefined) return known;
    const bytes = pkg.bytes(part);
    const info = bytes === undefined ? undefined : sniffImage(bytes);
    let result: ReadPicture | string;
    if (bytes === undefined || info === undefined) {
      result = `a picture in a format that is not read (${describeUnreadImage(bytes, part)}); PNG, JPEG and GIF are`;
    } else {
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      result = { file: `media/p-${hash}.${info.ext}`, info, bytes };
    }
    parts.set(part, result);
    return result;
  };

  return {
    pictures,
    refused,
    tagFor(object: XmlElement): string | undefined {
      // Something that holds text (a text box, a labelled shape) is not a picture, whatever else it holds.
      if (holdsWords(object)) return undefined;

      const blips = descendants(object, (e) => e.name === "a:blip" && e.attrs["r:embed"] !== undefined);
      const vml = descendants(object, (e) => e.name === "v:imagedata" && e.attrs["r:id"] !== undefined);
      const ids = [...blips.map((e) => e.attrs["r:embed"] as string), ...vml.map((e) => e.attrs["r:id"] as string)];
      // An alternate-content wrapper holds the picture twice, once for a newer Word and once for an older one. That is one picture.
      const distinct = [...new Set(ids)];
      if (distinct.length === 0) return undefined; // a chart, a shape, an ink drawing: not a picture, counted by the caller
      const chosenId = blips.length > 0 ? (blips[0]!.attrs["r:embed"] as string) : (vml[0]!.attrs["r:id"] as string);
      if (blips.length > 1 && new Set(blips.map((e) => e.attrs["r:embed"])).size > 1) return refuse("several pictures grouped together");
      if (blips.length === 0 && new Set(vml.map((e) => e.attrs["r:id"])).size > 1) return refuse("several pictures grouped together");

      // Shapes drawn on or around the picture, which a picture alone would leave out.
      const drawn = (e: XmlElement): boolean =>
        e.name === "wps:wsp" || e.name === "wpg:wgp" || e.name === "wpc:wpc" || (e.name === "v:shape" && e.children.some((c) => typeof c !== "string" && c.name === "v:textbox"));
      if (descendants(object, drawn).length > 0) return refuse("a picture with shapes drawn on it");
      // Cropped, rotated or flipped in Word: the file holds the whole picture, and the page shows something else.
      for (const crop of descendants(object, (e) => e.name === "a:srcRect")) {
        if (["l", "t", "r", "b"].some((side) => Number(crop.attrs[side] ?? 0) !== 0)) return refuse("a picture cropped in Word");
      }
      for (const xfrm of descendants(object, (e) => e.name === "a:xfrm")) {
        if (Number(xfrm.attrs["rot"] ?? 0) !== 0 || xfrm.attrs["flipH"] === "1" || xfrm.attrs["flipH"] === "true" || xfrm.attrs["flipV"] === "1" || xfrm.attrs["flipV"] === "true") {
          return refuse("a picture rotated or flipped in Word");
        }
      }
      for (const crop of descendants(object, (e) => e.name === "v:imagedata")) {
        if (["cropleft", "croptop", "cropright", "cropbottom"].some((k) => crop.attrs[k] !== undefined && crop.attrs[k] !== "0")) return refuse("a picture cropped in Word");
      }

      const read = readPart(chosenId);
      if (typeof read === "string") return refuse(read);

      const docPr = descendants(object, (e) => e.name === "wp:docPr")[0];
      const shape = descendants(object, (e) => e.name === "v:shape")[0];
      const imagedata = vml[0];
      // Word's description is `descr`. The older Title field is next, then the older drawing format's own two. `||` and not `??`:
      // an empty description is no description, and the next one is looked at.
      const alt = tidyAlt(docPr?.attrs["descr"] || docPr?.attrs["title"] || shape?.attrs["alt"] || imagedata?.attrs["o:title"] || "");
      // "Mark as decorative", which Word keeps in an extension of the drawing's properties (adec:decorative val="1"): the author has said
      // the picture carries no meaning, so it needs no description, and is not flagged for lacking one.
      const decorative = docPr !== undefined && descendants(docPr, (e) => /(^|:)decorative$/.test(e.name) && (e.attrs["val"] === "1" || e.attrs["val"] === "true")).length > 0;

      pictures.set(read.file, read);
      return `[ img: "${read.file.slice("media/".length)}" "${decorative ? "" : alt}"${decorative ? " decorative" : ""} ]`;
    },
  };
}
