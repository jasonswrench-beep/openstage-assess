/**
 * Looking for tags in markup without a pattern that can read the same text again and again.
 *
 * A pattern such as `<[^>]*>` is fine on markup, and quadratic on a text that has many `<` and no `>`: every `<` is a place to start, and
 * every one of them reads to the end of the text before it fails. `<` repeated 200,000 times (a 1.3 KB bank) took ten seconds to open and
 * forty-six to check, and the same text in a stem took each exporter twenty. The rule here is the one a reader of the pattern does not see:
 * a tag that is looked for by its first `>` is looked for once. If the first `>` after a start is not there, no later start has one either,
 * so the search ends, and if the part after the tag does not fit, every start before that `>` ends at the same place and fails the same
 * way, so they are skipped. Each function says which pattern it is the same as, and `test/linear-parity.test.ts` holds each to the
 * pattern it replaces on thousands of generated texts, including texts made only of the characters that give a pattern trouble.
 *
 * Nothing here is imported from anywhere else in the engine, so that every reader and writer can use it.
 */

/**
 * The text with every `<` and the characters up to the first `>` after it taken out: the same as `text.replace(/<[^>]*>/g, "")`. A `<`
 * with no `>` after it stays (and so does every later one), as it does for the pattern.
 */
export function stripTags(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) break;
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;
    out += text.slice(from, open);
    from = close + 1;
  }
  return out + text.slice(from);
}

/**
 * Whether a text holds a tag, a `<` and a letter and then, somewhere, a `>`: the same as `/<[a-z][^>]*>/i.test(text)`. Only the first `<`
 * and a letter can matter, since a later one has fewer `>` after it.
 */
export function hasTag(text: string): boolean {
  const open = /<[a-z]/i.exec(text);
  return open !== null && text.indexOf(">", open.index + 2) !== -1;
}

/** A tag found by its start and its first `>`. */
export interface FoundTag {
  index: number;
  /** The whole tag, from its `<` to its `>`. */
  text: string;
}

/**
 * Every tag that begins where `start` matches and runs to the first `>`: the same as the matches of a pattern made of `start` and `[^>]*>`.
 * `start` must not itself match a `>`. It is copied, so that a caller can keep it in a constant.
 */
export function findTags(text: string, start: RegExp): FoundTag[] {
  const found: FoundTag[] = [];
  const seek = new RegExp(start.source, start.flags.includes("g") ? start.flags : start.flags + "g");
  for (let m = seek.exec(text); m !== null; m = seek.exec(text)) {
    const close = text.indexOf(">", m.index + m[0].length);
    if (close === -1) break;
    found.push({ index: m.index, text: text.slice(m.index, close + 1) });
    seek.lastIndex = close + 1;
  }
  return found;
}

/** `findTags`, with each tag replaced by what `replace` makes of it. */
export function replaceTags(text: string, start: RegExp, replace: (tag: string) => string): string {
  let out = "";
  let from = 0;
  for (const tag of findTags(text, start)) {
    out += text.slice(from, tag.index) + replace(tag.text);
    from = tag.index + tag.text.length;
  }
  return out + text.slice(from);
}

/**
 * The text with what `tail` matches taken out wherever it follows a tag that begins where `start` matches and runs to its first `>`: the
 * same as `text.replace(new RegExp("(" + start + "[^>]*>)" + tail, "g"), "$1")`. `tail` must be a sticky pattern, and is asked at one
 * place for each tag. When it does not fit after a tag, it does not fit after any start that has the same `>` either, so those are skipped.
 */
export function dropAfterTags(text: string, start: RegExp, tail: RegExp): string {
  const seek = new RegExp(start.source, start.flags.includes("g") ? start.flags : start.flags + "g");
  const after = new RegExp(tail.source, tail.flags.includes("y") ? tail.flags : tail.flags + "y");
  let out = "";
  let copied = 0;
  for (let m = seek.exec(text); m !== null; m = seek.exec(text)) {
    const close = text.indexOf(">", m.index + m[0].length);
    if (close === -1) break;
    after.lastIndex = close + 1;
    const dropped = after.exec(text);
    seek.lastIndex = close + 1;
    if (dropped === null) continue;
    out += text.slice(copied, close + 1);
    copied = close + 1 + dropped[0].length;
    seek.lastIndex = copied;
  }
  return out + text.slice(copied);
}

/**
 * A text cut into its tags and its words: the same as `text.match(/<[^>]+>|[^<]+/g) ?? []`. A tag is a `<`, one or more characters that are
 * not `>`, and the first `>`; a run of words ends at the next `<`. A `<` that begins neither (a `<` with no `>` after it, or `<>`) belongs to no
 * token and is not in the result, as it was not before. The pattern read to the end of the text from every `<` that had no `>` after it.
 */
export function markupTokens(text: string): string[] {
  const tokens: string[] = [];
  const n = text.length;
  let at = 0;
  let noClose = false;
  while (at < n) {
    if (text.charCodeAt(at) !== 60) {
      const end = text.indexOf("<", at);
      const stop = end === -1 ? n : end;
      tokens.push(text.slice(at, stop));
      at = stop;
      continue;
    }
    if (!noClose) {
      const close = text.indexOf(">", at + 1);
      if (close === -1) noClose = true;
      else if (close > at + 1) {
        tokens.push(text.slice(at, close + 1));
        at = close + 1;
        continue;
      }
    }
    at++;
  }
  return tokens;
}

/**
 * Each stretch from a match of `open` to the first match of `close` after it, replaced by what `replace` makes of what lies between: the
 * same as `text.replace(new RegExp(open + "([\\s\\S]*?)" + close, "g"), ...)`. Neither pattern may match the other's text. When no `close`
 * is left after an `open`, none is left after any later one, so the search ends.
 */
export function replaceDelimited(text: string, open: RegExp, close: RegExp, replace: (inner: string) => string): string {
  const starts = new RegExp(open.source, open.flags.includes("g") ? open.flags : open.flags + "g");
  const ends = new RegExp(close.source, close.flags.includes("g") ? close.flags : close.flags + "g");
  let out = "";
  let copied = 0;
  for (let m = starts.exec(text); m !== null; m = starts.exec(text)) {
    const innerFrom = m.index + m[0].length;
    ends.lastIndex = innerFrom;
    const end = ends.exec(text);
    if (end === null) break;
    out += text.slice(copied, m.index) + replace(text.slice(innerFrom, end.index));
    copied = end.index + end[0].length;
    starts.lastIndex = copied;
  }
  return out + text.slice(copied);
}

/** An element found by its opening tag and by the first closing tag after it. */
export interface FoundElement {
  /** The name as it was written, in any case. */
  name: string;
  index: number;
  /** Where the element ends, after its closing tag. */
  end: number;
  /** The opening tag, from its `<` to its `>`. */
  open: string;
  /** What is between the opening tag and the closing one. */
  inner: string;
}

/**
 * The elements the pattern `<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>` finds (with the names of `names` in place of td and th): each opening tag
 * runs to its first `>`, and its content to the first closing tag of the same name after that. An opening tag whose closing tag is nowhere
 * after it fails, and so does every later one of that name, because the search for a closing tag starts no earlier than this one did, so a
 * name that has failed once is not looked for again. A start with no `>` after it ends the search. A closing tag may have white space before
 * its `>` (`</td >`) unless `tight` says that it may not, as in `<\/\1>`.
 */
export function findElements(text: string, names: readonly string[], tight = false): FoundElement[] {
  const found: FoundElement[] = [];
  const start = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const closers = new Map<string, RegExp>();
  const dead = new Set<string>();
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    const name = (m[1] as string).toLowerCase();
    if (dead.has(name)) {
      start.lastIndex = m.index + 1;
      continue;
    }
    const close = text.indexOf(">", m.index + m[0].length);
    if (close === -1) break;
    let closer = closers.get(name);
    if (closer === undefined) {
      closer = new RegExp(tight ? `</${name}>` : `</${name}\\s*>`, "gi");
      closers.set(name, closer);
    }
    closer.lastIndex = close + 1;
    const end = closer.exec(text);
    if (end === null) {
      dead.add(name);
      start.lastIndex = m.index + 1;
      continue;
    }
    const stop = end.index + end[0].length;
    found.push({ name: m[1] as string, index: m.index, end: stop, open: text.slice(m.index, close + 1), inner: text.slice(close + 1, end.index) });
    start.lastIndex = stop;
  }
  return found;
}

/**
 * The text with each of these elements, from its opening tag to the first closing tag of the same name after it, replaced by
 * `replacement`: `text.replace(/<(strong|em|u)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")` is `replaceElements(text, ["strong", "em", "u"], " ")`.
 */
export function replaceElements(text: string, names: readonly string[], replacement: string): string {
  let out = "";
  let from = 0;
  for (const element of findElements(text, names, true)) {
    out += text.slice(from, element.index) + replacement;
    from = element.end;
  }
  return out + text.slice(from);
}

const ANGLE = /[<>]/g;

/** Where the first `<` or `>` at or after `from` is, or -1, read in one pass. */
function nextAngle(text: string, from: number): number {
  ANGLE.lastIndex = from;
  const m = ANGLE.exec(text);
  return m === null ? -1 : m.index;
}

// Asked at one place only: what it reads there stops at the first quotation mark, angle bracket or end of the text.
const REF_AT = /ref\s*=\s*"([^"<>]*)"/iy;
const REF_WORD = /ref/gi;

/**
 * The value of the attribute `ref="..."` in the text of a tag's attributes, taking the last when there are several, or undefined. `whole`
 * says that the name must begin at a word (`\bref`), so that `xref` is not it.
 */
function refIn(attributes: string, whole: boolean): string | undefined {
  const places: number[] = [];
  REF_WORD.lastIndex = 0;
  for (let m = REF_WORD.exec(attributes); m !== null; m = REF_WORD.exec(attributes)) places.push(m.index);
  for (let i = places.length - 1; i >= 0; i--) {
    const at = places[i] as number;
    if (whole && at > 0 && /\w/.test(attributes.charAt(at - 1))) continue;
    REF_AT.lastIndex = at;
    const m = REF_AT.exec(attributes);
    if (m !== null) return m[1] as string;
  }
  return undefined;
}

/**
 * Each picture (`kind` "media") or equation ("math") placeholder, `<oa-media ref="..."></oa-media>`, replaced by what `replace` makes of it
 * from the reference it names and its markup. It is the same as `text.replace(/<oa-media\b[^<>]*\bref\s*=\s*"([^"<>]*)"[^<>]*>\s*<\/oa-media>/gi, ...)`
 * on any text the engine wrote (a tag of that text never holds a `<` or a `>` inside, since the sanitizer escapes both in a value), and
 * does not read the text of an unclosed tag again for every `<oa-media` in it.
 */
export function replacePlaceholders(text: string, kind: "media" | "math", replace: (ref: string, whole: string) => string): string {
  const element = `oa-${kind}`;
  const start = new RegExp(`<${element}\\b`, "gi");
  const close = new RegExp(`\\s*</${element}>`, "iy");
  let out = "";
  let copied = 0;
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    const bodyFrom = m.index + m[0].length;
    const stop = nextAngle(text, bodyFrom);
    // No `>` ahead: this start fails, and so does every later one.
    if (stop === -1) break;
    // Another `<` before the `>`: this is not the tag of a placeholder, and no start before that `<` can be one.
    if (text.charAt(stop) === "<") {
      start.lastIndex = stop;
      continue;
    }
    close.lastIndex = stop + 1;
    const closed = close.exec(text);
    const ref = closed === null ? undefined : refIn(text.slice(bodyFrom, stop), true);
    if (closed === null || ref === undefined) {
      start.lastIndex = stop + 1;
      continue;
    }
    const end = stop + 1 + closed[0].length;
    out += text.slice(copied, m.index) + replace(ref, text.slice(m.index, end));
    copied = end;
    start.lastIndex = end;
  }
  return out + text.slice(copied);
}

/**
 * Each element `<name ...></name>` with nothing but white space between its tags taken out of a text and replaced by `replacement`,
 * whatever its attributes: `text.replace(/<oa-media[^>]*>\s*<\/oa-media>/gi, " ")` is `replaceBareElements(text, "oa-media", " ")` for text
 * the engine wrote. The name is not followed by a word boundary here: `<oa-mediaX>` counts, as it did.
 */
export function replaceBareElements(text: string, element: string, replacement: string): string {
  const start = new RegExp(`<${element}`, "gi");
  const close = new RegExp(`\\s*</${element}>`, "iy");
  let out = "";
  let copied = 0;
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    const stop = nextAngle(text, m.index + m[0].length);
    if (stop === -1) break;
    if (text.charAt(stop) === "<") {
      start.lastIndex = stop;
      continue;
    }
    close.lastIndex = stop + 1;
    const closed = close.exec(text);
    if (closed === null) {
      start.lastIndex = stop + 1;
      continue;
    }
    const end = stop + 1 + closed[0].length;
    out += text.slice(copied, m.index) + replacement;
    copied = end;
    start.lastIndex = end;
  }
  return out + text.slice(copied);
}

/**
 * The references the placeholders of a text name, in order, as `/<oa-(media|math)\s[^>]*ref\s*=\s*"([^"]*)"/gi` finds them in text the
 * engine wrote.
 */
export function placeholderRefs(text: string): Array<{ kind: "media" | "math"; ref: string }> {
  const found: Array<{ kind: "media" | "math"; ref: string }> = [];
  const start = /<oa-(media|math)\s/gi;
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    const bodyFrom = m.index + m[0].length;
    const stop = nextAngle(text, bodyFrom);
    const ref = refIn(text.slice(bodyFrom, stop === -1 ? text.length : stop), false);
    if (ref !== undefined) found.push({ kind: (m[1] as string).toLowerCase() as "media" | "math", ref });
    if (stop === -1) break;
    start.lastIndex = stop;
  }
  return found;
}
