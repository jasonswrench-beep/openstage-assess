/**
 * A shuffle that is the same every time for the same id.
 *
 * Printing and test versions both need an order that can be made again: a printed test shown twice must be the same test, and a
 * version made from a stored seed must be the version that was handed out. So nothing here is random in the sense of changing from
 * one run to the next. The text given is the whole of the seed.
 */

/** A generator of numbers from 0 up to but not including 1, the same sequence for the same text. */
export function seededRandom(text: string): () => number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same items in another order, the same other order each time for the same id, and never the order they came in. */
export function shuffledFor<T>(items: readonly T[], id: string): T[] {
  const out = [...items];
  const random = seededRandom(id);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  // A shuffle that came out as it went in would show the key, so it is turned by one place.
  if (out.length > 1 && out.every((item, i) => item === items[i])) out.push(out.shift() as T);
  return out;
}
