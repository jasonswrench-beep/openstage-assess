/**
 * The QTI importer: the question and test format that learning systems write when a quiz is exported, in the two versions this program
 * also writes, 1.2 and 2.1, as a package (a zip with an `imsmanifest.xml`) or as a bare file. A Common Cartridge package (`.imscc`, which
 * is a zip of the same kind, and is what this program's own Common Cartridge export is and what Canvas names a course export) is read
 * the same way: every XML file in it is looked at, and the files that are not questions are counted.
 *
 * A QTI file states its key, in the scoring and not in the question: in 1.2 a condition says that choosing this label sets SCORE to
 * the whole of the points; in 2.1 a response declaration says what the correct response is, and may carry a mapping of what each
 * value is worth. The rule of the project is the same as for every importer. A key is read only where the file gives one, in a shape
 * this reader knows (the shapes this program writes, and the ones Canvas and the standard's own templates write); a question whose
 * scoring it cannot read is not given a key it guessed, and is kept with its words as an essay that fails. Credit for part of a
 * question that cannot be kept (partial credit on a single answer, an answer worth less than the whole) is said and never turned into
 * a key.
 *
 * Nothing is dropped silently: feedback with nowhere to go, an XML file of the package that is not a question, a picture that is not
 * in the package or not a PNG, JPEG or GIF (it stays as `[picture]` and the question is flagged), an equation (MathML is not turned
 * into LaTeX, so it stays as `[equation]` and the question is flagged) each is reported. A kind this reader does not know (a hotspot,
 * a drag and drop, a calculated question, several blanks with their own drop downs) is kept as an essay with its words. The version
 * is told from the root of each file: `questestinterop` is 1.2, `assessmentItem` is 2.1, and an `assessmentTest` gives the order.
 */

import { unzipSync } from "../container/zip.ts";
import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding, type Severity } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import type { MediaRef, Question, QuestionBody } from "../model/question.ts";
import { escapeHtml, isEmptyRichText, plainToRich, rich, richTextToPlain, sanitizeRichText, type RichText } from "../model/richtext.ts";
import { unreadObjectFindings } from "../model/unread-objects.ts";
import { allText, elements, first, parseXml, XmlError, type XmlElement, type XmlNode } from "./docx/xml.ts";
import { PictureKeeper, type FoundPicture } from "./html-pictures.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const QTI_PROFILE_ID = "qti";

/** The most XML files of a package that are read, and the most items. A zip holds at most 65535 entries, so the first is no limit in practice; both are a guard against a file built to be followed forever. */
const MOST_FILES = 70000;
const MOST_ITEMS = 100000;

const BLANK = "_____";
const SHORT = 120;
const quoted = (s: string): string => (s.length > SHORT ? `${s.slice(0, SHORT - 1)}...` : s).replace(/\s+/g, " ").trim();
const attr = (el: XmlElement | undefined, name: string): string => el?.attrs[name] ?? "";
const NONE: XmlElement = { name: "", attrs: {}, children: [] };

/** Every descendant with this name, in document order. */
function all(el: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (e: XmlElement): void => {
    for (const c of elements(e)) {
      if (c.name === name) found.push(c);
      walk(c);
    }
  };
  walk(el);
  return found;
}

const modelTags = (html: string): string => html.replace(/<(\/?)b(?=[\s>/])/gi, "<$1strong").replace(/<(\/?)i(?=[\s>/])/gi, "<$1em");
const BLOCK = /<(p|ul|ol|table|pre|blockquote)[\s>/]/i;

/** A file's XML as text, for showing beside its question. Attributes are in the order they were read. */
function serialize(el: XmlElement, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`).join("");
  const kids = el.children;
  if (kids.length === 0) return [`${pad}<${el.name}${attrs}/>`];
  if (kids.every((k) => typeof k === "string")) return [`${pad}<${el.name}${attrs}>${(kids as string[]).join("").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</${el.name}>`];
  const lines = [`${pad}<${el.name}${attrs}>`];
  for (const k of kids) {
    if (typeof k === "string") {
      if (k.trim() !== "") lines.push(`${pad}  ${k.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;")}`);
    } else lines.push(...serialize(k, depth + 1));
  }
  lines.push(`${pad}</${el.name}>`);
  return lines;
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

interface Doc {
  path: string;
  root: XmlElement;
}

const parts = (path: string): string[] => path.split("/").filter((p) => p !== "" && p !== ".");

/** A path with its `..` and `.` resolved, or undefined if it climbs out of the package. */
function normalize(path: string): string | undefined {
  const out: string[] = [];
  for (const p of parts(path)) {
    if (p === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

/** Where a picture a question points at is, in the package: beside the file that holds the question, or as the cartridge's file base says. */
function resolver(docPath: string, files: ReadonlyMap<string, Uint8Array>): (src: string) => FoundPicture {
  const dir = parts(docPath).slice(0, -1).join("/");
  const lower = new Map<string, string>();
  for (const name of files.keys()) lower.set(name.toLowerCase(), name);
  return (src) => {
    if (src.trim() === "") return { label: "", why: "it has no address" };
    if (/^data:/i.test(src)) return { label: "an inline picture", why: "it is written into the page and not stored as a file" };
    if (/^(https?:)?\/\//i.test(src)) return { label: src, why: "it is linked from another site, and a bank holds only pictures that are in the file" };
    let path = src.split(/[?#]/)[0] as string;
    try {
      path = decodeURIComponent(path);
    } catch {
      // a name with a stray percent sign is looked for as it is written
    }
    path = path.replace(/^\$IMS-CC-FILEBASE\$\//i, "web_resources/");
    const candidates = [normalize(dir === "" ? path : `${dir}/${path}`), normalize(path), normalize(`web_resources/${path}`)].filter((c): c is string => c !== undefined);
    for (const c of candidates) {
      const hit = files.has(c) ? c : lower.get(c.toLowerCase());
      if (hit !== undefined) return { bytes: files.get(hit) as Uint8Array, label: hit };
    }
    return { label: path, why: `the package does not hold a file named ${quoted(path)}` };
  };
}

// ---------------------------------------------------------------------------
// One item at a time
// ---------------------------------------------------------------------------

interface Context {
  file: string;
  at: string;
  author: string;
  media: Map<string, Uint8Array>;
  defaultPoints: number;
  files: ReadonlyMap<string, Uint8Array>;
}

/** The state of one question while it is read: its pictures, what it says about itself, the markup taken out. */
class ItemReader {
  readonly findings: Finding[] = [];
  readonly removed = new Set<string>();
  readonly pictures: PictureKeeper;
  private readonly find: (src: string) => FoundPicture;

  constructor(ctx: Context, docPath: string) {
    this.pictures = new PictureKeeper(ctx.media);
    this.find = resolver(docPath, ctx.files);
  }

  get media(): MediaRef[] {
    return this.pictures.media;
  }

  note(code: string, severity: Severity, message: string): void {
    this.findings.push(finding(code, severity, message));
  }

  dropped(what: string, value: string): void {
    this.note(FindingCode.UnreadContent, "warn", `${what} was not read: "${quoted(value)}".`);
  }

  /** HTML as rich text, with its pictures kept or left as [picture]. Undefined when it holds nothing. */
  html(raw: string): RichText | undefined {
    if (raw.trim() === "") return undefined;
    const html = modelTags(this.pictures.replaceImages(raw, this.find));
    // A div or a span only wraps words, so taking it out loses nothing worth a note.
    for (const tag of sanitizeRichText(html).removedTags) if (tag !== "div" && tag !== "span") this.removed.add(tag);
    const text = rich(BLOCK.test(html) ? html : `<p>${html}</p>`);
    return isEmptyRichText(text) ? undefined : text;
  }

  plainText(raw: string): RichText | undefined {
    return raw.trim() === "" ? undefined : plainToRich(raw.trim());
  }

  /** A string of the right side of a pair, a label, a title: words only. */
  words(text: RichText | undefined): string {
    return text ? richTextToPlain(text).replace(/\s+/g, " ").trim() : "";
  }

  finish(): Finding[] {
    const out = [...this.findings];
    const lost = this.pictures.lostMessage();
    if (lost) out.push(finding(FindingCode.UnreadContent, "warn", lost));
    if (this.removed.size > 0) {
      out.push(finding(FindingCode.MarkupRemoved, "info", `Some markup in the text is not one OpenAssess keeps, and was taken out, leaving its words: ${[...this.removed].sort().map((t) => `<${t}>`).join(" ")}.`));
    }
    return out;
  }
}

interface Built {
  question?: Question;
  orphan?: Orphan;
}

interface Pieces {
  title: string;
  stem?: RichText;
  points?: number;
  tag?: string;
  feedback: { general?: RichText; correct?: RichText; incorrect?: RichText };
}

/** What a reader of one version hands the common end: the question as a type and a body, or the reason it cannot be one. */
type Read = { type: Question["type"]; body: QuestionBody } | { unsupported: string };

function create(r: ItemReader, pieces: Pieces, read: Read, source: { file: string; firstBlock: number; lastBlock: number }, ctx: Context): Built {
  const base = {
    stem: pieces.stem ?? plainToRich("(no question text in the source)"),
    ...(pieces.title !== "" ? { title: pieces.title } : {}),
    points: pieces.points !== undefined && pieces.points > 0 ? pieces.points : ctx.defaultPoints,
    by: ctx.author,
    at: ctx.at,
    media: r.media,
    metadata: { status: "draft" as const, tags: pieces.tag ? [pieces.tag] : [] },
    origin: { kind: "import" as const, source, profile: QTI_PROFILE_ID, at: ctx.at },
  };
  const made =
    "unsupported" in read
      ? createQuestion({ ...base, type: "essay", body: {}, findings: [...r.finish(), finding(FindingCode.UnsupportedType, "error", `${read.unsupported} The question's text is kept, as an essay, so that nothing in it is lost.`)] })
      : createQuestion({ ...base, type: read.type, body: read.body, feedback: pieces.feedback, findings: r.finish() });
  return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
}

// ---------------------------------------------------------------------------
// QTI 1.2
// ---------------------------------------------------------------------------

type Expr = { kind: "equal"; resp: string; value: string; caseSensitive: boolean } | { kind: "and" | "or"; parts: Expr[] } | { kind: "not"; part: Expr } | { kind: "other" } | { kind: "unknown"; name: string };

function expr12(el: XmlElement): Expr {
  switch (el.name) {
    case "varequal":
      return { kind: "equal", resp: attr(el, "respident"), value: allText(el).trim(), caseSensitive: attr(el, "case") === "Yes" };
    case "and":
    case "or":
      return { kind: el.name, parts: elements(el).map(expr12) };
    case "not":
      return { kind: "not", part: expr12(elements(el)[0] ?? NONE) };
    case "other":
      return { kind: "other" };
    default:
      return { kind: "unknown", name: el.name };
  }
}

interface Condition12 {
  expr: Expr;
  action: "Set" | "Add" | undefined;
  amount: number;
  feedback: string[];
}

function conditions12(item: XmlElement): { list: Condition12[]; max: number; unreadable: number } {
  const processing = first(item, "resprocessing");
  const list: Condition12[] = [];
  let unreadable = 0;
  for (const c of elements(processing ?? NONE, "respcondition")) {
    const vars = first(c, "conditionvar");
    const sets = elements(c, "setvar");
    const set = sets.find((s) => attr(s, "varname") === "SCORE") ?? sets[0];
    if (!vars || elements(vars).length === 0) {
      unreadable++;
      continue;
    }
    const parts = elements(vars).map(expr12);
    const expr: Expr = parts.length === 1 ? (parts[0] as Expr) : { kind: "and", parts };
    const amount = set ? Number(allText(set).trim()) : 0;
    const action = set ? (attr(set, "action") === "Add" ? "Add" : "Set") : undefined;
    list.push({ expr, action, amount: Number.isFinite(amount) ? amount : 0, feedback: elements(c, "displayfeedback").map((d) => attr(d, "linkrefid")) });
  }
  const decvar = all(processing ?? NONE, "decvar")[0];
  const declared = Number(attr(decvar, "maxvalue"));
  const biggest = Math.max(0, ...list.map((c) => c.amount));
  // A file that declares no scale (Brightspace's does not): scores of 100 or more are on the usual 0 to 100 scale, and a biggest of
  // exactly 1 is on a 0 to 1 scale. Any other biggest (50, 5) might be part of a whole that is not written down, so the whole is
  // taken to be 100 and nothing smaller reads as the key, rather than the biggest being called whole because it is the biggest.
  const assumed = biggest >= 100 || biggest === 1 ? biggest : 100;
  return { list, max: Number.isFinite(declared) && declared > 0 ? declared : assumed, unreadable };
}

const isWhole = (amount: number, max: number): boolean => max > 0 && amount >= max * 0.9999;

/** The flat parts of a condition: the choices it asks for and the ones it asks not to have. */
function flat(e: Expr): { yes: Array<Extract<Expr, { kind: "equal" }>>; no: Array<Extract<Expr, { kind: "equal" }>>; plain: boolean } {
  if (e.kind === "equal") return { yes: [e], no: [], plain: true };
  if (e.kind === "and") {
    const yes: Array<Extract<Expr, { kind: "equal" }>> = [];
    const no: Array<Extract<Expr, { kind: "equal" }>> = [];
    let plain = true;
    for (const p of e.parts) {
      if (p.kind === "equal") yes.push(p);
      else if (p.kind === "not" && p.part.kind === "equal") no.push(p.part);
      else plain = false;
    }
    return { yes, no, plain };
  }
  return { yes: [], no: [], plain: false };
}

/** Text of a QTI 1.2 `material`: its text parts (html or plain) and the pictures it names. */
function material12(r: ItemReader, m: XmlElement | undefined): RichText | undefined {
  if (!m) return undefined;
  let html = "";
  for (const part of elements(m)) {
    if (part.name === "mattext") {
      const text = allText(part);
      html += attr(part, "texttype") === "text/html" ? text : escapeHtml(text).replace(/\r?\n/g, "<br>");
    } else if (part.name === "matimage") {
      html += `<img src="${escapeHtml(attr(part, "uri"))}" alt="${escapeHtml(attr(part, "label"))}">`;
    } else if (part.name === "matbreak") html += "<br>";
    else if (part.name !== "altmaterial") html += r.pictures.lose(part.name, "this kind of material is not read");
  }
  return r.html(html);
}

const CANVAS_UNSUPPORTED: Record<string, string> = {
  fill_in_multiple_blanks_question: "A fill in several blanks question is not read.",
  multiple_dropdowns_question: "A question with several drop down lists is not read.",
  numerical_question: "A numerical question is not read.",
  calculated_question: "A calculated question is not read.",
  file_upload_question: "A file upload question is not read.",
  text_only_question: "A text only entry is not a question.",
};

function item12(item: XmlElement, tag: string | undefined, source: { file: string; firstBlock: number; lastBlock: number }, ctx: Context, docPath: string): Built {
  const r = new ItemReader(ctx, docPath);
  // The field is `qtimetadatafield` in QTI 1.2 and Canvas's files, and `qti_metadatafield` in Brightspace's.
  const meta = new Map([...all(item, "qtimetadatafield"), ...all(item, "qti_metadatafield")].map((f) => [allText(first(f, "fieldlabel") ?? NONE).trim(), allText(first(f, "fieldentry") ?? NONE).trim()] as const));
  const presentation = first(item, "presentation") ?? NONE;
  // Canvas writes an item's points as `points_possible`; Common Cartridge fixes the score of a right answer at 100 and says what the
  // item is worth in `cc_weighting`, so reading the score would call every question 100 points.
  // Brightspace writes it as `qmd_weighting` ("1.0000"), in a file that is its own question library export.
  const pointsRaw = Number(meta.get("points_possible") ?? meta.get("cc_weighting") ?? meta.get("qmd_weighting"));
  const pieces: Pieces = {
    title: attr(item, "title").replace(/\s+/g, " ").trim(),
    stem: material12(r, first(presentation, "material") ?? all(presentation, "material")[0]),
    ...(Number.isFinite(pointsRaw) && pointsRaw > 0 ? { points: pointsRaw } : {}),
    ...(tag ? { tag } : {}),
    feedback: {},
  };
  if (pieces.title === "" || /^question$/i.test(pieces.title)) pieces.title = "";
  // A title that is only the first words of the question, cut where a field ran out (Brightspace's library does it at about twenty
  // characters), is left out, and the question is titled from its own words as any other is.
  const stemWords = r.words(pieces.stem);
  if (pieces.title !== "" && pieces.title.length < stemWords.length && stemWords.toLowerCase().startsWith(pieces.title.toLowerCase())) pieces.title = "";
  // A hint has nowhere to go, so its words are said.
  const hint = first(item, "hint");
  const hintWords = hint ? allText(hint).replace(/\s+/g, " ").trim() : "";
  if (hintWords !== "") r.dropped("A hint", hintWords);

  // Feedback: the entries Canvas names, by identifier. One for a single answer is kept with the answer.
  const fb = new Map<string, RichText>();
  for (const f of elements(item, "itemfeedback")) {
    const text = material12(r, all(f, "material")[0]);
    if (text) fb.set(attr(f, "ident"), text);
  }
  if (fb.has("general_fb")) pieces.feedback.general = fb.get("general_fb") as RichText;
  if (fb.has("correct_fb")) pieces.feedback.correct = fb.get("correct_fb") as RichText;
  if (fb.has("general_incorrect_fb")) pieces.feedback.incorrect = fb.get("general_incorrect_fb") as RichText;
  const usedFeedback = new Set(["general_fb", "correct_fb", "general_incorrect_fb"]);

  const done = (read: Read): Built => {
    for (const [id, text] of fb) if (!usedFeedback.has(id)) r.dropped(`Feedback "${id}"`, r.words(text));
    return create(r, pieces, read, source, ctx);
  };
  const unsupported = (why: string): Built => {
    // The words of the answers are kept with the stem, so that nothing the question said is lost.
    const labels = all(presentation, "response_label").map((l) => r.words(material12(r, first(l, "material") ?? all(l, "material")[0]))).filter((t) => t !== "");
    if (labels.length > 0 && pieces.stem) pieces.stem = rich(`${pieces.stem.content}<ul>${labels.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`);
    return done({ unsupported: why });
  };

  const kind = meta.get("question_type") ?? "";
  if (CANVAS_UNSUPPORTED[kind]) return unsupported(CANVAS_UNSUPPORTED[kind] as string);

  const lids = all(presentation, "response_lid");
  const strs = all(presentation, "response_str");
  const scoring = conditions12(item);
  const { list, max } = scoring;
  if (lids.length + strs.length === 0) return unsupported("It has no response to read an answer from.");

  // An answer's words are in its `material`, which Brightspace nests inside a `flow_mat`.
  const materialOf = (e: XmlElement): XmlElement | undefined => first(e, "material") ?? all(e, "material")[0];
  const labelsOf = (lid: XmlElement): Array<{ id: string; text: RichText | undefined }> => all(lid, "response_label").map((l) => ({ id: attr(l, "ident"), text: material12(r, materialOf(l)) }));

  // Conditions that set a score above nothing and that no rule below reads are said, so that a question scored in a way this
  // does not understand is never passed as read.
  const claimed = new Set<Condition12>();
  const rest = (): void => {
    const missed = list.filter((c) => !claimed.has(c) && c.amount > 0);
    if (missed.length > 0 || scoring.unreadable > 0) {
      r.note(FindingCode.UnreadContent, "warn", `${missed.length + scoring.unreadable === 1 ? "A scoring rule" : `${missed.length + scoring.unreadable} scoring rules`} of this question ${missed.length + scoring.unreadable === 1 ? "was" : "were"} not read, so the key below is only what the rules this reader understands give.`);
    }
  };

  // ---- one choice list, one answer or several
  if (lids.length === 1 && strs.length === 0) {
    const lid = lids[0] as XmlElement;
    const resp = attr(lid, "ident");
    // Brightspace writes a multiple choice question, and a true or false one, with `rcardinality="Multiple"` and says what it is in
    // `qmd_questiontype`; the type is what it says, and one answer is the answer, scored on its own.
    const single = ["multiple choice", "true/false"].includes((meta.get("qmd_questiontype") ?? "").toLowerCase());
    const multiple = attr(lid, "rcardinality") === "Multiple" && !single;
    const labels = labelsOf(lid);
    if (labels.length < 2) return unsupported("A choice question needs at least two answers.");
    const right = new Set<string>();
    let partial = false;
    let allOrNothing = false;
    for (const c of list) {
      const f = flat(c.expr);
      if (!f.plain || f.yes.some((y) => y.resp !== resp) || f.no.some((n) => n.resp !== resp)) continue;
      if (!multiple) {
        if (f.yes.length === 1 && f.no.length === 0 && c.amount > 0) {
          claimed.add(c);
          if (isWhole(c.amount, max)) right.add((f.yes[0] as { value: string }).value);
          else r.note(FindingCode.WeightsNotKept, "warn", `The answer "${quoted(r.words(labels.find((l) => l.id === (f.yes[0] as { value: string }).value)?.text))}" is worth part of the points. Partial credit for a single answer question is not kept: it is read as wrong.`);
        }
      } else if (f.yes.length >= 1 && f.no.length >= 1 && isWhole(c.amount, max)) {
        // Every right answer chosen and no wrong one: the shape Canvas writes, and this program.
        claimed.add(c);
        for (const y of f.yes) right.add(y.value);
        allOrNothing = true;
      } else if (f.yes.length === 1 && f.no.length === 0 && c.action === "Add" && c.amount > 0) {
        claimed.add(c);
        right.add((f.yes[0] as { value: string }).value);
        partial = true;
      } else if (f.yes.length >= 2 && f.no.length === 0 && isWhole(c.amount, max)) {
        claimed.add(c);
        for (const y of f.yes) right.add(y.value);
        allOrNothing = true;
      }
    }
    // Feedback on an answer: Canvas names it `<answer>_fb`; Brightspace names it in the condition that scores the answer
    // (`displayfeedback linkrefid`), and the entry is found by that name. The three Canvas general entries are not an answer's.
    const feedbackOf = (id: string): { name: string; text: RichText } | undefined => {
      const own = fb.get(`${id}_fb`);
      if (own) return { name: `${id}_fb`, text: own };
      for (const c of list) {
        const f = flat(c.expr);
        if (!f.plain || f.yes.length !== 1 || f.no.length !== 0 || (f.yes[0] as { value: string }).value !== id) continue;
        for (const ref of c.feedback) {
          const text = fb.get(ref);
          if (text && !usedFeedback.has(ref)) return { name: ref, text };
        }
      }
      return undefined;
    };
    const options = labels.map((l, i) => {
      const text = l.text ?? plainToRich("(missing)");
      const found = feedbackOf(l.id);
      const f = found?.text;
      if (found) usedFeedback.add(found.name);
      return { id: localId("o", i), content: text, correct: right.has(l.id), ...(f ? { feedback: f } : {}), empty: l.text === undefined };
    });
    if (options.some((o) => o.empty)) r.note(FindingCode.EmptyOption, "error", "An answer has no text. It is kept as (missing), and the question needs fixing.");
    const unknown = [...right].filter((v) => !labels.some((l) => l.id === v));
    if (unknown.length > 0) r.note(FindingCode.UnreadContent, "warn", `The scoring names an answer the question does not offer (${unknown.map(quoted).join(", ")}). It is not read as a key.`);
    const clean = options.map(({ empty: _empty, ...o }) => o);
    rest();
    // "No" in Canvas's files, "no" in Brightspace's; the standard's own values are Yes and No.
    const shuffle = attr(first(lid, "render_choice"), "shuffle").toLowerCase() !== "no";
    if (!multiple) {
      const names = labels.map((l) => r.words(l.text).toLowerCase());
      if (labels.length === 2 && names.includes("true") && names.includes("false")) {
        const yes = right.has((labels[names.indexOf("true")] as { id: string }).id);
        const no = right.has((labels[names.indexOf("false")] as { id: string }).id);
        if (yes === no) r.note(FindingCode.UnreadContent, "warn", yes ? "Both true and false are scored as right. Neither is read as the key." : "Neither true nor false is scored as right. Nothing was guessed.");
        return done({ type: "trueFalse", body: yes !== no ? { correct: yes } : {} });
      }
      if (right.size === 0) r.note(FindingCode.UnreadContent, "warn", "No answer is scored as the whole of the points, so no answer is read as the key. Nothing was guessed.");
      else if (right.size > 1) r.note(FindingCode.MoreThanOneRight, "warn", `${right.size} answers are each scored as the whole of the points, and a single answer question has one right answer. Every one is marked right as the file has it, and the question needs fixing.`);
      return done({ type: "multipleChoice", body: { shuffle, options: clean } });
    }
    if (right.size === 0) r.note(FindingCode.UnreadContent, "warn", "No answer is scored as right, so none is read as the key. Nothing was guessed.");
    if (partial && allOrNothing) r.note(FindingCode.WeightsNotKept, "warn", "This question is scored both as shared credit and as all or nothing. It is read as shared credit, and the weights are not kept.");
    return done({ type: "multipleResponse", body: { shuffle, partialCredit: partial, options: clean } });
  }

  // ---- a text box: short answer, or an essay when nothing is scored
  if (strs.length === 1 && lids.length === 0) {
    const resp = attr(strs[0] as XmlElement, "ident");
    const accepted: string[] = [];
    const cases: boolean[] = [];
    for (const c of list) {
      const f = flat(c.expr);
      const ors = c.expr.kind === "or" ? c.expr.parts.filter((p): p is Extract<Expr, { kind: "equal" }> => p.kind === "equal") : [];
      const equals = ors.length > 0 ? ors : f.plain && f.no.length === 0 ? f.yes : [];
      if (equals.length === 0 || equals.some((e) => e.resp !== resp)) continue;
      claimed.add(c);
      if (isWhole(c.amount, max)) {
        for (const e of equals) {
          if (e.value !== "" && !accepted.includes(e.value)) {
            accepted.push(e.value);
            cases.push(e.caseSensitive);
          }
        }
      } else if (c.amount > 0) {
        r.note(FindingCode.UnreadContent, "warn", `The answer "${quoted(equals.map((e) => e.value).join(", "))}" is worth part of the points, which is partial credit. It was not read as an accepted answer, and nothing was guessed about it.`);
      }
    }
    rest();
    // Nothing scored by what is typed is an essay, marked by hand. A question that says it is a short answer, or that has a rule that
    // scores something, is a short answer with no accepted answer, which is flagged for it.
    if (accepted.length === 0 && kind !== "short_answer_question" && list.every((c) => c.amount <= 0 || c.expr.kind === "other")) {
      return done({ type: "essay", body: {} });
    }
    const caseSensitive = cases.length > 0 && cases.every(Boolean);
    if (cases.some(Boolean) && !caseSensitive) r.note(FindingCode.UnreadContent, "warn", "Some accepted answers count case and some do not. The question is read as not counting case.");
    return done({ type: "shortAnswer", body: { caseSensitive, accepted } });
  }

  // ---- matching: a response for each left side, each offering the right sides
  if (lids.length >= 2 && strs.length === 0 && lids.every((l) => attr(l, "rcardinality") !== "Multiple")) {
    const pairs: Array<{ left: RichText; right: string }> = [];
    const rights: string[] = [];
    let problem: string | undefined;
    for (const lid of lids) {
      const resp = attr(lid, "ident");
      const labels = labelsOf(lid);
      for (const l of labels) {
        const t = r.words(l.text);
        if (t !== "" && !rights.includes(t)) rights.push(t);
      }
      const hits = new Set<string>();
      for (const c of list) {
        const f = flat(c.expr);
        if (f.plain && f.yes.length === 1 && f.no.length === 0 && (f.yes[0] as { resp: string }).resp === resp && c.amount > 0) {
          claimed.add(c);
          hits.add((f.yes[0] as { value: string }).value);
        }
      }
      const left = material12(r, first(lid, "material") ?? NONE);
      if (hits.size !== 1 || !left) {
        problem = !left ? "A left side has no text." : hits.size === 0 ? "A left side has no right match in the scoring." : "A left side is scored as matching more than one right side.";
        break;
      }
      const label = labels.find((l) => l.id === [...hits][0]);
      const text = r.words(label?.text);
      if (text === "") {
        problem = "A match names a right side the question does not offer.";
        break;
      }
      pairs.push({ left, right: text });
    }
    if (problem || pairs.length < 2) return unsupported(`${problem ?? "A matching question needs at least two pairs."} The pairs cannot be read without guessing.`);
    rest();
    const used = new Set(pairs.map((p) => p.right));
    return done({ type: "matching", body: { shuffle: true, distractors: rights.filter((t) => !used.has(t)), pairs: pairs.map((p, i) => ({ id: localId("p", i), left: p.left, right: p.right })) } });
  }

  return unsupported("The shape of this question (its responses) is not one this reader knows.");
}

// ---------------------------------------------------------------------------
// QTI 2.1
// ---------------------------------------------------------------------------

interface Declaration {
  id: string;
  cardinality: string;
  baseType: string;
  correct: string[];
  mapping?: { dflt: number; entries: Array<{ key: string; value: number; caseSensitive: boolean }> };
}

function declarations(root: XmlElement): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const d of elements(root, "responseDeclaration")) {
    const mapping = first(d, "mapping");
    out.set(attr(d, "identifier"), {
      id: attr(d, "identifier"),
      cardinality: attr(d, "cardinality"),
      baseType: attr(d, "baseType"),
      correct: elements(first(d, "correctResponse") ?? NONE, "value").map((v) => allText(v).trim()),
      ...(mapping
        ? { mapping: { dflt: Number(attr(mapping, "defaultValue") || 0), entries: elements(mapping, "mapEntry").map((e) => ({ key: attr(e, "mapKey"), value: Number(attr(e, "mappedValue")), caseSensitive: attr(e, "caseSensitive") !== "false" })) } }
        : {}),
    });
  }
  return out;
}

const INTERACTIONS = ["choiceInteraction", "textEntryInteraction", "extendedTextInteraction", "matchInteraction", "orderInteraction"];
const OTHER_INTERACTIONS = ["inlineChoiceInteraction", "associateInteraction", "gapMatchInteraction", "hottextInteraction", "hotspotInteraction", "graphicOrderInteraction", "graphicAssociateInteraction", "graphicGapMatchInteraction", "selectPointInteraction", "positionObjectInteraction", "sliderInteraction", "mediaInteraction", "drawingInteraction", "uploadInteraction", "customInteraction", "endAttemptInteraction"];

function item21(root: XmlElement, tag: string | undefined, source: { file: string; firstBlock: number; lastBlock: number }, ctx: Context, docPath: string): Built {
  const r = new ItemReader(ctx, docPath);
  const decls = declarations(root);
  const body = first(root, "itemBody") ?? NONE;
  const score = elements(root, "outcomeDeclaration").find((o) => attr(o, "identifier") === "SCORE");
  const maxScore = elements(root, "outcomeDeclaration").find((o) => attr(o, "identifier") === "MAXSCORE");
  const pointsRaw = Number(attr(score, "normalMaximum") || allText(first(maxScore ?? NONE, "defaultValue") ?? NONE).trim());
  const pieces: Pieces = {
    title: attr(root, "title").replace(/\s+/g, " ").trim(),
    ...(Number.isFinite(pointsRaw) && pointsRaw > 0 ? { points: pointsRaw } : {}),
    ...(tag ? { tag } : {}),
    feedback: {},
  };

  const interactions = INTERACTIONS.flatMap((n) => all(body, n));
  const others = OTHER_INTERACTIONS.flatMap((n) => all(body, n));
  const lost = (what: string): string => r.pictures.lose(what, "it is not read");

  // The question's own text: everything in the body except the interaction, with a blank where a text box stood in a sentence.
  const textBoxes: Array<{ id: string; inline: boolean }> = [];
  const html = (nodes: XmlNode[], parent: XmlElement | undefined): string =>
    nodes
      .map((n): string => {
        if (typeof n === "string") return escapeHtml(n);
        if (n.name === "textEntryInteraction") {
          const inline = parent !== undefined && allText(parent).trim() !== "";
          textBoxes.push({ id: attr(n, "responseIdentifier"), inline });
          return inline ? BLANK : "";
        }
        if (INTERACTIONS.includes(n.name)) {
          // A prompt is the question's own words; the choices are read apart.
          const prompt = first(n, "prompt");
          return prompt ? `<p>${html(prompt.children, prompt)}</p>` : "";
        }
        if (n.name === "math") return " [equation] ";
        if (n.name === "br") return "<br>";
        if (n.name === "img") return `<img src="${escapeHtml(attr(n, "src"))}" alt="${escapeHtml(attr(n, "alt"))}"${attr(n, "role") !== "" ? ` role="${escapeHtml(attr(n, "role"))}"` : ""}>`;
        if (n.name === "object" || n.name === "audio" || n.name === "video") return lost(attr(n, "data") || attr(n, "src") || n.name);
        const attrs = Object.entries(n.attrs).filter(([k]) => ["colspan", "rowspan", "scope", "start"].includes(k)).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join("");
        const inner = html(n.children, n);
        // A paragraph that only held the text box has nothing left once the box is read apart.
        if ((n.name === "p" || n.name === "div") && inner.trim() === "") return "";
        return `<${n.name}${attrs}>${inner}</${n.name}>`;
      })
      .join("");
  const stemHtml = html(body.children, undefined);
  pieces.stem = r.html(stemHtml);

  const modal = elements(root, "modalFeedback");
  const done = (read: Read): Built => {
    for (const m of modal) {
      const words = r.words(r.html(html(m.children, m)));
      if (words !== "") r.dropped("Feedback that is shown on a condition", words);
    }
    return create(r, pieces, read, source, ctx);
  };
  const unsupported = (why: string): Built => {
    const answers = [...all(body, "simpleChoice"), ...all(body, "simpleAssociableChoice")].map((c) => r.words(r.html(html(c.children, c)))).filter((t) => t !== "");
    if (answers.length > 0 && pieces.stem) pieces.stem = rich(`${pieces.stem.content}<ul>${answers.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`);
    return done({ unsupported: why });
  };

  if (others.length > 0) return unsupported(`A ${others[0]?.name.replace(/Interaction$/, "")} question is not read.`);
  if (interactions.length === 0) return unsupported("It has no interaction to read an answer from.");

  // Scoring: the declared correct response is the key. The processing says only whether credit is shared.
  const processing = first(root, "responseProcessing");
  const template = attr(processing, "template");
  const usesMap = /map_response/.test(template) || all(processing ?? NONE, "mapResponse").length > 0;

  const choiceOf = (el: XmlElement, i: number) => {
    const content = r.html(html(el.children, el));
    return { id: attr(el, "identifier"), content: content ?? plainToRich("(missing)"), empty: content === undefined, fixed: attr(el, "fixed") === "true", index: i };
  };
  const blanksOf = (id: string): string[] => {
    const d = decls.get(id);
    if (!d) return [];
    if (d.mapping) {
      const top = Math.max(0, ...d.mapping.entries.map((e) => e.value));
      const whole = d.mapping.entries.filter((e) => top > 0 && e.value >= top * 0.9999);
      for (const e of d.mapping.entries) {
        if (e.value > 0 && e.value < top * 0.9999) r.note(FindingCode.UnreadContent, "warn", `The answer "${quoted(e.key)}" is worth part of the points, which is partial credit. It was not read as an accepted answer, and nothing was guessed about it.`);
      }
      return whole.map((e) => e.key);
    }
    return d.correct;
  };

  if (interactions.length === 1 && interactions[0]?.name === "choiceInteraction") {
    const ci = interactions[0];
    const id = attr(ci, "responseIdentifier");
    const d = decls.get(id);
    const multiple = d?.cardinality === "multiple" || attr(ci, "maxChoices") === "0" || Number(attr(ci, "maxChoices")) > 1;
    const choices = elements(ci, "simpleChoice").map(choiceOf);
    if (choices.length < 2) return unsupported("A choice question needs at least two answers.");
    let right = new Set(d?.correct ?? []);
    if (right.size === 0 && d?.mapping) right = new Set(d.mapping.entries.filter((e) => e.value > 0).map((e) => e.key));
    const unknown = [...right].filter((v) => !choices.some((c) => c.id === v));
    if (unknown.length > 0) {
      r.note(FindingCode.UnreadContent, "warn", `The declared correct response names an answer the question does not offer (${unknown.map(quoted).join(", ")}). It is not read as a key.`);
      right = new Set([...right].filter((v) => !unknown.includes(v)));
    }
    if (!d || right.size === 0) r.note(FindingCode.UnreadContent, "warn", "The question declares no correct response, so no answer is read as the key. Nothing was guessed.");
    if (choices.some((c) => c.empty)) r.note(FindingCode.EmptyOption, "error", "An answer has no text. It is kept as (missing), and the question needs fixing.");
    if (!processing) r.note(FindingCode.UnreadContent, "info", "The question has no response processing, so the declared correct response is the only scoring it states.");
    const shuffle = attr(ci, "shuffle") === "true";
    const options = choices.map((c) => ({ id: localId("o", c.index), content: c.content, correct: right.has(c.id), ...(shuffle && c.fixed ? { fixedPosition: true } : {}) }));
    if (!multiple) {
      const names = choices.map((c) => r.words(c.content).toLowerCase());
      if (choices.length === 2 && names.includes("true") && names.includes("false")) {
        const yes = right.has((choices[names.indexOf("true")] as { id: string }).id);
        const no = right.has((choices[names.indexOf("false")] as { id: string }).id);
        return done({ type: "trueFalse", body: yes !== no ? { correct: yes } : {} });
      }
      if (right.size > 1) r.note(FindingCode.MoreThanOneRight, "warn", `${right.size} answers are declared right, and a single answer question has one right answer. Every one is marked right as the file has it, and the question needs fixing.`);
      return done({ type: "multipleChoice", body: { shuffle, options } });
    }
    return done({ type: "multipleResponse", body: { shuffle, partialCredit: usesMap && d?.mapping !== undefined, options } });
  }

  if (interactions.every((i) => i.name === "textEntryInteraction")) {
    const ids = interactions.map((i) => attr(i, "responseIdentifier"));
    const sensitive = (id: string): boolean => {
      const entries = decls.get(id)?.mapping?.entries ?? [];
      return entries.length > 0 ? entries.every((e) => e.caseSensitive) : true;
    };
    if (!processing) r.note(FindingCode.UnreadContent, "info", "The question has no response processing, so the declared correct response is the only scoring it states.");
    const inline = textBoxes.some((t) => t.inline);
    if (ids.length === 1 && !inline) {
      const accepted = blanksOf(ids[0] as string);
      return done({ type: "shortAnswer", body: { caseSensitive: sensitive(ids[0] as string), accepted: [...new Set(accepted)] } });
    }
    if (!inline) return unsupported("It has several text boxes and no sentence to put them in.");
    const caseSensitive = ids.every(sensitive);
    return done({ type: "fillInBlank", body: { caseSensitive, blanks: ids.map((id, i) => ({ id: localId("b", i), accepted: [...new Set(blanksOf(id))] })) } });
  }

  if (interactions.length === 1 && interactions[0]?.name === "extendedTextInteraction") {
    return done({ type: "essay", body: {} });
  }

  if (interactions.length === 1 && interactions[0]?.name === "matchInteraction") {
    const mi = interactions[0];
    const d = decls.get(attr(mi, "responseIdentifier"));
    const sets = elements(mi, "simpleMatchSet").map((s) => elements(s, "simpleAssociableChoice"));
    if (sets.length !== 2) return unsupported("A matching question has two lists.");
    const lefts = (sets[0] as XmlElement[]).map((c) => ({ id: attr(c, "identifier"), text: r.html(html(c.children, c)) }));
    const rights = (sets[1] as XmlElement[]).map((c) => ({ id: attr(c, "identifier"), text: r.words(r.html(html(c.children, c))) }));
    const given = d?.correct ?? [];
    const pairs: Array<{ left: RichText; right: string }> = [];
    let problem: string | undefined;
    for (const left of lefts) {
      const hits = given.map((g) => g.split(/\s+/)).filter((g) => g[0] === left.id);
      if (hits.length !== 1 || !left.text) {
        problem = !left.text ? "A left side has no text." : hits.length === 0 ? "A left side has no right match declared." : "A left side is declared as matching more than one right side.";
        break;
      }
      const right = rights.find((x) => x.id === (hits[0] as string[])[1]);
      if (!right || right.text === "") {
        problem = "A match names a right side the question does not offer.";
        break;
      }
      pairs.push({ left: left.text, right: right.text });
    }
    if (problem || pairs.length < 2) return unsupported(`${problem ?? "A matching question needs at least two pairs."} The pairs cannot be read without guessing.`);
    const used = new Set(pairs.map((p) => p.right));
    return done({ type: "matching", body: { shuffle: attr(mi, "shuffle") === "true", distractors: [...new Set(rights.map((x) => x.text).filter((t) => t !== "" && !used.has(t)))], pairs: pairs.map((p, i) => ({ id: localId("p", i), left: p.left, right: p.right })) } });
  }

  if (interactions.length === 1 && interactions[0]?.name === "orderInteraction") {
    const oi = interactions[0];
    const d = decls.get(attr(oi, "responseIdentifier"));
    const choices = elements(oi, "simpleChoice").map(choiceOf);
    const order = d?.correct ?? [];
    if (choices.length < 2 || order.length !== choices.length || new Set(order).size !== order.length || order.some((v) => !choices.some((c) => c.id === v))) {
      return unsupported("The correct order is not declared for every item, so the items cannot be put in order without guessing.");
    }
    return done({ type: "ordering", body: { items: order.map((v, i) => { const c = choices.find((x) => x.id === v) as (typeof choices)[number]; return { id: localId("i", i), content: c.content, position: i + 1 }; }) } });
  }

  return unsupported("The shape of this question (its interactions) is not one this reader knows.");
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Whether text looks like a QTI file: a questestinterop, assessmentItem or assessmentTest root, after any declaration and comments. */
export function looksLikeQtiXml(text: string): boolean {
  const head = text.slice(0, 4000).replace(/^﻿/, "").replace(/^\s*(<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*/, "");
  return /^<(questestinterop|assessmentItem|assessmentTest)[\s>/]/.test(head);
}

interface Found {
  docs: Doc[];
  files: Map<string, Uint8Array>;
  problems: string[];
  /** Files of the package that end in `.qti`. They are not XML by name and are not read, so they are counted and said. */
  unreadQti: number;
}

function gather(bytes: Uint8Array, name: string): Found | { refusal: string } {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const docs: Doc[] = [];
  const problems: string[] = [];
  if (!isZip) {
    try {
      docs.push({ path: name, root: parseXml(Buffer.from(bytes).toString("utf8").replace(/^﻿/, "")) });
    } catch (error) {
      if (error instanceof XmlError) return { refusal: `This file is not well formed XML, so it could not be read as QTI: ${error.message}` };
      throw error;
    }
    return { docs, files: new Map(), problems, unreadQti: 0 };
  }
  let files: Map<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    return { refusal: `This zip file could not be opened: ${(error as Error).message}` };
  }
  const xml = [...files.keys()].filter((n) => n.toLowerCase().endsWith(".xml") && !n.toLowerCase().endsWith("imsmanifest.xml"));
  if (xml.length > MOST_FILES) return { refusal: `This package has ${xml.length} XML files, more than the ${MOST_FILES} this reader follows.` };
  for (const path of xml) {
    try {
      docs.push({ path, root: parseXml(Buffer.from(files.get(path) as Uint8Array).toString("utf8").replace(/^﻿/, "")) });
    } catch (error) {
      if (error instanceof XmlError) problems.push(`${path} is not well formed XML and was not read: ${error.message}`);
      else throw error;
    }
  }
  return { docs, files, problems, unreadQti: [...files.keys()].filter((n) => n.toLowerCase().endsWith(".qti")).length };
}

function readBytes(bytes: Uint8Array, options: ImportOptions): ImportResult {
  const file = options.file ?? "input.zip";
  const ctx: Context = { file, at: options.at ?? new Date().toISOString(), author: options.author ?? "import", media: new Map(), defaultPoints: options.defaultPoints ?? DEFAULT_POINTS, files: new Map() };
  const refuse = (message: string): ImportResult => ({
    profile: options.profile ?? QTI_PROFILE_ID,
    file,
    questions: [],
    orphans: [],
    counts: countVerdicts([], 0),
    fileFindings: [finding(FindingCode.UnreadContent, "error", message)],
  });

  const found = gather(bytes, file);
  if ("refusal" in found) return refuse(found.refusal);
  const readCtx: Context = { ...ctx, files: found.files };
  const fileFindings: Finding[] = found.problems.map((p) => finding(FindingCode.UnreadContent, "warn", p));

  // The items, in the order a test lists them; those no test lists follow, in file order.
  interface Entry {
    version: "1.2" | "2.1";
    doc: Doc;
    el: XmlElement;
    tag?: string;
  }
  const entries: Entry[] = [];
  const byPath = new Map(found.docs.map((d) => [d.path, d] as const));
  const placed = new Set<string>();
  let ignored = 0;
  const title = (el: XmlElement): string | undefined => {
    const t = attr(el, "title").replace(/\s+/g, " ").trim();
    return t !== "" && t.length <= 100 ? t : undefined;
  };
  for (const doc of found.docs.filter((d) => d.root.name === "assessmentTest")) {
    const dir = parts(doc.path).slice(0, -1).join("/");
    for (const ref of all(doc.root, "assessmentItemRef")) {
      const target = normalize(dir === "" ? attr(ref, "href") : `${dir}/${attr(ref, "href")}`);
      const item = target !== undefined ? byPath.get(target) : undefined;
      if (item && item.root.name === "assessmentItem" && !placed.has(item.path)) {
        placed.add(item.path);
        const t = title(doc.root);
        entries.push({ version: "2.1", doc: item, el: item.root, ...(t ? { tag: t } : {}) });
      } else if (!item) fileFindings.push(finding(FindingCode.UnreadContent, "warn", `The test names the item ${quoted(attr(ref, "href"))}, which is not in the package.`));
    }
  }
  for (const doc of found.docs) {
    if (doc.root.name === "questestinterop") {
      const assessments = all(doc.root, "assessment");
      const walk = (e: XmlElement, tag: string | undefined): void => {
        for (const c of elements(e)) {
          if (c.name === "item") entries.push({ version: "1.2", doc, el: c, ...(tag ? { tag } : {}) });
          else walk(c, c.name === "assessment" ? (title(c) ?? tag) : tag);
        }
      };
      walk(doc.root, assessments.length === 1 ? title(assessments[0] as XmlElement) : undefined);
    } else if (doc.root.name === "assessmentItem" && !placed.has(doc.path)) {
      entries.push({ version: "2.1", doc, el: doc.root });
    } else if (doc.root.name !== "assessmentItem" && doc.root.name !== "assessmentTest") ignored++;
  }
  if (entries.length > MOST_ITEMS) return refuse(`This file has ${entries.length} questions, more than the ${MOST_ITEMS} this reader follows.`);

  const lines: string[] = [];
  const questions: Question[] = [];
  const orphans: Orphan[] = [];
  entries.forEach((e) => {
    const own = [`<!-- ${e.doc.path} -->`, ...serialize(e.el)];
    const source = { file, firstBlock: lines.length, lastBlock: lines.length + own.length - 1 };
    lines.push(...own);
    let built: Built;
    try {
      built = e.version === "1.2" ? item12(e.el, e.tag, source, readCtx, e.doc.path) : item21(e.el, e.tag, source, readCtx, e.doc.path);
    } catch {
      // One question that cannot be read must not lose the file. It is kept as the words it holds, and fails.
      const words = allText(e.el).replace(/\s+/g, " ").trim();
      built = {
        question: createQuestion({
          type: "essay",
          stem: plainToRich(words === "" ? "(no question text in the source)" : words),
          body: {},
          by: ctx.author,
          at: ctx.at,
          metadata: { status: "draft", tags: e.tag ? [e.tag] : [] },
          origin: { kind: "import", source, profile: QTI_PROFILE_ID, at: ctx.at },
          findings: [finding(FindingCode.UnsupportedType, "error", "This question could not be read. Its words are kept, as an essay, so that nothing in it is lost.")],
        }),
      };
    }
    if (built.question) questions.push(built.question);
    if (built.orphan) orphans.push(built.orphan);
  });

  // Brightspace keeps a difficulty, a bonus mark and a mandatory mark for each question in `itemproc_extension`. The model has no place
  // for them (a difficulty is a different scale), so they are counted and said once for the file and not for every question.
  const withSettings = entries.filter((e) => e.version === "1.2" && first(e.el, "itemproc_extension") !== undefined).length;
  if (withSettings > 0) fileFindings.push(finding(FindingCode.UnreadContent, "info", `${withSettings === 1 ? "One question carries" : `${withSettings} questions carry`} Brightspace's own settings (difficulty, bonus, mandatory), which are not read.`));
  if (ignored > 0) fileFindings.push(finding(FindingCode.UnreadContent, "info", `${ignored === 1 ? "One XML file" : `${ignored} XML files`} of the package ${ignored === 1 ? "is" : "are"} not questions or a test (settings, course data) and ${ignored === 1 ? "was" : "were"} not read.`));
  // A file that ends in .qti is not looked at, because it is not named as XML and a second copy of a quiz read from it could double the
  // questions. Canvas names some of the files of a course export this way (its question banks are said to be among them), so a bank
  // that lives only there would come in empty; the count is said, and is a warning when nothing else was found.
  if (found.unreadQti > 0) {
    const n = found.unreadQti;
    fileFindings.push(finding(FindingCode.UnreadContent, questions.length === 0 ? "warn" : "info", `${n === 1 ? "One file" : `${n} files`} of the package end${n === 1 ? "s" : ""} in .qti and ${n === 1 ? "was" : "were"} not read, so a question that is only in ${n === 1 ? "it" : "them"} is not here.`));
  }
  if (questions.length === 0) fileFindings.push(finding(FindingCode.UnreadContent, "warn", "No question was found in this file. A QTI file holds item elements (1.2) or assessmentItem files (2.1)."));
  return {
    profile: options.profile ?? QTI_PROFILE_ID,
    file,
    questions,
    orphans,
    counts: countVerdicts(questions, orphans.length),
    fileFindings,
    sourceLines: lines,
    ...(ctx.media.size > 0 ? { media: ctx.media } : {}),
  };
}

export const qtiImporter: Importer = {
  id: QTI_PROFILE_ID,
  label: "QTI (1.2 and 2.1)",
  extensions: [".zip", ".imscc"],

  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = typeof input === "string" ? input : input.map((b) => b.text).join("\n");
    return readBytes(new Uint8Array(Buffer.from(text, "utf8")), { ...options, file: options.file ?? "input.xml" });
  },

  parseBytes(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
    return readBytes(bytes, options);
  },
};
