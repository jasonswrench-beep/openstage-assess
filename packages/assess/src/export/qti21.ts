/**
 * Export as a QTI 2.1 package: the version Canvas names for Classic Quizzes (1.2 and 2.1) and for New Quizzes (1.2 and 2.x), and the
 * one Brightspace's Import/Export/Copy Components lists as partly read. Nothing here has been imported anywhere: see
 * `docs/design-plan.md` for what is known and what is not.
 *
 * QTI 2.1 is a different file from QTI 1.2, not a newer spelling of it. A package is a zip of an `imsmanifest.xml`, one
 * `assessmentTest.xml` that lists the questions, and a file of its own for each question (`assessmentItem`). The text of a question
 * is XHTML written into the file as markup (1.2 holds it as escaped text), an answer is declared once (`responseDeclaration`) and
 * scored by response processing that is written in the standard's own operators, and the points are a number the processing sets.
 *
 * What a question looks like here:
 *
 *  - Multiple choice and true or false: a `choiceInteraction` with one choice allowed, scored by `match` of the response against
 *    the declared correct response.
 *  - Multiple answer: the same with any number of choices allowed. An all-or-nothing question is `match` again (QTI compares a
 *    multiple response without regard to order). One with partial credit is a mapping: each right answer is an equal share and each
 *    wrong one takes the same share away, never below nothing, which is what the bank itself scores (`sheets/score.ts`).
 *  - Short answer and one blank: a `textEntryInteraction`, scored by a mapping with an entry for each accepted answer and the case
 *    rule on each entry.
 *  - Matching: a `matchInteraction`, scored by a mapping of an equal share to each right pair, so that half right is worth half.
 *  - Essay: an `extendedTextInteraction` with no processing, so it is marked by hand.
 *
 * What the 1.2 package cannot do and this one does: an answer that must stay in place when the others are mixed is said exactly
 * (`fixed`), a picture is a file in the package that the text points at, an equation is MathML, and partial credit is carried.
 *
 * What it still cannot hold: feedback, a model answer, a rubric, a numeric, ordering, hotspot or calculated question, and a fill in
 * the blank with several blanks. Underline and strike-through are not in the markup QTI 2.1 allows in a question, so they are
 * dropped and said. A question with no usable answer key is never written, and no key is ever guessed to fit.
 */

import { textEntry, zipSync, type ZipEntry } from "../container/zip.ts";
import { hasUsableKey } from "../quality/answer-key.ts";
import { sniffImage } from "../model/image.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import { decodeEntities, plainToRich, tokenize, type RichText } from "../model/richtext.ts";
import { parseXml } from "../import/docx/xml.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { escapeXml } from "./moodle-xml.ts";
import { buildReport, exportable, hasText, keyProblem, plural, plainText, safeName, TYPE_NAMES, newLosses, type Losses } from "./text.ts";
import { flat, num } from "./qti12.ts";

export const QTI21_ID = "qti-2.1";
export const QTI21_LABEL = "QTI 2.1 package (Canvas and Brightspace Course Import)";

/** The names the XML uses. */
export const QTI21_NAMESPACE = "http://www.imsglobal.org/xsd/imsqti_v2p1";
const QTI_SCHEMA = "http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd";
const CP_NAMESPACE = "http://www.imsglobal.org/xsd/imscp_v1p1";
const CP_SCHEMA = "http://www.imsglobal.org/xsd/imscp_v1p1.xsd";
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/** The resource types IMS gives a test and an item in a QTI 2.1 package. */
export const QTI21_TEST_TYPE = "imsqti_test_xmlv2p1";
export const QTI21_ITEM_TYPE = "imsqti_item_xmlv2p1";

/** What the markup of a question may hold in QTI 2.1: XHTML without underline, strike-through or a list's start number. */
const KEEP = new Set(["p", "strong", "em", "sub", "sup", "code", "pre", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td"]);
const SCOPES = new Set(["row", "col", "rowgroup", "colgroup"]);
const SMALL_NUMBER = /^[1-9][0-9]{0,2}$/;

/** A name a picture can be kept under inside the package, safe as a file name and as an attribute. */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** What carrying a question's text cost or gained, counted so it can be said. */
interface Carried {
  losses: Losses;
  /** Underline or strike-through taken out of the text. */
  styles: boolean;
  /** A list's start number taken out. */
  listStart: boolean;
  pictures: number;
  equations: number;
  /** The pictures this question's text points at, by the name they have in the package. */
  files: Set<string>;
}

interface Pictures {
  media?: ReadonlyMap<string, Uint8Array>;
  /** Every picture written, by name in the package: two different pictures never share a name. */
  written: Map<string, Uint8Array>;
}

interface Planned {
  item: ReportItem;
  xml?: string;
  files?: Set<string>;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** An equation as MathML, when the question holds MathML that is well formed and is MathML. Otherwise undefined. */
function mathOf(question: Question, ref: string): string | undefined {
  const entry = question.math.find((m) => m.id === ref);
  const source = entry?.mathml.trim() ?? "";
  if (source === "") return undefined;
  try {
    const root = parseXml(source);
    // The namespace is read from the text itself: the reader takes a namespace declaration out of the attributes it hands over.
    if (root.name !== "math" || !new RegExp(`^<math\\s[^>]*\\bxmlns\\s*=\\s*"${MATHML_NAMESPACE.replace(/[./]/g, "\\$&")}"`).test(source)) return undefined;
  } catch {
    return undefined;
  }
  return source;
}

/**
 * The text of a question as XHTML, from the closed subset the bank stores. Every tag written is on the list above and closed, every
 * character is escaped for XML, a picture is an `img` that points at a file in the package (when its bytes are held and it is a
 * PNG, JPEG or GIF) and an equation is its MathML (when the bank holds it). A picture or an equation that cannot be carried is
 * written as words, as in the other exporters, and counted. Nothing is dropped without being counted.
 */
function xhtml(text: RichText, question: Question, carried: Carried, pictures: Pictures): string {
  const html = text.format === "plain" ? plainToRich(text.content).content : text.content;
  const out: string[] = [];
  const open: string[] = [];
  const word = (s: string): void => void out.push(escapeXml(s));

  const picture = (ref: string): void => {
    const entry = question.media.find((m) => m.id === ref);
    const bytes = entry && entry.file.startsWith("media/") ? pictures.media?.get(entry.file) : undefined;
    const info = bytes ? sniffImage(bytes) : undefined;
    if (entry && bytes && info) {
      const name = `${entry.file.slice("media/".length).replace(/\.[A-Za-z0-9]+$/, "")}.${info.ext}`;
      const held = pictures.written.get(name);
      if (SAFE_FILE.test(name) && (held === undefined || sameBytes(held, bytes))) {
        pictures.written.set(name, bytes);
        carried.files.add(name);
        carried.pictures++;
        // A decorative picture has an empty description on purpose, so a screen reader passes over it.
        out.push(`<img src="images/${escapeXml(name)}" alt="${escapeXml(entry.decorative ? "" : entry.alt.trim())}"/>`);
        return;
      }
    }
    carried.losses.pictures++;
    if (entry?.decorative) return void word(" ");
    const alt = entry ? entry.alt.trim() : "";
    word(alt.length > 0 ? ` [Picture: ${alt}] ` : " [Picture] ");
  };

  const equation = (ref: string): void => {
    const mathml = mathOf(question, ref);
    if (mathml !== undefined) {
      carried.equations++;
      out.push(mathml);
      return;
    }
    carried.losses.equations++;
    const latex = question.math.find((m) => m.id === ref)?.latex.trim() ?? "";
    word(latex.length > 0 ? ` [Equation: ${latex}] ` : " [Equation] ");
  };

  for (const t of tokenize(html)) {
    if (t.kind === "text") {
      word(decodeEntities(t.text ?? ""));
    } else if (t.kind === "open" || t.kind === "selfclose") {
      const name = t.name as string;
      const ref = t.attrs?.["ref"] ?? "";
      if (name === "oa-media") picture(ref);
      else if (name === "oa-math") equation(ref);
      else if (name === "br") out.push("<br/>");
      else if (name === "u" || name === "s") carried.styles = true;
      else if (KEEP.has(name)) {
        const attrs: string[] = [];
        for (const [key, value] of Object.entries(t.attrs ?? {})) {
          if ((key === "colspan" || key === "rowspan") && (name === "th" || name === "td") && SMALL_NUMBER.test(value)) attrs.push(`${key}="${value}"`);
          else if (key === "scope" && name === "th" && SCOPES.has(value)) attrs.push(`scope="${value}"`);
          else if (key === "start" && name === "ol") carried.listStart = true;
        }
        out.push(`<${name}${attrs.length > 0 ? " " + attrs.join(" ") : ""}>`);
        if (t.kind === "selfclose") out.push(`</${name}>`);
        else open.push(name);
      }
    } else if (t.kind === "close") {
      const name = t.name as string;
      if (!KEEP.has(name)) continue;
      const at = open.lastIndexOf(name);
      if (at === -1) continue; // a stray end tag
      while (open.length > at) out.push(`</${open.pop()}>`);
    }
  }
  while (open.length > 0) out.push(`</${open.pop()}>`);
  return out.join("");
}

/** An answer's text for a choice: a single paragraph is written as its words, since a choice holds text and a paragraph is not needed. */
function inline(text: RichText, question: Question, carried: Carried, pictures: Pictures): string {
  const body = xhtml(text, question, carried, pictures);
  const single = /^<p>((?:(?!<\/?p>)[\s\S])*)<\/p>$/.exec(body);
  return single ? (single[1] as string) : body;
}

function plan(question: Question, position: number, pictures: Pictures): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) || isMultipleResponse(question) || isTrueFalse(question) || isFillInBlank(question) || isShortAnswer(question) || question.type === "matching" || question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    const why =
      question.type === "ordering"
        ? "Neither Canvas nor Brightspace documents an ordering question in a QTI file, so it is not written untried. Brightspace's CSV export carries ordering questions."
        : question.type === "numeric"
          ? "Neither Canvas nor Brightspace documents a numeric question in a QTI file, so it is not written untried."
          : `A QTI 2.1 package from here has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.`;
    return leftOut(why);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "the destination"));

  const carried: Carried = { losses: newLosses(), styles: false, listStart: false, pictures: 0, equations: 0, files: new Set() };
  const notes: string[] = [];
  let asType: string | undefined;

  const text = (t: RichText): string => xhtml(t, question, carried, pictures);
  const choiceText = (t: RichText): string => inline(t, question, carried, pictures);
  const words = (t: RichText): boolean => hasText(t);

  if (plainText(question.stem, question, newLosses(), true) === "" && !/<oa-(media|math)\b/i.test(question.stem.content)) return leftOut("It has no question text.");
  const stem = `<div>${text(question.stem)}</div>`;

  const n = position;
  const pts = num(question.points);
  const points = (value: number): string => `<baseValue baseType="float">${num(value)}</baseValue>`;
  const wins = `<setOutcomeValue identifier="SCORE">${points(question.points)}</setOutcomeValue>`;
  const choiceId = (i: number): string => `c${i + 1}`;
  const asMatch = (): string => `<responseProcessing><responseCondition><responseIf><match><variable identifier="RESPONSE"/><correct identifier="RESPONSE"/></match>${wins}</responseIf></responseCondition></responseProcessing>`;
  const mapped = `<responseProcessing><setOutcomeValue identifier="SCORE"><mapResponse identifier="RESPONSE"/></setOutcomeValue></responseProcessing>`;

  let declaration: string;
  let body: string;
  let processing: string;

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    if (options.length < 2) return leftOut("It has fewer than two answers.");
    if (options.some((o) => !words(o.content))) return leftOut("One of its answers has no text, and the destination needs text in every answer.");
    const multiple = isMultipleResponse(question);
    const right = options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
    const partial = multiple && (question.body as { partialCredit: boolean }).partialCredit;
    declaration =
      `<responseDeclaration identifier="RESPONSE" cardinality="${multiple ? "multiple" : "single"}" baseType="identifier">` +
      `<correctResponse>${right.map((i) => `<value>${choiceId(i)}</value>`).join("")}</correctResponse>` +
      (partial ? mappingOf(options.map((o, i) => [choiceId(i), o.correct ? 1 : -1] as const), question.points, right.length) : "") +
      `</responseDeclaration>`;
    // A fixed answer stays where it is when the others are mixed. The attribute says it exactly, answer by answer.
    const shuffle = question.body.shuffle;
    const choices = options.map((o, i) => `<simpleChoice identifier="${choiceId(i)}"${shuffle && o.fixedPosition ? ' fixed="true"' : ""}>${choiceText(o.content)}</simpleChoice>`).join("");
    body = `${stem}<choiceInteraction responseIdentifier="RESPONSE" shuffle="${shuffle ? "true" : "false"}" maxChoices="${multiple ? 0 : 1}">${choices}</choiceInteraction>`;
    processing = partial ? mapped : asMatch();
    if (options.some((o) => o.feedback && hasText(o.feedback))) notes.push("Feedback on a single answer cannot be carried.");
  } else if (isTrueFalse(question)) {
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    declaration = `<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"><correctResponse><value>${question.body.correct ? "true" : "false"}</value></correctResponse></responseDeclaration>`;
    body = `${stem}<choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1"><simpleChoice identifier="true">True</simpleChoice><simpleChoice identifier="false">False</simpleChoice></choiceInteraction>`;
    processing = asMatch();
  } else if (isFillInBlank(question) || isShortAnswer(question)) {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      if (question.body.blanks.length !== 1) {
        return leftOut(`It has ${question.body.blanks.length} blanks, and the one text box this question gets takes one answer. The blanks cannot be placed in the text from here.`);
      }
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "short answer";
      notes.push("A fill in the blank is written as a short answer, because the file cannot say where in the text the blank is. The text still has the blank in it.");
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
    }
    // Two answers that differ only in case are one answer when case does not count, or the mapping would hold the same key twice.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const a of accepted.map(flat).filter((x) => x !== "")) {
      const key = caseSensitive ? a : a.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        cleaned.push(a);
      }
    }
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    declaration =
      `<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"><correctResponse><value>${escapeXml(cleaned[0] as string)}</value></correctResponse>` +
      `<mapping defaultValue="0" lowerBound="0" upperBound="${pts}">${cleaned.map((a) => `<mapEntry mapKey="${escapeXml(a)}" mappedValue="${pts}" caseSensitive="${caseSensitive ? "true" : "false"}"/>`).join("")}</mapping>` +
      `</responseDeclaration>`;
    body = `${stem}<p><textEntryInteraction responseIdentifier="RESPONSE" expectedLength="40"/></p>`;
    processing = mapped;
  } else if (question.type === "matching") {
    const match = question.body as { pairs: Array<{ left: RichText; right: string }>; distractors?: string[]; shuffle?: boolean };
    if (match.pairs.length < 2) return leftOut(`It has ${match.pairs.length} pair${match.pairs.length === 1 ? "" : "s"}, and a matching question needs at least two.`);
    if (match.pairs.some((p) => !words(p.left) || flat(p.right) === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    // Each distinct right side is one choice, offered to every left side. The spare answers are choices no left side points to.
    const rights: string[] = [];
    const rightIndex = (s: string): number => {
      const at = rights.indexOf(s);
      if (at >= 0) return at;
      rights.push(s);
      return rights.length - 1;
    };
    const wanted = match.pairs.map((p) => rightIndex(flat(p.right)));
    for (const d of match.distractors ?? []) if (flat(d) !== "") rightIndex(flat(d));
    const count = match.pairs.length;
    const leftId = (i: number): string => `l${i + 1}`;
    const rightId = (i: number): string => `r${i + 1}`;
    const keys = match.pairs.map((_p, i) => `${leftId(i)} ${rightId(wanted[i] as number)}`);
    declaration =
      `<responseDeclaration identifier="RESPONSE" cardinality="multiple" baseType="directedPair">` +
      `<correctResponse>${keys.map((k) => `<value>${k}</value>`).join("")}</correctResponse>` +
      mappingOf(keys.map((k) => [k, 1] as const), question.points, count) +
      `</responseDeclaration>`;
    // A left side takes one answer. A right side may take as many left sides as there are, so the structure of the question does not show.
    const lefts = match.pairs.map((p, i) => `<simpleAssociableChoice identifier="${leftId(i)}" matchMax="1">${choiceText(p.left)}</simpleAssociableChoice>`).join("");
    const rightChoices = rights.map((r, i) => `<simpleAssociableChoice identifier="${rightId(i)}" matchMax="${count}">${escapeXml(r)}</simpleAssociableChoice>`).join("");
    body = `${stem}<matchInteraction responseIdentifier="RESPONSE" shuffle="${match.shuffle === false ? "false" : "true"}" maxAssociations="${count}"><simpleMatchSet>${lefts}</simpleMatchSet><simpleMatchSet>${rightChoices}</simpleMatchSet></matchInteraction>`;
    processing = mapped;
  } else {
    // An essay is a written response, marked by hand: there is nothing to process.
    declaration = `<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"/>`;
    body = `${stem}<extendedTextInteraction responseIdentifier="RESPONSE" expectedLines="15"/>`;
    processing = "";
    const essay = question.body as { modelAnswer?: RichText; rubric?: unknown[]; expectedWords?: number };
    if (essay.modelAnswer && hasText(essay.modelAnswer)) notes.push("The model answer cannot be carried.");
    if ((essay.rubric ?? []).length > 0) notes.push("The rubric cannot be carried: a rubric is made in the learning system.");
    if (typeof essay.expectedWords === "number") notes.push("The expected length cannot be carried.");
  }

  if ([question.feedback.general, question.feedback.correct, question.feedback.incorrect].some((f) => f && hasText(f))) {
    notes.push("Feedback cannot be carried in this package.");
  }
  if (carried.styles) notes.push("Underline and strike-through are not allowed in the markup of a QTI 2.1 question, so they were taken out and the words stayed.");
  if (carried.listStart) notes.push("A list's starting number is not allowed in the markup of a QTI 2.1 question, so the list starts at 1.");
  if (carried.losses.formatting) notes.push("Bold, italics, lists or tables in the text became plain text.");
  if (carried.losses.pictures > 0) notes.push(`${plural(carried.losses.pictures, "picture", "pictures")} could not be written into the package, and appears in the text as [Picture: its alternative text]; add the picture again in the learning system.`);
  if (carried.losses.equations > 0) notes.push(`${plural(carried.losses.equations, "equation", "equations")} became text, written as [Equation: LaTeX], because the bank holds no MathML for it. Check how it reads in the learning system.`);

  const title = escapeXml(flat(question.title).slice(0, 100) || `Question ${n}`);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<assessmentItem xmlns="${QTI21_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${QTI21_NAMESPACE} ${QTI_SCHEMA}" identifier="q${n}" title="${title}" adaptive="false" timeDependent="false">\n` +
    `${declaration}\n` +
    `<outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float" normalMinimum="0" normalMaximum="${pts}"><defaultValue><value>0</value></defaultValue></outcomeDeclaration>\n` +
    `<itemBody>${body}</itemBody>\n` +
    (processing !== "" ? `${processing}\n` : "") +
    `</assessmentItem>\n`;

  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, xml, files: carried.files };
}

/**
 * A mapping of shares of the points. A share is `weight` times an equal part of the points among `rights` right answers: the right
 * answers are the part and the wrong ones (weight -1) take the same part away. The last right answer is what is left of the points,
 * so that every right answer adds up to the points exactly and not to 0.99999 of them. The score is held between nothing and all of
 * the points.
 */
function mappingOf(entries: ReadonlyArray<readonly [string, number]>, points: number, rights: number): string {
  const each = Math.round((points / rights) * 100000) / 100000;
  let seen = 0;
  const parts = entries.map(([key, weight]) => {
    if (weight < 0) return `<mapEntry mapKey="${key}" mappedValue="${num(-each)}"/>`;
    seen++;
    return `<mapEntry mapKey="${key}" mappedValue="${num(seen < rights ? each : points - each * (rights - 1))}"/>`;
  });
  return `<mapping defaultValue="0" lowerBound="0" upperBound="${num(points)}">${parts.join("")}</mapping>`;
}

export interface Qti21Options {
  /** What to call the assessment and the file. Usually the bank's title. */
  name?: string;
  /** The bank's pictures by path (`Bank.media`). With it, a picture in a question's text is written into the package; without it, as words. */
  media?: ReadonlyMap<string, Uint8Array>;
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkQti21(questions: readonly Question[], options: Qti21Options = {}): ExportResult["report"] {
  return exportQti21(questions, options).report;
}

/** The destination check, and the package to write. */
export function exportQti21(questions: readonly Question[], options: Qti21Options = {}): ExportResult {
  questions = exportable(questions);
  const items: ReportItem[] = [];
  const written: Array<{ id: string; xml: string; files: Set<string> }> = [];
  const pictures: Pictures = { ...(options.media ? { media: options.media } : {}), written: new Map() };
  questions.forEach((question, i) => {
    const planned = plan(question, i + 1, pictures);
    items.push(planned.item);
    if (planned.xml) written.push({ id: `q${i + 1}`, xml: planned.xml, files: planned.files ?? new Set() });
  });

  const base = safeName(options.name);
  const title = escapeXml(options.name?.trim() || base);
  const test =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<assessmentTest xmlns="${QTI21_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${QTI21_NAMESPACE} ${QTI_SCHEMA}" identifier="test1" title="${title}">\n` +
    `<outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"/>\n` +
    `<testPart identifier="part1" navigationMode="nonlinear" submissionMode="simultaneous">\n` +
    `<assessmentSection identifier="section1" title="${title}" visible="true">\n` +
    written.map((w) => `<assessmentItemRef identifier="${w.id}" href="${w.id}.xml"/>`).join("\n") +
    `\n</assessmentSection>\n</testPart>\n` +
    `<outcomeProcessing><setOutcomeValue identifier="SCORE"><sum><testVariables variableIdentifier="SCORE"/></sum></setOutcomeValue></outcomeProcessing>\n` +
    `</assessmentTest>\n`;
  const resource = (w: { id: string; files: Set<string> }): string =>
    `<resource identifier="res_${w.id}" type="${QTI21_ITEM_TYPE}" href="${w.id}.xml"><file href="${w.id}.xml"/>${[...w.files].sort().map((f) => `<file href="images/${escapeXml(f)}"/>`).join("")}</resource>`;
  const manifest =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<manifest identifier="manifest1" xmlns="${CP_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${CP_NAMESPACE} ${CP_SCHEMA}">\n` +
    `<metadata><schema>QTIv2.1 Package</schema><schemaversion>1.0.0</schemaversion></metadata>\n` +
    `<organizations/>\n` +
    `<resources>\n` +
    `<resource identifier="res_test1" type="${QTI21_TEST_TYPE}" href="assessmentTest.xml"><file href="assessmentTest.xml"/>${written.map((w) => `<dependency identifierref="res_${w.id}"/>`).join("")}</resource>\n` +
    written.map(resource).join("\n") +
    `\n</resources>\n</manifest>\n`;

  const file = `${base} - QTI 2.1.zip`;
  let bytes: Uint8Array | undefined;
  if (written.length > 0) {
    const used = new Set(written.flatMap((w) => [...w.files]));
    const entries: ZipEntry[] = [textEntry("imsmanifest.xml", manifest), textEntry("assessmentTest.xml", test), ...written.map((w) => textEntry(`${w.id}.xml`, w.xml))];
    // A picture that only a question left out pointed at is not carried.
    for (const name of [...used].sort()) entries.push({ name: `images/${name}`, data: pictures.written.get(name) as Uint8Array, store: true });
    bytes = zipSync(entries);
  }

  const general = [
    "In Canvas: Settings, then Import Course Content, with the content type QTI .zip file. Canvas's guides say Classic Quizzes reads QTI 1.2 and 2.1 and New Quizzes reads QTI 1.2 and 2.x. If this package does not arrive, the QTI 1.2 package is the other one to try.",
    "In Brightspace: Course Admin, Import/Export/Copy Components, Import Components, from a File. Campus guides list QTI 2.1 there as partly read, and a D2L staff reply says Course Import reads a subset of QTI 2.x. The Quizzes tool reads QTI 1.2 only, so use the QTI 1.2 package or the Brightspace CSV for it.",
    "Neither tool lists which question types it reads from a QTI 2.1 file, so a type that does not arrive says so when you import. The other questions still do.",
    "A multiple answer question with partial credit is scored by a mapping: each right answer is an equal share of the points, each wrong one takes the same share away, and the score is never below nothing. Whether the tool you import into uses a mapping is not documented, and the check cannot tell.",
    "Difficulty, tags, objectives and history are not part of the file. A picture or an equation in the text of a question is carried when the file can hold it, and the check says when it could not.",
  ];
  const report = buildReport(QTI21_ID, QTI21_LABEL, questions.length, items, bytes ? [file] : [], general);
  return { files: bytes ? [{ name: file, content: "", bytes, questions: written.length }] : [], report };
}
