/**
 * Answer keys marked with formatting.
 *
 * Publisher test banks very often mark the right option by making it bold,
 * underlined, highlighted or coloured, and give no other key. Reading that is the
 * difference between a bank that imports and one that has to be keyed by hand, and
 * it is also the nearest this importer comes to guessing, so the rules are strict.
 *
 * What a mark means is a convention of the whole file, not a fact about one
 * question. So it is decided once, from all the choice questions together:
 *
 *   - A property (bold, italic, underline, a highlight, a colour) is a candidate
 *     when some options of a question carry it and others do not. An option
 *     carries it only if all of its text does, so a bold word inside an option is
 *     not a mark.
 *   - It becomes the file's convention only when most questions show it (at least
 *     80 percent of the choice questions, and at least three). A few bold options
 *     in a long bank are emphasis, not a key.
 *   - If two different properties both qualify and do not agree, there is no
 *     convention. A key chosen between bold and highlight would be a guess.
 *   - A question that already has a key in words (an asterisk, an "Answer:" line,
 *     an Answers list) keeps it. Formatting only supplies a key where there is none,
 *     and where it names different options than the key in words, that is said.
 *   - A question that does not follow the convention gets no key from formatting
 *     and a finding that says why, so it is looked at and not passed.
 *   - The convention is reported once for the file, so that the author can confirm
 *     that the formatting does mean the correct answer.
 *
 * The caller can also say what the mark is (`keyMark`), which skips the decision
 * about whether there is a convention but not the checks on each question, or turn
 * the whole thing off.
 */

import { finding, FindingCode, type Finding } from "../model/findings.ts";
import type { RawQuestion } from "./standard-text-scan.ts";
import type { SourceBlock, SourceRun } from "./types.ts";

/** The share of choice questions that must show a property before it is taken as the file's convention. */
const SHARE = 0.8;
/** The fewest questions that can establish a convention. */
const AT_LEAST = 3;

/** Type lines that make a question a choice question, besides no type line at all. */
const CHOICE_HINTS = new Set(["MC", "MA", "MR", "TF"]);

function propertiesOf(run: SourceRun): string[] {
  const found: string[] = [];
  if (run.bold) found.push("bold");
  if (run.italic) found.push("italic");
  if (run.underline) found.push("underline");
  if (run.highlight) found.push("highlight", `highlight:${run.highlight}`);
  if (run.color) found.push("color", `color:${run.color}`);
  return found;
}

/** The phrase a property goes by in a message. */
export function describeMark(property: string): string {
  if (property === "bold") return "bold";
  if (property === "italic") return "italics";
  if (property === "underline") return "underlining";
  if (property === "highlight") return "highlighting";
  if (property.startsWith("highlight:")) return `${property.slice(10)} highlighting`;
  if (property === "color") return "coloured text";
  if (property.startsWith("color:")) return `text in the colour ${property.slice(6)}`;
  return property;
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The properties that all of an option's own text carries, or undefined if it has
 * no text to judge. Only the option's own lines are read, from after its label,
 * so a bold label or bold feedback beneath it says nothing about the option.
 */
function carried(blocks: readonly SourceBlock[], option: RawQuestion["options"][number]): Set<string> | undefined {
  let shared: Set<string> | undefined;
  option.textBlocks.forEach((index, k) => {
    const block = blocks[index];
    if (!block?.runs) return;
    let position = 0;
    const from = k === 0 ? option.textOffset : 0;
    for (const run of block.runs) {
      const end = position + run.text.length;
      const text = run.text.slice(Math.max(0, from - position));
      position = end;
      if (text.trim().length === 0) continue;
      const here = propertiesOf(run);
      shared = shared === undefined ? new Set(here) : new Set(here.filter((p) => shared?.has(p)));
    }
  });
  return shared;
}

export interface FormatKeyOutcome {
  /** Findings about the file as a whole. */
  fileFindings: Finding[];
}

/**
 * Decide the file's convention and apply it. Sets `keyedByFormat` on options and
 * `formatMarked`, `formatConvention` and `notes` on questions.
 *
 * `keyMark` is "auto" to decide from the file, "off" to read no key from formatting,
 * or the name of a property ("bold", "underline", "highlight", "highlight:yellow",
 * "color", "color:FF0000") to take that as the mark.
 */
export function applyFormattingKey(blocks: readonly SourceBlock[], questions: readonly RawQuestion[], keyMark: string): FormatKeyOutcome {
  const none: FormatKeyOutcome = { fileFindings: [] };
  if (keyMark === "off") return none;
  if (!blocks.some((b) => b.runs && b.runs.length > 0)) return none;

  const eligible = questions.filter((q) => q.options.length >= 2 && (q.typeHint === undefined || CHOICE_HINTS.has(q.typeHint)));
  if (eligible.length === 0) return none;

  const signatures = new Map<RawQuestion, Array<Set<string> | undefined>>();
  const candidates = new Set<string>();
  for (const q of eligible) {
    const signature = q.options.map((o) => carried(blocks, o));
    signatures.set(q, signature);
    for (const s of signature) for (const p of s ?? []) candidates.add(p);
  }

  const markedBy = (q: RawQuestion, property: string): number[] =>
    (signatures.get(q) ?? []).flatMap((s, i) => (s?.has(property) ? [i] : []));
  const partial = (q: RawQuestion, property: string): boolean => {
    const marked = markedBy(q, property).length;
    return marked > 0 && marked < q.options.length;
  };

  // How many questions each property splits the options of.
  const shows = new Map<string, number>();
  for (const property of candidates) shows.set(property, eligible.filter((q) => partial(q, property)).length);

  const fileFindings: Finding[] = [];
  const keyless = eligible.filter((q) => !hasWordedKey(q));

  let convention: string[] | undefined;
  if (keyMark !== "auto") {
    convention = [keyMark];
  } else {
    const qualifying = [...candidates].filter((p) => {
      const n = shows.get(p) ?? 0;
      return n >= AT_LEAST && n >= SHARE * eligible.length;
    });
    // Properties that always mark the same options are one convention seen twice,
    // as a bold and underlined answer is, or "highlight" and "highlight:yellow".
    const groups = new Map<string, string[]>();
    for (const p of qualifying) {
      const pattern = eligible.map((q) => markedBy(q, p).join(",")).join("|");
      groups.set(pattern, [...(groups.get(pattern) ?? []), p]);
    }
    if (groups.size === 1) {
      const names = [...groups.values()][0] as string[];
      // Where a general property and a particular one go together, the general one is enough.
      convention = names.filter((p) => !(p.includes(":") && names.includes(p.slice(0, p.indexOf(":")))));
    } else if (groups.size > 1) {
      const named = [...groups.values()].map((g) => describeMark(g[0] as string));
      fileFindings.push(
        finding(
          FindingCode.FormattingKeyUnclear,
          "warn",
          `${sentence(named.join(" and "))} each set one option apart from the others in most choice questions, and they do not always pick the same option, so no answer was taken from formatting. Nothing was guessed.`,
        ),
      );
    } else if (keyless.length > 0 && candidates.size > 0) {
      const best = [...shows].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] > 0) {
        fileFindings.push(
          finding(
            FindingCode.FormattingKeyUnclear,
            "warn",
            `${sentence(describeMark(best[0]))} sets one option apart from the others in ${best[1]} of ${eligible.length} choice questions, which is not often enough to read as marking the correct answer (it takes at least ${AT_LEAST} questions and ${Math.round(SHARE * 100)} percent of them), so no answer was taken from formatting.`,
          ),
        );
      }
    }
  }

  if (!convention || convention.length === 0) return { fileFindings };

  const name = convention.map(describeMark).join(" and ");
  // "Bold and underlining set", but "bold sets".
  const several = convention.length > 1;
  let applied = 0;
  let broken = 0;
  for (const q of eligible) {
    // A question is marked by a property when it is partial under all of them.
    const lists = convention.map((p) => markedBy(q, p));
    const first = lists[0] as number[];
    const agree = lists.every((l) => l.join(",") === first.join(","));
    const marked = agree && first.length > 0 && first.length < q.options.length ? first : [];

    q.formatConvention = name;
    q.formatMarked = marked;
    if (hasWordedKey(q)) continue;

    if (marked.length > 0) {
      for (const i of marked) (q.options[i] as RawQuestion["options"][number]).keyedByFormat = true;
      applied++;
    } else {
      broken++;
      const every = lists.some((l) => l.length === q.options.length);
      q.notes.push(
        finding(
          FindingCode.FormattingKeyBroken,
          "warn",
          every
            ? `In this file ${name} marks the correct answer, but every option of this question is ${name}, so it marks none of them. No answer was taken from formatting.`
            : `In this file ${name} marks the correct answer, but ${agree ? `no option of this question is ${name}` : `${name} does not pick out the same options here`}. No answer was taken from formatting.`,
          { field: "body.options" },
        ),
      );
    }
  }

  if (applied > 0) {
    const showing = eligible.filter((q) => (q.formatMarked?.length ?? 0) > 0).length;
    fileFindings.push(
      finding(
        FindingCode.FormattingKeyUsed,
        "warn",
        `${sentence(name)} ${keyMark === "auto" ? (several ? "set the correct answer apart" : "sets the correct answer apart") : several ? "were taken to mark the correct answer" : "was taken to mark the correct answer"} in ${showing} of ${eligible.length} choice questions, so it was read as the answer key for the ${applied} that had no other key.` +
          (broken > 0 ? ` ${broken} ${broken === 1 ? "question does" : "questions do"} not follow it and ${broken === 1 ? "is" : "are"} flagged.` : "") +
          ` Check that ${name} ${several ? "do" : "does"} mean the correct answer in this file.`,
      ),
    );
  }
  return { fileFindings };
}

/** A key in words: an asterisk, an "Answer:" line, or an Answers list entry. */
function hasWordedKey(q: RawQuestion): boolean {
  return q.options.some((o) => o.starred) || q.answerLines.length > 0 || q.keyValues.length > 0 || q.keyAmbiguous;
}
