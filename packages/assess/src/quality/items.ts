/**
 * Item quality and accessibility checks, one question at a time.
 *
 * Every finding here is a note (severity "info"), never a warning or an error, and that is a decision, not a default. A warning
 * makes a question "needs review" and an error makes it "failed", and those verdicts are what the import gate counts and what an
 * export holds back. These checks are advice about good writing, and a bank full of questions that are fine as written, such as
 * "None of the above" used on purpose, must not look broken because of them. An author can dismiss any of them, and the
 * dismissal survives the next check (`withFreshQuality`).
 *
 * Each rule is meant to be right when it speaks and silent when unsure. The false positives that would teach an author to ignore
 * the notes cost more than the misses: the longest-answer rule needs the right answer to be well clear of the others, the
 * a/an rule leaves a question alone when any option starts with a letter whose sound is not settled by the letter (an hour, a
 * university), and the negative-stem rule ignores "at least" and "not only", and a "not" that is in a story, a quotation, a why
 * question or a condition and not in the question itself. Nothing here reads a key that is not there: a rule
 * that depends on which option is right is skipped for a question with no usable key (`hasUsableKey`), so none of these can
 * make a guess about the answer.
 *
 * These run when a question is saved into a bank and when a person asks for the whole bank to be checked. They do not run at
 * import: an import's findings are about what the importer had to guess, and a note about writing style would be mixed in with
 * them. Checks that look at more than one question (duplicates, how the right answers are spread) are in `bank.ts`.
 */

import { finding, FindingCode, type Finding } from "../model/findings.ts";
import { isChoice, isMatching, isMultipleResponse, isOrdering, type Option, type Question } from "../model/question.ts";
import { collectRefs, foldTypography, richTextToPlain, type RichText } from "../model/richtext.ts";
import { dependsOnPlace, placeLetter } from "../model/test.ts";
import { hasUsableKey } from "./answer-key.ts";
import { isPlaceholderOption } from "./placeholders.ts";

/** The finding codes `checkItemQuality` can raise. Only these are replaced when a question is checked again. */
export const QUALITY_CODES: ReadonlySet<string> = new Set<string>([
  FindingCode.AllOrNoneOfTheAbove,
  FindingCode.LongestOptionCorrect,
  FindingCode.NegativeStemNotEmphasised,
  FindingCode.GrammaticalCue,
  FindingCode.DuplicateOption,
  FindingCode.AltTextGivesAnswer,
  FindingCode.ColourOnlyMeaning,
  FindingCode.LongMatchingList,
  FindingCode.TypedAnswerTypography,
]);

/** The longest a matching list may be before it is called long. A judgement, kept in one place so it can be changed. */
export const LONG_MATCHING_LIST = 8;

/** The right answer must be at least this many times as long as the longest wrong one, and this many characters longer. */
export const LONGEST_RATIO = 1.5;
export const LONGEST_MARGIN = 20;

const COLOURS = ["red", "orange", "yellow", "green", "blue", "purple", "violet", "pink", "brown"];

/**
 * A text as it is compared with another for being the same: in one Unicode form, lower case, with runs of space made one, and without
 * the quotes, brackets and marks that end a sentence or a phrase. Everything inside is kept, symbols and marks included.
 *
 * It used to keep only letters and digits, so options that differ in a sign or an operator read as the same ("+2" and "-2", "x > 3"
 * and "x < 3", "$5" and "€5"), two questions whose right answers were "x > 3" and "x < 3" were called the same question, and the
 * vowel signs of Hindi, which are marks, were taken for spaces so that four different words read as one. A difference is not made
 * to disappear unless it is only spacing, case, or the stop at the end.
 */
export function normalForm(text: string): string {
  return tidy(text, true);
}

/** `normalForm` with or without the lower case. A function of one parameter apart from this, because callers hand `normalForm` to `map`. */
function tidy(text: string, lower: boolean): string {
  // Typography is folded because the text is no longer flattened on the way in (see `normalizeCharacters`): the same question
  // typed with straight quotes and with curly ones is still the same question.
  const folded = foldTypography(text).normalize("NFC");
  return (lower ? folded.toLowerCase() : folded)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’(\[]+/u, "")
    .replace(/["'“”‘’)\].!?;:,]+$/u, "")
    .trim();
}

/**
 * A text as it is compared with another option for being a copy of it: `normalForm`, but with the case kept, except for the first letter
 * of an option of four letters or more, which is a capital because it starts the option and means nothing ("Paris" and "paris" are one
 * answer). A capital inside an option can be the whole of the difference: PV = nRT and PV = NRt (n moles and N molecules), a calorie and
 * a Calorie, Mb and MB. Real questions had the first two and they were called copies, with the advice to change one or take it out, which
 * would have spoilt each question. A short option (Mb, pH, kHz) keeps its first letter too, since there the capital is part of the symbol.
 */
function copyForm(text: string): string {
  const kept = tidy(text, false);
  if ((kept.match(/\p{L}/gu) ?? []).length < 4) return kept;
  const first = [...kept][0] ?? "";
  return first.toLowerCase() + kept.slice(first.length);
}

/**
 * The words of a text, for finding what is alike and for finding an answer written in a description: lower case, in one Unicode form,
 * with what surrounds a word (a comma, a stop, a bracket) taken off. A sign that belongs to a number or a word stays: "-2" is not "2",
 * and "c++" is not "c".
 */
export function wordTokens(text: string): string[] {
  return foldTypography(text)
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{M}\p{N}\p{S}-]+/u, "").replace(/[^\p{L}\p{M}\p{N}\p{S}+#]+$/u, ""))
    .filter((token) => token !== "");
}

function plain(value: RichText): string {
  return richTextToPlain(value).replace(/\s+/g, " ").trim();
}

function shorten(text: string, longest = 60): string {
  return text.length <= longest ? text : `${text.slice(0, longest - 1).trimEnd()}...`;
}

function choiceOptions(question: Question): Option[] | undefined {
  if (isChoice(question) || isMultipleResponse(question)) return question.body.options;
  return undefined;
}

function hasPictureOrEquation(value: RichText): boolean {
  const refs = collectRefs(value);
  return refs.media.length > 0 || refs.math.length > 0;
}

function note(code: string, message: string, field: string): Finding {
  return finding(code, "info", message, { field });
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** An option that only makes sense beside the others. It is answered by ruling things in or out, and it breaks when options move. */
function placeDependent(options: Option[]): Finding | undefined {
  const at = options.findIndex((o) => !isPlaceholderOption(o) && dependsOnPlace(plain(o.content)));
  if (at === -1) return undefined;
  const words = plain((options[at] as Option).content);
  return note(
    FindingCode.AllOrNoneOfTheAbove,
    `Option ${placeLetter(at)}, "${shorten(words)}", only makes sense beside the other options. A student can reach it by ruling the others in or out without knowing the answer itself, and it stops making sense when options are shuffled, so a printed test keeps this question's options in order. A multiple response question says the same thing without it.`,
    "body.options",
  );
}

/** The right answer is much longer than every wrong one. Students learn to pick the longest. */
function longestIsRight(question: Question, options: Option[]): Finding | undefined {
  if (!isChoice(question) || !hasUsableKey(question)) return undefined;
  const said = options.filter((o) => !isPlaceholderOption(o));
  if (said.length < 3 || said.some((o) => hasPictureOrEquation(o.content))) return undefined;
  const right = said.filter((o) => o.correct);
  if (right.length !== 1) return undefined;
  const rightLength = plain((right[0] as Option).content).length;
  const wrongest = Math.max(...said.filter((o) => !o.correct).map((o) => plain(o.content).length));
  if (rightLength < wrongest * LONGEST_RATIO || rightLength - wrongest < LONGEST_MARGIN) return undefined;
  return note(
    FindingCode.LongestOptionCorrect,
    `The right answer (option ${placeLetter(options.indexOf(right[0] as Option))}, ${rightLength} characters) is much longer than the longest wrong one (${wrongest}). Students learn to pick the longest option. Shorten it, or give the wrong options as much detail.`,
    "body.options",
  );
}

/** A sentence that tells the student what to do, which is the question of a stem that has no question mark. */
const INSTRUCTION = /^\s*(?:select|choose|identify|pick|mark|indicate|circle|name|find|determine|decide|which|what|who)\b/i;

/** "not", "except", "least" in a stem, not set apart. A student who reads past it answers the opposite question. */
function negativeStem(question: Question): Finding | undefined {
  if (!isChoice(question) && !isMultipleResponse(question)) return undefined;
  const html = question.stem.content;
  // What is bold, underlined or in italics is set apart, so it is taken out before looking. These are the three tags the rich
  // text subset has for it (richtext.ts); a <b> or an <i> is unwrapped on the way in and never reaches a stored stem.
  const unemphasised = question.stem.format === "rich" ? html.replace(/<(strong|em|u)\b[^>]*>[\s\S]*?<\/\1>/gi, " ") : html;
  // Phrases that use these words without asking for the opposite are taken out first: "at least two", "whether or not", "not only",
  // "least common multiple".
  const text = richTextToPlain(unemphasised)
    .replace(/\bat least\b/gi, " ")
    .replace(/\bor (?:\w+ )?not\b|\bif not\b/gi, " ")
    .replace(/\bnot (?:only|just)\b/gi, " ")
    .replace(/\bleast (?:common|squares?)\b/gi, " ")
    // Words in quotation marks are an example the question is about, not the question: “If you do not use lotion, you will burn!” is
    // an example of which aspect of style? A straight quote is a quotation mark only where it opens a group of words and where it
    // closes one, and not as an inch mark ('a 2" pipe is not true for a 4" pipe' is a question, not a quotation).
    .replace(/“[^”]*”|(?<![\p{L}\p{N}])"[^"]*"(?![\p{L}\p{N}])/gu, " ");
  // A story before the question can say not as much as it likes ("Darlene is concerned that she will not appear honest. What aspect of
  // credibility ..."), so with more than one sentence only the ones that ask are looked at: those that end in a question mark, the
  // last, and an instruction ("Select the statement that is not true. Choose one answer."). A sentence ends at a stop and a capital,
  // so that "e.g. a method" is not cut in two.
  const sentences = text.split(/(?<=[.!?])\s+(?=[\p{Lu}(])/u);
  const asked = sentences.length > 1 ? sentences.filter((s, i) => i === sentences.length - 1 || /\?\s*$/.test(s) || INSTRUCTION.test(s)) : sentences;
  for (const sentence of asked) {
    // "Why can't sound waves travel through a vacuum?" explains a negative fact and does not pick the one that is not true.
    if (/^\s*why\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(/\b(?:not|cannot|except|least|incorrect(?:ly)?)\b|\b\w+n['’]t\b/gi)) {
      const word = match[0];
      // A word already written in capitals is set apart.
      if (word === word.toUpperCase()) continue;
      // Not inside a condition: "If you do not understand, you should", "when the object is not near the focus". The condition is the
      // words since the last comma, colon or bracket, so "When receiving criticism, which of these should you not do?" is still noted.
      const before = sentence.slice(0, match.index);
      const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(":"), before.lastIndexOf("(")) + 1);
      if (/\b(?:if|when|whenever|where|while|unless|because|although|though)\b/i.test(clause)) {
        // A when, where or while that opens a question is not a condition: "Where in the cell is ATP not produced?", "When should a
        // nurse not administer this drug?". It is one when a comma closes it before the question goes on ("When the object is not near
        // the focus, what image is formed?") or the sentence is not a question at all.
        const opensQuestion = /^\s*(?:when|whenever|where|while)\b/i.test(sentence) && /\?\s*$/.test(sentence) && !/[,;:]/.test(sentence.slice((match.index ?? 0) + word.length));
        if (!opensQuestion) continue;
      }
      return note(
        FindingCode.NegativeStemNotEmphasised,
        `The stem asks for the opposite of what is usual ("${word}") and the word is not set apart. A student who reads past it answers the other question. Write it in capitals or bold: NOT, EXCEPT, LEAST.`,
        "stem",
      );
    }
  }
  return undefined;
}

/** A vowel sound or a consonant sound, from the first letter, where the letter settles it. Undefined where it does not (an hour, a unit). */
function soundOf(words: string): "vowel" | "consonant" | undefined {
  // A letter that is read by its name and not as a word has the sound of its name, not of its place in the alphabet: an acronym (MRI,
  // RNA: "an MRI", "an RNA"), a letter on its own (x, a: "a x" is not wrong, it is a variable), and a letter and a word joined by a
  // hyphen (X-ray: "an X-ray"). None of them is judged.
  const lead = /^[^\p{L}\p{N}]*(\p{L}[\p{L}\p{M}]*)/u.exec(words)?.[1];
  if (lead !== undefined && (lead.length === 1 || /^\p{Lu}{2,}$/u.test(lead))) return undefined;
  // A number or a symbol first gives no letter here, and so no sound; so does a letter outside a to z.
  const letter = /^[^\p{L}\p{N}]*(\p{L})/u.exec(words)?.[1]?.toLowerCase();
  if (letter === undefined || !/^[a-z]$/.test(letter)) return undefined;
  // Words whose first letter says the wrong thing: a one, a European, a once-only. A prefix is enough; being silent about
  // "onerous" is a small price for never being wrong about "one".
  if (/^[^\p{L}\p{N}]*(?:one|once|eu|ew)/iu.test(words)) return undefined;
  if ("aeio".includes(letter)) return "vowel";
  // H (an hour, a house) and U (an umbrella, a university) are the two letters that do not settle it.
  if (letter === "h" || letter === "u") return undefined;
  return "consonant";
}

/** A stem that ends in "a" or "an" tells which options can follow, so the grammar picks the answer. */
function grammaticalCue(question: Question, options: Option[]): Finding | undefined {
  const stem = plain(question.stem).replace(/[\s_.:…-]+$/u, "");
  // In lower case only: a capital A at the end of a stem is a grade or a vitamin as often as it is an article.
  const article = /(?:^|\s)(an?)$/.exec(stem)?.[1];
  if (!article) return undefined;
  const said = options.filter((o) => !isPlaceholderOption(o));
  const sounds = said.map((o) => soundOf(plain(o.content)));
  // Where any option's sound is not settled by its first letter, say nothing.
  if (sounds.some((s) => s === undefined)) return undefined;
  const wanted = article === "an" ? "vowel" : "consonant";
  const fits = sounds.filter((s) => s === wanted).length;
  if (fits === 0 || fits === sounds.length) return undefined;
  const wrong = said.flatMap((o, i) => (sounds[i] === wanted ? [] : [placeLetter(options.indexOf(o))]));
  return note(
    FindingCode.GrammaticalCue,
    `The stem ends in "${article}", so only the options that start with ${wanted === "vowel" ? "a vowel" : "a consonant"} fit it, and the grammar rules out option${wrong.length === 1 ? "" : "s"} ${wrong.join(", ")}. Write "a/an", or end the stem so that every option fits.`,
    "stem",
  );
}

/** Two options that say the same thing: the student cannot be asked to choose between them. */
function duplicateOptions(question: Question): Finding | undefined {
  const seen = new Map<string, number[]>();
  const add = (signature: string, at: number) => {
    if (signature === "") return;
    // Added to the list in place: a list rebuilt for each option (a copy of every one before it) made N identical options N squared
    // (40,000 of them took 5 seconds on every save).
    const places = seen.get(signature);
    if (places) places.push(at);
    else seen.set(signature, [at]);
  };
  let what = "options";
  let name = (at: number) => `option ${placeLetter(at)}`;
  let field = "body.options";

  const options = choiceOptions(question);
  if (options) {
    options.forEach((o, i) => {
      if (isPlaceholderOption(o)) return;
      const refs = collectRefs(o.content);
      add(`${copyForm(plain(o.content))}|${refs.media.join(",")}|${refs.math.join(",")}`, i);
    });
  } else if (isMatching(question)) {
    // Two pairs may share a right-hand entry on purpose (a category that two things belong to). An extra entry that repeats
    // another is the one that cannot be meant: it matches nothing, and is the same as one that does.
    what = "right-hand entries";
    field = "body.pairs";
    const pairs = question.body.pairs.length;
    name = (at) => (at < pairs ? `right-hand entry ${at + 1}` : `extra entry ${at - pairs + 1}`);
    [...question.body.pairs.map((p) => p.right), ...question.body.distractors].forEach((r, i) => add(copyForm(r), i));
    for (const [signature, at] of seen) if (!at.some((i) => i >= pairs)) seen.delete(signature);
  } else if (isOrdering(question)) {
    what = "items";
    field = "body.items";
    name = (at) => `item ${at + 1}`;
    question.body.items.forEach((item, i) => add(`${copyForm(plain(item.content))}|${collectRefs(item.content).media.join(",")}`, i));
  } else {
    return undefined;
  }

  const groups = [...seen.values()].filter((g) => g.length > 1);
  if (groups.length === 0) return undefined;
  const said = groups.map((g) => g.map(name).join(" and ")).join("; ");
  return note(
    FindingCode.DuplicateOption,
    `${what.charAt(0).toUpperCase()}${what.slice(1)} read the same (${said}), so a student cannot be asked to tell them apart. Change one, or take one out.`,
    field,
  );
}

/** The words that would be the answer, for the rules that look for an answer written somewhere it should not be. */
function answerWords(question: Question): string[] {
  if (isChoice(question) || isMultipleResponse(question)) {
    if (!hasUsableKey(question)) return [];
    return question.body.options.filter((o) => o.correct && !isPlaceholderOption(o)).map((o) => plain(o.content));
  }
  if (question.type === "shortAnswer") return (question.body as { accepted: string[] }).accepted;
  if (question.type === "fillInBlank") return (question.body as { blanks: Array<{ accepted: string[] }> }).blanks.flatMap((b) => b.accepted);
  return [];
}

/** The description of a picture in the stem says what the question asks for. A screen reader reads it out. */
function altGivesAnswer(question: Question): Finding | undefined {
  const used = new Set(collectRefs(question.stem).media);
  const pictures = question.media.filter((m) => used.has(m.id));
  if (pictures.length === 0) return undefined;
  const answers = answerWords(question).map((a) => wordTokens(a).join(" ")).filter((a) => a.length >= 4);
  for (const picture of pictures) {
    const described = ` ${wordTokens(picture.alt).join(" ")} `;
    const given = answers.find((a) => described.includes(` ${a} `));
    if (given === undefined) continue;
    return note(
      FindingCode.AltTextGivesAnswer,
      `The description of the picture ("${shorten(picture.alt)}") contains the answer ("${shorten(given, 30)}"), so a student who has it read out is told the answer. Describe what the picture shows without saying what the question asks for.`,
      "media",
    );
  }
  return undefined;
}

/** A picture and a colour word: the question may depend on telling colours apart. */
function colourOnly(question: Question): Finding | undefined {
  if (collectRefs(question.stem).media.length === 0) return undefined;
  const texts = [plain(question.stem), ...(choiceOptions(question) ?? []).map((o) => plain(o.content))];
  const pattern = new RegExp(`\\b(${COLOURS.join("|")})\\b`, "i");
  for (const text of texts) {
    const word = pattern.exec(text)?.[1];
    if (!word) continue;
    return note(
      FindingCode.ColourOnlyMeaning,
      `The question has a picture and uses a colour ("${word.toLowerCase()}"). A student who cannot tell colours apart, or who has the picture read out, may not be able to use it. Say it another way as well: a label, a pattern or a position.`,
      "stem",
    );
  }
  return undefined;
}

function longMatching(question: Question): Finding | undefined {
  if (!isMatching(question) || question.body.pairs.length <= LONG_MATCHING_LIST) return undefined;
  return note(
    FindingCode.LongMatchingList,
    `This matching question has ${question.body.pairs.length} pairs. A long list is hard to hold in mind, and harder for a student who has each entry read out. ${LONG_MATCHING_LIST} or fewer is easier; consider splitting it.`,
    "body.pairs",
  );
}

/**
 * An accepted answer with a curly quotation mark or apostrophe, a dash or an ellipsis in it. A student types an answer on a keyboard
 * that makes the plain forms, and a learning system compares what was typed with what is accepted letter for letter, so "Earth's
 * moon" is marked wrong against an accepted "Earth’s moon". (A phone may curl an apostrophe by itself, so the plain form is not the
 * only one a student may type, and the note asks for both.) It is a note and never a rewrite: which form a student types is not for
 * this program to guess, and the author's own accepted answer is not changed. It says nothing when the plain form is accepted too.
 */
function typedAnswerTypography(question: Question): Finding | undefined {
  const lists: Array<{ accepted: string[]; field: string; caseSensitive: boolean }> = [];
  const body = question.body as { accepted?: string[]; blanks?: Array<{ accepted: string[] }>; caseSensitive?: boolean };
  const caseSensitive = body.caseSensitive === true;
  if (question.type === "shortAnswer" && Array.isArray(body.accepted)) lists.push({ accepted: body.accepted, field: "body.accepted", caseSensitive });
  if (question.type === "fillInBlank" && Array.isArray(body.blanks)) {
    body.blanks.forEach((blank, i) => lists.push({ accepted: blank.accepted ?? [], field: `body.blanks.${i}.accepted`, caseSensitive }));
  }
  for (const list of lists) {
    const key = (text: string): string => (list.caseSensitive ? text.trim() : text.trim().toLowerCase());
    const have = new Set(list.accepted.map(key));
    for (const answer of list.accepted) {
      const flat = foldTypography(answer).trim();
      if (flat === "" || flat === answer.trim() || have.has(key(flat))) continue;
      return note(
        FindingCode.TypedAnswerTypography,
        `The accepted answer "${shorten(answer, 40)}" has a curly quotation mark or apostrophe, a dash or an ellipsis in it. A student's keyboard may type the plain form instead, and a learning system compares what is typed letter for letter, so "${shorten(flat, 40)}" would be marked wrong. Add "${shorten(flat, 40)}" as another accepted answer.`,
        list.field,
      );
    }
  }
  return undefined;
}

/** Every note the item checks have about one question. At most one of each code. */
export function checkItemQuality(question: Question): Finding[] {
  const options = choiceOptions(question);
  const found: Array<Finding | undefined> = [
    options ? placeDependent(options) : undefined,
    options ? longestIsRight(question, options) : undefined,
    negativeStem(question),
    options ? grammaticalCue(question, options) : undefined,
    duplicateOptions(question),
    altGivesAnswer(question),
    colourOnly(question),
    longMatching(question),
    typedAnswerTypography(question),
  ];
  return found.filter((f): f is Finding => f !== undefined);
}

/**
 * The question with its item notes made fresh: the ones it had are replaced by what the checks say now, and a note that an author
 * dismissed stays dismissed when the same check speaks again about the same part of the question. Nothing else about the question
 * changes. In particular the version, the history and the status are left alone, because looking at a question is not editing it.
 */
export function withFreshQuality(question: Question): Question {
  const before = question.findings.filter((f) => QUALITY_CODES.has(f.code));
  const dismissals = new Map<string, Finding>();
  for (const f of before) if (f.dismissed) dismissals.set(`${f.code}|${f.field ?? ""}`, f);

  const fresh = checkItemQuality(question).map((f) => {
    const dismissal = dismissals.get(`${f.code}|${f.field ?? ""}`);
    return dismissal
      ? { ...f, dismissed: true, ...(dismissal.dismissedBy ? { dismissedBy: dismissal.dismissedBy } : {}), ...(dismissal.dismissedAt ? { dismissedAt: dismissal.dismissedAt } : {}) }
      : f;
  });
  if (JSON.stringify(before) === JSON.stringify(fresh)) return question;
  return { ...question, findings: [...question.findings.filter((f) => !QUALITY_CODES.has(f.code)), ...fresh] };
}
