/**
 * The OpenStage suite's look (2026-11-11): the menus under the navy bar, which command each holds and when it can be used, the
 * command search's order, and the list of keys. The parts that need a page (the keyboard in the menus, focus going back, the dialogs'
 * Close button, small windows, the dark scheme) were tried in a real browser with a script and OpenStage Author's accessibility audit,
 * and are listed in TESTING-TODO.md for a person and a screen reader.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { buildMenus, menuEntries, newQuestionLabel, routeOf } from "../ui/frame.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { ariaKeys, letterIndex, stepIndex } from "../ui/menubar.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { placeMenu, tidyEntries } from "../ui/popupmenu.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { foundText, menusText, rankCommands, scoreCommand, searchEntries } from "../ui/commandsearch.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { KEY_GROUPS } from "../ui/keys.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { UI_ICONS } from "../ui/ui-icons.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { EDITABLE_TYPES } from "../ui/dom.js";

type Cmd = { label: string; icon?: string; keys?: string; run: () => void; enabled?: () => boolean };
type Menu = { id: string; label: string; items: Array<Cmd | "-"> };

/** The menus as a screen sees them: at `hash`, with what the screen offers, and a record of where commands went. */
function menusAt(hash: string, offered: Record<string, { run: () => void; enabled?: () => boolean }> = {}) {
  const did: string[] = [];
  const built = buildMenus({
    go: (to: string) => did.push(`go ${to}`),
    hash: () => hash,
    offer: () => ({ actions: offered }),
    onHome: (id: string) => did.push(`home ${id}`),
    showFolder: () => did.push("folder"),
    search: () => did.push("search"),
    keys: () => did.push("keys"),
  }) as { menus: Menu[]; quick: Cmd[] };
  const item = (menu: string, label: string): Cmd => {
    const found = built.menus.find((m) => m.id === menu)?.items.find((i) => i !== "-" && i.label === label);
    assert.ok(found && found !== "-", `${menu} has ${label}`);
    return found as Cmd;
  };
  const usable = (menu: string, label: string): boolean => {
    const cmd = item(menu, label);
    return cmd.enabled ? cmd.enabled() : true;
  };
  return { ...built, did, item, usable };
}

describe("the menus", () => {
  test("are File, Bank, Question, Test and Help, and every command has an icon this program carries", () => {
    const { menus } = menusAt("#/");
    assert.deepEqual(menus.map((m) => m.label), ["File", "Bank", "Question", "Test", "Help"]);
    for (const menu of menus) {
      for (const item of menu.items) {
        if (item === "-") continue;
        assert.ok(item.icon && item.icon in UI_ICONS, `${item.label} has an icon in ui-icons.js`);
      }
    }
  });

  test("hold every command the eight buttons along the top of a bank's screen used to, so none was lost", () => {
    const { menus } = menusAt("#/bank/Planets");
    const labels = menus.flatMap((m) => m.items).filter((i): i is Cmd => i !== "-").map((i) => i.label);
    for (const was of ["Rename…", "Print…", "Export…", "Answer sheets…", "Folders", "Coverage", "Check quality", "Remove…"]) {
      assert.ok(labels.includes(was), `${was} is in a menu`);
    }
  });

  test("write a new question of every kind the bank screen's select offers, each named for its kind", () => {
    const { menus } = menusAt("#/bank/Planets");
    const question = menus.find((m) => m.id === "question") as Menu;
    const kinds = question.items.filter((i): i is Cmd => i !== "-").map((i) => i.label).filter((l) => l.startsWith("New "));
    assert.equal(kinds.length, EDITABLE_TYPES.length);
    assert.equal(newQuestionLabel("multipleChoice"), "New multiple choice question");
    assert.equal(newQuestionLabel("trueFalse"), "New true or false question");
    assert.ok(kinds.includes("New essay question"));
  });

  test("a command the screen does not offer stays in its menu and cannot be used; one it offers is done by the screen", () => {
    const home = menusAt("#/");
    for (const label of ["Rename…", "Folders", "Coverage", "Check quality", "Remove…"]) assert.equal(home.usable("bank", label), false, label);
    assert.equal(home.usable("question", "New essay question"), false);
    let renamed = 0;
    const bank = menusAt("#/bank/Planets", { rename: { run: () => renamed++ }, clearFilters: { run: () => undefined, enabled: () => false } });
    assert.equal(bank.usable("bank", "Rename…"), true);
    bank.item("bank", "Rename…").run();
    assert.equal(renamed, 1);
    assert.equal(bank.usable("bank", "Folders"), false, "not offered by this screen");
    assert.equal(bank.usable("question", "Clear filters"), false, "offered, but the screen says not now (no filter is on)");
  });

  test("Print, Answer sheets and Export go to the bank's own screens, from any screen that is about a bank, and not to the one already shown", () => {
    const bank = menusAt("#/bank/Planets%20and%20moons");
    assert.equal(bank.usable("test", "Print…"), true);
    bank.item("test", "Print…").run();
    bank.item("test", "Export…").run();
    assert.deepEqual(bank.did, ["go #/print/Planets%20and%20moons", "go #/export/Planets%20and%20moons"]);
    assert.deepEqual(bank.quick.map((c) => c.label), ["Print…", "Answer sheets…", "Export…"], "and are the navy bar's buttons on a bank");
    const print = menusAt("#/print/Planets");
    assert.equal(print.usable("test", "Print…"), false, "already there");
    assert.equal(print.usable("test", "Answer sheets…"), true);
    const home = menusAt("#/");
    assert.equal(home.usable("test", "Export…"), false, "no bank on Home");
  });

  test("Home's commands are done on Home, wherever they are chosen, and the rest of File and Help work everywhere", () => {
    const sheets = menusAt("#/sheets/Planets");
    sheets.item("file", "New bank…").run();
    sheets.item("file", "Open a bank file…").run();
    sheets.item("file", "Your banks").run();
    sheets.item("file", "Show the OpenAssess folder").run();
    sheets.item("help", "Search for a command").run();
    sheets.item("help", "Keyboard keys").run();
    assert.deepEqual(sheets.did, ["home newBank", "home openBankFile", "go #/", "folder", "search", "keys"]);
    assert.equal(menusAt("#/").usable("file", "Your banks"), false, "Home is already showing");
    assert.equal(sheets.item("help", "Search for a command").keys, "Ctrl+K");
    assert.equal(sheets.item("help", "Keyboard keys").keys, "Ctrl+/");
  });

  test("the bank's \"...\" offers the Bank menu's own commands", () => {
    const { menus } = menusAt("#/bank/Planets");
    const entries = menuEntries(menus, "bank").filter((i: Cmd | "-") => i !== "-").map((i: Cmd) => i.label);
    assert.deepEqual(entries, ["Rename…", "Folders", "Coverage", "Check quality", "Remove…"]);
  });
});

describe("which screen an address is", () => {
  test("names the bank of a bank's screens, and no bank elsewhere", () => {
    assert.deepEqual(routeOf("#/bank/Planets%202"), { screen: "bank", bank: "Planets 2" });
    assert.deepEqual(routeOf("#/sheets/A"), { screen: "sheets", bank: "A" });
    assert.deepEqual(routeOf("#/"), { screen: "home", bank: null });
    assert.deepEqual(routeOf(""), { screen: "other", bank: null });
    assert.deepEqual(routeOf("#/import/s1"), { screen: "import", bank: null });
    assert.deepEqual(routeOf("#/score/abc"), { screen: "score", bank: null }, "a scoring session is not a bank");
  });
});

describe("moving in a menu", () => {
  test("goes round at the ends, finds the next item by its letter, and writes keys the way aria-keyshortcuts wants", () => {
    assert.equal(stepIndex(2, 3, 1), 0);
    assert.equal(stepIndex(0, 3, -1), 2);
    assert.equal(stepIndex(-1, 3, -1), 2);
    assert.equal(stepIndex(0, 0, 1), -1);
    assert.equal(letterIndex(["Rename", "Remove", "Coverage"], 0, "r"), 1);
    assert.equal(letterIndex(["Rename", "Remove", "Coverage"], 1, "R"), 0, "round again, in any case");
    assert.equal(letterIndex(["Rename"], 0, " "), -1);
    assert.equal(ariaKeys("Ctrl+K"), "Control+K");
    assert.equal(ariaKeys("Alt+Up"), "Alt+ArrowUp");
  });

  test("a menu from a button stays inside the window, and its lines between groups are tidied", () => {
    const view = { width: 400, height: 300 };
    assert.deepEqual(placeMenu({ left: 350, top: 10, right: 390, bottom: 40 }, { width: 200, height: 100 }, view), { left: 190, top: 42 });
    assert.deepEqual(placeMenu({ left: 10, top: 260, right: 50, bottom: 290 }, { width: 100, height: 120 }, view), { left: 10, top: 138 }, "over the button when there is no room under it");
    const run = () => undefined;
    assert.deepEqual(tidyEntries(["-", { label: "a", run }, "-", "-", { label: "b", run }, "-"]).map((e: Cmd | "-") => (e === "-" ? "-" : e.label)), ["a", "-", "b"]);
  });
});

describe("the command search", () => {
  test("lists each command once with the menus it is in, and puts the best name first", () => {
    const { menus } = menusAt("#/bank/Planets");
    const entries = searchEntries(menus);
    assert.equal(entries.length, menus.flatMap((m) => m.items).filter((i) => i !== "-").length, "no command is in two menus here");
    const ranked = rankCommands(entries, "check");
    assert.equal(ranked[0].label, "Check quality");
    assert.equal(menusText(ranked[0].entry.menus), "Bank menu");
    assert.equal(rankCommands(entries, "essay")[0].label, "New essay question");
    assert.ok(rankCommands(entries, "moodle").some((f: { label: string }) => f.label === "Export…"), "found by what it is for");
    assert.equal(rankCommands(entries, "zzzz").length, 0);
    assert.equal(rankCommands(entries, "").length, entries.length, "nothing typed lists every command, in the order of the menus");
    assert.equal(scoreCommand("print", "Print…"), 100, "the dots after a name that opens a window do not count");
    assert.equal(foundText(0, "zzzz"), "No command has those words. Try another word, or look in the menus.");
    assert.equal(foundText(1, "x"), "1 command found.");
  });
});

describe("the list of keys", () => {
  test("has every key a person can use here, in named groups, with nothing said twice in a group", () => {
    const all = KEY_GROUPS.flatMap((g: { rows: { keys: string }[] }) => g.rows.map((r) => r.keys));
    for (const keys of ["Ctrl+K", "Ctrl+/", "Ctrl+S", "Z", "0"]) assert.ok(all.includes(keys), `${keys} is listed`);
    for (const group of KEY_GROUPS as { title: string; rows: { keys: string }[] }[]) {
      assert.ok(group.title.length > 0);
      assert.equal(new Set(group.rows.map((r) => r.keys)).size, group.rows.length, `${group.title} lists each key once`);
    }
  });

  test("names keys the program really has: Ctrl+S is the editor's, and the score review's keys are scoring.js's", () => {
    const UI = join(import.meta.dirname, "..", "ui");
    const editor = readFileSync(join(UI, "editor.js"), "utf8");
    assert.match(editor, /e\.key\.toLowerCase\(\) === "s"/);
    const scoring = readFileSync(join(UI, "scoring.js"), "utf8");
    assert.match(scoring, /key === "z"/);
    assert.match(scoring, /key === "0"/);
  });
});
