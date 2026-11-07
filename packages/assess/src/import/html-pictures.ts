/**
 * Pictures in the HTML of an imported question, for the importers whose files carry the picture beside the text (Moodle XML, QTI).
 *
 * The bank keeps a picture only when it can be shown exactly as the author placed it, and tells a picture by its bytes and never by
 * its name (`model/image.ts`): a PNG, JPEG or GIF is kept under a name made from the bytes, with the description the tag gave, and
 * the text points at it. A picture that is linked from another site, is not in the file, is another format or is too large stays
 * where it stood as `[picture]`, with the reason said once for the question, so that the question is flagged
 * (`model/unread-objects.ts`) and not passed as parsed with the figure it depends on gone.
 */

import { createHash } from "node:crypto";

import { MAX_PICTURE_BYTES, sniffImage } from "../model/image.ts";
import type { MediaRef } from "../model/question.ts";
import { decodeEntities } from "../model/richtext.ts";

/** What an importer found when it looked for the file a tag points at. */
export interface FoundPicture {
  /** The file's bytes, when the file was there. */
  bytes?: Uint8Array;
  /** What to call the picture in a message when the tag gave no description. */
  label: string;
  /** Why there are no bytes, in words that follow "because": it is linked from another site, it is not in the file. */
  why?: string;
}

const SHORT = 120;
const quoted = (s: string): string => (s.length > SHORT ? `${s.slice(0, SHORT - 1)}...` : s).replace(/\s+/g, " ").trim();

/** The attributes of a tag, by lower case name, with their character references undone. */
export function tagAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(/([a-zA-Z][-a-zA-Z0-9:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.set((m[1] as string).toLowerCase(), decodeEntities(m[2] ?? m[3] ?? ""));
  return attrs;
}

/** The pictures of one question. */
export class PictureKeeper {
  readonly media: MediaRef[] = [];
  private readonly store: Map<string, Uint8Array>;
  private readonly lost: string[] = [];

  /** `store` is where kept pictures go, by the path each has inside a bank: shared by every question of a file. */
  constructor(store: Map<string, Uint8Array>) {
    this.store = store;
  }

  /** Every `<img>` in the HTML, kept or left as `[picture]`. */
  replaceImages(html: string, find: (src: string) => FoundPicture): string {
    return html.replace(/<img\b[^>]*>/gi, (tag) => this.one(tag, find));
  }

  private one(tag: string, find: (src: string) => FoundPicture): string {
    const attrs = tagAttributes(tag);
    const found = find(attrs.get("src") ?? "");
    const alt = (attrs.get("alt") ?? "").trim();
    const info = found.bytes ? sniffImage(found.bytes) : undefined;
    if (found.bytes && info && found.bytes.length <= MAX_PICTURE_BYTES) {
      const file = `media/p-${createHash("sha256").update(found.bytes).digest("hex").slice(0, 16)}.${info.ext}`;
      this.store.set(file, found.bytes);
      const id = `m${this.media.length + 1}`;
      const decorative = alt === "" && /^(presentation|none)$/i.test(attrs.get("role") ?? "");
      this.media.push({ id, file, mime: info.mime, alt, ...(decorative ? { decorative: true } : {}), width: info.width, height: info.height });
      return `<oa-media ref="${id}"></oa-media>`;
    }
    const why = found.why ?? (found.bytes === undefined ? "it is not in the file" : info === undefined ? "it is not a PNG, JPEG or GIF" : "it is larger than a question can hold");
    this.lost.push(`${alt || quoted(found.label) || "a picture"} (${why})`);
    return " [picture] ";
  }

  /** A picture that stood for something else than an `<img>` and could not be kept (an image element of a QTI 1.2 material). */
  lose(label: string, why: string): string {
    this.lost.push(`${quoted(label) || "a picture"} (${why})`);
    return " [picture] ";
  }

  /** What was lost, as one sentence for the question, or none. */
  lostMessage(): string | undefined {
    if (this.lost.length === 0) return undefined;
    return `${this.lost.length === 1 ? "A picture" : `${this.lost.length} pictures`} could not be kept, and stands as [picture] in the text: ${this.lost.map(quoted).join("; ")}.`;
  }
}
