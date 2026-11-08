/**
 * Lists that can be as long as a file.
 *
 * `target.push(...items)`, `Math.max(...items)` and `Math.min(...items)` pass every item as an argument, and a call takes about 125,000 of
 * them before it throws "Maximum call stack size exceeded" (fewer when the call is already deep, as it is in the server). A question with
 * 130,000 lines, options, conditions or key words is a file of 130 KB to 650 KB, and each of these was a crash with that message instead of
 * a question. They are loops here, and `test/spread-guard.test.ts` fails on a spread into a call that is not listed with its reason.
 */

/** Everything in `items` added to the end of `target`, one at a time. */
export function pushAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}

/** The largest of the numbers, or `empty` when there are none (`Math.max` gives -Infinity). */
export function largest(numbers: Iterable<number>, empty = 0): number {
  let most: number | undefined;
  for (const n of numbers) if (most === undefined || n > most || Number.isNaN(n)) most = n;
  return most ?? empty;
}

/** The smallest of the numbers, or `empty` when there are none (`Math.min` gives Infinity). */
export function smallest(numbers: Iterable<number>, empty = 0): number {
  let least: number | undefined;
  for (const n of numbers) if (least === undefined || n < least || Number.isNaN(n)) least = n;
  return least ?? empty;
}
