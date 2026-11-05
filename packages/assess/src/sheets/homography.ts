/**
 * The transform that straightens a page: where a point of the sheet (in millimetres) falls in the picture (in pixels).
 *
 * Four corners are enough to fix it, and it holds a turn, a shift, a change of scale and the lean of a page photographed at an
 * angle, which is a perspective transform (a homography). The reader never builds a straightened copy of the picture; it asks this
 * transform where each bubble is and looks there, which is cheaper and loses nothing.
 */

export interface Point {
  x: number;
  y: number;
}

/** The nine numbers of a 3 by 3 matrix, row by row. */
export type Homography = readonly [number, number, number, number, number, number, number, number, number];

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

function multiply(a: Homography, b: Homography): Homography {
  const x = a as readonly number[];
  const y = b as readonly number[];
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push((x[r * 3] as number) * (y[c] as number) + (x[r * 3 + 1] as number) * (y[3 + c] as number) + (x[r * 3 + 2] as number) * (y[6 + c] as number));
  }
  return out as unknown as Homography;
}

export function invertHomography(h: Homography): Homography | undefined {
  const [a, b, c, d, e, f, g, i, j] = h;
  const cofactors = [e * j - f * i, c * i - b * j, b * f - c * e, f * g - d * j, a * j - c * g, c * d - a * f, d * i - e * g, b * g - a * i, a * e - b * d];
  const det = a * cofactors[0]! + b * cofactors[3]! + c * cofactors[6]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return undefined;
  return cofactors.map((x) => x / det) as unknown as Homography;
}

/** The scale and shift that put a set of points around the origin at a mean distance of the square root of two (so the equations stay well conditioned). */
function normaliser(points: Point[]): Homography {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const mean = points.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / points.length;
  const k = mean > 0 ? Math.SQRT2 / mean : 1;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

/**
 * The transform that takes each of four source points to its destination point, or undefined when the four do not make a shape that
 * can be mapped (three in a line, or two on top of each other).
 */
export function homographyFrom(source: Point[], destination: Point[]): Homography | undefined {
  if (source.length !== 4 || destination.length !== 4) throw new Error("A transform is fixed by four points and their four destinations.");
  const ts = normaliser(source);
  const td = normaliser(destination);
  const s = source.map((p) => applyHomography(ts, p));
  const d = destination.map((p) => applyHomography(td, p));

  // h0 x + h1 y + h2 - h6 x u - h7 y u = u, and h3 x + h4 y + h5 - h6 x v - h7 y v = v, for each of the four points.
  const m: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const { x, y } = s[k] as Point;
    const { x: u, y: v } = d[k] as Point;
    m.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    m.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs((m[r] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) pivot = r;
    const best = m[pivot] as number[];
    if (Math.abs(best[col] as number) < 1e-9) return undefined;
    [m[col], m[pivot]] = [best, m[col] as number[]];
    const row = m[col] as number[];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const other = m[r] as number[];
      const factor = (other[col] as number) / (row[col] as number);
      if (factor === 0) continue;
      for (let c = col; c < 9; c++) other[c] = (other[c] as number) - factor * (row[c] as number);
    }
  }
  const solved = m.map((row, r) => (row[8] as number) / (row[r] as number));
  const normalised: Homography = [solved[0]!, solved[1]!, solved[2]!, solved[3]!, solved[4]!, solved[5]!, solved[6]!, solved[7]!, 1];
  const back = invertHomography(td);
  if (!back) return undefined;
  const h = multiply(multiply(back, normalised), ts);
  if (h.some((x) => !Number.isFinite(x))) return undefined;
  const scale = h[8] !== 0 ? h[8] : 1;
  const result = h.map((x) => x / scale) as unknown as Homography;
  // Four points can look solvable and not be (three of them in a line, with a destination that is not): the answer is then a matrix that
  // sends them somewhere else. It is checked by sending them, and by being invertible.
  const size = Math.max(...destination.map((p) => Math.hypot(p.x, p.y)), 1);
  const exact = source.every((p, k) => {
    const q = applyHomography(result, p);
    return Number.isFinite(q.x) && Number.isFinite(q.y) && Math.hypot(q.x - (destination[k] as Point).x, q.y - (destination[k] as Point).y) <= 1e-6 * size;
  });
  return exact && invertHomography(result) ? result : undefined;
}
