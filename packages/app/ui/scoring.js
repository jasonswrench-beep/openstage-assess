// @ts-check
/**
 * Scoring a class of answer sheets: scans in, the questions the reader was not sure of settled by a person, scores and adjustments,
 * item statistics, and what to keep.
 *
 * The reader says what it is sure of and flags the rest; nothing it is unsure of is guessed. Review shows each flagged question
 * with a piece of the picture and the fill of every bubble, and everything in it can be done from the keyboard: a letter (or a
 * digit) chooses the bubble, 0 says the row is blank, Enter records several, the arrows move, and Z takes the last one back.
 * Scores are worked out from what is settled every time they are shown, so a decision or an adjustment shows at once with no rescan.
 */

import { del, get, post, put as putJson } from "./api.js";
import { ask } from "./dialogs.js";
import { clear, h, plural, put } from "./dom.js";
import { fileButtons } from "./files.js";
import { sendScans } from "./scan.js";

const OUTCOME_WORDS = {
  right: "Right",
  partial: "Partly right",
  wrong: "Wrong",
  blank: "Blank",
  credited: "Credit given",
  unsettled: "Not settled",
  notScored: "No usable key, not scored",
  dropped: "Dropped",
  notOnSheet: "Not on the sheet",
};

/** @param {number | null | undefined} n @param {number} [digits] */
const figure = (n, digits = 2) => (n === undefined || n === null ? "-" : n.toFixed(digits));

/**
 * Chooses the bubbles that are marked, in a dialog. Resolves to the places, "blank", or null when nothing was chosen.
 * @param {string} title
 * @param {string[]} labels
 * @param {boolean} multiple
 * @param {number[]} current
 */
async function chooseBubbles(title, labels, multiple, current) {
  const boxes = labels.map((label, i) => {
    const id = `choose-${i}`;
    const input = h("input", { type: multiple ? "checkbox" : "radio", name: "bubble", id, checked: current.includes(i) });
    return { input, row: h("div", { class: "choice" }, input, h("label", { for: id, text: label })) };
  });
  const answer = await ask({
    title,
    body: [h("p", { class: "sub", text: multiple ? "Tick every bubble that is marked." : "Choose the bubble that is marked." }), ...boxes.map((b) => b.row)],
    actions: [
      { label: "Cancel", value: "cancel" },
      { label: "Blank", value: "blank" },
      { label: "Save", value: "save", primary: true },
    ],
    collect: () => boxes.flatMap((b, i) => (b.input.checked ? [i] : [])),
  });
  if (!answer || answer.value === "cancel") return null;
  if (answer.value === "blank") return "blank";
  return answer.collected.length === 0 ? null : answer.collected;
}

/**
 * @param {HTMLElement} host
 * @param {{ id: string }} params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderScoring(host, params, shell) {
  const sid = params.id;
  const base = `scoring/${encodeURIComponent(sid)}`;
  const tell = (/** @type {unknown} */ error) => shell.notify(error instanceof Error ? error.message : "That did not work.", "error");
  /** @type {any} */
  let view = await get(base);
  let cursor = 0;
  let busy = false;
  /** @type {number | null} */
  let openSheet = null;
  /** @type {Array<{ sheet: number, kind: "answer" | "version", question?: number }>} */
  const trail = [];
  let said = "";

  clear(host);
  const headHost = h("div", { class: "page-head" });
  const scanHost = h("section", { class: "panel" });
  const reviewHost = h("section", { class: "panel", attrs: { "aria-labelledby": "review-heading" } });
  const resultsHost = h("section", { class: "panel" });
  const adjustHost = h("section", { class: "panel" });
  const statsHost = h("section", { class: "panel" });
  const saveHost = h("section", { class: "panel" });
  host.append(h("div", { class: "export wide" }, headHost, scanHost, reviewHost, resultsHost, adjustHost, statsHost, saveHost));

  function renderAll() {
    renderHead();
    renderScans();
    renderReview();
    renderResults();
    renderAdjust();
    renderStats();
    renderSave();
  }

  /** @param {any} next */
  function apply(next) {
    view = next;
    renderAll();
  }

  async function refresh() {
    apply(await get(base));
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // The head

  function renderHead() {
    clear(headHost);
    const complete = view.sheets.filter(/** @param {any} s */ (s) => s.complete).length;
    put(
      headHost,
      h(
        "div",
        null,
        h("h1", { text: `Scoring ${view.test.name}` }),
        h(
          "p",
          { class: "sub" },
          `${plural(view.sheets.length, "sheet", "sheets")}, ${complete} complete, ${view.queue.total === 0 ? "nothing" : plural(view.queue.total, "question", "questions")} waiting for you. Sheet code ${view.test.fingerprint}. `,
          view.unsaved ? h("span", { class: "dirty", text: "Not saved." }) : view.savedAs ? h("span", { text: `Saved as ${view.savedAs}.` }) : null,
        ),
      ),
      h(
        "div",
        { class: "head-actions" },
        h("button", { type: "button", class: view.unsaved ? "primary" : "", text: "Save scores", on: { click: () => void save() } }),
        h("button", { type: "button", text: "Close", on: { click: () => void close() } }),
      ),
    );
  }

  async function close() {
    if (!(await canLeave())) return;
    try {
      await del(base);
    } catch {
      // It was already gone; there is nothing left to close.
    }
    view.unsaved = false;
    shell.go(`#/sheets/${encodeURIComponent(view.bank)}`);
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Scans

  const progress = h("p", { class: "sub", attrs: { "aria-live": "polite" } });

  /** @param {File[]} files */
  async function addFiles(files) {
    if (busy || files.length === 0) return;
    busy = true;
    const chooser = /** @type {HTMLInputElement | null} */ (scanHost.querySelector("#scan-files"));
    if (chooser) chooser.disabled = true;
    try {
      await sendScans(sid, files, (done, total, name) => {
        progress.textContent = done === total ? "Reading is done." : `Reading ${done + 1} of ${total}: ${name}`;
      });
      cursor = 0;
      await refresh();
      const read = view.pages.filter(/** @param {any} p */ (p) => p.ok).length;
      shell.notify(`${plural(read, "page", "pages")} read into ${plural(view.sheets.length, "sheet", "sheets")}.`, "ok");
    } catch (error) {
      tell(error);
      await refresh().catch(() => undefined);
    } finally {
      busy = false;
    }
  }
  scanHost.addEventListener("dragover", (/** @type {DragEvent} */ e) => {
    if (view.opened) return;
    e.preventDefault();
    scanHost.classList.add("over");
  });
  scanHost.addEventListener("dragleave", () => scanHost.classList.remove("over"));
  scanHost.addEventListener("drop", (/** @type {DragEvent} */ e) => {
    e.preventDefault();
    scanHost.classList.remove("over");
    if (!view.opened) void addFiles([...(e.dataTransfer?.files ?? [])]);
  });

  function renderScans() {
    clear(scanHost);
    const problems = view.pages.filter(/** @param {any} p */ (p) => !p.ok);
    const input = h("input", { type: "file", id: "scan-files", multiple: true, accept: ".png,.jpg,.jpeg,.pdf,.webp,.gif,.bmp,image/*,application/pdf" });
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      void addFiles(files);
    });

    put(
      scanHost,
      h("h2", { text: "Scans" }),
      view.opened
        ? h("p", { class: "sub", text: "These scores were opened from a saved file. The readings and your decisions are back, and no pictures are kept in a scores file, so a question cannot be looked at again; to add more sheets, score them as a new batch." })
        : h(
            "div",
            null,
            h("p", { class: "sub", text: "Choose the scans, or drop them here, in the order the sheets were scanned: a PDF from a scanner with a page for each sheet, a folder of pictures, or photographs from a phone. Pictures stay in this window while they are read and are never saved." }),
            h("div", { class: "field" }, h("label", { for: "scan-files", class: "field-label", text: "Add scans (PNG, JPG or PDF)" }), input),
          ),
      progress,
      view.pages.length > 0 ? h("p", { text: `${plural(view.pages.length, "page", "pages")} so far: ${view.pages.length - problems.length} read, ${problems.length} not read, ${plural(view.duplicates.length, "duplicate", "duplicates")}.` }) : null,
      problems.length > 0
        ? h("div", { class: "note-group" }, h("h3", { text: "Pages that were not read" }), h("ul", null, ...problems.map(/** @param {any} p */ (p) => h("li", { text: `${p.file}, page ${p.page}: ${p.reason}` }))))
        : null,
      view.batchFlags.length > 0
        ? h("div", { class: "note-group" }, h("h3", { text: "About the batch" }), h("ul", null, ...view.batchFlags.map(/** @param {any} f */ (f) => h("li", { text: f.reason }))))
        : null,
      view.pages.length > 0
        ? h(
            "details",
            { class: "more" },
            h("summary", { text: "Every page" }),
            h("ul", { class: "general" }, ...view.pages.map(/** @param {any} p */ (p) => h("li", { text: `${p.file}, page ${p.page}: ${p.ok ? `read${p.dpi ? ` at about ${p.dpi} dots to the inch` : ""}${p.version ? `, version ${p.version}` : ""}${p.notes.length ? `. ${p.notes.join(" ")}` : ""}` : `not read. ${p.reason}`}` }))),
          )
        : null,
    );
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Review

  /** @param {string} text */
  function say(text) {
    said = text;
  }

  function renderReview() {
    clear(reviewHost);
    const items = view.queue.items;
    const blanks = h("input", { type: "checkbox", id: "accept-blanks", checked: view.acceptBlanks });
    blanks.addEventListener("change", async () => {
      try {
        apply(await putJson(`${base}/settings`, { acceptBlanks: blanks.checked }));
      } catch (error) {
        tell(error);
      }
    });
    put(
      reviewHost,
      h("h2", { id: "review-heading", text: view.queue.total === 0 ? "Review" : `Review: ${view.queue.total} to settle` }),
      h("div", { class: "check" }, blanks, h("label", { for: "accept-blanks" }, h("span", { text: "Take a row the reader found blank as blank, without asking" }), h("span", { class: "hint", text: "For when students leave questions unanswered. A faint or doubled mark is still asked about. Every blank is counted, and none is turned into an answer." }))),
    );
    if (items.length === 0) {
      put(reviewHost, h("p", { class: "sub", text: view.sheets.length === 0 ? "Add scans to begin." : "Nothing is waiting for you: every question is settled." }), said ? h("p", { class: "hint", attrs: { "aria-live": "polite" }, text: said }) : null);
      return;
    }
    if (cursor >= items.length || cursor < 0) cursor = 0;
    const item = items[cursor];
    const isVersion = item.kind === "version";
    const picked = new Set();
    const card = h("div", { class: "review-card", tabIndex: 0, attrs: { role: "group", "aria-label": isVersion ? `Sheet ${item.sheet}: which version` : `Sheet ${item.sheet}, question ${item.question}` } });
    const live = h("p", { class: "hint", attrs: { "aria-live": "polite" }, text: said });
    const fills = item.fills.map(/** @param {number} f @param {number} i */ (f, i) => `${item.labels[i] ?? String.fromCharCode(65 + i)} ${Math.round(f * 100)}%`).join(", ");

    /** @param {number[] | "blank" | number} choice */
    async function record(choice) {
      if (busy) return;
      busy = true;
      try {
        const body = isVersion ? { sheet: item.sheet, kind: "version", version: choice } : { sheet: item.sheet, kind: "answer", question: item.question, places: choice };
        const next = await post(`${base}/decisions`, body);
        trail.push({ sheet: item.sheet, kind: isVersion ? "version" : "answer", ...(isVersion ? {} : { question: item.question }) });
        const words = choice === "blank" ? "blank" : isVersion ? `version ${item.labels[/** @type {number} */ (choice) - 1]}` : /** @type {number[]} */ (choice).map((c) => item.labels[c]).join(" and ");
        say(`Recorded ${words} for ${isVersion ? `sheet ${item.sheet}` : `sheet ${item.sheet}, question ${item.question}`}. ${next.queue.total === 0 ? "That was the last one." : `${next.queue.total} to go.`}`);
        apply(next);
        focusCard();
      } catch (error) {
        tell(error);
      } finally {
        busy = false;
      }
    }

    async function undo() {
      const last = trail.pop();
      if (!last || busy) {
        say("There is nothing to take back.");
        live.textContent = said;
        return;
      }
      busy = true;
      try {
        const next = await post(`${base}/decisions/undo`, last);
        const back = next.queue.items.findIndex(/** @param {any} i */ (i) => i.sheet === last.sheet && (last.kind === "version" ? i.kind === "version" : i.question === last.question));
        if (back !== -1) cursor = back;
        say(`Took back the last decision. ${next.queue.total} to go.`);
        apply(next);
        focusCard();
      } catch (error) {
        tell(error);
      } finally {
        busy = false;
      }
    }

    function move(by) {
      cursor = (cursor + by + items.length) % items.length;
      say("");
      renderReview();
      focusCard();
    }

    const buttons = item.labels.map(/** @param {string} label @param {number} i */ (label, i) => {
      const button = h("button", { type: "button", class: "bubble", text: label, attrs: { ...(item.multiple ? { "aria-pressed": "false" } : {}), "aria-keyshortcuts": `${label} ${i + 1}` } });
      button.addEventListener("click", () => {
        if (item.multiple) {
          if (picked.has(i)) picked.delete(i);
          else picked.add(i);
          button.setAttribute("aria-pressed", picked.has(i) ? "true" : "false");
          button.classList.toggle("on", picked.has(i));
          return;
        }
        void record(isVersion ? i + 1 : [i]);
      });
      return button;
    });
    const recordPicked = () => {
      if (picked.size === 0) {
        say("Choose at least one bubble, or say the row is blank.");
        live.textContent = said;
        return;
      }
      void record([...picked].sort((a, b) => a - b));
    };

    put(
      card,
      h("h3", { text: isVersion ? `Sheet ${item.sheet}: which version is it?` : `Sheet ${item.sheet}, question ${item.question}, version ${item.version}` }),
      isVersion ? null : h("p", { class: "stem", text: item.stem }),
      h("p", { class: "why", text: item.why }),
      item.picture
        ? h("img", { class: "crop", src: `/api/scoring/${encodeURIComponent(sid)}/entries/${item.entry}/crops/${isVersion ? "version" : `q${item.question}`}`, attrs: { alt: `The row of bubbles as scanned. The reader measured these fills: ${fills || "none"}.` } })
        : h("p", { class: "hint", text: item.entry === undefined ? "There is no picture of this." : "No picture is kept of this one: scores opened from a saved file carry the readings but no pictures." }),
      h("p", { class: "fills", text: fills ? `How full each bubble read: ${fills}.` : "" }),
      h("div", { class: "bubbles", attrs: { role: "group", "aria-label": isVersion ? "Choose the version" : item.multiple ? "Mark every bubble that is filled" : "Choose the bubble that is filled" } }, ...buttons),
      h(
        "div",
        { class: "review-actions" },
        item.multiple ? h("button", { type: "button", class: "primary", text: "Record these (Enter)", on: { click: recordPicked } }) : null,
        isVersion ? null : h("button", { type: "button", text: "Blank (0)", on: { click: () => void record("blank") } }),
        h("button", { type: "button", text: "Previous (←)", disabled: items.length < 2, on: { click: () => move(-1) } }),
        h("button", { type: "button", text: "Skip (→)", disabled: items.length < 2, on: { click: () => move(1) } }),
        h("button", { type: "button", text: "Take back the last (Z)", disabled: trail.length === 0, on: { click: () => void undo() } }),
      ),
      h("p", { class: "hint", text: isVersion ? "Keys: A to D choose the version, the arrows move, Z takes back." : item.multiple ? "Keys: a letter or a digit ticks a bubble, Enter records them, 0 says blank, the arrows move, Z takes back." : "Keys: a letter or a digit records that bubble, 0 says blank, the arrows move, Z takes back." }),
      live,
    );

    card.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
      if (e.ctrlKey || e.altKey || e.metaKey || busy) return;
      const key = e.key.toLowerCase();
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (items.length > 1) move(1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (items.length > 1) move(-1);
        return;
      }
      if (key === "z") {
        e.preventDefault();
        void undo();
        return;
      }
      if (e.key === "Enter" && item.multiple && document.activeElement === card) {
        e.preventDefault();
        recordPicked();
        return;
      }
      if (key === "0" && !isVersion) {
        e.preventDefault();
        void record("blank");
        return;
      }
      let at = item.labels.findIndex(/** @param {string} l */ (l) => l.toLowerCase() === key);
      if (at === -1 && /^[1-9]$/.test(key) && Number(key) <= item.labels.length) at = Number(key) - 1;
      if (at === -1) return;
      e.preventDefault();
      if (item.multiple) buttons[at]?.click();
      else void record(isVersion ? at + 1 : [at]);
    });
    reviewHost.append(card);
  }

  function focusCard() {
    /** @type {HTMLElement | null} */ (reviewHost.querySelector(".review-card"))?.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Results

  function renderResults() {
    clear(resultsHost);
    put(resultsHost, h("h2", { text: "Scores" }));
    if (view.sheets.length === 0) {
      put(resultsHost, h("p", { class: "sub", text: "No sheet has been read yet." }));
      return;
    }
    const stats = view.stats;
    put(
      resultsHost,
      h(
        "p",
        { class: "sub" },
        stats.sheets > 0 ? `Mean ${stats.mean} of ${stats.possible}, standard deviation ${stats.sd}, over ${plural(stats.sheets, "complete sheet", "complete sheets")}${stats.reliability ? `; ${stats.reliability.kind} ${stats.reliability.value}` : ""}.` : "No sheet is complete yet, so there is no mean.",
      ),
      ...stats.notes.map(/** @param {string} n */ (n) => h("p", { class: "hint", text: n })),
      h(
        "table",
        { class: "results" },
        h("caption", { class: "visually-hidden", text: "Scores, one row for each sheet" }),
        h("thead", null, h("tr", null, ...["Sheet", "Version", "Score", "Percent", "Status", ""].map((t) => h("th", { scope: "col", text: t })))),
        h(
          "tbody",
          null,
          ...view.sheets.map(/** @param {any} s */ (s) =>
            h(
              "tr",
              { class: openSheet === s.number ? "current" : "" },
              h("th", { scope: "row", text: String(s.number) }),
              h("td", { text: s.version ?? "?" }),
              h("td", { text: `${s.earned} of ${s.possible}` }),
              h("td", { text: s.percent === null ? "" : `${s.percent.toFixed(1)}%` }),
              h("td", { text: s.complete ? "Complete" : `${s.unsettled === 0 ? "" : `${plural(s.unsettled, "question", "questions")} to settle. `}${s.problems.join(" ")}`.trim() }),
              h("td", null, h("button", { type: "button", class: "small-button", text: openSheet === s.number ? "Hide" : "Look", attrs: { "aria-expanded": String(openSheet === s.number) }, on: { click: () => void look(s.number) } })),
            ),
          ),
        ),
      ),
      h("div", { attrs: { "aria-live": "polite" }, id: "sheet-detail" }),
    );
    if (openSheet !== null) void showDetail(openSheet);
  }

  /** @param {number} n */
  async function look(n) {
    openSheet = openSheet === n ? null : n;
    renderResults();
  }

  /** @param {number} n */
  async function showDetail(n) {
    const place = resultsHost.querySelector("#sheet-detail");
    if (!place) return;
    try {
      const sheet = await get(`${base}/sheets/${n}`);
      if (openSheet !== n) return;
      clear(place);
      put(
        place,
        h("h3", { text: `Sheet ${n}${sheet.version ? `, version ${sheet.version}` : ""}: ${sheet.earned} of ${sheet.possible}` }),
        sheet.problems.length > 0 ? h("p", { class: "problem", text: sheet.problems.join(" ") }) : null,
        h(
          "table",
          { class: "results" },
          h("thead", null, h("tr", null, ...["#", "Question", "Marked", "Result", "Points", "Settled by", ""].map((t) => h("th", { scope: "col", text: t })))),
          h(
            "tbody",
            null,
            ...sheet.questions.map(/** @param {any} q */ (q) => {
              const picture = h("div", { hidden: true, class: "inline-crop" });
              return h(
                "tr",
                null,
                h("th", { scope: "row", text: String(q.number) }),
                h("td", null, h("span", { text: q.stem }), q.why ? h("span", { class: "hint", text: ` ${q.why}` }) : null, picture),
                h("td", { text: q.marked === null ? "?" : q.marked === "" ? "blank" : q.marked }),
                h("td", { text: /** @type {Record<string, string>} */ (OUTCOME_WORDS)[q.outcome] ?? q.outcome }),
                h("td", { text: q.possible === 0 ? "" : `${q.earned} of ${q.possible}` }),
                h("td", { text: q.by === "person" ? "You" : q.by === "reader" ? "The reader" : "" }),
                h(
                  "td",
                  null,
                  q.labels.length > 0 ? h("button", { type: "button", class: "small-button", text: "Change…", on: { click: () => void change(n, q) } }) : null,
                  q.decided ? h("button", { type: "button", class: "small-button", text: "Take back", on: { click: () => void takeBack(n, q.number) } }) : null,
                  q.picture
                    ? h("button", {
                        type: "button",
                        class: "small-button",
                        text: "Picture",
                        on: {
                          click: () => {
                            if (picture.hidden && picture.childNodes.length === 0) put(picture, h("img", { class: "crop", src: `/api/scoring/${encodeURIComponent(sid)}/entries/${q.entry}/crops/q${q.number}`, attrs: { alt: `The row of bubbles for question ${q.number} as scanned.` } }));
                            picture.hidden = !picture.hidden;
                          },
                        },
                      })
                    : null,
                ),
              );
            }),
          ),
        ),
      );
    } catch (error) {
      tell(error);
    }
  }

  /**
   * @param {number} sheet
   * @param {any} q
   */
  async function change(sheet, q) {
    const current = q.marked ? [...q.marked].map(/** @param {string} l */ (l) => q.labels.indexOf(l)).filter(/** @param {number} i */ (i) => i >= 0) : [];
    const choice = await chooseBubbles(`Sheet ${sheet}, question ${q.number}`, q.labels, q.multiple, current);
    if (choice === null) return;
    try {
      apply(await post(`${base}/decisions`, { sheet, kind: "answer", question: q.number, places: choice }));
      trail.push({ sheet, kind: "answer", question: q.number });
      shell.notify(`Question ${q.number} on sheet ${sheet} is changed.`, "ok");
    } catch (error) {
      tell(error);
    }
  }

  /**
   * @param {number} sheet
   * @param {number} question
   */
  async function takeBack(sheet, question) {
    try {
      apply(await post(`${base}/decisions/undo`, { sheet, kind: "answer", question }));
      shell.notify("Your decision is taken back, and the reader's own reading stands.", "ok");
    } catch (error) {
      tell(error);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Adjustments

  function renderAdjust() {
    clear(adjustHost);
    const items = view.test.items;
    const kinds = /** @type {Array<[string, string]>} */ ([
      ["drop", "Drop the question from the total"],
      ["credit", "Give everyone credit for it"],
      ["alsoRight", "Count another answer as right"],
      ["points", "Change what it is worth"],
    ]);
    const kind = h("select", { id: "adj-kind" }, ...kinds.map(([v, t]) => h("option", { value: v, text: t })));
    const question = h("select", { id: "adj-question" }, ...items.map(/** @param {any} i */ (i) => h("option", { value: String(i.number), text: `${i.number}. ${i.stem}` })));
    const answer = h("select", { id: "adj-answer" });
    const points = h("input", { type: "number", id: "adj-points", min: 0, max: 1000, step: "any", value: 1 });
    const note = h("input", { type: "text", id: "adj-note", autocomplete: "off", placeholder: "Why, for your own records (optional)" });
    const versionBoxes = view.test.versions.map(/** @param {string} v @param {number} i */ (v, i) => {
      const box = h("input", { type: "checkbox", id: `adj-v${i}`, checked: true });
      return { box, row: h("span", { class: "check inline" }, box, h("label", { for: `adj-v${i}`, text: `Version ${v}` })) };
    });
    const answerField = h("div", { class: "field small", hidden: true }, h("label", { for: "adj-answer", class: "field-label", text: "Which answer counts too (as in version A)" }), answer);
    const pointsField = h("div", { class: "field small", hidden: true }, h("label", { for: "adj-points", class: "field-label", text: "Points it is worth" }), points);
    const result = h("div", { attrs: { "aria-live": "polite" } });
    const apply1 = h("button", { type: "button", class: "primary", text: "Apply", hidden: true });

    function options() {
      clear(answer);
      const chosen = items.find(/** @param {any} i */ (i) => String(i.number) === question.value);
      for (const o of chosen?.options ?? []) put(answer, h("option", { value: o.letter, text: `${o.letter}. ${o.text}` }));
    }
    function shape() {
      answerField.hidden = kind.value !== "alsoRight";
      pointsField.hidden = kind.value !== "points";
      apply1.hidden = true;
      clear(result);
    }
    kind.addEventListener("change", shape);
    question.addEventListener("change", () => {
      options();
      shape();
    });
    options();

    const request = () => {
      const chosen = view.test.versions.flatMap(/** @param {string} _v @param {number} i */ (_v, i) => (versionBoxes[i].box.checked ? [i + 1] : []));
      return {
        kind: kind.value,
        question: Number(question.value),
        ...(chosen.length > 0 && chosen.length < view.test.versions.length ? { versions: chosen } : {}),
        ...(kind.value === "alsoRight" ? { answer: answer.value } : {}),
        ...(kind.value === "points" ? { points: Number(points.value) } : {}),
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      };
    };
    const look1 = h("button", { type: "button", text: "See what it would change", on: { click: () => void (async () => {
      try {
        const effect = await post(`${base}/adjustments/check`, request());
        clear(result);
        put(
          result,
          h("p", { text: effect.changed.length === 0 ? `${effect.words}: this changes no sheet's score.` : `${effect.words}: this changes ${effect.changed.length} of ${plural(effect.sheets, "sheet", "sheets")}: ${effect.changed.slice(0, 12).map(/** @param {any} c */ (c) => `sheet ${c.sheet} from ${c.from} to ${c.to}`).join("; ")}${effect.changed.length > 12 ? `; and ${effect.changed.length - 12} more` : ""}.` }),
        );
        apply1.hidden = false;
      } catch (error) {
        apply1.hidden = true;
        clear(result);
        put(result, h("p", { class: "problem", text: error instanceof Error ? error.message : "That could not be checked." }));
      }
    })() } });
    apply1.addEventListener("click", async () => {
      try {
        apply(await post(`${base}/adjustments`, request()));
        shell.notify("The adjustment is made.", "ok");
      } catch (error) {
        tell(error);
      }
    });

    put(
      adjustHost,
      h("h2", { text: "Adjustments" }),
      h("p", { class: "sub", text: "A question that turned out to be faulty can be dropped, credited to everyone, given a second right answer or a different worth. You see how many sheets it changes before it is applied, and it needs no rescan." }),
      ...view.adjustments.map(/** @param {any} a */ (a) =>
        h("div", { class: "file-row" }, h("span", { class: "file-name", text: `Question ${a.question}: ${a.words}${a.versions ? ` (versions ${a.versions.map(/** @param {number} v */ (v) => view.test.versions[v - 1]).join(", ")})` : ""}` }), a.note ? h("span", { class: "meta", text: a.note }) : null, h("button", { type: "button", class: "small-button", text: "Remove", on: { click: () => void (async () => {
          try {
            apply(await del(`${base}/adjustments/${encodeURIComponent(a.id)}`));
          } catch (error) {
            tell(error);
          }
        })() } })),
      ),
      items.length === 0
        ? null
        : h(
            "div",
            null,
            h("div", { class: "grid" }, h("div", { class: "field" }, h("label", { for: "adj-kind", class: "field-label", text: "Adjustment" }), kind), h("div", { class: "field" }, h("label", { for: "adj-question", class: "field-label", text: "Question (numbered as in version A)" }), question)),
            answerField,
            pointsField,
            view.test.versions.length > 1 ? h("div", { class: "field" }, h("span", { class: "field-label", text: "For which versions" }), ...versionBoxes.map(/** @param {any} b */ (b) => b.row)) : null,
            h("div", { class: "field" }, h("label", { for: "adj-note", class: "field-label", text: "Note" }), note),
            h("div", { class: "editor-actions" }, look1, apply1),
            result,
          ),
    );
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Item statistics

  function renderStats() {
    clear(statsHost);
    const stats = view.stats;
    put(statsHost, h("h2", { text: "How the questions did" }));
    if (stats.sheets === 0) {
      put(statsHost, h("p", { class: "sub", text: "Figures for each question appear when there is a complete sheet. They count complete sheets only, across every version." }), ...stats.notes.map(/** @param {string} n */ (n) => h("p", { class: "hint", text: n })));
      return;
    }
    const byId = new Map(view.test.items.map(/** @param {any} i */ (i) => [i.id, i]));
    put(
      statsHost,
      h("p", { class: "sub", text: "Difficulty is the share of the points earned. Discrimination is how well the question told the strong from the weak (the correlation with the total, and the top 27 percent less the bottom 27 percent). Answers are counted in the order of version A, with the right one marked." }),
      h(
        "table",
        { class: "results" },
        h("caption", { class: "visually-hidden", text: "Item statistics, one row for each question" }),
        h("thead", null, h("tr", null, ...["#", "Question", "Sheets", "Difficulty", "Discrimination", "Top less bottom", "Blank", "Answers marked"].map((t) => h("th", { scope: "col", text: t })))),
        h(
          "tbody",
          null,
          ...stats.items.map(/** @param {any} i */ (i) => {
            const item = /** @type {any} */ (byId.get(i.questionId));
            return h(
              "tr",
              null,
              h("th", { scope: "row", text: item ? String(item.number) : "" }),
              h("td", { text: item?.stem ?? "" }),
              h("td", { text: String(i.sheets) }),
              h("td", { text: figure(i.difficulty) }),
              h("td", { text: figure(i.discrimination.pointBiserial) }),
              h("td", { text: figure(i.discrimination.upperLower) }),
              h("td", { text: String(i.blanks) }),
              h("td", { text: i.options.map(/** @param {any} o @param {number} at */ (o, at) => `${String.fromCharCode(65 + at)}${o.correct ? "✓" : ""} ${o.chosen}`).join("   ") }),
            );
          }),
        ),
      ),
      ...stats.notes.map(/** @param {string} n */ (n) => h("p", { class: "hint", text: n })),
    );
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Saving and writing

  async function save() {
    try {
      const saved = await post(`${base}/save`);
      apply(saved.view);
      shell.notify(`Saved as ${saved.name} in the Scores folder.`, "ok");
      return true;
    } catch (error) {
      tell(error);
      return false;
    }
  }

  function renderSave() {
    clear(saveHost);
    const written = h("div", { attrs: { "aria-live": "polite" } });
    const choices = { workbook: true, csv: true, analysis: true };
    /**
     * @param {"workbook" | "csv" | "analysis"} key
     * @param {string} label
     * @param {string} hint
     */
    const tick = (key, label, hint) => {
      const box = h("input", { type: "checkbox", id: `out-${key}`, checked: true });
      box.addEventListener("change", () => (choices[key] = box.checked));
      return h("div", { class: "check" }, box, h("label", { for: `out-${key}` }, h("span", { text: label }), h("span", { class: "hint", text: hint })));
    };
    const write = h("button", { type: "button", class: "primary", text: "Write the results", disabled: view.sheets.length === 0 });
    write.addEventListener("click", async () => {
      const what = Object.entries(choices).filter(([, on]) => on).map(([k]) => k);
      if (what.length === 0) {
        shell.notify("Choose something to write.", "error");
        return;
      }
      write.disabled = true;
      try {
        const result = await post(`${base}/export`, { what });
        clear(written);
        put(
          written,
          h(
            "div",
            { class: "written" },
            h("h3", { text: "The files are made" }),
            h("p", { class: "sub", text: "They are in the Exports folder inside your OpenAssess folder. Nothing already there was written over." }),
            ...result.written.map(/** @param {any} file */ (file) => h("div", { class: "file-row" }, h("span", { class: "file-name", text: file.name }), ...fileButtons(file, shell))),
          ),
        );
      } catch (error) {
        tell(error);
      } finally {
        write.disabled = false;
      }
    });
    const keep = h("button", { type: "button", text: "Keep the class figures in the bank…", disabled: view.stats.sheets === 0, on: { click: () => void keepFigures() } });
    put(
      saveHost,
      h("h2", { text: "Keep and write" }),
      h("p", { class: "sub", text: "Save the scores to carry on another day or to score again with a different key; a scores file holds each sheet's readings and what you decided, and no name, no file name and no picture." }),
      h("div", { class: "editor-actions" }, h("button", { type: "button", class: "primary", text: "Save scores", on: { click: () => void save() } })),
      h("h3", { text: "Results" }),
      tick("workbook", "A workbook (Excel)", "Scores with an empty Name column for you to fill, the key of each version, the adjustments and the item figures."),
      tick("csv", "The scores as a CSV", "For a spreadsheet or a learning system's grade import."),
      tick("analysis", "A page of item analysis", "For printing or filing: each question with how many marked each answer."),
      h("div", { class: "editor-actions" }, write),
      written,
      h("h3", { text: "The class figures" }),
      h("p", { class: "sub", text: "A bank can keep how each question did for this class: its difficulty and discrimination, and how many sheets marked each answer. Nothing about any sheet or student goes in, and nothing is kept unless you ask." }),
      h("div", { class: "editor-actions" }, keep),
    );
  }

  async function keepFigures() {
    const answer = await ask({
      title: "Keep the class figures in the bank?",
      body: [`The bank "${view.bank}" will keep, for this test given on ${new Date().toISOString().slice(0, 10)}, the number of complete sheets (${view.stats.sheets}) and for each question its difficulty, its discrimination, how many sheets marked each answer and how many left it blank. No sheet, name, response or file name is kept. The bank file is shared when you share the bank.`],
      actions: [
        { label: "Cancel", value: false },
        { label: "Keep the figures", value: true, primary: true },
      ],
    });
    if (answer?.value !== true) return;
    try {
      const kept = await post(`${base}/statistics`, { confirm: true });
      shell.notify(`The figures of ${plural(kept.sheets, "sheet", "sheets")} are kept in the bank.`, "ok");
    } catch (error) {
      tell(error);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------

  async function canLeave() {
    if (!view.unsaved) return true;
    const answer = await ask({
      title: "Save these scores?",
      body: ["You have read sheets, settled answers or made adjustments that are not saved. Scores you do not save are lost when OpenAssess closes."],
      actions: [
        { label: "Stay", value: "stay" },
        { label: "Leave without saving", value: "leave", danger: true },
        { label: "Save", value: "save", primary: true },
      ],
    });
    if (!answer || answer.value === "stay") return false;
    if (answer.value === "save") return save();
    return true;
  }

  renderAll();
  return { canLeave, dirty: () => view.unsaved === true };
}
