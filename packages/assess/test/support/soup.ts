/**
 * Generated files for the "nothing is lost" tests.
 *
 * Shared by the scanner tests and the Word importer tests, so that a file of lines
 * in no sensible order is the same file whether it arrives as text or as a .docx.
 */

// A small deterministic generator, so that a failure can be reproduced from
// the seed in the message rather than from a screenshot of a flaky run.
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T, chance: (p: number) => next() < p };
}

/**
 * A file made of lines in no sensible order. Each carries a unique marker, so
 * "was anything lost" is a question about whether the marker came out
 * somewhere, not about what the scanner decided the line meant.
 */
export function soup(seed: number, wide = false): { text: string; markers: string[] } {
  const g = generator(seed);
  const markers: string[] = [];
  const mark = () => {
    const m = `zq${markers.length}z`;
    markers.push(m);
    return m;
  };
  const kinds: Array<() => string> = [
    () => `${1 + Math.floor(g.chance(0.5) ? 1 : 9)}) stem ${mark()}`,
    () => `a. option ${mark()}`,
    () => `*b. option ${mark()}`,
    () => `c) option ${mark()}`,
    () => `~ good ${mark()}`,
    () => `@ bad ${mark()}`,
    () => `REF: ${mark()}`,
    () => `MSC: ${mark()}`,
    () => `DIF: ${mark()}`,
    () => `a heading ${mark()}`,
    () => `Title: ${mark()}`,
    () => `Type: ${g.pick(["E", "MC", "MA", "MT", "SA"])}`,
    () => `Points: ${g.pick(["1", "2.5", "20"])}`,
    () => "Answers:",
    () => `${1 + Math.floor(g.chance(0.5) ? 1 : 9)}. ${g.pick(["A", "B", "C", "A, C"])}`,
    () => "",
    () => "",
  ];
  // Shapes that reach the model's own limits rather than the scanner's: empty
  // options and values, matching pairs, true and false, every type hint, points
  // beyond the ceiling, a title too long to keep, images and raw HTML.
  if (wide) {
    kinds.push(
      () => "a. ",
      () => "a.   ",
      () => `Type: ${g.pick(["F", "TF", "MT", "MC", "MA", "E", "MR", "S", "FMB", "ORD", "JUM"])}`,
      () => `a. x${mark()} = y`,
      () => `b. p${mark()} = q`,
      () => `c. z${mark()} =`,
      () => `d. = w${mark()}`,
      () => `Points: ${g.pick(["5000", "0", "1000", "1001", "99999999999999999999999999"])}`,
      () => `Title: ${"long title ".repeat(8)}${mark()}`,
      () => "Title:",
      () => `z [ img: "" ] ${mark()}`,
      () => `a. [ img: "x.png" "alt" ] ${mark()}`,
      () => "[HTML]<script>x</script>[/HTML]",
      () => "[HTML][/HTML]",
      () => "a. [HTML][/HTML]",
      () => `ABC: value ${mark()}`,
      () => `DIF: ${g.pick(["hard", "weird"])}`,
      () => "REF:    ",
      () => `Topic: a; b ${mark()}`,
      () => "a. True",
      () => "b. False",
      () => `1. ${g.pick(["True", "T", "F", "essay text here"])}`,
      () => "~ ",
      () => "@ ",
    );
  }
  const lines: string[] = [];
  const length = 1 + Math.floor(g.chance(0.5) ? 12 : 40);
  for (let i = 0; i < length; i++) lines.push(g.pick(kinds)());
  return { text: lines.join("\n"), markers };
}
