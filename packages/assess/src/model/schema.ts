/**
 * Validation for the open question model.
 *
 * Hand-written rather than pulled from a schema library, for two reasons. The
 * engine has no runtime dependencies at all, which keeps the Tauri bundle
 * small and the supply chain short for a free tool with one maintainer. And
 * the envelope rejects unknown keys, which is what mechanically enforces the
 * boundary the plan draws: delivery settings such as attempts, time limits or
 * feedback timing cannot be smuggled onto a question, because the validator
 * will not accept them. `metadata.custom` is the one designated escape hatch,
 * and it is for publisher metadata, not for behaviour.
 */

import { isId } from "./ids.ts";
import {
  BLOOM_LEVELS,
  DIFFICULTIES,
  MAX_POINTS,
  MAX_TITLE_LENGTH,
  QUESTION_TYPES,
  STATUSES,
  type Question,
  type QuestionType,
} from "./question.ts";

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
}

const ENVELOPE_KEYS = new Set([
  "id",
  "version",
  "type",
  "title",
  "stem",
  "points",
  "body",
  "feedback",
  "metadata",
  "media",
  "math",
  "findings",
  "history",
  "origin",
]);

/**
 * Keys that have been tried on a question and must never land there. Naming
 * them produces a message that explains the boundary instead of a bare
 * "unknown key".
 */
const DELIVERY_SETTING_KEYS: Record<string, string> = {
  attempts: "attempts are a property of the quiz, not the item",
  maxAttempts: "attempts are a property of the quiz, not the item",
  timeLimit: "a time limit is a property of the quiz, not the item",
  showAnswers: "when answers are shown is a property of the quiz, not the item",
  showCorrectAnswers: "when answers are shown is a property of the quiz, not the item",
  feedbackTiming: "feedback timing is a property of the quiz, not the item",
  dueDate: "scheduling is a property of the course, not the item",
  available: "availability is a property of the course, not the item",
  weight: "weighting within a test belongs to the test, not the item",
  shuffleQuestions: "question order belongs to the test, not the item",
};

class Checker {
  readonly issues: Issue[] = [];

  fail(path: string, message: string): false {
    this.issues.push({ path, message });
    return false;
  }

  string(value: unknown, path: string, opts: { max?: number; allowEmpty?: boolean } = {}): boolean {
    if (typeof value !== "string") return this.fail(path, "must be a string");
    if (!opts.allowEmpty && value.trim().length === 0) return this.fail(path, "must not be empty");
    if (opts.max !== undefined && value.length > opts.max) {
      return this.fail(path, `must be at most ${opts.max} characters`);
    }
    return true;
  }

  number(value: unknown, path: string, opts: { min?: number; max?: number } = {}): boolean {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return this.fail(path, "must be a finite number");
    }
    if (opts.min !== undefined && value < opts.min) return this.fail(path, `must be at least ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) return this.fail(path, `must be at most ${opts.max}`);
    return true;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") return this.fail(path, "must be true or false");
    return true;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): boolean {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      return this.fail(path, `must be one of: ${allowed.join(", ")}`);
    }
    return true;
  }

  array(value: unknown, path: string, opts: { min?: number; max?: number } = {}): value is unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, "must be an array");
      return false;
    }
    if (opts.min !== undefined && value.length < opts.min) {
      this.fail(path, `must have at least ${opts.min} entries`);
    }
    if (opts.max !== undefined && value.length > opts.max) {
      this.fail(path, `must have at most ${opts.max} entries`);
    }
    return true;
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(path, "must be an object");
      return false;
    }
    return true;
  }

  richText(value: unknown, path: string, opts: { allowEmpty?: boolean } = {}): boolean {
    if (!this.object(value, path)) return false;
    const format = value["format"];
    if (format !== "rich" && format !== "plain") {
      return this.fail(`${path}.format`, 'must be "rich" or "plain"');
    }
    return this.string(value["content"], `${path}.content`, { allowEmpty: opts.allowEmpty ?? true });
  }

  /** Unknown keys are an error, not a shrug. */
  noUnknownKeys(value: Record<string, unknown>, path: string, known: Set<string>): void {
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      const explanation = DELIVERY_SETTING_KEYS[key];
      this.fail(
        path === "" ? key : `${path}.${key}`,
        explanation ? `not allowed on a question: ${explanation}` : "unknown key",
      );
    }
  }
}

/**
 * Structure only.
 *
 * Whether an answer key is present and sane is NOT checked here. The schema's
 * job is whether a question is well formed; whether it is a good question is
 * the quality checker's job (quality/answer-key.ts), and it reports findings
 * rather than refusing the question. That split matters in two places: a
 * question half-written in the editor still has to be saveable, and a question
 * imported from a file with no key has to be storable so it can be shown
 * beside its source text and repaired.
 */
function checkOptionList(c: Checker, value: unknown, path: string, _singleAnswer: boolean): void {
  if (!c.array(value, path, { min: 2 })) return;
  const seen = new Set<string>();
  value.forEach((raw, i) => {
    const p = `${path}.${i}`;
    if (!c.object(raw, p)) return;
    c.noUnknownKeys(raw, p, new Set(["id", "content", "correct", "feedback", "fixedPosition"]));
    c.string(raw["id"], `${p}.id`);
    if (typeof raw["id"] === "string") {
      if (seen.has(raw["id"])) c.fail(`${p}.id`, "duplicate option id");
      seen.add(raw["id"]);
    }
    c.richText(raw["content"], `${p}.content`, { allowEmpty: false });
    c.boolean(raw["correct"], `${p}.correct`);
    if (raw["feedback"] !== undefined) c.richText(raw["feedback"], `${p}.feedback`);
    if (raw["fixedPosition"] !== undefined) c.boolean(raw["fixedPosition"], `${p}.fixedPosition`);
  });
}

function checkBody(c: Checker, type: QuestionType, body: unknown): void {
  const p = "body";
  if (!c.object(body, p)) return;

  switch (type) {
    case "multipleChoice":
      c.noUnknownKeys(body, p, new Set(["shuffle", "options"]));
      c.boolean(body["shuffle"], `${p}.shuffle`);
      checkOptionList(c, body["options"], `${p}.options`, true);
      return;

    case "multipleResponse":
      c.noUnknownKeys(body, p, new Set(["shuffle", "partialCredit", "options"]));
      c.boolean(body["shuffle"], `${p}.shuffle`);
      c.boolean(body["partialCredit"], `${p}.partialCredit`);
      checkOptionList(c, body["options"], `${p}.options`, false);
      return;

    case "trueFalse":
      c.noUnknownKeys(body, p, new Set(["correct"]));
      // Absent is legal and means no key was given. An unkeyed question has to
      // be storable so it can be shown beside its source text and repaired;
      // the answer-key check is what refuses to let it reach a learner.
      if (body["correct"] !== undefined) c.boolean(body["correct"], `${p}.correct`);
      return;

    case "fillInBlank": {
      c.noUnknownKeys(body, p, new Set(["caseSensitive", "blanks"]));
      c.boolean(body["caseSensitive"], `${p}.caseSensitive`);
      if (!c.array(body["blanks"], `${p}.blanks`, { min: 1 })) return;
      (body["blanks"] as unknown[]).forEach((raw, i) => {
        const bp = `${p}.blanks.${i}`;
        if (!c.object(raw, bp)) return;
        c.noUnknownKeys(raw, bp, new Set(["id", "label", "accepted"]));
        c.string(raw["id"], `${bp}.id`);
        if (raw["label"] !== undefined) c.string(raw["label"], `${bp}.label`);
        if (c.array(raw["accepted"], `${bp}.accepted`, { min: 1 })) {
          // An empty string is how an unkeyed blank is stored. The answer-key
          // check is what refuses it, and a placeholder such as "(missing)"
          // would be worse: it reads as a real answer, so the check would pass.
          (raw["accepted"] as unknown[]).forEach((a, j) =>
            c.string(a, `${bp}.accepted.${j}`, { allowEmpty: true }),
          );
        }
      });
      return;
    }

    case "matching": {
      c.noUnknownKeys(body, p, new Set(["pairs", "distractors", "shuffle"]));
      c.boolean(body["shuffle"], `${p}.shuffle`);
      if (c.array(body["pairs"], `${p}.pairs`, { min: 2 })) {
        (body["pairs"] as unknown[]).forEach((raw, i) => {
          const pp = `${p}.pairs.${i}`;
          if (!c.object(raw, pp)) return;
          c.noUnknownKeys(raw, pp, new Set(["id", "left", "right"]));
          c.string(raw["id"], `${pp}.id`);
          c.richText(raw["left"], `${pp}.left`, { allowEmpty: false });
          c.string(raw["right"], `${pp}.right`);
        });
      }
      if (c.array(body["distractors"], `${p}.distractors`)) {
        (body["distractors"] as unknown[]).forEach((d, i) =>
          c.string(d, `${p}.distractors.${i}`),
        );
      }
      return;
    }

    case "ordering": {
      c.noUnknownKeys(body, p, new Set(["items"]));
      if (!c.array(body["items"], `${p}.items`, { min: 2 })) return;
      const items = body["items"] as unknown[];
      const positions = new Set<number>();
      items.forEach((raw, i) => {
        const ip = `${p}.items.${i}`;
        if (!c.object(raw, ip)) return;
        c.noUnknownKeys(raw, ip, new Set(["id", "content", "position"]));
        c.string(raw["id"], `${ip}.id`);
        c.richText(raw["content"], `${ip}.content`, { allowEmpty: false });
        if (c.number(raw["position"], `${ip}.position`, { min: 1, max: items.length })) {
          const pos = raw["position"] as number;
          if (positions.has(pos)) c.fail(`${ip}.position`, "duplicate position");
          positions.add(pos);
        }
      });
      if (positions.size > 0 && positions.size !== items.length) {
        c.fail(`${p}.items`, "positions must be 1..n with no gaps or repeats");
      }
      return;
    }

    case "numeric": {
      c.noUnknownKeys(body, p, new Set(["mode", "value", "min", "max", "tolerance", "units"]));
      if (!c.oneOf(body["mode"], `${p}.mode`, ["exact", "range", "tolerance"] as const)) return;
      const mode = body["mode"];
      if (mode === "exact") {
        c.number(body["value"], `${p}.value`);
      } else if (mode === "range") {
        const okMin = c.number(body["min"], `${p}.min`);
        const okMax = c.number(body["max"], `${p}.max`);
        if (okMin && okMax && (body["min"] as number) > (body["max"] as number)) {
          c.fail(`${p}.min`, "min must not be greater than max");
        }
      } else {
        c.number(body["value"], `${p}.value`);
        c.number(body["tolerance"], `${p}.tolerance`, { min: 0 });
      }
      if (body["units"] !== undefined) c.string(body["units"], `${p}.units`);
      return;
    }

    case "shortAnswer": {
      c.noUnknownKeys(body, p, new Set(["caseSensitive", "accepted"]));
      c.boolean(body["caseSensitive"], `${p}.caseSensitive`);
      if (c.array(body["accepted"], `${p}.accepted`, { min: 1 })) {
        // Empty is storable for the same reason as in a fill in the blank.
        (body["accepted"] as unknown[]).forEach((a, i) =>
          c.string(a, `${p}.accepted.${i}`, { allowEmpty: true }),
        );
      }
      return;
    }

    case "essay": {
      c.noUnknownKeys(body, p, new Set(["modelAnswer", "rubric", "expectedWords"]));
      if (body["modelAnswer"] !== undefined) c.richText(body["modelAnswer"], `${p}.modelAnswer`);
      if (body["expectedWords"] !== undefined) {
        c.number(body["expectedWords"], `${p}.expectedWords`, { min: 1 });
      }
      if (body["rubric"] !== undefined && c.array(body["rubric"], `${p}.rubric`)) {
        (body["rubric"] as unknown[]).forEach((raw, i) => {
          const rp = `${p}.rubric.${i}`;
          if (!c.object(raw, rp)) return;
          c.noUnknownKeys(raw, rp, new Set(["criterion", "points", "description"]));
          c.string(raw["criterion"], `${rp}.criterion`);
          c.number(raw["points"], `${rp}.points`, { min: 0 });
          if (raw["description"] !== undefined) c.string(raw["description"], `${rp}.description`);
        });
      }
      return;
    }

    case "hotspot": {
      c.noUnknownKeys(body, p, new Set(["mediaRef", "regions", "alternative"]));
      c.string(body["mediaRef"], `${p}.mediaRef`);
      // The accessible alternative is required, not optional. Hotspot does not
      // ship until an author has to supply one.
      c.richText(body["alternative"], `${p}.alternative`, { allowEmpty: false });
      if (c.array(body["regions"], `${p}.regions`, { min: 1 })) {
        (body["regions"] as unknown[]).forEach((raw, i) => {
          const rp = `${p}.regions.${i}`;
          if (!c.object(raw, rp)) return;
          c.noUnknownKeys(raw, rp, new Set(["id", "shape", "coords", "correct"]));
          c.string(raw["id"], `${rp}.id`);
          c.oneOf(raw["shape"], `${rp}.shape`, ["rect", "circle", "poly"] as const);
          if (c.array(raw["coords"], `${rp}.coords`, { min: 3 })) {
            (raw["coords"] as unknown[]).forEach((n, j) => c.number(n, `${rp}.coords.${j}`));
          }
          c.boolean(raw["correct"], `${rp}.correct`);
        });
      }
      return;
    }

    case "calculated": {
      c.noUnknownKeys(body, p, new Set(["formula", "variables", "tolerance", "toleranceIsPercent"]));
      c.string(body["formula"], `${p}.formula`);
      c.number(body["tolerance"], `${p}.tolerance`, { min: 0 });
      c.boolean(body["toleranceIsPercent"], `${p}.toleranceIsPercent`);
      if (c.array(body["variables"], `${p}.variables`, { min: 1 })) {
        (body["variables"] as unknown[]).forEach((raw, i) => {
          const vp = `${p}.variables.${i}`;
          if (!c.object(raw, vp)) return;
          c.noUnknownKeys(raw, vp, new Set(["name", "min", "max", "decimals"]));
          c.string(raw["name"], `${vp}.name`);
          c.number(raw["min"], `${vp}.min`);
          c.number(raw["max"], `${vp}.max`);
          c.number(raw["decimals"], `${vp}.decimals`, { min: 0, max: 10 });
        });
      }
      return;
    }
  }
}

function checkMetadata(c: Checker, value: unknown): void {
  const p = "metadata";
  if (!c.object(value, p)) return;
  c.noUnknownKeys(
    value,
    p,
    new Set([
      "objective",
      "chapter",
      "section",
      "page",
      "bloom",
      "difficulty",
      "tags",
      "author",
      "status",
      "custom",
    ]),
  );
  for (const key of ["objective", "chapter", "section", "page", "author"]) {
    if (value[key] !== undefined) c.string(value[key], `${p}.${key}`);
  }
  if (value["bloom"] !== undefined) c.oneOf(value["bloom"], `${p}.bloom`, BLOOM_LEVELS);
  if (value["difficulty"] !== undefined) {
    c.oneOf(value["difficulty"], `${p}.difficulty`, DIFFICULTIES);
  }
  c.oneOf(value["status"], `${p}.status`, STATUSES);
  if (c.array(value["tags"], `${p}.tags`)) {
    (value["tags"] as unknown[]).forEach((t, i) => c.string(t, `${p}.tags.${i}`));
  }
  if (value["custom"] !== undefined && c.object(value["custom"], `${p}.custom`)) {
    for (const [key, v] of Object.entries(value["custom"] as Record<string, unknown>)) {
      c.string(v, `${p}.custom.${key}`);
    }
  }
}

function checkSidecars(c: Checker, raw: Record<string, unknown>): void {
  if (c.array(raw["media"], "media")) {
    (raw["media"] as unknown[]).forEach((m, i) => {
      const p = `media.${i}`;
      if (!c.object(m, p)) return;
      c.noUnknownKeys(m, p, new Set(["id", "file", "mime", "alt", "decorative", "width", "height"]));
      c.string(m["id"], `${p}.id`);
      c.string(m["file"], `${p}.file`);
      c.string(m["mime"], `${p}.mime`);
      c.string(m["alt"], `${p}.alt`, { allowEmpty: true });
      if (m["decorative"] !== undefined) c.boolean(m["decorative"], `${p}.decorative`);
      if (m["width"] !== undefined) c.number(m["width"], `${p}.width`, { min: 1 });
      if (m["height"] !== undefined) c.number(m["height"], `${p}.height`, { min: 1 });
    });
  }
  if (c.array(raw["math"], "math")) {
    (raw["math"] as unknown[]).forEach((m, i) => {
      const p = `math.${i}`;
      if (!c.object(m, p)) return;
      c.noUnknownKeys(m, p, new Set(["id", "latex", "mathml", "source"]));
      c.string(m["id"], `${p}.id`);
      c.string(m["latex"], `${p}.latex`, { allowEmpty: true });
      // Both representations are stored, which is the whole accessibility
      // gain over an equation that arrives as a picture.
      c.string(m["mathml"], `${p}.mathml`, { allowEmpty: true });
      if (m["source"] !== undefined) {
        c.oneOf(m["source"], `${p}.source`, ["omml", "typed", "latex", "image"] as const);
      }
    });
  }
}

function checkFindingsAndHistory(c: Checker, raw: Record<string, unknown>): void {
  if (c.array(raw["findings"], "findings")) {
    (raw["findings"] as unknown[]).forEach((f, i) => {
      const p = `findings.${i}`;
      if (!c.object(f, p)) return;
      c.noUnknownKeys(
        f,
        p,
        new Set([
          "code",
          "severity",
          "message",
          "field",
          "source",
          "dismissed",
          "dismissedBy",
          "dismissedAt",
        ]),
      );
      c.string(f["code"], `${p}.code`);
      c.oneOf(f["severity"], `${p}.severity`, ["error", "warn", "info"] as const);
      c.string(f["message"], `${p}.message`);
    });
  }
  if (c.array(raw["history"], "history")) {
    (raw["history"] as unknown[]).forEach((h, i) => {
      const p = `history.${i}`;
      if (!c.object(h, p)) return;
      c.noUnknownKeys(h, p, new Set(["at", "by", "change", "fromVersion", "toVersion"]));
      c.string(h["at"], `${p}.at`);
      c.string(h["by"], `${p}.by`);
      c.string(h["change"], `${p}.change`);
    });
  }
}

export function validateQuestion(raw: unknown): ValidationResult {
  const c = new Checker();
  if (!c.object(raw, "")) return { ok: false, issues: c.issues };

  c.noUnknownKeys(raw, "", ENVELOPE_KEYS);

  if (!isId(raw["id"], "q")) c.fail("id", "must be a question id of the form q_<26 characters>");
  c.number(raw["version"], "version", { min: 1 });
  c.string(raw["title"], "title", { max: MAX_TITLE_LENGTH });
  c.richText(raw["stem"], "stem", { allowEmpty: false });
  c.number(raw["points"], "points", { min: 0, max: MAX_POINTS });

  if (c.oneOf(raw["type"], "type", QUESTION_TYPES)) {
    checkBody(c, raw["type"] as QuestionType, raw["body"]);
  }

  if (c.object(raw["feedback"], "feedback")) {
    c.noUnknownKeys(raw["feedback"] as Record<string, unknown>, "feedback", new Set(["general", "correct", "incorrect"]));
    for (const key of ["general", "correct", "incorrect"]) {
      const v = (raw["feedback"] as Record<string, unknown>)[key];
      if (v !== undefined) c.richText(v, `feedback.${key}`);
    }
  }

  checkMetadata(c, raw["metadata"]);
  checkSidecars(c, raw);
  checkFindingsAndHistory(c, raw);

  if (raw["origin"] !== undefined && c.object(raw["origin"], "origin")) {
    const o = raw["origin"] as Record<string, unknown>;
    c.noUnknownKeys(o, "origin", new Set(["kind", "bankId", "questionId", "source", "profile", "at"]));
    c.oneOf(o["kind"], "origin.kind", ["authored", "import", "copy", "link"] as const);
  }

  return { ok: c.issues.length === 0, issues: c.issues };
}

/** Throwing form, for places where an invalid question is a programming error. */
export function assertValidQuestion(raw: unknown): asserts raw is Question {
  const result = validateQuestion(raw);
  if (!result.ok) {
    const lines = result.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n");
    throw new Error(`Question failed validation:\n${lines}`);
  }
}

export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("\n");
}
