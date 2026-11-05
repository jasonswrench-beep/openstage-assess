/**
 * The ways a scan or a photograph goes wrong, done to a picture on purpose, so that the reader is tested against them.
 *
 * A sheet comes out of a scanner turned a little, squeezed by a feeder, darker or lighter than it was printed, speckled by a dirty
 * glass, blurred, saved as a JPEG; from a phone it also leans, is lit from one side and has a table round it. Each of these is
 * here as a function on a grey image. The harness (gate.ts) applies them to sheets with a known answer and counts what the reader
 * does: it may flag a sheet or refuse it, but it must never read a wrong answer and say nothing.
 *
 * These are models and not measurements. They make the reader's life harder in the ways paper and cameras are known to, and
 * they say nothing about real paper, which is a separate corpus.
 */

import { seededRandom } from "../model/random.ts";
import { applyHomography, homographyFrom, invertHomography, type Homography, type Point } from "./homography.ts";
import { newImage, sample, type GreyImage } from "./image.ts";

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** The picture moved by a transform (where each source pixel goes), onto a new canvas of a size, with a background where the page is not. */
export function warp(image: GreyImage, forward: Homography, width: number, height: number, background = 255): GreyImage {
  const inverse = invertHomography(forward);
  if (!inverse) throw new Error("That transform cannot be undone, so it cannot move a picture.");
  const out = newImage(width, height, background);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyHomography(inverse, { x: x + 0.5, y: y + 0.5 });
      if (p.x < 0 || p.y < 0 || p.x > image.width || p.y > image.height) continue;
      out.data[y * width + x] = clamp(sample(image, p.x, p.y));
    }
  }
  return out;
}

/**
 * The page put in a frame: its four corners are sent to the four points given (top left, top right, bottom right, bottom left), in a
 * frame of a size. This is a lean, a turn, a shrink and a shift all at once, which is how a photograph of a page is made.
 */
export function placeInFrame(image: GreyImage, corners: [Point, Point, Point, Point], width: number, height: number, background = 255): GreyImage {
  const source: Point[] = [{ x: 0, y: 0 }, { x: image.width, y: 0 }, { x: image.width, y: image.height }, { x: 0, y: image.height }];
  const h = homographyFrom(source, corners);
  if (!h) throw new Error("Those four corners do not make a shape a page can be put in.");
  return warp(image, h, width, height, background);
}

/** The page turned by an angle (in degrees, clockwise) about its middle, on a frame as big as the page needs, with a margin of paper-coloured background. */
export function rotate(image: GreyImage, degrees: number, background = 255): GreyImage {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const w = Math.ceil(Math.abs(image.width * c) + Math.abs(image.height * s));
  const h = Math.ceil(Math.abs(image.width * s) + Math.abs(image.height * c));
  const at = (x: number, y: number): Point => ({ x: w / 2 + (x - image.width / 2) * c - (y - image.height / 2) * s, y: h / 2 + (x - image.width / 2) * s + (y - image.height / 2) * c });
  return placeInFrame(image, [at(0, 0), at(image.width, 0), at(image.width, image.height), at(0, image.height)], w, h, background);
}

/** A quarter turn clockwise, whole pixels, no blending: what a scanner does when a sheet goes in sideways. */
export function quarterTurn(image: GreyImage, turns: number): GreyImage {
  let current = image;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    const out = newImage(current.height, current.width);
    for (let y = 0; y < current.height; y++) for (let x = 0; x < current.width; x++) out.data[x * out.width + (current.height - 1 - y)] = current.data[y * current.width + x] as number;
    current = out;
  }
  return current;
}

/** The picture cut down to the part inside the given distances from each side, in pixels. */
export function crop(image: GreyImage, left: number, top: number, right: number, bottom: number): GreyImage {
  const width = image.width - left - right;
  const height = image.height - top - bottom;
  const out = newImage(width, height);
  for (let y = 0; y < height; y++) out.data.set(image.data.subarray((y + top) * image.width + left, (y + top) * image.width + left + width), y * width);
  return out;
}

/** Soft focus: a gaussian blur of a width, in pixels. */
export function blur(image: GreyImage, sigma: number): GreyImage {
  if (sigma <= 0) return image;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = Array.from({ length: radius * 2 + 1 }, (_x, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((s, x) => s + x, 0);
  const k = kernel.map((x) => x / total);
  const { width, height } = image;
  const tmp = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const xx = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
        sum += (image.data[y * width + xx] as number) * (k[i + radius] as number);
      }
      tmp[y * width + x] = sum;
    }
  }
  const out = newImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const yy = y + i < 0 ? 0 : y + i >= height ? height - 1 : y + i;
        sum += (tmp[yy * width + x] as number) * (k[i + radius] as number);
      }
      out.data[y * width + x] = clamp(sum);
    }
  }
  return out;
}

/** Sensor noise: every pixel moved by a random amount, with a standard deviation in grey levels. */
export function noise(image: GreyImage, sigma: number, seed: string): GreyImage {
  const random = seededRandom(`noise:${seed}`);
  const out = newImage(image.width, image.height);
  for (let i = 0; i < image.data.length; i++) {
    // Two uniform numbers make a normal one (Box and Muller).
    const u = Math.max(1e-9, random());
    const v = random();
    out.data[i] = clamp((image.data[i] as number) + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  return out;
}

/** Dust on the glass and toner specks: a number of dark dots up to a size in pixels, and as many lighter ones. */
export function speckle(image: GreyImage, count: number, maxSize: number, seed: string): GreyImage {
  const random = seededRandom(`speckle:${seed}`);
  const out = newImage(image.width, image.height);
  out.data.set(image.data);
  for (let n = 0; n < count; n++) {
    const cx = random() * image.width;
    const cy = random() * image.height;
    const r = 0.5 + random() * Math.max(0.5, maxSize / 2);
    const dark = random() < 0.8;
    const level = dark ? 20 + random() * 90 : 200 + random() * 55;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(image.height - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(image.width - 1, Math.ceil(cx + r)); x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) {
          const i = y * image.width + x;
          out.data[i] = dark ? Math.min(out.data[i] as number, level) : Math.max(out.data[i] as number, level);
        }
      }
    }
  }
  return out;
}

/** Light from one side: the picture multiplied by a gradient across it, strength 0 to 1 (0.3 darkens one edge by 30 percent), in a direction in degrees. */
export function shade(image: GreyImage, strength: number, degrees: number): GreyImage {
  const a = (degrees * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = (Math.abs(dx) * image.width + Math.abs(dy) * image.height) / 2;
  const out = newImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const t = ((x - image.width / 2) * dx + (y - image.height / 2) * dy) / half;
      out.data[y * image.width + x] = clamp((image.data[y * image.width + x] as number) * (1 - strength * (t * 0.5 + 0.5)));
    }
  }
  return out;
}

/** The grey scale remapped: what was black becomes `black`, what was white becomes `white`, with a curve (gamma above 1 lightens the middle). */
export function levels(image: GreyImage, black: number, white: number, gamma = 1): GreyImage {
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++) table[v] = clamp(black + (white - black) * Math.pow(v / 255, 1 / gamma));
  const out = newImage(image.width, image.height);
  for (let i = 0; i < image.data.length; i++) out.data[i] = table[image.data[i] as number] as number;
  return out;
}

/** A black and white scan: every pixel is black or white, by a threshold. */
export function toBilevel(image: GreyImage, threshold = 128): GreyImage {
  const out = newImage(image.width, image.height);
  for (let i = 0; i < image.data.length; i++) out.data[i] = (image.data[i] as number) < threshold ? 0 : 255;
  return out;
}

// The luminance table of the JPEG standard, which every encoder scales by a quality.
const JPEG_TABLE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72,
  92, 95, 98, 112, 100, 103, 99,
];

/**
 * What saving as a JPEG of a quality (1 to 100) does to a picture: each block of 8 by 8 pixels is changed to frequencies, the small
 * ones are rounded away, and it is changed back. The file itself is not written; the damage is the same.
 */
export function jpegBlocks(image: GreyImage, quality: number): GreyImage {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const table = JPEG_TABLE.map((b) => Math.max(1, Math.min(255, Math.floor((b * scale + 50) / 100))));
  const cos = Array.from({ length: 8 }, (_x, u) => Array.from({ length: 8 }, (_y, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1) * 0.5));
  const out = newImage(image.width, image.height);
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Float64Array(64);
  for (let by = 0; by < image.height; by += 8) {
    for (let bx = 0; bx < image.width; bx += 8) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = pixelClamped(image, bx + x, by + y) - 128;
      for (let y = 0; y < 8; y++) {
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let x = 0; x < 8; x++) s += (block[y * 8 + x] as number) * ((cos[u] as number[])[x] as number);
          tmp[y * 8 + u] = s;
        }
      }
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let y = 0; y < 8; y++) s += (tmp[y * 8 + u] as number) * ((cos[v] as number[])[y] as number);
          const t = table[v * 8 + u] as number;
          coef[v * 8 + u] = Math.round(s / t) * t;
        }
      }
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let s = 0;
          for (let v = 0; v < 8; v++) {
            let row = 0;
            for (let u = 0; u < 8; u++) row += (coef[v * 8 + u] as number) * ((cos[u] as number[])[x] as number);
            s += row * ((cos[v] as number[])[y] as number);
          }
          if (bx + x < image.width && by + y < image.height) out.data[(by + y) * image.width + bx + x] = clamp(s + 128);
        }
      }
    }
  }
  return out;
}

function pixelClamped(image: GreyImage, x: number, y: number): number {
  return image.data[Math.min(image.height - 1, y) * image.width + Math.min(image.width - 1, x)] as number;
}

/** What a copier does to a copy of a copy: contrast pushed up so the lead and the paper both change, a few specks, a little noise. */
export function photocopy(image: GreyImage, seed: string, options: { darken?: number; specks?: number } = {}): GreyImage {
  const darken = options.darken ?? 0;
  let out = levels(image, 0, 250, 1 + darken);
  out = speckle(out, options.specks ?? Math.round((image.width * image.height) / 150_000), 4, seed);
  return noise(out, 3, seed);
}
