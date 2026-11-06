/**
 * A blueprint: a recipe for a test that a bank keeps, so that "5 from each chapter, 3 on this objective" is written once.
 *
 * A blueprint is a list of rules, and a rule is a value on one axis (a chapter, an objective, a tag, a Bloom level) and how many
 * questions to take that have it. Applying a blueprint to a bank is `pickQuestions` for each rule in turn, with what the earlier rules
 * took counted as already chosen, so a question that fits two rules is taken once and the second rule says it found it taken.
 *
 * What it keeps and what it does not:
 *
 *  - It keeps the recipe and not the questions. Applying it with another seed, or after the bank has changed, gives another test. A
 *    test that was made from it is a test record, which holds its own copies; changing or removing the blueprint never touches one.
 *  - It keeps no seed. The seed belongs to the draw, and the test record keeps the one that was used.
 *  - It never fills a rule up with something else when the bank is short. A rule that found fewer than it wanted says by how many,
 *    and the test is short by that many, because a question chosen to make up the number is a question nobody picked.
 *  - It has no say about a key: `pickQuestions` leaves out a question with no usable key, a retired one and a copy of one already
 *    taken, and counts each, and that is what a blueprint reports too.
 */

import { isId, newBlueprintId } from "../model/ids.ts";
import type { Issue } from "../model/schema.ts";
import type { Question } from "../model/question.ts";
import { COVERAGE_AXES, isCoverageAxis, type CoverageAxis } from "./coverage.ts";
import { MOST_PICKED, pickQuestions, type PickResult } from "./pick.ts";

export const BLUEPRINT_VERSION = 1;

/** The most rules a blueprint holds, and the longest a name or a value is. A limit keeps a file that was damaged from being followed forever. */
export const MOST_RULES = 50;
export const LONGEST_NAME = 120;
export const LONGEST_VALUE = 200;

export interface BlueprintRule {
  axis: CoverageAxis;
  /** The value the questions must have on the axis. `(none)` asks for those that have none. Never blank: see `validateBlueprint`. */
  value: string;
  /** How many to take, a whole number from 1 to `MOST_PICKED`. */
  count: number;
}

export interface Blueprint {
  recordVersion: typeof BLUEPRINT_VERSION;
  id: string;
  name: string;
  rules: BlueprintRule[];
  created: string;
  modified: string;
}

/** A blueprint as a person writes it: the rules' values are tidied, and nothing else is changed. */
export function newBlueprint(input: { name: string; rules: ReadonlyArray<{ axis: string; value: string; count: number }> }, at: string = new Date().toISOString(), id: string = newBlueprintId()): Blueprint {
  return {
    recordVersion: BLUEPRINT_VERSION,
    id,
    name: input.name.trim(),
    // A value is trimmed because the questions' values are (`valuesOn`), so " Chapter 1" would match nothing and say nothing.
    rules: input.rules.map((r) => ({ axis: r.axis as CoverageAxis, value: r.value.trim(), count: r.count })),
    created: at,
    modified: at,
  };
}

export type BlueprintCheck = { ok: true; blueprint: Blueprint } | { ok: false; issues: Issue[] };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isDay = (v: unknown): v is string => typeof v === "string" && v.length >= 10 && v.length <= 40 && !Number.isNaN(Date.parse(v));

/**
 * Whether a recipe holds together. Every field is named, and a field this program does not know is refused: a blueprint written by
 * something newer would be rewritten by a save without its extra field if it were read and written back, and that is a thing lost
 * without a word, so it is kept as it was and reported instead.
 *
 * A rule with a blank value is refused. `matchesFacets` treats a blank value as "no filter", so a rule for "" would take from the whole
 * bank and read as though it had asked for something.
 */
export function validateBlueprint(value: unknown): BlueprintCheck {
  const issues: Issue[] = [];
  const bad = (path: string, message: string): void => void issues.push({ path, message });
  if (!isObject(value)) return { ok: false, issues: [{ path: "", message: "A blueprint is an object." }] };
  const known = ["recordVersion", "id", "name", "rules", "created", "modified"];
  for (const key of Object.keys(value)) if (!known.includes(key)) bad(key, `${key} is not a field of a blueprint, so this file was not read as one.`);
  if (value["recordVersion"] !== BLUEPRINT_VERSION) bad("recordVersion", `This record is version ${String(value["recordVersion"])}, and this program reads version ${BLUEPRINT_VERSION}.`);
  if (!isId(value["id"], "bp")) bad("id", "The id is not a blueprint id.");
  const name = value["name"];
  if (typeof name !== "string" || name.trim() === "" || name !== name.trim()) bad("name", "A blueprint needs a name, with no space at either end.");
  else if (name.length > LONGEST_NAME) bad("name", `A name is at most ${LONGEST_NAME} characters.`);
  if (!isDay(value["created"])) bad("created", "The time it was made is a date and time.");
  if (!isDay(value["modified"])) bad("modified", "The time it was last changed is a date and time.");
  const rules = value["rules"];
  if (!Array.isArray(rules)) bad("rules", "The rules are a list.");
  else {
    if (rules.length === 0) bad("rules", "A blueprint needs at least one rule.");
    if (rules.length > MOST_RULES) bad("rules", `A blueprint has at most ${MOST_RULES} rules.`);
    const seen = new Set<string>();
    rules.slice(0, MOST_RULES).forEach((raw, i) => {
      const at = `rules.${i}`;
      if (!isObject(raw)) return bad(at, "A rule is an object.");
      for (const key of Object.keys(raw)) if (!["axis", "value", "count"].includes(key)) bad(`${at}.${key}`, `${key} is not a field of a rule.`);
      const axis = raw["axis"];
      if (typeof axis !== "string" || !isCoverageAxis(axis)) bad(`${at}.axis`, `The axis is one of ${COVERAGE_AXES.join(", ")}.`);
      const v = raw["value"];
      if (typeof v !== "string" || v.trim() === "") bad(`${at}.value`, "A rule needs a value. A blank one would match every question.");
      else if (v !== v.trim()) bad(`${at}.value`, "A value has no space at either end, because the questions' values have none and it would match nothing.");
      else if (v.length > LONGEST_VALUE) bad(`${at}.value`, `A value is at most ${LONGEST_VALUE} characters.`);
      const count = raw["count"];
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MOST_PICKED) bad(`${at}.count`, `The number of questions is a whole number from 1 to ${MOST_PICKED}.`);
      if (typeof axis === "string" && typeof v === "string") {
        const key = `${axis}\u0000${v}`;
        if (seen.has(key)) bad(at, "Two rules ask for the same thing. Make it one rule with the number added up.");
        seen.add(key);
      }
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, blueprint: value as unknown as Blueprint };
}

export interface RuleResult {
  rule: BlueprintRule;
  /** The questions this rule took, in the order they were taken. */
  ids: string[];
  /** How many it wanted that it did not find. */
  short: number;
  /** What was found and what was left out, as `pickQuestions` counts them. */
  pick: PickResult;
}

export interface BlueprintDraw {
  /** Every question taken, rule by rule in the order of the rules. */
  ids: string[];
  /** How many the blueprint asks for in all, and how many short it came out. */
  wanted: number;
  short: number;
  rules: RuleResult[];
}

export interface DrawOptions {
  /** The same seed takes the same questions from the same bank. */
  seed?: string;
  /** Questions already in the test: not taken again, and nothing alike to them is taken. */
  chosen?: readonly string[];
}

/** Takes the questions a blueprint asks for from a bank's questions. Reads nothing but the questions it is given and changes none. */
export function drawBlueprint(questions: readonly Question[], blueprint: Blueprint, options: DrawOptions = {}): BlueprintDraw {
  const ids: string[] = [];
  const rules: RuleResult[] = [];
  let wanted = 0;
  let short = 0;
  for (const rule of blueprint.rules) {
    const pick = pickQuestions(questions, {
      axis: rule.axis,
      value: rule.value,
      count: rule.count,
      chosen: [...(options.chosen ?? []), ...ids],
      // The rule is in the seed, so two rules that find the same candidates do not take the same ones in the same order.
      seed: `${options.seed ?? ""}:blueprint:${blueprint.id}:${rule.axis}:${rule.value}`,
    });
    ids.push(...pick.ids);
    wanted += rule.count;
    const missing = rule.count - pick.ids.length;
    short += missing;
    rules.push({ rule, ids: pick.ids, short: missing, pick });
  }
  return { ids, wanted, short, rules };
}

/** What a draw says in a line, for a person: how many were taken, and for each rule that came out short, what was in the way. */
export function describeDraw(draw: BlueprintDraw): string[] {
  const lines = [`${draw.ids.length} of ${draw.wanted} questions taken${draw.short > 0 ? `, ${draw.short} short` : ""}.`];
  for (const r of draw.rules) {
    if (r.short === 0) continue;
    const l = r.pick.left;
    const why = [
      l.noKey > 0 ? `${l.noKey} with no usable answer key` : "",
      l.retired > 0 ? `${l.retired} retired` : "",
      l.chosen > 0 ? `${l.chosen} already in the test` : "",
      l.alike > 0 ? `${l.alike} alike to one already taken` : "",
    ].filter((s) => s !== "");
    lines.push(`${r.rule.axis} ${r.rule.value}: wanted ${r.rule.count}, took ${r.ids.length}${why.length > 0 ? `; left out ${why.join(", ")}` : "; the bank has no more"}.`);
  }
  return lines;
}
