/**
 * A page that shows what an import made of a file: each question as the importer built it, with the answer it found, the
 * checks it raised and the lines of the file it came from, then the text no question claimed and the warnings about the
 * file as a whole.
 *
 * This is the first look at the preview and repair screen the desktop app will have, and it reads the same result that
 * screen will read. It changes nothing and decides nothing: it shows the result as it is, and a question with no answer is
 * shown with no answer, never with a likely one.
 *
 * One file, with no script and no address outside it, so it opens from a double-click and can be sent to someone. The text
 * of the document goes into it, so every piece of that text is escaped on the way in; a question that reads
 * `<script>` is shown as those characters.
 */

import { ENGINE_VERSION, PRODUCT_NAME } from "../naming.ts";
import { verdictOf, type ImportResult } from "../import/types.ts";
import { liveFindings, type Finding, type Severity, type Verdict } from "../model/findings.ts";
import type { Question, QuestionType } from "../model/question.ts";
import { richTextToPlain } from "../model/richtext.ts";

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const TYPE_NAMES: Record<QuestionType, string> = {
  multipleChoice: "Multiple choice",
  multipleResponse: "Multiple response",
  trueFalse: "True or false",
  fillInBlank: "Fill in the blank",
  matching: "Matching",
  ordering: "Ordering",
  numeric: "Numeric",
  shortAnswer: "Short answer",
  essay: "Essay",
  hotspot: "Hotspot",
  calculated: "Calculated",
};

const VERDICT_NAMES: Record<Verdict, string> = { parsed: "Parsed", needsReview: "Needs review", failed: "Failed" };
const SEVERITY_NAMES: Record<Severity, string> = { error: "Error", warn: "Check", info: "Note" };

/** A, B, C... and then numbers, for a question with more options than the alphabet. */
const letter = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : String(index + 1));

const plain = (value: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(value).trim();

/** The start of a stem on one line, for a row that is folded. */
function snippet(text: string, length = 110): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 3).trimEnd()}...` : line;
}

function findingsHtml(findings: readonly Finding[]): string {
  const live = liveFindings(findings);
  if (live.length === 0) return "";
  return `<ul class="findings">${live
    .map((f) => `<li class="sev-${f.severity}"><span class="sev">${SEVERITY_NAMES[f.severity]}</span> ${esc(f.message)}</li>`)
    .join("")}</ul>`;
}

/** The options of a choice question, with the ones the file marked as right. */
function optionsHtml(options: ReadonlyArray<{ content: Parameters<typeof richTextToPlain>[0]; correct: boolean }>): string {
  const marked = options.filter((o) => o.correct).length;
  const rows = options
    .map(
      (o, i) =>
        `<li class="${o.correct ? "right" : ""}"><span class="letter">${letter(i)}</span><span class="text">${esc(plain(o.content))}</span>${
          o.correct ? '<span class="mark">marked as the answer</span>' : ""
        }</li>`,
    )
    .join("");
  return `<ul class="options">${rows}</ul>${marked === 0 ? '<p class="no-answer">No option is marked as the answer.</p>' : ""}`;
}

/** What the question holds as its answer, in words, for the types that are not a list of options. */
function answerHtml(q: Question): string {
  const body = q.body as unknown as Record<string, unknown>;
  const line = (label: string, value: string): string => `<p class="answer"><span class="label">${esc(label)}</span> ${esc(value)}</p>`;
  const none = '<p class="no-answer">No answer is recorded.</p>';

  switch (q.type) {
    case "multipleChoice":
    case "multipleResponse":
      return optionsHtml((body["options"] as Array<{ content: Parameters<typeof richTextToPlain>[0]; correct: boolean }>) ?? []);
    case "trueFalse": {
      const correct = body["correct"];
      return typeof correct === "boolean" ? line("Answer", correct ? "True" : "False") : '<p class="no-answer">No answer is recorded.</p>';
    }
    case "fillInBlank": {
      const blanks = (body["blanks"] as Array<{ accepted: string[] }>) ?? [];
      const given = blanks.filter((b) => b.accepted.length > 0);
      return given.length === 0 ? none : given.map((b, i) => line(blanks.length > 1 ? `Blank ${i + 1}` : "Accepted", b.accepted.join("  |  "))).join("");
    }
    case "shortAnswer": {
      const accepted = (body["accepted"] as string[]) ?? [];
      return accepted.length === 0 ? none : line("Accepted", accepted.join("  |  "));
    }
    case "matching": {
      const pairs = (body["pairs"] as Array<{ left: Parameters<typeof richTextToPlain>[0]; right: string }>) ?? [];
      return pairs.length === 0
        ? none
        : `<ul class="pairs">${pairs.map((p) => `<li><span class="text">${esc(plain(p.left))}</span><span class="arrow">matches</span><span class="text">${esc(p.right)}</span></li>`).join("")}</ul>`;
    }
    case "ordering": {
      const items = [...((body["items"] as Array<{ content: Parameters<typeof richTextToPlain>[0]; position: number }>) ?? [])].sort((a, b) => a.position - b.position);
      return items.length === 0 ? none : `<ol class="ordered">${items.map((it) => `<li>${esc(plain(it.content))}</li>`).join("")}</ol>`;
    }
    case "numeric": {
      const mode = body["mode"];
      const value = body["value"];
      const min = body["min"];
      const max = body["max"];
      if (mode === "range" && typeof min === "number" && typeof max === "number") return line("Accepted", `${min} to ${max}`);
      if (typeof value === "number") {
        const tolerance = body["tolerance"];
        return line("Accepted", typeof tolerance === "number" && mode === "tolerance" ? `${value}, give or take ${tolerance}` : String(value));
      }
      return none;
    }
    case "essay": {
      const model = body["modelAnswer"] as Parameters<typeof richTextToPlain>[0] | undefined;
      return model && plain(model) !== "" ? line("Model answer", plain(model)) : '<p class="answer"><span class="label">Marked by a person; no answer is recorded.</span></p>';
    }
    default:
      return none;
  }
}

/** The lines of the file a question came from, numbered as a person counts them. */
function sourceHtml(q: Question, source: readonly string[]): string {
  const at = q.origin?.source;
  if (!at || source.length === 0) return "";
  const from = Math.max(0, at.firstBlock);
  const to = Math.min(source.length - 1, at.lastBlock);
  if (to < from) return "";
  const rows: string[] = [];
  for (let i = from; i <= to; i++) rows.push(`<span class="no">${i + 1}</span>${esc(source[i] as string)}`);
  const where = from === to ? `line ${from + 1}` : `lines ${from + 1} to ${to + 1}`;
  return `<details class="source"><summary>The file, ${where}</summary><pre>${rows.join("\n")}</pre></details>`;
}

function questionHtml(q: Question, number: number, source: readonly string[]): string {
  const verdict = verdictOf(q);
  const stem = plain(q.stem);
  // A question with something to look at is open when the page loads; one that read cleanly is a single line.
  const open = verdict === "parsed" ? "" : " open";
  return (
    `<details class="q v-${verdict}" id="q${number}"${open}>` +
    `<summary><span class="n">${number}</span><span class="badge b-${verdict}">${VERDICT_NAMES[verdict]}</span>` +
    `<span class="type">${TYPE_NAMES[q.type]}</span><span class="peek">${esc(snippet(stem))}</span></summary>` +
    `<div class="body"><p class="stem">${esc(stem) || '<span class="empty">No question text was read.</span>'}</p>` +
    answerHtml(q) +
    findingsHtml(q.findings) +
    sourceHtml(q, source) +
    `</div></details>`
  );
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1c2128;--muted:#5b6573;--line:#d8dde4;--ok:#1f7a3f;--ok-bg:#e4f4ea;--warn:#8a5a00;--warn-bg:#fdf1d6;--bad:#b3261e;--bad-bg:#fbe4e2;--note:#2a5a99;--note-bg:#e6eefa;--accent:#2a5a99}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2127;--text:#e6e9ee;--muted:#9aa4b2;--line:#323843;--ok:#6fcf8f;--ok-bg:#1b3325;--warn:#f0c46a;--warn-bg:#3a2f12;--bad:#ff8b82;--bad-bg:#40201e;--note:#8db6ee;--note-bg:#1c2a40;--accent:#8db6ee}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.4rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:32px 0 10px}
.sub{color:var(--muted);margin:0 0 16px;overflow-wrap:anywhere}
.counts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px;padding:0;list-style:none}
.counts li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.counts b{display:block;font-size:1.4rem;line-height:1.1}
.counts span{color:var(--muted);font-size:.85rem}
.jump{margin:8px 0 0}
a{color:var(--accent)}
.findings{margin:10px 0 0;padding:0;list-style:none}
.findings li{border-radius:6px;padding:6px 10px;margin:0 0 6px;overflow-wrap:anywhere}
.sev{font-weight:600;margin-right:6px}
.sev-error{background:var(--bad-bg)}.sev-error .sev{color:var(--bad)}
.sev-warn{background:var(--warn-bg)}.sev-warn .sev{color:var(--warn)}
.sev-info{background:var(--note-bg)}.sev-info .sev{color:var(--note)}
.q{background:var(--card);border:1px solid var(--line);border-left-width:5px;border-radius:8px;margin:0 0 8px}
.q.v-parsed{border-left-color:var(--ok)}.q.v-needsReview{border-left-color:var(--warn)}.q.v-failed{border-left-color:var(--bad)}
.q>summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:10px 12px;cursor:pointer}
.n{font-weight:700;min-width:2ch}
.badge{font-size:.78rem;font-weight:600;border-radius:999px;padding:1px 9px}
.b-parsed{background:var(--ok-bg);color:var(--ok)}.b-needsReview{background:var(--warn-bg);color:var(--warn)}.b-failed{background:var(--bad-bg);color:var(--bad)}
.type{color:var(--muted);font-size:.85rem}
.peek{flex:1 1 100%;color:var(--muted);overflow-wrap:anywhere}
.q[open]>summary .peek{display:none}
.body{padding:0 14px 14px}
.stem{white-space:pre-wrap;margin:4px 0 10px;overflow-wrap:anywhere}
.empty,.no-answer{color:var(--bad)}
.no-answer{margin:6px 0 0;font-weight:600}
.options,.pairs,.ordered{margin:0 0 4px;padding:0;list-style:none}
.options li,.pairs li{display:flex;gap:10px;align-items:baseline;padding:4px 8px;border-radius:6px;overflow-wrap:anywhere}
.options li.right{background:var(--ok-bg)}
.letter{font-weight:700;min-width:1.5ch}
.mark{margin-left:auto;font-size:.8rem;font-weight:600;color:var(--ok);white-space:nowrap}
.arrow{color:var(--muted);font-size:.85rem}
.ordered{list-style:decimal;padding-left:28px}
.answer{margin:4px 0}.label{color:var(--muted);margin-right:6px}
.source{margin-top:12px}.source summary{cursor:pointer;color:var(--muted);font-size:.9rem}
pre{margin:6px 0 0;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow-x:auto;font:13px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.no{display:inline-block;min-width:4ch;color:var(--muted);user-select:none}
.orphan{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--warn);border-radius:8px;padding:10px 12px;margin:0 0 8px}
.orphan p{margin:0 0 4px;overflow-wrap:anywhere;white-space:pre-wrap}
.orphan .why{color:var(--muted);font-size:.9rem}
.none{color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:.85rem}
`;

/**
 * The page for one import. `source` is the lines of the file as the importer read them, one for each block, so that a
 * question's lines can be shown beside it; without it the questions are shown without their source.
 */
export function reviewHtml(result: ImportResult, source: readonly string[] = []): string {
  const { counts } = result;
  const total = result.questions.length;
  const firstProblem = result.questions.findIndex((q) => verdictOf(q) !== "parsed");

  const file = liveFindings(result.fileFindings);
  const fileSection =
    file.length === 0
      ? ""
      : `<h2>About the file</h2>${findingsHtml(file)}`;

  const questions =
    total === 0
      ? '<p class="none">No question was found in this file.</p>'
      : result.questions.map((q, i) => questionHtml(q, i + 1, source)).join("");

  const orphans =
    result.orphans.length === 0
      ? '<p class="none">Every line of the file was used by a question or set aside as a heading.</p>'
      : result.orphans
          .map((o) => {
            const from = o.source.firstBlock + 1;
            const to = o.source.lastBlock + 1;
            return `<div class="orphan"><p>${esc(o.text)}</p><p class="why">${from === to ? `Line ${from}` : `Lines ${from} to ${to}`}. ${esc(o.reason)}</p></div>`;
          })
          .join("");

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><title>Import review - ${esc(result.file)}</title><style>${STYLE}</style></head><body><main>` +
    `<h1>Import review</h1><p class="sub">${esc(result.file)}</p>` +
    `<ul class="counts">` +
    `<li><b>${total}</b><span>questions</span></li>` +
    `<li><b>${counts.parsed}</b><span>parsed</span></li>` +
    `<li><b>${counts.needsReview}</b><span>need review</span></li>` +
    `<li><b>${counts.failed}</b><span>failed</span></li>` +
    `<li><b>${counts.orphans}</b><span>lines no question used</span></li></ul>` +
    (firstProblem >= 0 ? `<p class="jump"><a href="#q${firstProblem + 1}">Go to the first question that needs a look</a></p>` : "") +
    fileSection +
    `<h2>Questions</h2>${questions}` +
    `<h2>Text no question used</h2>${orphans}` +
    `<footer>Read by ${esc(PRODUCT_NAME)} engine ${esc(ENGINE_VERSION)}. Nothing in your file was changed. A question with no answer shown here had none that could be read; the importer does not guess one.</footer>` +
    `</main></body></html>`
  );
}
