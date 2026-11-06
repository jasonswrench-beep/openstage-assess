/**
 * How an equation travels from a reader to the question that holds it.
 *
 * A reader of a file that has equations (the Word reader) cannot put the equation in a line of text, and a line of text is all the
 * scanner reads. So the reader writes a short tag where the equation stood, `[ eq: "eq-<hash>" ]`, and hands the equations themselves
 * over beside the lines, keyed by that name, the way a picture is a tag and its bytes beside. The question builder turns each tag in a
 * stem or an option into an equation of the question (an id of its own, LaTeX, MathML and Word's own XML) and a placeholder in the text.
 *
 * The table is held for the length of one `parse` and no longer. It is held here and not passed down because the places that read
 * lines are many and deep (a stem, an option, feedback, a matching pair), and a parse is synchronous and never runs inside another.
 */

import type { MathReading } from "./docx/omml.ts";

export const MATH_TAG = /\[\s*eq\s*:\s*"([^"]*)"\s*\]/gi;

let active: ReadonlyMap<string, MathReading> = new Map();

/** Runs `run` with this table of equations to look tags up in, and puts the previous one back after, however it ends. */
export function withMathTable<T>(table: ReadonlyMap<string, MathReading> | undefined, run: () => T): T {
  const before = active;
  active = table ?? new Map();
  try {
    return run();
  } finally {
    active = before;
  }
}

export const mathFor = (name: string): MathReading | undefined => active.get(name);

/**
 * Text that has no place for an equation (feedback, a matching pair, a model answer) with each tag written out as
 * `[Equation: LaTeX]`, which is how every export writes one. The words are kept and the equation is not lost; it is just not an
 * equation any more, and the editor shows it as the words it is.
 */
export function equationsAsWords(text: string): string {
  return text.replace(MATH_TAG, (whole, name: string) => {
    const math = mathFor(name);
    return math ? `[Equation: ${math.latex}]` : whole;
  });
}
