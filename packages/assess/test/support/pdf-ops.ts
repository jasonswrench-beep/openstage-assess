/**
 * Takes a printed answer sheet apart from its own drawing commands.
 *
 * This reads the content stream of each page of a PDF and follows the few operators the sheet printer uses (rectangles, lines,
 * curves, grey, and text), turning what is drawn into shapes in millimetres from the top left. It is written apart from the
 * printer, so a test that says "the bubble is where the geometry says" is measuring the file and not repeating the printer.
 */

import { inflateSync } from "node:zlib";

export interface RectShape {
  kind: "rect";
  /** The top left corner and the size, in millimetres. */
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "fill" | "stroke";
  gray: number;
}

export interface PathShape {
  kind: "path";
  /** Every end point of the path, in millimetres. A circle is four curves, so these are its four extreme points. */
  points: Array<{ x: number; y: number }>;
  curves: number;
  lines: number;
  mode: "fill" | "stroke";
  gray: number;
  /** The bounding box of the end points. */
  box: { x: number; y: number; width: number; height: number };
  /** The centre of the box. */
  center: { x: number; y: number };
}

export interface TextShape {
  kind: "text";
  text: string;
  /** The left end of the baseline, in millimetres. */
  x: number;
  y: number;
  size: number;
  font: string;
  gray: number;
}

export type Shape = RectShape | PathShape | TextShape;

export interface ReadPage {
  widthMm: number;
  heightMm: number;
  shapes: Shape[];
}

const PT = 72 / 25.4;

function tokens(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let text = "(";
      while (j < source.length && depth > 0) {
        const d = source[j] as string;
        if (d === "\\") {
          text += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (d === "(") depth++;
        if (d === ")") depth--;
        text += d;
        j++;
      }
      out.push(text);
      i = j;
    } else {
      let j = i;
      while (j < source.length && !/\s/.test(source[j] as string) && source[j] !== "(") j++;
      out.push(source.slice(i, j));
      i = j;
    }
  }
  return out;
}

function unescape(raw: string): string {
  return raw
    .slice(1, -1)
    .replace(/\\([0-7]{3})/g, (_w, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, "$1");
}

/** The content streams of a PDF, in file order, inflated. A page's own are the ones that hold drawing. */
function contentStreams(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  // "endstream" ends in "stream" too, so only a "stream" that is not the end of one begins a stream.
  for (const m of text.matchAll(/(?<!end)stream\r?\n/g)) {
    const start = (m.index as number) + m[0].length;
    const raw = Buffer.from(text.slice(start, text.indexOf("endstream", start)), "latin1");
    try {
      out.push(inflateSync(raw).toString("latin1"));
    } catch {
      out.push(raw.toString("latin1"));
    }
  }
  return out;
}

export function readSheetPdf(bytes: Uint8Array): ReadPage[] {
  const text = Buffer.from(bytes).toString("latin1");
  const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
  return contentStreams(bytes).map((stream, index) => {
    const box = boxes[index] as { w: number; h: number };
    const heightMm = box.h / PT;
    const mm = (x: number): number => x / PT;
    const mmY = (y: number): number => heightMm - y / PT;
    const shapes: Shape[] = [];

    let fill = 0;
    let stroke = 0;
    let stack: string[] = [];
    let path: { points: Array<{ x: number; y: number }>; curves: number; lines: number } | undefined;
    let rect: Omit<RectShape, "mode" | "gray"> | undefined;
    let textState = { x: 0, y: 0, size: 0, font: "" };

    const finish = (mode: "fill" | "stroke"): void => {
      const gray = mode === "fill" ? fill : stroke;
      if (rect) shapes.push({ ...rect, mode, gray });
      else if (path && path.points.length > 0) {
        const xs = path.points.map((p) => p.x);
        const ys = path.points.map((p) => p.y);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        const width = Math.max(...xs) - left;
        const height = Math.max(...ys) - top;
        shapes.push({ kind: "path", points: path.points, curves: path.curves, lines: path.lines, mode, gray, box: { x: left, y: top, width, height }, center: { x: left + width / 2, y: top + height / 2 } });
      }
      rect = undefined;
      path = undefined;
    };

    for (const token of tokens(stream)) {
      const numbers = (): number[] => stack.map(Number);
      switch (token) {
        case "g": fill = Number(stack.at(-1)); stack = []; break;
        case "G": stroke = Number(stack.at(-1)); stack = []; break;
        case "w": stack = []; break;
        case "re": {
          const [x, y, w, h] = numbers().slice(-4) as [number, number, number, number];
          // A PDF rectangle is given by its bottom left corner and goes up.
          rect = { kind: "rect", x: mm(x), y: mmY(y + h), width: mm(w), height: mm(h) };
          stack = [];
          break;
        }
        case "m": {
          const [x, y] = numbers().slice(-2) as [number, number];
          path = { points: [{ x: mm(x), y: mmY(y) }], curves: 0, lines: 0 };
          stack = [];
          break;
        }
        case "l": {
          const [x, y] = numbers().slice(-2) as [number, number];
          path?.points.push({ x: mm(x), y: mmY(y) });
          if (path) path.lines++;
          stack = [];
          break;
        }
        case "c": {
          const v = numbers().slice(-6) as [number, number, number, number, number, number];
          path?.points.push({ x: mm(v[4]), y: mmY(v[5]) });
          if (path) path.curves++;
          stack = [];
          break;
        }
        case "h": stack = []; break;
        case "f": finish("fill"); stack = []; break;
        case "S": finish("stroke"); stack = []; break;
        case "BT": stack = []; break;
        case "ET": stack = []; break;
        case "Tf": textState = { ...textState, font: (stack.at(-2) as string).slice(1), size: Number(stack.at(-1)) }; stack = []; break;
        case "Tm": {
          const v = numbers().slice(-6);
          textState = { ...textState, x: mm(v[4] as number), y: mmY(v[5] as number) };
          stack = [];
          break;
        }
        case "Tj":
          shapes.push({ kind: "text", text: unescape(stack.at(-1) as string), x: textState.x, y: textState.y, size: textState.size, font: textState.font, gray: fill });
          stack = [];
          break;
        default:
          stack.push(token);
      }
    }
    return { widthMm: box.w / PT, heightMm, shapes };
  });
}

export const rects = (page: ReadPage): RectShape[] => page.shapes.filter((s): s is RectShape => s.kind === "rect");
export const paths = (page: ReadPage): PathShape[] => page.shapes.filter((s): s is PathShape => s.kind === "path");
export const texts = (page: ReadPage): TextShape[] => page.shapes.filter((s): s is TextShape => s.kind === "text");

/** A path that is a circle: four curves, and a box that is square. */
export const isCircle = (p: PathShape): boolean => p.curves === 4 && Math.abs(p.box.width - p.box.height) < 0.01;
