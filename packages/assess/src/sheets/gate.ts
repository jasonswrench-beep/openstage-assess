/**
 * The accuracy gate for the sheet reader, the counterpart of the import's 95 percent gate.
 *
 * Sheets with known answers are drawn (raster.ts), filled in the way students fill them, damaged in the ways scans and photographs
 * are, and read. Each question is then counted as read right, flagged, or read wrong. The rule the whole feature stands on is the
 * first line of the gate: an answer read wrong and not flagged is a failure, in every corpus, every run. A flag is not a failure, and
 * a refused page is not a failure; both are measured and reported, because a reader that flags everything is no use.
 *
 * Two corpora are made here, kept apart and reported apart: clean sheets filled in with a range of marks, and the same kind of sheet
 * damaged. A third, real sheets filled in by hand and scanned on real machines, cannot be made by a program and is not part of this
 * gate; it is what the targets in the specification are judged on, and it stays open in TESTING-TODO.md.
 *
 * Everything is made from a seed, so the same seed gives the same sheets and a failure can be made again.
 */

import { createQuestion } from "../model/create.ts";
import { seededRandom } from "../model/random.ts";
import { plainToRich } from "../model/richtext.ts";
import type { Question } from "../model/question.ts";
import { createTest, type TestRecord } from "../model/test.ts";
import { blur, crop, jpegBlocks, levels, noise, photocopy, placeInFrame, quarterTurn, rotate, shade, speckle, toBilevel, warp } from "./damage.ts";
import { layoutFor, type PaperName } from "./geometry.ts";
import type { GreyImage } from "./image.ts";
import { homographyFrom, type Point } from "./homography.ts";
import { planSheet, type SheetPlan, type SlotUse } from "./plan.ts";
import { SheetRaster, type MarkKind, type PencilMark, type SheetMarks } from "./raster.ts";
import { SheetReader, type SheetResult } from "./read.ts";

export type Profile = "careful" | "typical" | "sloppy" | "firm";

export interface GateOptions {
  /** How many sheets in each corpus. */
  sheets?: number;
  seed?: string;
  /** Called with a line of progress now and then. */
  progress?: (line: string) => void;
  /** Run only this corpus ("synthetic" or "damaged"). */
  only?: string;
  /** The reader to try, for a test of the gate itself: a reader that gives wrong answers must make the gate fail. */
  readerFor?: (record: TestRecord) => { read(image: GreyImage): SheetResult };
}

interface Truth {
  /** The places that are the student's answer: one place, several for a multiple response question, or none. */
  places: number[];
  /** What a reader must do: record exactly these places, or flag the question. Blank and ambiguous questions must never be recorded. */
  expect: "answer" | "blank" | "ambiguous";
  kind: MarkKind | "blank" | "double";
  /** How each of the places was marked, in the same order. */
  kinds: MarkKind[];
  /** Places where the student rubbed an answer out and left a smudge, which are neither marks nor clean paper. */
  smudged: number[];
}

interface Scenario {
  id: string;
  paper: PaperName;
  large: boolean;
  questions: number;
  versions: number;
  perVersionSheet: boolean;
  version: number;
  dpi: number;
  profile: Profile;
  damage: string[];
  record: TestRecord;
  plan: SheetPlan;
}

export interface KindCount {
  right: number;
  flagged: number;
  blank: number;
  wrong: number;
}

export interface CorpusReport {
  name: string;
  sheets: number;
  pages: number;
  refused: number;
  refusals: Record<string, number>;
  /** Questions with a student's answer or a left-blank row, on pages that were read. */
  questions: number;
  right: number;
  /** Read as an answer that is not what the student marked: the failure the gate is for. */
  wrong: number;
  flagged: number;
  blankFlagged: number;
  byKind: Record<string, KindCount>;
  version: { right: number; flagged: number; wrong: number };
  wrongCases: string[];
  /** On clean sheets at 200 dots to the inch or more with firm marks: the share of answers flagged. */
  cleanFlagRate?: number;
  readMs: { median: number; max: number };
  refusedCases: string[];
  /** The fill the reader measured on the bubble the student marked, by how it was marked: the fifth percentile, the median and the ninety-fifth. */
  fillStats: Record<string, { n: number; p5: number; p50: number; p95: number }>;
  /** The fill of bubbles with nothing in them (no mark, no smudge): the median, the ninety-ninth percentile and the greatest. */
  blankNoise: { n: number; p50: number; p99: number; max: number };
  /** How clearly the printed outlines showed on the pages that were read, as a share of what the picture's own sharpness allows: the least, the fifth percentile and the median. */
  ring: { n: number; min: number; p5: number; p50: number };
  /** How soft the edges were on the pages read, in millimetres: the median and the greatest. */
  blur: { median: number; max: number };
}

export interface GateReport {
  seed: string;
  corpora: CorpusReport[];
  passed: boolean;
  failures: string[];
}

const AT = "2026-01-01T00:00:00.000Z";

function questionOf(random: () => number, serial: { n: number }, kind: "mc" | "tf" | "mr" | "essay", options: number): Question {
  const id = `q_${String(++serial.n).padStart(26, "0")}`;
  const opt = (i: number, right: boolean) => ({ id: `o${i}`, content: plainToRich(`Answer ${i}`), correct: right });
  const base = { stem: plainToRich("A question"), by: "gate", at: AT, id };
  if (kind === "tf") return createQuestion({ ...base, type: "trueFalse", body: { correct: random() < 0.5 } });
  if (kind === "essay") return createQuestion({ ...base, type: "essay", body: {} });
  if (kind === "mr") {
    return createQuestion({ ...base, type: "multipleResponse", body: { shuffle: true, partialCredit: false, options: Array.from({ length: options }, (_x, i) => opt(i + 1, i < 2)) } });
  }
  const right = Math.floor(random() * options);
  return createQuestion({ ...base, type: "multipleChoice", body: { shuffle: true, options: Array.from({ length: options }, (_x, i) => opt(i + 1, i === right)) } });
}

const pick = <T>(random: () => number, items: T[], weights?: number[]): T => {
  if (!weights) return items[Math.floor(random() * items.length)] as T;
  const total = weights.reduce((s, w) => s + w, 0);
  let r = random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] as number;
    if (r <= 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
};

const range = (random: () => number, low: number, high: number): number => low + random() * (high - low);

function makeScenario(corpus: "synthetic" | "damaged", index: number, seed: string): Scenario | undefined {
  const random = seededRandom(`${seed}:${corpus}:${index}`);
  const serial = { n: index * 1000 };
  const large = random() < 0.1;
  const wide = !large && random() < 0.15;
  const paper: PaperName = random() < 0.35 ? "a4" : "letter";
  const questions = pick(random, [12, 25, 40, 60, 100, 118, 130], [2, 4, 4, 3, 3, 1, 1]);
  const versions = pick(random, [1, 2, 3, 4], [4, 3, 2, 1]);
  const list: Question[] = [];
  for (let i = 0; i < questions; i++) {
    const r = random();
    if (r < 0.03) list.push(questionOf(random, serial, "essay", 0));
    else if (r < 0.15) list.push(questionOf(random, serial, "tf", 2));
    else if (r < 0.25) list.push(questionOf(random, serial, "mr", pick(random, [4, 5])));
    else list.push(questionOf(random, serial, "mc", wide && i % 7 === 3 ? pick(random, [6, 7, 8]) : pick(random, [3, 4, 4, 5, 5])));
  }
  let record: TestRecord;
  try {
    // The id is made from the place in the corpus, so the same seed makes the same fingerprint and the same code strip every time.
    record = createTest({ id: `t_${corpus === "synthetic" ? "1" : "2"}${String(index).padStart(25, "0")}`, name: `Gate test ${corpus} ${index}`, questions: list, versions, seed: `${seed}:${index}`, questionOrder: random() < 0.5 ? "shuffled" : "kept", at: AT });
  } catch {
    return undefined;
  }
  const planned = planSheet(record, { paper, large });
  if (!planned.ok) return undefined;
  const dpi = corpus === "synthetic" ? pick(random, [150, 200, 300], [3, 5, 1]) : pick(random, [100, 150, 200, 300], [1, 4, 4, 1]);
  const profile: Profile = corpus === "synthetic" ? pick(random, ["careful", "typical", "sloppy"] as Profile[], [3, 5, 2]) : pick(random, ["careful", "typical", "sloppy"] as Profile[], [2, 5, 3]);
  const perVersionSheet = versions > 1 && random() < 0.3;
  return {
    id: `${corpus}#${index}`,
    paper,
    large,
    questions,
    versions,
    perVersionSheet,
    version: 1 + Math.floor(random() * versions),
    dpi,
    profile,
    damage: [],
    record,
    plan: planned.plan,
  };
}

const MARK_WEIGHTS: Record<Profile, Array<[MarkKind | "change", number]>> = {
  careful: [["solid", 100]],
  // What survives a black and white scan: only a mark dark enough to stay black, and no smudge to turn black beside it.
  firm: [["solid", 100]],
  typical: [["solid", 62], ["scribble", 14], ["offcenter", 8], ["light", 5], ["tick", 4], ["cross", 3], ["half", 2], ["change", 2]],
  sloppy: [["solid", 35], ["scribble", 20], ["offcenter", 15], ["light", 12], ["tick", 7], ["cross", 5], ["half", 4], ["change", 2]],
};

/** How a student marks one bubble. */
function markFor(random: () => number, profile: Profile): { kind: MarkKind | "change"; mark: PencilMark } {
  const entries = MARK_WEIGHTS[profile];
  const kind = pick(random, entries.map((e) => e[0]), entries.map((e) => e[1]));
  switch (kind) {
    case "scribble": return { kind, mark: { kind, darkness: range(random, 0.6, 0.9) } };
    case "light": return { kind, mark: { kind, darkness: range(random, 0.3, 0.55) } };
    case "offcenter": {
      const a = random() * 2 * Math.PI;
      const d = range(random, 0.4, 1.3);
      return { kind, mark: { kind, dx: Math.cos(a) * d, dy: Math.sin(a) * d, darkness: range(random, 0.7, 0.92) } };
    }
    case "change": return { kind, mark: { kind: "solid", darkness: range(random, 0.75, 0.92) } };
    default: return { kind, mark: { kind, darkness: profile === "firm" ? range(random, 0.88, 0.97) : range(random, 0.72, 0.95) } };
  }
}

interface Filled {
  marks: SheetMarks;
  truth: Map<number, Truth>;
}

function fill(scenario: Scenario, random: () => number): Filled {
  const label = (["A", "B", "C", "D"] as const)[scenario.version - 1] as "A" | "B" | "C" | "D";
  const uses: SlotUse[] = scenario.plan.uses[label] ?? [];
  const marks: SheetMarks = { answers: {}, strays: [], seed: scenario.id };
  const truth = new Map<number, Truth>();
  const layout = layoutFor(scenario.plan.paper, scenario.plan.style);
  uses.forEach((use, i) => {
    if (use.kind === "none") return;
    const number = i + 1;
    const list: Array<{ place: number; mark: PencilMark }> = [];
    (marks.answers as Record<number, typeof list>)[number] = list;
    const r = random();
    if (r < 0.03) {
      truth.set(number, { places: [], expect: "blank", kind: "blank", kinds: [], smudged: [] });
      return;
    }
    if (r < 0.05 && use.kind !== "multiple") {
      const a = Math.floor(random() * use.places);
      let b = Math.floor(random() * use.places);
      if (b === a) b = (a + 1) % use.places;
      list.push({ place: a, mark: { kind: "solid", darkness: range(random, 0.75, 0.95) } }, { place: b, mark: { kind: "solid", darkness: range(random, 0.75, 0.95) } });
      truth.set(number, { places: [Math.min(a, b), Math.max(a, b)], expect: "ambiguous", kind: "double", kinds: ["solid", "solid"], smudged: [] });
      return;
    }
    const count = use.kind === "multiple" ? 1 + Math.floor(random() * 3) : 1;
    const places = new Set<number>();
    while (places.size < Math.min(count, use.places)) places.add(Math.floor(random() * use.places));
    let kindOfAnswer: MarkKind = "solid";
    const smudged: number[] = [];
    const drawn = new Map<number, MarkKind>();
    for (const place of places) {
      const m = markFor(random, scenario.profile);
      list.push({ place, mark: m.mark });
      kindOfAnswer = m.mark.kind;
      drawn.set(place, m.mark.kind);
      if (m.kind === "change" && use.places > 1) {
        // The student changed their mind: a smudge where the first answer was rubbed out.
        let other = Math.floor(random() * use.places);
        if (places.has(other)) other = (other + 1) % use.places;
        if (!places.has(other)) {
          list.push({ place: other, mark: { kind: "erased", darkness: range(random, 0.15, 0.4) } });
          smudged.push(other);
        }
      }
    }
    const sorted = [...places].sort((a, b) => a - b);
    truth.set(number, { places: sorted, expect: "answer", kind: kindOfAnswer, kinds: sorted.map((p) => drawn.get(p) as MarkKind), smudged });
  });
  // Stray marks: dots of lead on the page, anywhere in the grid.
  const strays = Math.floor(random() * (scenario.profile === "careful" ? 1 : 5));
  for (let s = 0; s < strays; s++) {
    (marks.strays as NonNullable<SheetMarks["strays"]>).push({ x: range(random, layout.gridLeft, layout.width - layout.gridLeft), y: range(random, layout.gridTop, layout.height - 30), size: range(random, 0.6, 2), darkness: range(random, 0.4, 0.9) });
  }
  if (!scenario.perVersionSheet && scenario.versions > 1) marks.versions = [{ version: scenario.version, mark: random() < 0.97 ? { kind: "solid", darkness: range(random, 0.75, 0.95) } : { kind: "light", darkness: 0.4 } }];
  return { marks, truth };
}

type Damage = (image: GreyImage, random: () => number, dpi: number) => { image: GreyImage; name: string };

const background = (random: () => number): number => pick(random, [255, 235, 160, 90, 30]);

const DAMAGES: Record<string, Damage> = {
  skew: (image, random) => {
    const degrees = (random() < 0.5 ? -1 : 1) * range(random, 0.3, 5);
    return { image: rotate(image, degrees, background(random)), name: `skew ${degrees.toFixed(1)} deg` };
  },
  quarter: (image, random) => {
    const t = 1 + Math.floor(random() * 3);
    return { image: quarterTurn(image, t), name: `turned ${t * 90} deg` };
  },
  squeeze: (image, random) => {
    const sx = range(random, 0.95, 1.05);
    const sy = range(random, 0.95, 1.05);
    const w = Math.round(image.width * sx);
    const h = Math.round(image.height * sy);
    const out = placeInFrame(image, [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], w, h);
    return { image: out, name: `squeezed ${(sx * 100).toFixed(0)} by ${(sy * 100).toFixed(0)} percent` };
  },
  photo: (image, random) => {
    const W = image.width;
    const H = image.height;
    const fill = range(random, 0.82, 0.95);
    const jitter = range(random, 0.01, 0.06);
    const frameW = Math.round(W * 1.1);
    const frameH = Math.round(H * 1.1);
    const cx = frameW / 2;
    const cy = frameH / 2;
    const corner = (sx: number, sy: number): Point => ({
      x: cx + sx * (frameW * fill) / 2 + (random() - 0.5) * 2 * jitter * frameW,
      y: cy + sy * (frameH * fill) / 2 + (random() - 0.5) * 2 * jitter * frameH,
    });
    let out = placeInFrame(image, [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], frameW, frameH, range(random, 60, 200));
    out = shade(out, range(random, 0.05, 0.35), random() * 360);
    return { image: out, name: `photographed at an angle (corners off by ${(jitter * 100).toFixed(1)} percent)` };
  },
  blur: (image, random, dpi) => {
    const s = range(random, 0.6, 1.6) * (dpi / 150);
    return { image: blur(image, s), name: `blurred ${s.toFixed(1)} px` };
  },
  jpeg: (image, random) => {
    const q = Math.round(range(random, 15, 60));
    return { image: jpegBlocks(image, q), name: `JPEG quality ${q}` };
  },
  noise: (image, random) => {
    const s = range(random, 4, 14);
    return { image: noise(image, s, String(random())), name: `noise ${s.toFixed(0)}` };
  },
  copy: (image, random) => {
    const d = range(random, 0.2, 0.8);
    return { image: photocopy(image, String(random()), { darken: d }), name: `photocopy (contrast ${d.toFixed(1)})` };
  },
  dull: (image, random) => {
    const white = Math.round(range(random, 170, 230));
    const black = Math.round(range(random, 0, 60));
    return { image: levels(image, black, white, range(random, 0.8, 1.2)), name: `dull scan (black ${black}, white ${white})` };
  },
  bilevel: (image, random, dpi) => {
    const t = Math.round(range(random, 125, 170));
    return { image: toBilevel(blur(image, 0.6 * (dpi / 150)), t), name: `black and white at ${t}` };
  },
  specks: (image, random) => {
    const n = Math.round(range(random, 20, 200));
    return { image: speckle(image, n, 5, String(random())), name: `${n} specks` };
  },
  crop: (image, random, dpi) => {
    const mm = range(random, 4, 25);
    const px = Math.round((mm / 25.4) * dpi);
    const side = Math.floor(random() * 4);
    const cut: [number, number, number, number] = [0, 0, 0, 0];
    cut[side] = px;
    return { image: crop(image, ...cut), name: `cut off ${mm.toFixed(0)} mm of the ${["left", "top", "right", "bottom"][side]}` };
  },
};

const SCAN_DAMAGE = ["skew", "squeeze", "blur", "jpeg", "noise", "copy", "dull", "bilevel", "specks"];

function damageFor(random: () => number): string[] {
  const kind = random();
  if (kind < 0.2) return ["photo", ...pickSome(random, ["blur", "jpeg", "noise", "dull"], 1 + Math.floor(random() * 2))];
  if (kind < 0.3) return ["crop", ...pickSome(random, SCAN_DAMAGE, 1)];
  if (kind < 0.4) return ["quarter", ...pickSome(random, SCAN_DAMAGE, 1 + Math.floor(random() * 2))];
  return pickSome(random, SCAN_DAMAGE, 1 + Math.floor(random() * 3));
}

function pickSome(random: () => number, items: string[], count: number): string[] {
  const pool = [...items];
  const out: string[] = [];
  while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0] as string);
  return out;
}

/** Applies damages in a fixed order: geometry first, then what a lens and a sensor do, then what saving does. */
const ORDER = ["quarter", "photo", "skew", "squeeze", "crop", "blur", "dull", "copy", "specks", "noise", "bilevel", "jpeg"];

function emptyKind(): KindCount {
  return { right: 0, flagged: 0, blank: 0, wrong: 0 };
}

function runCorpus(name: "synthetic" | "damaged", options: Required<Pick<GateOptions, "sheets" | "seed">> & Pick<GateOptions, "progress" | "readerFor">): CorpusReport {
  const report: CorpusReport = {
    name,
    sheets: 0,
    pages: 0,
    refused: 0,
    refusals: {},
    questions: 0,
    right: 0,
    wrong: 0,
    flagged: 0,
    blankFlagged: 0,
    byKind: {},
    version: { right: 0, flagged: 0, wrong: 0 },
    wrongCases: [],
    readMs: { median: 0, max: 0 },
    refusedCases: [],
    fillStats: {},
    blankNoise: { n: 0, p50: 0, p99: 0, max: 0 },
    ring: { n: 0, min: 0, p5: 0, p50: 0 },
    blur: { median: 0, max: 0 },
  };
  const rings: number[] = [];
  const blurs: number[] = [];
  const times: number[] = [];
  const fillsByKind: Record<string, number[]> = {};
  const noiseFills: number[] = [];
  let cleanAnswers = 0;
  let cleanFlagged = 0;
  for (let index = 0; index < options.sheets; index++) {
    const scenario = makeScenario(name, index, options.seed);
    if (!scenario) continue;
    const damageRandom = seededRandom(`${options.seed}:${name}:${index}:damage`);
    const damages = name === "damaged" ? damageFor(damageRandom).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)) : [];
    // A black and white scan cannot show a pale mark or tell a smudge from a mark, whatever reads it, so the student of such a scan is
    // drawn as marking firmly and leaving no smudge: the harness judges the reader on what the picture can show.
    if (damages.includes("bilevel")) scenario.profile = "firm";
    const random = seededRandom(`${options.seed}:${name}:${index}:fill`);
    const filled = fill(scenario, random);
    const reader = options.readerFor ? options.readerFor(scenario.record) : new SheetReader(scenario.record);
    const layout = layoutFor(scenario.plan.paper, scenario.plan.style);
    const pages = Math.max(1, Math.ceil(scenario.plan.drawn.length / layout.questionsPerPage));
    report.sheets++;
    const described: string[] = [];
    for (let page = 1; page <= pages; page++) {
      report.pages++;
      const raster = new SheetRaster(scenario.plan, { title: scenario.record.name, fingerprint: scenario.record.fingerprint, versions: scenario.versions, version: scenario.perVersionSheet ? scenario.version : undefined }, page, scenario.dpi);
      let image = raster.render(filled.marks);
      const applied: string[] = [];
      for (const d of damages) {
        const result = (DAMAGES[d] as Damage)(image, damageRandom, scenario.dpi);
        image = result.image;
        applied.push(result.name);
      }
      if (page === 1) described.push(...applied);
      const t0 = performance.now();
      const read = reader.read(image);
      const ms = performance.now() - t0;
      if (scenario.questions >= 90) times.push(ms);
      const where = `${scenario.id} page ${page} (${scenario.paper}${scenario.large ? " large" : ""}, ${scenario.questions} questions, ${scenario.versions} version${scenario.versions === 1 ? "" : "s"}${scenario.perVersionSheet ? " one sheet each" : ""}, ${scenario.dpi} dpi, ${scenario.profile}${applied.length ? `; ${applied.join(", ")}` : ""})`;
      if (!read.ok) {
        report.refused++;
        report.refusals[read.cause] = (report.refusals[read.cause] ?? 0) + 1;
        report.refusedCases.push(`${where}: ${read.cause}`);
        continue;
      }
      rings.push(read.quality.ring / read.quality.ringExpected);
      blurs.push(read.quality.blurMm);
      // The sheet's version: read it, and hold it to what the student marked.
      if (!scenario.perVersionSheet && scenario.versions > 1) {
        if (read.version === undefined) report.version.flagged++;
        else if (read.version === scenario.version) report.version.right++;
        else {
          report.version.wrong++;
          report.wrongCases.push(`${where}: read version ${read.version}, the student marked ${scenario.version}`);
        }
      } else if (read.version !== scenario.version && scenario.versions > 1) {
        report.version.wrong++;
        report.wrongCases.push(`${where}: read version ${read.version}, the sheet was printed for ${scenario.version}`);
      }
      if (read.version === undefined || read.version !== scenario.version) continue;
      for (const q of read.questions) {
        const truth = filled.truth.get(q.number);
        if (!truth) continue;
        report.questions++;
        const slot = (report.byKind[truth.kind] ??= emptyKind());
        truth.places.forEach((p, i) => {
          if (truth.expect === "answer") (fillsByKind[truth.kinds[i] as string] ??= []).push(q.fills[p] as number);
        });
        q.fills.forEach((f, p) => {
          if (!truth.places.includes(p) && !truth.smudged.includes(p) && p < (scenario.plan.uses[(["A", "B", "C", "D"] as const)[scenario.version - 1] as "A"]?.[q.number - 1]?.places ?? 0)) noiseFills.push(f);
        });
        const firm = truth.expect === "answer" && truth.kind === "solid";
        const clean = name === "synthetic" && scenario.dpi >= 200 && scenario.profile === "careful" && firm;
        if (clean) cleanAnswers++;
        if (q.status === "answered") {
          const right = truth.expect === "answer" && q.marked.length === truth.places.length && q.marked.every((p, i) => p === truth.places[i]);
          if (right) {
            report.right++;
            slot.right++;
          } else {
            report.wrong++;
            slot.wrong++;
            report.wrongCases.push(`${where}: question ${q.number} read as ${q.marked.map((p) => String.fromCharCode(65 + p)).join("")}, the student's was ${truth.expect === "answer" ? truth.places.map((p) => String.fromCharCode(65 + p)).join("") : truth.expect} (${truth.kind}; fills ${q.fills.map((f) => f.toFixed(2)).join(" ")})`);
          }
        } else if (q.status === "blank") {
          report.blankFlagged++;
          slot.blank++;
          if (clean) cleanFlagged++;
        } else {
          report.flagged++;
          slot.flagged++;
          if (clean) cleanFlagged++;
        }
      }
    }
    options.progress?.(`${name} ${index + 1}/${options.sheets}`);
  }
  times.sort((a, b) => a - b);
  report.readMs = { median: times.length ? (times[Math.floor(times.length / 2)] as number) : 0, max: times.length ? (times[times.length - 1] as number) : 0 };
  if (cleanAnswers > 0) report.cleanFlagRate = cleanFlagged / cleanAnswers;
  const at = (sorted: number[], p: number): number => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number) : 0);
  for (const [kind, values] of Object.entries(fillsByKind)) {
    values.sort((a, b) => a - b);
    report.fillStats[kind] = { n: values.length, p5: at(values, 0.05), p50: at(values, 0.5), p95: at(values, 0.95) };
  }
  rings.sort((a, b) => a - b);
  report.ring = { n: rings.length, min: rings[0] ?? 0, p5: at(rings, 0.05), p50: at(rings, 0.5) };
  blurs.sort((a, b) => a - b);
  report.blur = { median: at(blurs, 0.5), max: blurs[blurs.length - 1] ?? 0 };
  noiseFills.sort((a, b) => a - b);
  report.blankNoise = { n: noiseFills.length, p50: at(noiseFills, 0.5), p99: at(noiseFills, 0.99), max: noiseFills.length ? (noiseFills[noiseFills.length - 1] as number) : 0 };
  return report;
}

/** Runs the gate and says whether it passed. */
export function runSheetGate(options: GateOptions = {}): GateReport {
  const sheets = options.sheets ?? 60;
  const seed = options.seed ?? "gate-1";
  const corpora: CorpusReport[] = [];
  for (const name of ["synthetic", "damaged"] as const) {
    if (options.only && options.only !== name) continue;
    corpora.push(runCorpus(name, { sheets, seed, progress: options.progress, readerFor: options.readerFor }));
  }
  const failures: string[] = [];
  for (const c of corpora) {
    if (c.wrong > 0) failures.push(`${c.name}: ${c.wrong} answer${c.wrong === 1 ? "" : "s"} read wrong and not flagged`);
    if (c.version.wrong > 0) failures.push(`${c.name}: ${c.version.wrong} version${c.version.wrong === 1 ? "" : "s"} read wrong and not flagged`);
    if (c.name === "synthetic" && c.refused > 0) failures.push(`${c.name}: ${c.refused} clean page${c.refused === 1 ? "" : "s"} refused`);
    if (c.cleanFlagRate !== undefined && c.cleanFlagRate > 0.01) failures.push(`${c.name}: ${(c.cleanFlagRate * 100).toFixed(1)} percent of firm answers on clean sheets at 200 dpi or more were flagged (the target is 1 percent or fewer)`);
    if (c.readMs.median > 1000) failures.push(`${c.name}: a sheet of 90 questions or more took ${Math.round(c.readMs.median)} ms to read (the target is under 1000)`);
  }
  return { seed, corpora, passed: failures.length === 0, failures };
}

/** A report as lines of text. */
export function formatGate(report: GateReport): string {
  const lines: string[] = [];
  for (const c of report.corpora) {
    const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
    lines.push(`${c.name}: ${c.sheets} sheets, ${c.pages} pages; ${c.refused} refused${c.refused ? ` (${Object.entries(c.refusals).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
    lines.push(`  questions ${c.questions}: read right ${c.right} (${pct(c.right, c.questions)}), flagged ${c.flagged}, blank ${c.blankFlagged}, WRONG AND NOT FLAGGED ${c.wrong}`);
    lines.push(`  version of the sheet: right ${c.version.right}, flagged ${c.version.flagged}, WRONG ${c.version.wrong}`);
    lines.push(`  by what the student drew: ${Object.entries(c.byKind).map(([k, v]) => `${k} ${v.right}/${v.right + v.flagged + v.blank + v.wrong}${v.wrong ? ` (${v.wrong} WRONG)` : ""}`).join(", ")}`);
    lines.push(`  fill of the marked bubble: ${Object.entries(c.fillStats).map(([k, v]) => `${k} ${v.p5.toFixed(2)}/${v.p50.toFixed(2)}/${v.p95.toFixed(2)}`).join(", ")} (5th, median, 95th percentile)`);
    lines.push(`  clearness of the printed outlines as a share of what the picture's sharpness allows (${c.ring.n} pages): least ${c.ring.min.toFixed(2)}, 5th percentile ${c.ring.p5.toFixed(2)}, median ${c.ring.p50.toFixed(2)}; edge blur median ${c.blur.median.toFixed(2)} mm, greatest ${c.blur.max.toFixed(2)} mm`);
    lines.push(`  fill of empty bubbles (${c.blankNoise.n}): median ${c.blankNoise.p50.toFixed(3)}, 99th percentile ${c.blankNoise.p99.toFixed(3)}, greatest ${c.blankNoise.max.toFixed(3)}`);
    if (c.cleanFlagRate !== undefined) lines.push(`  firm marks on clean sheets at 200 dpi or more: ${(c.cleanFlagRate * 100).toFixed(2)} percent flagged`);
    lines.push(`  reading time for 90 questions or more: median ${Math.round(c.readMs.median)} ms, longest ${Math.round(c.readMs.max)} ms`);
    for (const w of c.wrongCases.slice(0, 12)) lines.push(`  WRONG: ${w}`);
  }
  lines.push(report.passed ? `PASSED (seed ${report.seed}): no answer was read wrong without a flag.` : `FAILED (seed ${report.seed}):\n  ${report.failures.join("\n  ")}`);
  return lines.join("\n");
}

export { warp, homographyFrom };
