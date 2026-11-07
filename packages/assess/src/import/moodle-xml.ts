/**
 * The Moodle XML importer: the question format Moodle writes when a question bank is exported, and that publishers and other tools
 * hand to instructors who use it.
 *
 * A file is a `quiz` of `question` elements. Each has a `type`, a name, the text of the question (with any pictures it holds as
 * base64 files beside it), and the answers with a `fraction` that says what each is worth. That is a key written in the file, so
 * it is read as one and never filled in: an answer is the right one only where the file gives it the whole of the points, a
 * question where none does is kept with no key and says so, and weights that cannot be kept (partial credit on a single answer,
 * credit for a wrong answer in a short answer) are reported with the answer they belong to and are not turned into a key.
 *
 * The rules of the project apply to it as to every importer. Nothing is dropped silently: a feedback with nowhere to go, a unit
 * that cannot be kept, a picture that is not a PNG, JPEG or GIF or is linked from elsewhere (it stays as `[picture]` in the
 * text and the question is flagged for it), each is reported with its words. A question that is not one of the types read here
 * (a cloze, a drag and drop, a calculated question, a plugin's) is kept as an essay with its text and marked failed. A
 * description, which is text for students and not a question, is an orphan with the reason. LaTeX between \( and \) stays in the
 * text as the author typed it.
 */

import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding, type Severity } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import type { MediaRef, Question, QuestionBody } from "../model/question.ts";
import { isEmptyRichText, plainToRich, rich, richTextToPlain, sanitizeRichText, type RichText } from "../model/richtext.ts";
import { unreadObjectFindings } from "../model/unread-objects.ts";
import { allText, elements, first, parseXml, XmlError, type XmlElement } from "./docx/xml.ts";
import { PictureKeeper, type FoundPicture } from "./html-pictures.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const MOODLE_XML_PROFILE_ID = "moodle-xml";

/** A weight this close to the whole of the points is the whole of them: Moodle writes 33.33333 for a third and 100 for the rest. */
const WHOLE = 99.99;

const SHORT = 120;
const quoted = (s: string): string => (s.length > SHORT ? `${s.slice(0, SHORT - 1)}...` : s).replace(/\s+/g, " ").trim();

const attr = (el: XmlElement | undefined, name: string): string => el?.attrs[name] ?? "";
const textOf = (el: XmlElement | undefined): string => (el ? allText(el).trim() : "");
const sub = (el: XmlElement, name: string): string => textOf(first(el, name));
const truthy = (s: string): boolean => /^(1|true|yes)$/i.test(s.trim());

/** The tags the model calls bold and italic are strong and em. Moodle's editor writes b and i. */
const modelTags = (html: string): string => html.replace(/<(\/?)b(?=[\s>/])/gi, "<$1strong").replace(/<(\/?)i(?=[\s>/])/gi, "<$1em");

const BLOCK = /<(p|ul|ol|table|pre|blockquote)[\s>/]/i;

/** Where the questions of a file stand in its own text, for showing beside each one. Pictures are not printed: they are long. */
function rawQuestions(source: string): string[] {
  const out: string[] = [];
  const open = /<question(?=[\s>/])/y;
  const close = /<\/question\s*>/y;
  let depth = 0;
  let start = -1;
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      i = end < 0 ? source.length : end + 3;
    } else if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end < 0 ? source.length : end + 3;
    } else if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      i = end < 0 ? source.length : end + 2;
    } else {
      open.lastIndex = lt;
      close.lastIndex = lt;
      if (open.test(source)) {
        if (depth === 0) start = lt;
        depth++;
        const end = source.indexOf(">", lt);
        // A question written as <question .../> holds nothing and is not one that nests.
        if (end > 0 && source[end - 1] === "/") {
          depth--;
          if (depth === 0) out.push(source.slice(start, end + 1));
        }
        i = end < 0 ? source.length : end + 1;
      } else if (close.test(source)) {
        depth--;
        const end = lt + (close.lastIndex - lt);
        if (depth === 0 && start >= 0) out.push(source.slice(start, end));
        if (depth < 0) depth = 0;
        i = end;
      } else i = lt + 1;
    }
  }
  return out.map((q) => q.replace(/(<file\b[^>]*>)([^<]{200,})(<\/file>)/g, (_m, a: string, b: string, c: string) => `${a}[${b.length} characters of picture data]${c}`));
}

/** The sentences Moodle writes into the combined feedback of a question when nothing else is typed, in English, lower case. */
const STOCK = new Set(["your answer is correct.", "your answer is partially correct.", "your answer is incorrect.", "your answer is correct", "your answer is partially correct", "your answer is incorrect"]);

interface Context {
  file: string;
  at: string;
  author: string;
  /** The pictures kept, by the path each has inside a bank. */
  media: Map<string, Uint8Array>;
  defaultPoints: number;
  /** How many of Moodle's standard feedback sentences were left out. */
  stock: number;
}

/** The state of one question while it is read: its pictures, what it says about itself, the markup taken out. */
class Reader {
  private readonly pictures: PictureKeeper;
  readonly findings: Finding[] = [];
  readonly removed = new Set<string>();


  constructor(ctx: Context) {
    this.pictures = new PictureKeeper(ctx.media);
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

  /** Where a Moodle picture is: the file of the same name, beside the text, in the files of the element that holds the text. */
  private finder(files: ReadonlyMap<string, Uint8Array>): (src: string) => FoundPicture {
    return (src) => {
      const named = /^@@PLUGINFILE@@\/(.+)$/.exec(src);
      if (!named) {
        return { label: src, why: /^(https?:)?\/\//i.test(src) ? "it is linked from another site, and a bank holds only pictures that are in the file" : "it does not point at a picture in the file" };
      }
      const bare = (named[1] as string).split(/[?#]/)[0] as string;
      let name = bare;
      try {
        name = decodeURIComponent(bare);
      } catch {
        // a name with a stray percent sign is looked for as it is written
      }
      const bytes = files.get(name);
      return bytes ? { bytes, label: name } : { label: name, why: `the file does not hold a picture named ${quoted(name)}` };
    };
  }

  /** The files an element holds beside its text. */
  private filesOf(container: XmlElement): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    for (const f of elements(container, "file")) {
      if (attr(f, "encoding") !== "base64") continue;
      const bytes = new Uint8Array(Buffer.from(allText(f).replace(/\s+/g, ""), "base64"));
      if (bytes.length > 0) files.set(attr(f, "name"), bytes);
    }
    return files;
  }

  /** The text of an element that holds `<text>` (a question's text, a feedback, an answer) as rich text; undefined when it holds nothing. */
  rich(container: XmlElement | undefined): RichText | undefined {
    if (!container) return undefined;
    const raw = allText(first(container, "text") ?? { name: "", attrs: {}, children: [] }).trim();
    if (raw === "" && elements(container, "file").length === 0) return undefined;
    const format = attr(container, "format") || "moodle_auto_format";
    const markup = format === "html" || (format === "moodle_auto_format" && /<[a-z][^>]*>/i.test(raw));
    if (format === "markdown") this.note(FindingCode.MarkupRemoved, "warn", "A text is marked as Markdown, which was not converted. It is kept as it was written.");
    if (!markup) return raw === "" ? undefined : plainToRich(raw);
    const html = modelTags(this.pictures.replaceImages(raw, this.finder(this.filesOf(container))));
    // A div or a span only wraps words, so taking it out loses nothing worth a note.
    for (const tag of sanitizeRichText(html).removedTags) if (tag !== "div" && tag !== "span") this.removed.add(tag);
    const text = rich(BLOCK.test(html) ? html : `<p>${html}</p>`);
    return isEmptyRichText(text) ? undefined : text;
  }

  /** An element's text as words, for the places that hold no markup (the right side of a pair, a unit). */
  plain(container: XmlElement | undefined): string {
    const text = this.rich(container);
    return text ? richTextToPlain(text).replace(/\s+/g, " ").trim() : "";
  }

  /** What the reading of the question's text and answers has to say, once, at the end. */
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

interface Answer {
  fraction: number;
  el: XmlElement;
}

/** The answers of a question with the weight each carries; a weight that is not a number makes the question unreadable and is said. */
function answersOf(q: XmlElement): { answers: Answer[]; bad?: string } {
  const answers: Answer[] = [];
  for (const el of elements(q, "answer")) {
    const raw = attr(el, "fraction").trim();
    const fraction = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(fraction)) return { answers, bad: `An answer has the weight "${quoted(raw)}", which is not a number.` };
    answers.push({ fraction, el });
  }
  return { answers };
}

/** The category line of Moodle without its context, as a tag. */
const categoryTag = (text: string): string => text.replace(/^\$[a-z]+\$\/(?:top\/)?/i, "").replace(/^top\//i, "").trim();

interface Built {
  question?: Question;
  orphan?: Orphan;
}

function build(q: XmlElement, source: { file: string; firstBlock: number; lastBlock: number }, category: string | undefined, ctx: Context): Built {
  const r = new Reader(ctx);
  const type = attr(q, "type");
  const name = r.plain(first(q, "name"));
  const tags = [...(category ? [category] : []), ...elements(first(q, "tags") ?? { name: "", attrs: {}, children: [] }, "tag").map((t) => textOf(first(t, "text") ?? t)).filter((t) => t !== "")];
  const tagList = [...new Set(tags)];
  const stemText = r.rich(first(q, "questiontext"));
  const points = (() => {
    const grade = Number(sub(q, "defaultgrade"));
    return Number.isFinite(grade) && grade > 0 ? grade : ctx.defaultPoints;
  })();

  if (type === "description") {
    return { orphan: { source, text: stemText ? richTextToPlain(stemText) : name, reason: "This is a description in Moodle: text shown to students, not a question, and a bank has no place for one." } };
  }

  // What every kind keeps: the general feedback, and a right or wrong feedback where the question has them.
  const feedback: { general?: RichText; correct?: RichText; incorrect?: RichText } = {};
  const general = r.rich(first(q, "generalfeedback"));
  if (general) feedback.general = general;
  // Moodle puts its own standard sentences in these three when an author writes nothing, so nearly every question of a real file has
  // them. They say nothing the author wrote, so they are not kept as feedback; the file's findings say how many there were.
  const authored = (name: string): RichText | undefined => {
    const text = r.rich(first(q, name));
    if (text && STOCK.has(richTextToPlain(text).replace(/\s+/g, " ").trim().toLowerCase())) {
      ctx.stock++;
      return undefined;
    }
    return text;
  };
  const correctFb = authored("correctfeedback");
  const incorrectFb = authored("incorrectfeedback");
  if (correctFb) feedback.correct = correctFb;
  if (incorrectFb) feedback.incorrect = incorrectFb;
  const partial = authored("partiallycorrectfeedback");
  if (partial) r.dropped("The feedback for a partly right answer", richTextToPlain(partial));

  const make = (kind: Question["type"], body: QuestionBody, extra: Finding[] = []): Built => {
    const made = createQuestion({
      type: kind,
      stem: stemText ?? plainToRich("(no question text in the source)"),
      body,
      feedback,
      ...(name !== "" ? { title: name } : {}),
      points,
      by: ctx.author,
      at: ctx.at,
      media: r.media,
      metadata: { status: "draft", tags: tagList },
      origin: { kind: "import", source, profile: MOODLE_XML_PROFILE_ID, at: ctx.at },
      findings: [...extra, ...r.finish()],
    });
    return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
  };

  // A kind this importer does not read: the whole of what the question says is kept as an essay, and it fails so that someone looks.
  const unsupported = (why: string): Built => {
    const asked = stemText ?? plainToRich(name);
    const answerWords = elements(q, "answer").map((a) => r.plain(a)).filter((a) => a !== "");
    const kept = answerWords.length > 0 ? rich(`${asked.content}<p>${answerWords.map((a) => a.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("</p><p>")}</p>`) : asked;
    const made = createQuestion({
      type: "essay",
      stem: kept,
      body: {},
      ...(name !== "" ? { title: name } : {}),
      points,
      by: ctx.author,
      at: ctx.at,
      media: r.media,
      metadata: { status: "draft", tags: tagList },
      origin: { kind: "import", source, profile: MOODLE_XML_PROFILE_ID, at: ctx.at },
      findings: [...r.finish(), finding(FindingCode.UnsupportedType, "error", `${why} The question's text is kept, as an essay, so that nothing in it is lost.`)],
    });
    return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
  };

  const { answers, bad } = answersOf(q);
  if (bad) return unsupported(bad);

  if (type === "multichoice") {
    const single = first(q, "single") ? truthy(sub(q, "single")) : true;
    if (answers.length < 2) return unsupported("A multiple choice question needs at least two answers.");
    const options = answers.map((a, i) => {
      // Read once: a picture in an answer is kept as it is read, and reading twice would keep it twice.
      const read = r.rich(a.el);
      const content = read ?? plainToRich("(missing)");
      const empty = read === undefined;
      const fb = r.rich(first(a.el, "feedback"));
      return { a, i, empty, option: { id: localId("o", i), content, correct: false, ...(fb ? { feedback: fb } : {}) } };
    });
    if (options.some((o) => o.empty)) r.note(FindingCode.EmptyOption, "error", "An answer has no text. It is kept as (missing), and the question needs fixing.");
    const whole = options.filter((o) => o.a.fraction >= WHOLE);
    const positive = options.filter((o) => o.a.fraction > 0);
    const shuffle = first(q, "shuffleanswers") ? truthy(sub(q, "shuffleanswers")) : true;

    if (single) {
      for (const o of whole) o.option.correct = true;
      if (whole.length === 0) {
        r.note(FindingCode.UnreadContent, "warn", "No answer is worth the whole of the points, so no answer is read as the key. Nothing was guessed.");
      } else if (whole.length > 1) {
        r.note(FindingCode.MoreThanOneRight, "warn", `${whole.length} answers are each worth the whole of the points, and a single answer question has one right answer. Every one is marked right as the file has it, and the question needs fixing.`);
      }
      if (options.some((o) => o.a.fraction > 0 && o.a.fraction < WHOLE)) r.note(FindingCode.WeightsNotKept, "warn", "Some answers are worth part of the points. Partial credit for a single answer question is not kept: those answers are read as wrong.");
      if (options.some((o) => o.a.fraction < 0)) r.note(FindingCode.WeightsNotKept, "warn", "Some answers take points away. That is not kept.");
      return make("multipleChoice", { shuffle, options: options.map((o) => o.option) });
    }

    // Several may be chosen: the answers with weight above nothing are right, and the weights say whether credit is shared.
    for (const o of positive) o.option.correct = true;
    if (positive.length === 0) r.note(FindingCode.UnreadContent, "warn", "No answer is worth anything, so no answer is read as the key. Nothing was guessed.");
    const wrong = options.filter((o) => o.a.fraction <= 0);
    const sum = positive.reduce((total, o) => total + o.a.fraction, 0);
    const equal = positive.length > 0 && positive.every((o) => Math.abs(o.a.fraction - (positive[0] as { a: Answer }).a.fraction) < 0.5);
    if (positive.length > 0 && (Math.abs(sum - 100) > 1 || !equal)) {
      r.note(FindingCode.WeightsNotKept, "warn", `The right answers are worth ${Math.round(sum * 100) / 100} percent between them and are not equal shares. They are read as the right answers, and the weights are not kept.`);
    }
    // Every wrong answer taking everything away is all or nothing; any other weight is credit that is shared, and the score of the bank takes a share away.
    const allOrNothing = wrong.length > 0 && wrong.every((o) => o.a.fraction <= -(sum - 1));
    if (!allOrNothing && wrong.some((o) => o.a.fraction === 0) && wrong.length > 0) {
      r.note(FindingCode.WeightsNotKept, "warn", "A wrong answer here takes nothing away, and in OpenAssess it takes a share of the points away. Partial credit is kept as the right answers earning a share each, with a wrong answer costing one.");
    }
    return make("multipleResponse", { shuffle, partialCredit: !allOrNothing, options: options.map((o) => o.option) });
  }

  if (type === "truefalse") {
    const side = (a: Answer): string => r.plain(a.el).toLowerCase();
    const yes = answers.find((a) => side(a) === "true");
    const no = answers.find((a) => side(a) === "false");
    if (!yes || !no || answers.length !== 2) return unsupported("A true or false question has one answer reading true and one reading false.");
    const fbOf = (a: Answer): RichText | undefined => r.rich(first(a.el, "feedback"));
    const rightIs = yes.fraction >= WHOLE ? true : no.fraction >= WHOLE ? false : undefined;
    if (rightIs === undefined) r.note(FindingCode.UnreadContent, "warn", "Neither true nor false is worth the whole of the points, so neither is read as the key. Nothing was guessed.");
    if (yes.fraction >= WHOLE && no.fraction >= WHOLE) {
      r.note(FindingCode.MoreThanOneRight, "warn", "Both true and false are worth the whole of the points. Neither is read as the key.");
    }
    const bothWhole = yes.fraction >= WHOLE && no.fraction >= WHOLE;
    if (rightIs !== undefined && !bothWhole) {
      const right = rightIs ? yes : no;
      const other = rightIs ? no : yes;
      const rf = fbOf(right);
      const of = fbOf(other);
      if (rf && !feedback.correct) feedback.correct = rf;
      if (of && !feedback.incorrect) feedback.incorrect = of;
    } else {
      for (const a of [yes, no]) {
        const f = fbOf(a);
        if (f) r.dropped("The feedback on an answer", richTextToPlain(f));
      }
    }
    return make("trueFalse", rightIs !== undefined && !bothWhole ? { correct: rightIs } : {});
  }

  if (type === "shortanswer") {
    const accepted: string[] = [];
    let kept = false;
    for (const a of answers) {
      const value = r.plain(a.el);
      const fb = r.rich(first(a.el, "feedback"));
      if (a.fraction >= WHOLE) {
        if (value !== "") accepted.push(value);
        if (fb) {
          if (!kept && !feedback.correct) feedback.correct = fb;
          else r.dropped("Feedback on an accepted answer", richTextToPlain(fb));
        }
        kept = true;
      } else if (a.fraction > 0) {
        r.note(FindingCode.UnreadContent, "warn", `The answer "${quoted(value)}" is worth ${Math.round(a.fraction * 100) / 100} percent, which is partial credit. It was not read as an accepted answer, and nothing was guessed about it.`);
      } else if (fb) r.dropped("Feedback on an answer that is not accepted", richTextToPlain(fb));
    }
    if (accepted.some((a) => a.includes("*"))) r.note(FindingCode.UnreadContent, "warn", "An accepted answer has an asterisk in it. Moodle reads that as any characters; here it is kept as typed, so the answer is read only as those exact characters.");
    return make("shortAnswer", { caseSensitive: truthy(sub(q, "usecase")), accepted });
  }

  if (type === "matching") {
    const pairs: Array<{ left: RichText; right: string }> = [];
    const distractors: string[] = [];
    let missing = false;
    for (const s of elements(q, "subquestion")) {
      const left = r.rich(s);
      const right = r.plain(first(s, "answer"));
      if (left && right !== "") pairs.push({ left, right });
      else if (!left && right !== "") distractors.push(right);
      else if (left) {
        pairs.push({ left, right: "(missing)" });
        missing = true;
      }
    }
    if (pairs.length < 2) return unsupported("A matching question needs at least two pairs, each with something on both sides.");
    if (missing) r.note(FindingCode.EmptyOption, "error", "A pair has nothing on its right side. It is kept as (missing), and the question needs fixing.");
    return make("matching", {
      shuffle: first(q, "shuffleanswers") ? truthy(sub(q, "shuffleanswers")) : true,
      distractors,
      pairs: pairs.map((p, i) => ({ id: localId("p", i), left: p.left, right: p.right })),
    });
  }

  if (type === "essay") {
    // What Moodle calls information for graders is what the bank calls a model answer, and this program's own export writes it there.
    const graders = r.rich(first(q, "graderinfo"));
    const template = r.rich(first(q, "responsetemplate"));
    if (template) r.dropped("The response template", richTextToPlain(template));
    return make("essay", graders ? { modelAnswer: graders } : {});
  }

  if (type === "numerical") {
    const whole = answers.filter((a) => a.fraction >= WHOLE);
    const valueOf = (a: Answer): number => Number(r.plain(a.el).replace(/\s+/g, ""));
    if (whole.length !== 1 || !Number.isFinite(valueOf(whole[0] as Answer))) {
      return unsupported(whole.length === 0 ? "No answer of this numerical question is worth the whole of the points, so there is no number to score against." : "A numerical question with several right numbers, or a right answer that is not a number, is not read.");
    }
    const key = whole[0] as Answer;
    for (const a of answers) {
      if (a === key) continue;
      if (a.fraction > 0) r.note(FindingCode.UnreadContent, "warn", `The answer "${quoted(r.plain(a.el))}" is worth ${Math.round(a.fraction * 100) / 100} percent, which is partial credit. It was not read, and nothing was guessed about it.`);
    }
    const value = valueOf(key);
    const tolerance = Number(sub(key.el, "tolerance") || 0);
    let body: QuestionBody;
    if (!Number.isFinite(tolerance) || tolerance < 0) return unsupported("The tolerance of this numerical question is not a number.");
    // A numerical question's tolerance is the most the answer may differ from the number, as Moodle writes it.
    body = tolerance === 0 ? { mode: "exact", value } : { mode: "tolerance", value, tolerance };
    const fb = r.rich(first(key.el, "feedback"));
    if (fb && !feedback.correct) feedback.correct = fb;
    const units = elements(first(q, "units") ?? { name: "", attrs: {}, children: [] }, "unit");
    const unit = units.find((u) => Number(sub(u, "multiplier")) === 1);
    if (unit && sub(unit, "unit_name") !== "") (body as { units?: string }).units = sub(unit, "unit_name");
    if (units.length > (unit ? 1 : 0)) r.note(FindingCode.UnreadContent, "warn", `Units other than the first were not read: ${units.filter((u) => u !== unit).map((u) => quoted(sub(u, "unit_name"))).join(", ")}.`);
    return make("numeric", body);
  }

  const known: Record<string, string> = {
    cloze: "A cloze question (answers written into its text) is not read.",
    multianswer: "A cloze question (answers written into its text) is not read.",
    calculated: "A calculated question is not read.",
    calculatedsimple: "A calculated question is not read.",
    calculatedmulti: "A calculated question is not read.",
    ddwtos: "A drag and drop into text question is not read.",
    ddmarker: "A drag and drop onto an image question is not read.",
    ddimageortext: "A drag and drop onto an image question is not read.",
    gapselect: "A select missing words question is not read.",
    ordering: "An ordering question from a Moodle plugin is not read, because its XML is not the one Moodle documents.",
    randomsamatch: "A random short answer matching question is not read.",
  };
  return unsupported(known[type] ?? `A question of the type "${quoted(type) || "(none)"}" is not one OpenAssess reads.`);
}

/** Whether text looks like a Moodle XML file: a `quiz` element, after any declaration and comments. */
export function looksLikeMoodleXml(text: string): boolean {
  const head = text.slice(0, 4000).replace(/^﻿/, "").replace(/^\s*(<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*/, "");
  return /^<quiz[\s>/]/.test(head);
}

export const moodleXmlImporter: Importer = {
  id: MOODLE_XML_PROFILE_ID,
  label: "Moodle XML",
  extensions: [".xml"],

  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = (typeof input === "string" ? input : input.map((b) => b.text).join("\n")).replace(/^﻿/, "");
    const file = options.file ?? "input.xml";
    const ctx: Context = { file, at: options.at ?? new Date().toISOString(), author: options.author ?? "import", media: new Map(), defaultPoints: options.defaultPoints ?? DEFAULT_POINTS, stock: 0 };
    const refuse = (message: string): ImportResult => ({
      profile: options.profile ?? MOODLE_XML_PROFILE_ID,
      file,
      questions: [],
      orphans: [],
      counts: countVerdicts([], 0),
      fileFindings: [finding(FindingCode.UnreadContent, "error", message)],
    });

    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch (error) {
      if (error instanceof XmlError) return refuse(`This file is not well formed XML, so it could not be read as Moodle XML: ${error.message}`);
      throw error;
    }
    if (root.name !== "quiz") return refuse(`This XML file is not a Moodle quiz: its first element is <${quoted(root.name)}>, and a Moodle XML file begins with <quiz>.`);

    const blocks = elements(root, "question");
    const raw = rawQuestions(text);
    // The text beside each question is its own lines. If the lines could not be matched to the questions, a one line summary stands in.
    const matched = raw.length === blocks.length;
    const lines: string[] = [];
    const place: Array<{ first: number; last: number }> = [];
    blocks.forEach((q, i) => {
      const own = matched ? (raw[i] as string).split(/\r?\n/) : [`<question type="${attr(q, "type")}"> ${quoted(textOf(first(q, "name")))}`];
      place.push({ first: lines.length, last: lines.length + own.length - 1 });
      lines.push(...own);
    });

    const questions: Question[] = [];
    const orphans: Orphan[] = [];
    const fileFindings: Finding[] = [];
    let category: string | undefined;
    let categories = 0;
    blocks.forEach((q, i) => {
      const source = { file, firstBlock: (place[i] as { first: number }).first, lastBlock: (place[i] as { last: number }).last };
      if (attr(q, "type") === "category") {
        category = categoryTag(textOf(first(first(q, "category") ?? q, "text"))) || undefined;
        categories++;
        return;
      }
      let built: Built;
      try {
        built = build(q, source, category, ctx);
      } catch {
        // One question that cannot be read must not lose the file. It is kept as the words it holds, and fails.
        const words = allText(q).replace(/\s+/g, " ").trim();
        built = {
          question: createQuestion({
            type: "essay",
            stem: plainToRich(words === "" ? "(no question text in the source)" : words),
            body: {},
            by: ctx.author,
            at: ctx.at,
            metadata: { status: "draft", tags: category ? [category] : [] },
            origin: { kind: "import", source, profile: MOODLE_XML_PROFILE_ID, at: ctx.at },
            findings: [finding(FindingCode.UnsupportedType, "error", "This question could not be read. Its words are kept, as an essay, so that nothing in it is lost.")],
          }),
        };
      }
      if (built.question) questions.push(built.question);
      if (built.orphan) orphans.push(built.orphan);
    });

    if (categories > 0) {
      fileFindings.push(finding(FindingCode.UnreadContent, "info", `${categories === 1 ? "A category" : `${categories} categories`} in the file named where the questions go in Moodle. Each question keeps its category as a tag.`));
    }
    if (ctx.stock > 0) {
      fileFindings.push(finding(FindingCode.UnreadContent, "info", `${ctx.stock === 1 ? "One feedback was" : `${ctx.stock} feedbacks were`} Moodle's standard sentence ("Your answer is correct." and the like), which Moodle writes when nothing is typed. It is not kept as feedback.`));
    }
    if (questions.length === 0 && orphans.length === 0) {
      fileFindings.push(finding(FindingCode.UnreadContent, "warn", "No question was found in this file. A Moodle XML file holds question elements inside its quiz."));
    }
    return {
      profile: options.profile ?? MOODLE_XML_PROFILE_ID,
      file,
      questions,
      orphans,
      counts: countVerdicts(questions, orphans.length),
      fileFindings,
      sourceLines: lines,
      ...(ctx.media.size > 0 ? { media: ctx.media } : {}),
    };
  },
};
