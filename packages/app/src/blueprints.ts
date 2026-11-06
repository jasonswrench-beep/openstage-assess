/**
 * Blueprints in the app: a stored recipe for a test ("5 from chapter 1, 3 on this objective"), kept in the bank, and a draw from it.
 *
 * A draw chooses nothing for the person. It answers with the questions the recipe would take, the same way Pick for me does, and the
 * screen adds them to the ones being chosen, where the person still sees every one and can take any out. Nothing about a test changes
 * until the person makes it, and a test that was made from a blueprint keeps its own copies, so changing or removing the blueprint
 * afterwards touches no test.
 */

import { randomBytes } from "node:crypto";

import { COVERAGE_AXES, describeDraw, drawBlueprint, LONGEST_NAME, LONGEST_VALUE, MOST_PICKED, MOST_RULES, newBlueprint, type Blueprint, type BlueprintRule } from "./engine.ts";
import type { ApiRequest, ApiResponse, Context } from "./api.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { jsonObject, oneOf, onlyFields, text, whole } from "./request.ts";

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

function show(bp: Blueprint): Record<string, unknown> {
  return { id: bp.id, name: bp.name, rules: bp.rules.map((r) => ({ axis: r.axis, value: r.value, count: r.count })), created: bp.created, modified: bp.modified };
}

function nameOf(value: unknown): string {
  const name = (text(value, "The blueprint's name", LONGEST_NAME, true) as string).trim();
  if (name === "") throw badRequest("The blueprint's name is needed.");
  return name;
}

function rulesOf(value: unknown): BlueprintRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MOST_RULES) throw badRequest(`The rules must be a list of 1 to ${MOST_RULES}.`);
  return value.map((raw: unknown, i: number) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw badRequest(`Rule ${i + 1} must be an object.`);
    const rule = raw as Record<string, unknown>;
    onlyFields(rule, ["axis", "value", "count"], `Rule ${i + 1}`);
    const found = (text(rule["value"], `The value in rule ${i + 1}`, LONGEST_VALUE, true) as string).trim();
    // A blank value is refused here as well as in the engine: the question filter reads a blank as "no filter", and a rule that
    // seemed to ask for something and took from the whole bank would be a test nobody chose.
    if (found === "") throw badRequest(`Rule ${i + 1} needs a value.`);
    return { axis: oneOf(rule["axis"], COVERAGE_AXES, `what rule ${i + 1} is by`), value: found, count: whole(rule["count"], `How many in rule ${i + 1}`, 1, MOST_PICKED) };
  });
}

/** What the engine refuses (a repeated name, two rules that ask for one thing) is the person's to fix, so it is a bad request and not a fault. */
function asBadRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest((error as Error).message);
  }
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((v) => typeof v !== "string" || v.length > 80)) throw badRequest("The questions must be a list of question ids.");
  return value as string[];
}

/** /api/sheets/:bank/blueprints, .../blueprints/:id and .../blueprints/:id/draw */
export async function blueprintsRoute(ctx: Context, req: ApiRequest, bankName: string): Promise<ApiResponse> {
  const [, , , id, action] = req.segments;

  if (id === undefined) {
    if (req.method === "GET") {
      const bank = await ctx.banks.open(bankName);
      return ok({ blueprints: bank.listBlueprints().map(show) });
    }
    if (req.method === "POST") {
      const input = jsonObject(req);
      onlyFields(input, ["name", "rules"], "The request");
      const name = nameOf(input["name"]);
      const rules = rulesOf(input["rules"]);
      const made = await ctx.banks.change(bankName, (bank) => asBadRequest(() => bank.addBlueprint(newBlueprint({ name, rules }))));
      return ok({ blueprint: show(made) });
    }
    throw notFound("There is no such page.");
  }

  const bank = await ctx.banks.open(bankName);
  const found = bank.getBlueprint(id);
  if (!found) throw notFound("There is no such blueprint in this bank.");

  if (action === undefined) {
    if (req.method === "GET") return ok({ blueprint: show(found) });
    if (req.method === "PUT") {
      const input = jsonObject(req);
      onlyFields(input, ["name", "rules"], "The request");
      if (input["name"] === undefined && input["rules"] === undefined) throw badRequest("Say what to change: the name or the rules.");
      const change = { ...(input["name"] !== undefined ? { name: nameOf(input["name"]) } : {}), ...(input["rules"] !== undefined ? { rules: rulesOf(input["rules"]) } : {}) };
      const changed = await ctx.banks.change(bankName, (b) => asBadRequest(() => b.updateBlueprint(found.id, change)));
      return ok({ blueprint: show(changed) });
    }
    if (req.method === "DELETE") {
      await ctx.banks.change(bankName, (b) => void b.removeBlueprint(found.id));
      return ok({ removed: found.id });
    }
  }

  if (action === "draw" && req.method === "POST") {
    const input = jsonObject(req);
    onlyFields(input, ["chosen"], "The request");
    const chosen = input["chosen"] === undefined ? [] : idList(input["chosen"]);
    // A new seed each time: pressing it again draws other questions, and the person decides which to keep. The seed is told, so a
    // draw that was liked can be said again.
    const seed = randomBytes(6).toString("hex");
    const draw = drawBlueprint(bank.sortedQuestions(), found, { seed, chosen });
    return ok({
      ids: draw.ids,
      wanted: draw.wanted,
      short: draw.short,
      notes: describeDraw(draw),
      rules: draw.rules.map((r) => ({ axis: r.rule.axis, value: r.rule.value, count: r.rule.count, taken: r.ids.length, short: r.short, left: r.pick.left })),
      seed,
    });
  }
  throw notFound("There is no such page.");
}
