/**
 * The chains of styles in a Word file, worked out for all the styles at once.
 *
 * A style is based on at most one other style, and it takes what it does not say from that one, and so on: its chain is itself, then
 * the style it is based on, then that style's, nearest first. A chain ends at a style that is based on nothing, or on a style the file
 * does not define, or where a loop would come round to a style it has already had (a file Word wrote has no loops, and a damaged one
 * can). The questions asked of a chain are "which is the nearest style that says this" and "is this style on that one's chain".
 *
 * They were asked by walking the chain, once for each paragraph and again for each style. A chain of 20,000 styles (168 KB of file)
 * took 28 seconds to read that way, and so did 20,000 paragraphs in 20,000 styles of a chain. Here the styles are a set of trees whose
 * roots are the styles based on nothing the file defines, and of loops with trees hanging off them, and each question is answered for
 * every style in one pass over the trees and the loops, or by a look at where each style stands in them.
 */

/** The nearest style on a chain that has what was asked for, and how many steps down the chain it is (0 for the style itself). */
export interface Near {
  style: string;
  steps: number;
}

export interface StyleChains<S> {
  /**
   * For each style that has one on its chain (itself first, then the style it is based on, and so on, to where the chain ends), the
   * nearest style for which `has` is true. A style with none on its chain is not in the result.
   */
  nearest(has: (style: S) => boolean): Map<string, Near>;
  /** Whether `to` is on the chain of `from`, `from` itself included. */
  reaches(from: string, to: string): boolean;
}

export function styleChains<S extends { basedOn: string | undefined }>(styles: ReadonlyMap<string, S>): StyleChains<S> {
  const next = new Map<string, string>();
  for (const [id, style] of styles) if (style.basedOn !== undefined && styles.has(style.basedOn)) next.set(id, style.basedOn);

  // The loops: walk on from each style not yet seen until a style that is settled (the end of a chain) or one on this walk (a loop).
  const settled = new Set<string>();
  const loopOf = new Map<string, number>();
  const loops: string[][] = [];
  for (const start of styles.keys()) {
    if (settled.has(start)) continue;
    const walk: string[] = [];
    const onWalk = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !settled.has(at) && !onWalk.has(at)) {
      onWalk.add(at);
      walk.push(at);
      at = next.get(at);
    }
    if (at !== undefined && onWalk.has(at)) {
      const loop = walk.slice(walk.indexOf(at));
      for (const id of loop) loopOf.set(id, loops.length);
      loops.push(loop);
    }
    for (const id of walk) settled.add(id);
  }

  // The trees: a style on a loop, or based on nothing, is a root; any other is a child of the style it is based on. They are walked
  // from the roots down, so that a style comes after the one it is based on (`order`) and every style has the span of places
  // (`entered` to `left`) its descendants take, which is how a style tells whether another is above it.
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of styles.keys()) {
    const above = next.get(id);
    if (above === undefined || loopOf.has(id)) roots.push(id);
    else {
      const list = children.get(above);
      if (list) list.push(id);
      else children.set(above, [id]);
    }
  }
  const order: string[] = [];
  const entered = new Map<string, number>();
  const left = new Map<string, number>();
  const rootOf = new Map<string, string>();
  let clock = 0;
  for (const root of roots) {
    const path: string[] = [root];
    const taken: number[] = [0];
    entered.set(root, clock++);
    rootOf.set(root, root);
    order.push(root);
    while (path.length > 0) {
      const top = path[path.length - 1] as string;
      const below = children.get(top);
      const k = taken[taken.length - 1] as number;
      if (below !== undefined && k < below.length) {
        taken[taken.length - 1] = k + 1;
        const child = below[k] as string;
        entered.set(child, clock++);
        rootOf.set(child, root);
        order.push(child);
        path.push(child);
        taken.push(0);
      } else {
        left.set(top, clock - 1);
        path.pop();
        taken.pop();
      }
    }
  }

  return {
    nearest(has) {
      const found = new Map<string, Near>();
      // Every style on a loop has all the others on its chain, so its nearest is the first that has it going round the loop.
      for (const loop of loops) {
        const first = loop.findIndex((id) => has(styles.get(id) as S));
        if (first === -1) continue;
        found.set(loop[first] as string, { style: loop[first] as string, steps: 0 });
        for (let back = 1; back < loop.length; back++) {
          const at = (first - back + loop.length) % loop.length;
          const id = loop[at] as string;
          if (has(styles.get(id) as S)) found.set(id, { style: id, steps: 0 });
          else {
            const onward = found.get(loop[(at + 1) % loop.length] as string) as Near;
            found.set(id, { style: onward.style, steps: onward.steps + 1 });
          }
        }
      }
      // The rest: each after the style it is based on.
      for (const id of order) {
        if (loopOf.has(id)) continue;
        if (has(styles.get(id) as S)) {
          found.set(id, { style: id, steps: 0 });
          continue;
        }
        const above = next.get(id);
        const onward = above === undefined ? undefined : found.get(above);
        if (onward) found.set(id, { style: onward.style, steps: onward.steps + 1 });
      }
      return found;
    },
    reaches(from, to) {
      const a = entered.get(from);
      const b = entered.get(to);
      if (a === undefined || b === undefined) return false;
      if (b <= a && a <= (left.get(to) as number)) return true;
      // Both on one loop, or the first leads to the loop the second is on.
      const loop = loopOf.get(rootOf.get(from) as string);
      return loop !== undefined && loopOf.get(to) === loop;
    },
  };
}
