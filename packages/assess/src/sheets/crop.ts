/**
 * The part of a picture a person has to look at: a row of bubbles, cut out upright.
 *
 * Review shows the instructor what the reader saw for a question it could not settle. The page may be sideways, mirrored or
 * turned a little, so the piece is cut out through the same transform the reader used, which puts it the right way up at a
 * fixed size however the page lay on the glass. A piece is small (a row of bubbles at 150 dots to the inch is about a thousand
 * pixels across and fifty down), so the app can keep the pieces it needs for review and let go of the page, and no whole picture
 * of a student's sheet has to stay in memory or be written anywhere.
 */

import { applyHomography } from "./homography.ts";
import { sample, type GreyImage } from "./image.ts";
import { findCornerMarks } from "./locate.ts";
import { transformFor } from "./read.ts";
import type { PaperName, Rect } from "./geometry.ts";

/** Dots to the inch a piece is cut at. */
export const CROP_DPI = 150;
/** The widest a piece may be, in pixels, however large the rectangle asked for. */
const MOST_WIDE = 1600;
/** Millimetres of the sheet to show round the rectangle asked for, so that a mark touching the edge of a bubble is seen whole. */
const MARGIN_MM = 1.5;

/**
 * Cuts the rectangles (in millimetres from the top left of the sheet) out of a picture, upright. A rectangle that falls outside
 * the picture is cut with white where there is no picture. Returns undefined when the sheet cannot be found in the picture again,
 * which cannot happen to a page that was just read.
 */
export function cropRects(image: GreyImage, paper: PaperName, rects: readonly Rect[], dpi: number = CROP_DPI): Array<GreyImage | undefined> | undefined {
  const located = findCornerMarks(image);
  if (!located.ok) return undefined;
  const h = transformFor(paper, located.marks);
  if (!h) return undefined;
  return rects.map((rect) => {
    const x0 = Math.max(0, rect.x - MARGIN_MM);
    const y0 = Math.max(0, rect.y - MARGIN_MM);
    const x1 = rect.x + rect.width + MARGIN_MM;
    const y1 = rect.y + rect.height + MARGIN_MM;
    const perMm = Math.min(dpi / 25.4, MOST_WIDE / (x1 - x0));
    const width = Math.max(1, Math.round((x1 - x0) * perMm));
    const height = Math.max(1, Math.round((y1 - y0) * perMm));
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = applyHomography(h, { x: x0 + (x + 0.5) / perMm, y: y0 + (y + 0.5) / perMm });
        data[y * width + x] = p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height ? 255 : Math.round(sample(image, p.x, p.y));
      }
    }
    return { width, height, data };
  });
}
