/**
 * What a screen reader is told a control is called.
 *
 * Looking at the screens with the browser's own accessibility tree found three kinds of fault that "every control has a name" did not
 * catch, because each control had one: a tick box whose label held a whole paragraph (so its name was the paragraph), and links and
 * buttons that repeat on every card or row of a list ("Open", "Export", "Print", "Try it", "Look") and say nothing about which bank,
 * sample or sheet they are for. There is no window here, so this holds the shared helper to what it promises with a stand-in for the
 * page's document, and holds the screens' scripts to the two habits that fixed the rest. It is not a substitute for looking: the
 * names were read from the real tree in the built-in browser, and a screen reader has not been tried (`TESTING-TODO.md`).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { checkRow, h, skipTo } from "../ui/dom.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { notSavedBody, saveFields } from "../ui/save-fields.js";
import { FakeNode, findById, installFakeDocument } from "./support/fake-dom.ts";

installFakeDocument();
const find = findById;
type Node_ = FakeNode;

const UI = join(import.meta.dirname, "..", "ui");
const scripts = readdirSync(UI).filter((f) => f.endsWith(".js"));
const source = (file: string): string => readFileSync(join(UI, file), "utf8");

describe("a tick box with an explanation", () => {
  test("is named by its words alone and described by the explanation, which sits under the words in the label", () => {
    const box = h("input", { type: "checkbox", id: "blanks" });
    const row = checkRow(box, "Take a blank as blank", "For when students leave questions unanswered.");
    const words = find(row, box.getAttribute("aria-labelledby"));
    const note = find(row, box.getAttribute("aria-describedby"));
    assert.equal(words?.words, "Take a blank as blank", "the name is the words and nothing more");
    assert.equal(note?.words, "For when students leave questions unanswered.");
    const label = row.children.find((c: Node_) => c.tag === "label");
    assert.equal(label.htmlFor, "blanks", "clicking the words still ticks the box");
    assert.ok(label.children.includes(words) && label.children.includes(note), "both are inside the label, so they look as they did");
    assert.notEqual(words?.id, note?.id);
  });

  test("a round button of a group is laid out as a choice, with its words in bold when asked, and is named and described the same way", () => {
    const radio = h("input", { type: "radio", id: "dest-0", name: "destination" });
    const row = checkRow(radio, "Moodle XML", "One file for Moodle's question bank.", { wrapper: "choice", bold: true });
    assert.equal(row.className, "choice");
    const words = find(row, radio.getAttribute("aria-labelledby"));
    assert.equal(words?.tag, "b");
    assert.equal(words?.words, "Moodle XML");
    assert.equal(find(row, radio.getAttribute("aria-describedby"))?.words, "One file for Moodle's question bank.");
  });

  test("with no explanation has a name and no description", () => {
    const box = h("input", { type: "checkbox", id: "plain" });
    const row = checkRow(box, "Include retired", undefined);
    assert.equal(find(row, box.getAttribute("aria-labelledby"))?.words, "Include retired");
    assert.equal(box.getAttribute("aria-describedby"), undefined);
    assert.equal(find(row, "plain-hint"), undefined, "no empty note is made");
  });
});

describe("the screens' scripts", () => {
  test("no screen puts an explanation inside a label by hand, which is what made a tick box's name a paragraph", () => {
    for (const file of scripts) {
      if (file === "dom.js") continue;
      const lines = source(file).split("\n");
      lines.forEach((line, i) => assert.doesNotMatch(line, /h\("label"[^\n]*class: "hint"/, `${file}:${i + 1} builds a label that holds a hint; use checkRow`));
    }
  });

  // Found by an independent reader of these changes.
  test("what the score review says is cancelled by the next thing it says, so an older confirmation is never written back", () => {
    const say = /function say\(text\) \{[\s\S]*?\n  \}\n/.exec(source("scoring.js"))?.[0] ?? "";
    assert.match(say, /clearTimeout\(sayTimer\)/, "the timer an earlier call left running is cleared");
    assert.match(say, /sayTimer = window\.setTimeout/, "and the new one is kept so that the next call can clear it");
    assert.ok(say.indexOf("clearTimeout") < say.indexOf("setTimeout"), "cleared before a new one is set");
  });

  test("in forced colours a row that is chosen and has focus keeps its focus ring", () => {
    const css = readFileSync(join(UI, "style.css"), "utf8");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    assert.match(forced, /\.qrow\[aria-current="true"\]:focus-visible \{[^}]*outline: 3px solid Highlight/);
  });

  // Found by walking the home screen with the Tab key in the browser: the two hidden file inputs were stops that showed nothing, and the
  // two labels that opened them were not stops at all, so a person at the keyboard could not choose a file or see where they were.
  test("a file chooser that is hidden is opened by a real button, and the hidden input is not a stop for the keyboard or the screen reader", () => {
    for (const file of scripts) {
      const lines = source(file).split("\n");
      const hidden: string[] = [];
      lines.forEach((line, i) => {
        if (!/h\("input", \{[^\n]*type: "file"/.test(line) || !/visually-hidden/.test(line)) return;
        assert.match(line, /tabIndex: -1/, `${file}:${i + 1} hides a file input and leaves it a stop for the keyboard`);
        assert.match(line, /"aria-hidden": "true"/, `${file}:${i + 1} hides a file input from sight and not from a screen reader`);
        const id = /id: "([^"]+)"/.exec(line)?.[1];
        assert.ok(id, `${file}:${i + 1} has an input with no id`);
        hidden.push(id as string);
      });
      for (const id of hidden) {
        lines.forEach((line, i) => assert.doesNotMatch(line, new RegExp(`h\\("label"[^\\n]*for: "${id}"`), `${file}:${i + 1} opens the hidden input ${id} with a label, which is no stop for the keyboard; use a button`));
      }
    }
    const home = source("home.js");
    assert.match(home, /h\("button", \{ type: "button", class: "button primary", text: "Choose a file", on: \{ click: \(\) => fileInput\.click\(\) \} \}\)/);
    assert.match(home, /h\("button", \{ type: "button", class: "button", text: "Open a bank file…", on: \{ click: \(\) => bankInput\.click\(\) \} \}\)/);
  });

  test("a link or button that repeats for each bank, sample or sheet says which one it is for", () => {
    const repeated: Array<[string, RegExp]> = [
      ["home.js", /text: "Open"/],
      ["home.js", /text: "Export"/],
      ["home.js", /text: "Print"/],
      ["home.js", /text: "Try it"/],
      ["home.js", /text: s\.template \? "Save a copy to fill in…" : "Save a copy…"/],
      ["scoring.js", /"Hide" : "Look"/],
    ];
    for (const [file, pattern] of repeated) {
      const line = source(file)
        .split("\n")
        .find((l) => pattern.test(l));
      assert.ok(line, `${file} still has a control matching ${pattern}`);
      assert.match(line as string, /"aria-label"/, `${file}: ${pattern} is the same words on every card or row, so it needs an aria-label that names what it is for`);
    }
  });
});

// Found by a reviewer reading the router against the page, and seen in the browser: the first link on every screen sent the person to
// "There is nothing here".
describe("the skip link", () => {
  test("moves focus to the main area and cancels the move to #main, which the router would take for a screen", () => {
    const link = h("a", { class: "skip", href: "#main" });
    const main = h("main", { id: "main", tabIndex: -1 });
    skipTo(link, main);
    assert.equal(main.focused, false);
    const clicked = link.click();
    assert.equal(clicked.defaultPrevented, true, "the address is left alone");
    assert.equal(main.focused, true, "and focus goes where the link said");
  });

  test("is wired in the shell, which also leaves the first screen without focus so that the link is the first stop", () => {
    const app = source("app.js");
    assert.match(app, /skipTo\(\/\*\*[^\n]*\(skip\), main\)/, "the shell wires the link it finds on the page");
    assert.match(readFileSync(join(UI, "index.html"), "utf8"), /<a class="skip" href="#main">/, "and the link is still the page's first element");
    assert.match(app, /if \(!firstScreen\) main\.focus\(/, "a screen the person moves to is given focus; the first one is not");
    assert.doesNotMatch(app, /\[\/\^#main/, "and #main is not a route");
  });
});

// Found by a reviewer matching every input, select and textarea the screens build to a label: these three had none, in the dialog
// every import ends in.
describe("the Save into a bank dialog", () => {
  const banks = [{ name: "Biology", title: "Biology 101", questions: 12 }];

  test("names its text box, its list of banks and its folder box by the words beside them, which are the words a person sees", () => {
    const fields = saveFields({ file: "Chapter 3.docx", banks });
    const root = h("div", null, ...fields.body);
    const expected: Array<[FakeNode, string, FakeNode]> = [
      [fields.titleInput, "A new bank, called", fields.modeNew],
      [fields.bankSelect, "Add to a bank you already have", fields.modeOld],
      [fields.folderInput, "Put the questions in a folder called", fields.folderOn],
    ];
    for (const [control, words, beside] of expected) {
      // The label that shows these words sits beside the button or tick box and belongs to it; the box beside the words is named
      // with the same words, and what it is called is checked against the label that is really on the page.
      const label = root.querySelectorAll("label").find((l: FakeNode) => l.htmlFor === beside.id);
      assert.ok(label, `${beside.id} has its label on the page`);
      assert.equal(label.words, words);
      assert.equal(control.getAttribute("aria-label"), label.words, `${control.id}: the name is exactly the words that are shown, so a person who says them is understood`);
      assert.equal(control.getAttribute("aria-labelledby"), undefined, "and it is a plain label, which every reader of the page follows");
    }
    const ids = [fields.modeNew, fields.modeOld, fields.folderOn, fields.titleInput, fields.bankSelect, fields.folderInput].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "no two controls share an id");
  });

  test("starts the new bank's name and the folder's name from the file's name, without its extension", () => {
    const fields = saveFields({ file: "Chapter 3.docx", banks });
    assert.equal(fields.titleInput.value, "Chapter 3");
    assert.equal(fields.folderInput.value, "Chapter 3");
    assert.equal(fields.modeNew.checked, true);
  });

  test("with no bank to add to, leaves the list and its button unavailable", () => {
    const fields = saveFields({ file: "x.txt", banks: [] });
    assert.equal(fields.bankSelect.disabled, true);
    assert.equal(fields.modeOld.disabled, true);
    assert.equal(fields.bankSelect.getAttribute("aria-label"), "Add to a bank you already have", "and it is still named");
  });
});

// Found by a reviewer reading what Save does when some questions cannot be stored: a green line that faded, then nothing.
describe("when some questions could not be saved", () => {
  test("the person is told how many were saved, and which were not and why, by name, with the number for one that has no title", () => {
    const body = notSavedBody({ bank: "Biology", added: 3, notSaved: [{ index: 1, title: "Capitals", reason: "It has no stem." }, { index: 4, title: "  ", reason: "The picture is missing." }] });
    const text = body.map((part: string | FakeNode) => (typeof part === "string" ? part : part.words)).join("\n");
    assert.match(text, /3 questions were saved into "Biology"\. 2 questions were not:/);
    assert.match(text, /Capitals: It has no stem\./);
    assert.match(text, /Question 5: The picture is missing\./);
    const list = body.find((part: string | FakeNode) => typeof part !== "string") as FakeNode;
    assert.equal(list.tag, "ul");
    assert.equal(list.children.length, 2, "one line for each");
  });

  test("a single question is said in the singular", () => {
    const text = notSavedBody({ bank: "B", added: 1, notSaved: [{ index: 0, title: "Only", reason: "No." }] })[0];
    assert.equal(text, '1 question was saved into "B". 1 question was not:');
  });

  test("the screen waits for that to be read before it moves on, and does not mark the line it also shows as a success", () => {
    const review = source("review.js");
    const asked = review.indexOf('await ask({ title: "Some questions were not saved"');
    const moved = review.indexOf("shell.go(`#/bank/");
    assert.ok(asked > 0, "the dialog is shown");
    assert.ok(moved > asked, "and the move to the bank comes after it has been answered");
    assert.match(review, /failed \? "error" : "ok"/, "and the line is an error when something was not saved, which stays longer");
  });
});
