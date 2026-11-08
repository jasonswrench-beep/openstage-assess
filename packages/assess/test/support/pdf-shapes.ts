/**
 * The shapes a PDF with no usable table of objects can have, written to be read by searching for its objects: a text that looks like the
 * start of an object inside a string, a comment, an uncompressed stream or a dictionary, an object saved twice, a length that is
 * wrong, an object that never closes. Each is written with three tails (a start-of-table that points at nothing, a trailer and no
 * start-of-table, and nothing), so that the objects are always found by searching.
 *
 * They were made by the reader who found that the first fix for objects that never close cut an object at the next text that looks like
 * `N G obj`, wherever it stands, and so lost the end of a page dictionary that held the words in a string (31 shapes, and fifteen of the
 * ninety-seven files read differently from the release before). A change to how the objects are found is held to what that release read
 * from every one of them (`pdf-reconstruct-parity.test.ts`).
 */

import { deflateSync } from "node:zlib";

const b = (s: string | Buffer): Buffer => (Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1"));

interface Item {
  num?: number;
  /** The body of an object. */
  text?: string;
  /** Text written as it is, which is not an object. */
  raw?: string;
  /** A stream's bytes, and the entries of its dictionary, and the length it declares (the right one by default). */
  data?: string | Buffer;
  dict?: string;
  len?: number | string;
}

const DEFAULT_TAIL = "trailer\n<< /Root 1 0 R /Size 99 >>\nstartxref\n7\n%%EOF\n";

function assemble(items: Item[], tail = DEFAULT_TAIL): Buffer {
  const parts: Buffer[] = [b("%PDF-1.5\n")];
  for (const it of items) {
    if (it.raw !== undefined) parts.push(b(it.raw));
    else if (it.data !== undefined) {
      const data = b(it.data);
      parts.push(Buffer.concat([b(`${it.num} 0 obj\n<< ${it.dict ?? ""} /Length ${it.len ?? data.length} >>\nstream\n`), data, b("\nendstream\nendobj\n")]));
    } else parts.push(b(`${it.num} 0 obj\n${it.text}\nendobj\n`));
  }
  parts.push(b(tail));
  return Buffer.concat(parts);
}

const cat: Item = { num: 1, text: "<< /Type /Catalog /Pages 2 0 R >>" };
const pages: Item = { num: 2, text: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" };
const page = (extra = ""): Item => ({ num: 3, text: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${extra} >>` });
const font: Item = { num: 5, text: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" };
const content = (t: string): string => `BT /F1 12 Tf 72 700 Td (${t}) Tj ET\nBT /F1 12 Tf 72 680 Td (A. Option one) Tj ET\nBT /F1 12 Tf 72 660 Td (B. Option two) Tj ET\n`;

const S: Record<string, Item[]> = {};
S.base = [cat, pages, page(), { num: 4, data: content("1. Plain question?") }, font];
// A start of an object inside an uncompressed stream: the number of a real object after it, before it, one that does not exist, and each of the objects in turn.
S.fake_font_after = [cat, pages, page(), { num: 4, data: content("1. See 5 0 obj in the text?") }, font];
S.fake_font_before = [cat, pages, page(), font, { num: 4, data: content("1. See 5 0 obj in text") }];
S.fake_novel = [cat, pages, page(), { num: 4, data: content("1. The 99 0 obj word?") }, font];
S.fake_catalog = [cat, pages, page(), { num: 4, data: content("1. What is 1 0 obj?") }, font];
S.fake_pages = [cat, pages, page(), { num: 4, data: content("1. What is 2 0 obj?") }, font];
S.fake_page = [cat, pages, page(), { num: 4, data: content("1. What is 3 0 obj?") }, font];
S.fake_self = [cat, pages, page(), { num: 4, data: content("1. What is 4 0 obj?") }, font];
// In a string of a dictionary, before the entry that matters.
S.dict_string_before_contents = [
  cat,
  pages,
  { num: 3, text: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Title (see 9 0 obj here) /Contents 4 0 R >>" },
  { num: 4, data: content("1. dict string") },
  font,
];
S.catalog_string_before_pages = [{ num: 1, text: "<< /Type /Catalog /Lang (a 9 0 obj b) /Pages 2 0 R >>" }, pages, page(), { num: 4, data: content("1. catalog string") }, font];
S.stream_dict_string = [cat, pages, page(), { num: 4, dict: "/Subject (see 9 0 obj here)", data: content("1. stream dict string") }, font];
S.stream_dict_string_after_filter = [
  cat,
  pages,
  page(),
  { num: 4, dict: "/Filter /FlateDecode /Subject (a 9 0 obj b)", data: deflateSync(Buffer.from(content("1. stream dict string flate"))) },
  font,
];
// A length that is a reference, a wrong one, a short one.
S.len_indirect_later = [cat, pages, page(), { num: 4, dict: "", data: content("1. indirect length?"), len: "6 0 R" }, font, { num: 6, text: String(Buffer.byteLength(content("1. indirect length?"))) }];
S.len_indirect_wrong = [cat, pages, page(), { num: 4, dict: "", data: content("1. indirect length wrong?"), len: "6 0 R" }, font, { num: 6, text: "5" }];
S.len_wrong_fake = [cat, pages, page(), { num: 4, data: content("1. wrong length with 77 0 obj fake?"), len: 9999 }, font];
S.len_short_fake = [cat, pages, page(), { num: 4, data: content("1. short length with 77 0 obj fake?"), len: 5 }, font];
// Comments between objects, with the words of an object start in them.
S.comments = [cat, { raw: "% 2 0 obj comment\n" }, pages, { raw: "%comment 8 0 obj\n" }, page(), { num: 4, data: content("1. comments") }, font];
// A file saved over: an object twice.
S.update_twice = [cat, pages, page(), { num: 4, data: content("1. OLD version") }, font, { num: 4, data: content("1. NEW version") }];
S.update_twice_page = [
  cat,
  pages,
  page(),
  { num: 4, data: content("1. content a") },
  font,
  { num: 3, text: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>" },
  { num: 6, data: content("1. content b (updated)") },
];
// The word trailer in a stream and in a string.
S.trailer_in_stream = [cat, pages, page(), { num: 4, data: content("1. trailer << /Root 9 0 R >> text") }, font];
S.trailer_in_string = [cat, pages, page("/Foo (trailer << /Root 9 0 R >>)"), { num: 4, data: content("1. trailer string") }, font];
S.two_trailers = [cat, pages, page(), { num: 4, data: content("1. two trailers") }, font];
// Objects after the page that never close.
S.unclosed_junk = [cat, pages, page(), { num: 4, data: content("1. unclosed junk") }, font, { num: 7, text: "[ [ [" }, { num: 8, text: "<< /A [" }];
S.catalog_last = [pages, page(), { num: 4, data: content("1. catalog last") }, font, cat];
S.crlf = [cat, pages, page(), { num: 4, data: content("1. crlf").replace(/\n/g, "\r\n") }, font];
S.binary_in_content = [cat, pages, page(), { num: 4, data: `${content("1. binary")}\n\x00\x01\x02 12 0 obj \xff\xfe\n` }, font];
S.hex_string_dict = [cat, pages, page("/H <4a6f20 37 30 6f626a>"), { num: 4, data: content("1. hex") }, font];
// A comment inside the dictionary of the page tree.
S.comment_in_dict = [cat, { num: 2, text: "<< /Type /Pages\n% 9 0 obj\n/Kids [3 0 R] /Count 1 >>" }, page(), { num: 4, data: content("1. comment in dict") }, font];
S.stream_newline_variants = [cat, pages, page(), { raw: `4 0 obj\n<< /Length 30 >>\nstream\r${content("1. cr only stream")}\nendstream\nendobj\n` }, font];
S.endstream_missing = [cat, pages, page(), { raw: `4 0 obj\n<< /Length 9999 >>\nstream\n${content("1. no endstream and 77 0 obj fake")}\nendobj\n` }, font];
S.multiple_streams_fake_each = [cat, pages, page(), { num: 4, data: content("1. a 10 0 obj b 11 0 obj c") }, font, { num: 10, data: "x" }, { num: 11, data: "y" }];

const TAILS: Array<[string, string]> = [
  ["brk", DEFAULT_TAIL],
  ["none", "trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n"],
  ["notrailer", "%%EOF\n"],
];

export interface Shape {
  name: string;
  bytes: Buffer;
}

/** Every shape with each of its three tails, and four files whose two trailers are damaged in different ways. */
export function pdfShapes(): Shape[] {
  const out: Shape[] = [];
  for (const [name, items] of Object.entries(S)) for (const [tailName, tail] of TAILS) out.push({ name: `${name}__${tailName}`, bytes: assemble(items, tail) });
  const two = S.two_trailers as Item[];
  out.push({ name: "two_trailers__2tr", bytes: assemble(two, "trailer\n<< /Size 3 >>\nstartxref\n0\n%%EOF\n trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n") });
  out.push({ name: "two_trailers__damaged_first", bytes: assemble(two, "trailer\n<< /Size 3 /Root 1 0 R\nstartxref\n0\n%%EOF\n trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n") });
  out.push({ name: "two_trailers__wrongroot_then_right", bytes: assemble(two, "trailer\n<< /Root 9 0 R >>\nstartxref\n0\n%%EOF\ntrailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n") });
  out.push({ name: "two_trailers__deep_first", bytes: assemble(two, "trailer\n<< /Info [[[[ /Root 1 0 R\nstartxref\n0\n%%EOF\ntrailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n") });
  return out;
}
