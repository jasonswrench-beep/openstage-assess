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
import { checkRow, h } from "../ui/dom.js";

/** Just enough of a page for `h` and `checkRow` to build into: elements that remember their attributes and children. */
class Node_ {
  id = "";
  className = "";
  textContent = "";
  htmlFor = "";
  children: Node_[] = [];
  attrs: Record<string, string> = {};
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | undefined {
    return this.attrs[name];
  }
  addEventListener(): void {}
  append(...kids: Node_[]): void {
    this.children.push(...kids);
  }
  /** The words under this element, the way a reader of the page would take them. */
  get words(): string {
    return this.textContent + this.children.map((c) => c.words).join("");
  }
}
(globalThis as unknown as { document: unknown }).document = { createElement: (tag: string) => new Node_(tag), createTextNode: (text: string) => Object.assign(new Node_("#text"), { textContent: text }) };

const find = (root: Node_, id: string): Node_ | undefined => (root.id === id ? root : root.children.map((c) => find(c, id)).find((f) => f !== undefined));

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
