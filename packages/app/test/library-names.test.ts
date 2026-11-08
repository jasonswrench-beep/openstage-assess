/**
 * The functions that make and check the names of files in the library (`cleanName`, `checkName`, `fitFileName`, `cutAt`, `writeNewFile`,
 * `placeFile`), one rule at a time, with the failing cases an independent reader planted: a write that fails halfway, a write that
 * fails for a reason that is not "the name is taken", a folder with ten thousand names, a platform with no way to tell characters
 * apart, a name with a space at its start or a dot at its end. Each rule here was once a line a fault could be put in and no test
 * noticed (20 of 32 faults planted in the code that the names round added survived).
 *
 * This is also where `cleanName` and the engine's `safeName` are held to the real `checkName`. The engine's own tests (`file-names.test.ts`
 * in packages/assess) hold `safeName` to a copy of the rules; a copy can fall behind the rules, which it did once, so this file is the
 * one that holds both makers to the rules themselves.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeName } from "../../assess/src/export/text.ts";
import { checkName, cleanName, cutAt, fileOps, fitFileName, placeFile, writeNewFile, type FileOps } from "../src/library.ts";

const errno = (code: string): Error => Object.assign(new Error(`${code}: made to fail by the test`), { code });

async function inFolder(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "openassess-names-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EMOJI = "\u{1f600}";

describe("cutting a name", () => {
  // The platform's way of telling characters apart can be missing (an older runtime), and the cut must still not leave half an emoji.
  test("without a way to tell characters apart, a pair is kept whole and never cut through", () => {
    const text = `${"a".repeat(5)}${EMOJI}${EMOJI}`;
    assert.equal(cutAt(text, 6, null), "aaaaa", "the cut would fall between the two halves of the first emoji");
    assert.equal(cutAt(text, 7, null), `aaaaa${EMOJI}`);
    assert.equal(cutAt(text, 8, null), `aaaaa${EMOJI}`, "and again between the halves of the second");
    assert.equal(cutAt(text, 9, null), text);
    assert.equal(cutAt("abcdef", 3, null), "abc");
    for (let n = 0; n <= text.length; n++) assert.doesNotThrow(() => encodeURIComponent(cutAt(text, n, null)), `at ${n}`);
  });

  test("with it, a flag and a family are kept whole as well", () => {
    const flag = "\u{1f1fa}\u{1f1f8}";
    assert.equal(cutAt(`ab${flag}`, 4), "ab", "half a flag is not kept");
    assert.equal(cutAt(`ab${flag}`, 6), `ab${flag}`);
  });
});

describe("a name that comes from outside", () => {
  test("is refused with a space or a no-break space at either end, a dot at either end, and the other things a file cannot be", () => {
    for (const refused of [" a", "a ", " a", "a ", ".a", "a.", "a. ", "a /b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\u0001b", "a\nb", "x".repeat(81), "A\ud83dB", "con", "con .txt", "Con. Ed. 101", "COM0", "lpt².txt", "CONIN$", "conout$.x"]) {
      assert.throws(() => checkName(refused), /cannot be used as a file name/, JSON.stringify(refused));
    }
    for (const taken of ["a", "a b", "a.b", "a-b", "x".repeat(80), "Con-Ed", "Console", "COM10", "LPT", "café", `${EMOJI} quiz`, "Report 2"]) assert.equal(checkName(taken), taken);
    assert.throws(() => checkName(""), /A name is needed/);
    assert.throws(() => checkName(undefined), /A name is needed/);
  });
});

describe("a name the program makes from a title", () => {
  test("is cut to fit with no dot or space in front of the mark that shows the cut, and the kind of file stays", () => {
    // The cut falls just after a space, and then after a dot: neither is left in front of the ellipsis.
    const spaced = fitFileName(`${"a".repeat(74)} ${"b".repeat(30)}.csv`);
    assert.equal(spaced, `${"a".repeat(74)}….csv`);
    const dotted = fitFileName(`${"a".repeat(74)}.${"b".repeat(30)}.csv`);
    assert.equal(dotted, `${"a".repeat(74)}….csv`);
  });

  test("keeps the end of the name that is worth keeping, when it is at most 40 characters, and no more than that", () => {
    const head = "h".repeat(100);
    // A tail of 37 characters (" - " and 34) fits in 40 and is kept; one of 45 does not, and the cut falls in the head.
    const kept = fitFileName(`${head} - ${"t".repeat(34)}.docx`);
    assert.ok(kept.endsWith(`… - ${"t".repeat(34)}.docx`), kept);
    assert.equal(kept.length, 80);
    const tooLong = fitFileName(`${head} - ${"t".repeat(42)}.docx`);
    assert.ok(!tooLong.includes(" - "), `a tail of 45 characters is not kept: ${tooLong}`);
    assert.ok(tooLong.endsWith("….docx"), tooLong);
    assert.ok(tooLong.length <= 80);
    // The window is 40 from the end of the stem, so a " - " 40 from the end is the last one kept.
    const edge = fitFileName(`${head} - ${"e".repeat(37)}.docx`);
    assert.ok(edge.endsWith(`… - ${"e".repeat(37)}.docx`), edge);
  });

  test("a title that is only a device's name has no words to keep, and one that has more keeps all of its words", () => {
    assert.equal(cleanName("Aux"), "Untitled");
    assert.equal(cleanName("Aux. Verbs"), "Aux_. Verbs");
    assert.equal(cleanName("aux .Verbs"), "aux_ .Verbs", "a space before the dot does not stop Windows reading the device");
    assert.equal(cleanName("Auxiliary. Verbs"), "Auxiliary. Verbs");
    assert.equal(cleanName("Aux Verbs"), "Aux Verbs");
    assert.equal(cleanName("con.txt"), "con_.txt");
  });

  test("the underscore after a device's name is counted in the length", () => {
    for (const long of [`Aux. ${"x".repeat(100)}`, `Aux.${"x".repeat(76)}`, `Aux.${"x".repeat(75)}`, `com1. ${"y".repeat(74)}`]) {
      const name = cleanName(long);
      assert.ok(name.length <= 80, `${name.length}: ${name}`);
      assert.equal(checkName(name), name);
      assert.match(name, /^(Aux|com1)_\./, name);
    }
    assert.equal(cleanName(`Aux.${"x".repeat(76)}`).length, 80, "the name is cut to 80 after the underscore, and not made 81");
  });

  test("a lone half of an emoji is made the replacement character, before anything else is done to the title", () => {
    assert.equal(cleanName("A\ud83dB"), "A�B");
    assert.equal(cleanName("\ude00"), "�");
    assert.equal(cleanName("tail\ud83d"), "tail�");
  });

  test("does not take time for a long title made of dots and spaces", () => {
    const started = performance.now();
    for (const title of [". ".repeat(200_000) + "x", "x" + ". ".repeat(200_000), "x.".repeat(200_000), " ".repeat(500_000) + ".", "a" + ".".repeat(500_000)]) cleanName(title);
    assert.ok(performance.now() - started < 1500, `${Math.round(performance.now() - started)} ms`);
  });
});

describe("a bank's number is counted in its length and leaves no dot or space before it", () => {
  test("a name cut to make room for the number does not end in a dot or a space where it was cut", async () => {
    for (const [base, expected] of [
      [`${"a".repeat(77)}.b`, `${"a".repeat(77)} 2`],
      [`${"a".repeat(77)} b`, `${"a".repeat(77)} 2`],
      [`${"a".repeat(78)}bc`, `${"a".repeat(78)} 2`],
    ] as const) {
      await inFolder(async (dir) => {
        const source = join(dir, "finished.tmp");
        writeFileSync(source, "a finished bank");
        writeFileSync(join(dir, `${base}.openassess`), "taken");
        const name = await placeFile(dir, base, ".openassess", source);
        assert.equal(name, expected, base);
        assert.equal(checkName(name), name);
      });
    }
  });
});

describe("writing a file under a name that is free", () => {
  const withOps = (replace: Partial<FileOps>): { files: FileOps; made: string[] } => {
    const made: string[] = [];
    return {
      made,
      files: {
        ...fileOps,
        createFile: async (path, data) => {
          made.push(path);
          return (replace.createFile ?? fileOps.createFile)(path, data);
        },
        ...(replace.remove ? { remove: replace.remove } : {}),
        ...(replace.mkdir ? { mkdir: replace.mkdir } : {}),
      },
    };
  };

  test("a write that fails halfway leaves no half-written file, and the error is the write's own", async () => {
    await inFolder(async (dir) => {
      const { files, made } = withOps({
        createFile: async (path, data) => {
          writeFileSync(path, String(data).slice(0, 3));
          throw errno("ENOSPC");
        },
      });
      await assert.rejects(() => writeNewFile(dir, "Export.csv", "a,b,c\n1,2,3\n", files), /ENOSPC/);
      assert.deepEqual(readdirSync(dir), [], "the part that was written is taken away");
      assert.equal(made.length, 1);
    });
  });

  test("a write that fails for any reason but a taken name is not taken for one, and is not asked again", async () => {
    await inFolder(async (dir) => {
      const { files, made } = withOps({ createFile: async () => void (await Promise.reject(errno("EACCES"))) });
      await assert.rejects(() => writeNewFile(dir, "Export.csv", "x", files), /EACCES/);
      assert.equal(made.length, 1, "9,999 more names were not tried");
    });
  });

  test("ten thousand names are tried and then it is said that the folder is full", async () => {
    await inFolder(async (dir) => {
      const { files, made } = withOps({ createFile: async () => void (await Promise.reject(errno("EEXIST"))) });
      await assert.rejects(() => writeNewFile(dir, "Export.csv", "x", files), (error: Error) => /too many files with that name/.test(error.message) && (error as { status?: number }).status === 400);
      assert.equal(made.length, 9_999, "the name itself and 2 to 9,999");
      assert.equal(made.at(-1), join(dir, "Export 9999.csv"));
    });
  });

  test("a taken name is the next number, and a folder that is gone is made again", async () => {
    await inFolder(async (dir) => {
      const folder = join(dir, "Exports", "deeper");
      assert.equal(await writeNewFile(folder, "Quiz.csv", "one"), "Quiz.csv");
      assert.equal(await writeNewFile(folder, "Quiz.csv", "two"), "Quiz 2.csv");
      assert.equal(readFileSync(join(folder, "Quiz.csv"), "utf8"), "one", "nothing is written over");
      assert.equal(readFileSync(join(folder, "Quiz 2.csv"), "utf8"), "two");
    });
  });
});

describe("every name the program makes is one it takes back", () => {
  // The device words, with the dots, spaces and suffixes that make a name a device or not, among the pieces a title is built from.
  const devices = ["con", "prn", "aux", "nul", "conin$", "conout$", ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "¹", "²", "³"].flatMap((d) => [`com${d}`, `lpt${d}`])];
  const cases = (word: string): string[] => [word, word.toUpperCase(), word[0]?.toUpperCase() + word.slice(1)];
  const pieces = [
    ...devices.flatMap(cases),
    ".", "..", " ", "  ", ". ", " .", "\t", " ", "　", "﻿", "/", "\\", ":", "*", "?", '"', "<", ">", "|", "\u0000", "\u001f", "\u007f",
    ".txt", ".csv", " - Student copy", " - Brightspace.csv", "x", "Quiz", "Chapter 3", "café", "é", EMOJI, "\u{1f1fa}\u{1f1f8}", "\u{1f468}‍\u{1f469}‍\u{1f467}", "\ud83d", "\ude00", "…", "“", "-", "_", "x".repeat(40), "y".repeat(78),
  ];

  const seeded = (seed: number): ((n: number) => number) => {
    let a = seed >>> 0;
    return (n) => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
  };

  /** Windows' own rule, written another way from the code under test: what is before the first dot, without the spaces at its end, is a device. */
  const isDevice = (name: string): boolean => devices.includes((name.split(".")[0] as string).replace(/ +$/, "").toLowerCase());
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  function titles(seed: number, count: number): string[] {
    const next = seeded(seed);
    return Array.from({ length: count }, () => {
      let title = "";
      const target = next(5) === 0 ? 60 + next(60) : next(30);
      while (title.length < target || next(3) !== 0) {
        title += pieces[next(pieces.length)] as string;
        if (title.length > 300) break;
      }
      return title;
    });
  }

  test("the app's cleanName and the engine's safeName both make a name that checkName takes, that is not a device, and that they leave alone when run again", () => {
    let kept = 0;
    for (const title of titles(20261109, 8000)) {
      for (const [maker, name] of [["cleanName", cleanName(title)], ["safeName", safeName(title)]] as const) {
        assert.equal(checkName(name), name, `${maker}(${JSON.stringify(title)}) = ${JSON.stringify(name)} is not a name the app takes`);
        assert.equal(isDevice(name), false, `${maker}(${JSON.stringify(title)}) = ${JSON.stringify(name)} is a device`);
        assert.equal(lone.test(name), false, `${maker}: a lone half in ${JSON.stringify(name)}`);
        assert.doesNotThrow(() => encodeURIComponent(name), JSON.stringify(name));
        // The names built round it are fitted to the app's limit, and are then names it takes.
        for (const whole of [`${name}.openassess`, `${name} - Student copy.docx`, `${name} - Scores 2026-11-09.openassess-scores`, `${name} - Version B - Answer key.pdf`]) {
          const fitted = fitFileName(whole);
          assert.equal(checkName(fitted), fitted, `${maker}(${JSON.stringify(title)}): ${JSON.stringify(fitted)}`);
          assert.equal(isDevice(fitted), false, fitted);
        }
      }
      assert.equal(cleanName(cleanName(title)), cleanName(title), `a second pass changed ${JSON.stringify(cleanName(title))}`);
      if (cleanName(title) !== "Untitled") kept++;
    }
    assert.ok(kept > 4000, `${kept} of 8000 titles had a name: the pieces must not make most of them empty`);
  });

  test("a title that begins with a device's name and a dot keeps its words in the app as it does in the engine", () => {
    let compared = 0;
    for (const device of devices.flatMap(cases)) {
      for (const title of [`${device}. Verbs`, `${device} . Verbs`, `${device}.txt`, `${device}. Ed. 101`]) {
        assert.equal(cleanName(title), safeName(title), JSON.stringify(title));
        assert.notEqual(cleanName(title), "Untitled", title);
        assert.ok(cleanName(title).startsWith(`${device}_`), `${title}: the words are kept and the device's name is followed by an underscore`);
        compared++;
      }
      assert.equal(cleanName(device), "Untitled", device);
      assert.equal(cleanName(`${device}.`), "Untitled", `${device}.`);
    }
    assert.ok(compared > 200);
  });
});
