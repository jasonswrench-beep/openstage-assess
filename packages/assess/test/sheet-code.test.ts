/**
 * The code strip and the geometry of the answer sheet. The rules under test: a strip says exactly what was written and nothing
 * else, a damaged one is refused and never read as another test (every single-bit error is caught, and so is every double-bit
 * error), a strip read backwards or inverted is refused, and the geometry puts everything where the printer and the reader both
 * need it: inside the page, clear of the edge, with no two bubbles touching.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CODE_BITS, LAYOUT_STANDARD, LAYOUT_WIDE, codeProblem, decodeCode, encodeCode, layoutNumber, styleOf, withCheck, type SheetCode } from "../src/sheets/code.ts";
import {
  CODE_CELL,
  CODE_CELLS,
  FOOTER_RISE,
  FOOTER_TEXT_HEIGHT,
  MARK_INSET,
  MARK_SIZE,
  MAX_SHEET_PAGES,
  PAPER_MM,
  codeCells,
  cornerMarks,
  exampleMarks,
  instructionArea,
  layoutFor,
  nameBox,
  pagesNeeded,
  placeOf,
  slotBubbles,
  slotNumberAnchor,
  slotRow,
  styleProblem,
  versionBubbles,
  type PaperName,
  type Rect,
  type SheetStyle,
} from "../src/sheets/geometry.ts";
import { seededRandom } from "../src/model/random.ts";

const PAPERS: PaperName[] = ["letter", "a4"];
const STYLES: SheetStyle[] = ["standard", "wide", "large"];

const code = (more: Partial<SheetCode> = {}): SheetCode => ({ layout: LAYOUT_STANDARD, paper: "letter", large: false, test: 0xabcde, page: 1, pages: 1, version: 0, ...more });
const flip = (bits: boolean[], at: number): boolean[] => bits.map((b, i) => (i === at ? !b : b));

describe("the code strip", () => {
  test("is 48 squares, begins with a black one, and reads back as what was written", () => {
    const bits = encodeCode(code());
    assert.equal(bits.length, 48);
    assert.equal(CODE_BITS, 48);
    assert.equal(bits[0], true);
    const read = decodeCode(bits);
    assert.ok(read.ok);
    assert.deepEqual(read.ok && read.code, code());
  });

  test("writes the squares it always has: a sheet already printed must still be read by every later version of this program", () => {
    // These are the strips of three sheets, written out once and pinned. If one of them changes, sheets in classrooms stop reading.
    const squares = (c: SheetCode): string => encodeCode(c).map((b) => (b ? "1" : "0")).join("");
    const pinned: Array<[SheetCode, string]> = [
      [code(), "100010010101011110011011110000000000011001001111"],
      [code({ layout: LAYOUT_WIDE, paper: "a4", test: 0x12345, page: 2, pages: 3, version: 2 }), "100100100010010001101000101001010010110001100010"],
      [code({ paper: "letter", large: true, test: 0, page: 8, pages: 8, version: 4 }), "100011000000000000000000000111111100001011010011"],
    ];
    // The check bits are the remainder of the 36 data bits followed by twelve zeros, divided by x^12 + x^11 + x^3 + x^2 + x + 1.
    // Written here from the definition, with big integers, and not from the program's own shifting register.
    const remainder = (bits: string): string => {
      let value = BigInt(`0b${bits}000000000000`);
      for (let at = BigInt(bits.length + 12 - 1); at >= 12n; at--) if ((value >> at) & 1n) value ^= 0x180fn << (at - 12n);
      return value.toString(2).padStart(12, "0");
    };
    for (const [c, expected] of pinned) {
      assert.equal(squares(c), expected);
      assert.equal(remainder(expected.slice(0, 36)), expected.slice(36), "the check bits are the CRC-12 of the rest");
      const read = decodeCode([...expected].map((x) => x === "1"));
      assert.deepEqual(read.ok && read.code, c);
    }
  });

  test("round trips every layout, paper, page, version and a spread of test fingerprints", () => {
    const random = seededRandom("fingerprints");
    const tests = [0, 1, 2 ** 20 - 1, 0x55555, 0xaaaaa, ...Array.from({ length: 40 }, () => Math.floor(random() * 2 ** 20))];
    let count = 0;
    for (const layout of [LAYOUT_STANDARD, LAYOUT_WIDE]) {
      for (const paper of PAPERS) {
        for (const large of [false, true]) {
          if (layout === LAYOUT_WIDE && large) continue;
          for (let pages = 1; pages <= MAX_SHEET_PAGES; pages++) {
            for (let page = 1; page <= pages; page++) {
              for (let version = 0; version <= 4; version++) {
                const c = code({ layout, paper, large, pages, page, version, test: tests[(count++) % tests.length] as number });
                const read = decodeCode(encodeCode(c));
                assert.ok(read.ok, JSON.stringify(c));
                assert.deepEqual(read.ok && read.code, c);
              }
            }
          }
        }
      }
    }
    assert.ok(count > 1000);
    for (const t of tests) assert.deepEqual((decodeCode(encodeCode(code({ test: t }))) as { code: SheetCode }).code.test, t);
  });

  test("a single wrong square is always caught, in every position of every kind of sheet", () => {
    const random = seededRandom("single");
    for (let n = 0; n < 60; n++) {
      const c = code({ test: Math.floor(random() * 2 ** 20), page: 1 + (n % 3), pages: 3, version: n % 5, paper: PAPERS[n % 2] as PaperName, layout: n % 4 === 0 ? LAYOUT_WIDE : LAYOUT_STANDARD });
      const bits = encodeCode(c);
      for (let at = 0; at < CODE_BITS; at++) assert.equal(decodeCode(flip(bits, at)).ok, false, `${JSON.stringify(c)} square ${at}`);
    }
  });

  test("two wrong squares are always caught, wherever they are", () => {
    const random = seededRandom("double");
    for (let n = 0; n < 12; n++) {
      const bits = encodeCode(code({ test: Math.floor(random() * 2 ** 20), page: 1 + (n % 2), pages: 2, version: n % 5 }));
      for (let a = 0; a < CODE_BITS; a++) for (let b = a + 1; b < CODE_BITS; b++) assert.equal(decodeCode(flip(flip(bits, a), b)).ok, false, `squares ${a} and ${b}`);
    }
  });

  test("a damaged strip is refused with a reason, never read as another test", () => {
    const random = seededRandom("noise");
    const bits = encodeCode(code({ test: 0x12345 }));
    let accepted = 0;
    for (let n = 0; n < 4000; n++) {
      const damaged = bits.map((b) => (random() < 0.12 ? !b : b));
      const read = decodeCode(damaged);
      if (read.ok) {
        // Anything that gets through must be a whole, valid code: it can only be the same strip, or an error the check cannot see.
        accepted++;
        assert.equal(codeProblem(read.code), undefined);
      } else assert.match(read.reason, /strip/);
    }
    assert.ok(accepted < 40, `${accepted} of 4000 damaged strips were accepted`);
  });

  test("random squares are almost never a code, and those that are say something valid", () => {
    const random = seededRandom("random");
    let accepted = 0;
    for (let n = 0; n < 30000; n++) {
      const read = decodeCode(Array.from({ length: CODE_BITS }, () => random() < 0.5));
      if (read.ok) {
        accepted++;
        assert.equal(codeProblem(read.code), undefined);
      }
    }
    // 1 in 2 to start, 1 in 4096 to pass the check, and then the layout and the paper have to be ones that exist: about 1 in 16000.
    assert.ok(accepted <= 12, `${accepted} of 30000 random strips were accepted`);
  });

  test("a strip read backwards, upside down, or as a negative is refused", () => {
    const random = seededRandom("reversed");
    for (let n = 0; n < 200; n++) {
      const bits = encodeCode(code({ test: Math.floor(random() * 2 ** 20), page: 1 + (n % 4), pages: 4, version: n % 5 }));
      assert.equal(decodeCode([...bits].reverse()).ok, false, "backwards");
      assert.equal(decodeCode(bits.map((b) => !b)).ok, false, "a negative");
    }
  });

  test("says why: the wrong number of squares, a start that is not black, and a check that disagrees", () => {
    const bits = encodeCode(code());
    assert.match((decodeCode(bits.slice(1)) as { reason: string }).reason, /47 squares, not 48/);
    assert.match((decodeCode([...bits, true]) as { reason: string }).reason, /49 squares/);
    assert.match((decodeCode(flip(bits, 0)) as { reason: string }).reason, /does not start where it should/);
    assert.match((decodeCode(flip(bits, 30)) as { reason: string }).reason, /check does not agree/);
    assert.match((decodeCode([]) as { reason: string }).reason, /0 squares/);
  });

  test("refuses to write what cannot be read back, and says what is wrong", () => {
    for (const [bad, why] of [
      [{ test: 2 ** 20 }, /not 20 bits/],
      [{ test: -1 }, /not 20 bits/],
      [{ test: 1.5 }, /not 20 bits/],
      [{ pages: 0 }, /1 to 8 sheet pages/],
      [{ pages: 9 }, /1 to 8 sheet pages/],
      [{ pages: 2, page: 3 }, /not one of the pages/],
      [{ page: 0 }, /not one of the pages/],
      [{ version: 5 }, /0 to 4/],
      [{ version: -1 }, /0 to 4/],
      [{ layout: 0 }, /1 to 15/],
      [{ layout: 16 }, /1 to 15/],
      [{ layout: 3 }, /layout 3 is not one this program knows/],
      [{ layout: LAYOUT_WIDE, large: true }, /no wide sheet in large print/],
    ] as Array<[Partial<SheetCode>, RegExp]>) {
      assert.match(codeProblem(code(bad)) ?? "", why, JSON.stringify(bad));
      assert.throws(() => encodeCode(code(bad)), /cannot be written/);
    }
  });

  test("a strip that is well formed but names a sheet this program does not print is refused, not guessed at", () => {
    // A newer program's sheet: a real strip's data with another layout in it and the check that goes with the change, so that
    // nothing is damaged and the only thing wrong is that this program does not know the layout.
    const data = encodeCode(code()).slice(0, 36);
    const withLayout = (layout: number, paperBits?: [boolean, boolean]): boolean[] => {
      const out = [...data];
      for (let i = 0; i < 4; i++) out[1 + i] = ((layout >> (3 - i)) & 1) === 1;
      if (paperBits) [out[5], out[6]] = paperBits;
      return withCheck(out);
    };
    for (const layout of [3, 5, 15]) {
      const read = decodeCode(withLayout(layout));
      assert.equal(read.ok, false, `layout ${layout}`);
      assert.match((read as { reason: string }).reason, new RegExp(`layout ${layout} is not one this program knows`));
    }
    assert.match((decodeCode(withLayout(0)) as { reason: string }).reason, /1 to 15/);
    // the wide arrangement on a large print paper (paper code 2: Letter, large)
    assert.match((decodeCode(withLayout(LAYOUT_WIDE, [true, false])) as { reason: string }).reason, /no wide sheet in large print/);
    // and the same strip with a layout that exists reads
    assert.equal(decodeCode(withLayout(LAYOUT_WIDE)).ok, true);
    assert.equal(decodeCode(withLayout(LAYOUT_STANDARD)).ok, true);
    // a page that is after the last
    const late = [...data];
    [true, false, false].forEach((b, i) => (late[27 + i] = b)); // page 5 (0b100 + 1)
    assert.match((decodeCode(withCheck(late)) as { reason: string }).reason, /not one of the pages/);
  });

  test("layout numbers and the sheets they name", () => {
    assert.equal(layoutNumber("standard"), LAYOUT_STANDARD);
    assert.equal(layoutNumber("large"), LAYOUT_STANDARD);
    assert.equal(layoutNumber("wide"), LAYOUT_WIDE);
    assert.equal(styleOf({ layout: LAYOUT_STANDARD, large: false }), "standard");
    assert.equal(styleOf({ layout: LAYOUT_STANDARD, large: true }), "large");
    assert.equal(styleOf({ layout: LAYOUT_WIDE, large: false }), "wide");
    assert.equal(styleOf({ layout: LAYOUT_WIDE, large: true }), undefined);
    assert.equal(styleOf({ layout: 7, large: false }), undefined);
  });
});

describe("the geometry", () => {
  const inside = (r: Rect, l: ReturnType<typeof layoutFor>, clear: number): boolean => r.x >= clear && r.y >= clear && r.x + r.width <= l.width - clear && r.y + r.height <= l.height - clear;

  test("holds 100, 50 and 51 questions to a page, in 25, 25 and 17 rows", () => {
    assert.deepEqual([layoutFor("letter", "standard").questionsPerPage, layoutFor("letter", "wide").questionsPerPage, layoutFor("letter", "large").questionsPerPage], [100, 50, 51]);
    assert.deepEqual([layoutFor("a4", "standard").rowsPerColumn, layoutFor("a4", "wide").rowsPerColumn, layoutFor("a4", "large").rowsPerColumn], [25, 25, 17]);
    assert.deepEqual([layoutFor("letter", "standard").places, layoutFor("letter", "wide").places, layoutFor("letter", "large").places], [5, 8, 5]);
    assert.equal(layoutFor("letter", "large").bubbleDiameter, 7);
    assert.equal(layoutFor("letter", "standard").bubbleDiameter, 5);
  });

  test("puts the four corner marks 12 mm in, 8 mm square, with the white centre at the top left", () => {
    for (const paper of PAPERS) {
      const l = layoutFor(paper, "standard");
      const marks = cornerMarks(l);
      assert.equal(marks.length, 4);
      assert.deepEqual(marks.map((m) => m.corner), ["topLeft", "topRight", "bottomLeft", "bottomRight"]);
      assert.deepEqual(marks.map((m) => m.hollow), [true, false, false, false]);
      for (const m of marks) {
        assert.equal(m.size, MARK_SIZE);
        assert.ok(m.center.x - m.size / 2 >= MARK_INSET - 1e-9 && m.center.x + m.size / 2 <= l.width - MARK_INSET + 1e-9);
        assert.ok(m.center.y - m.size / 2 >= MARK_INSET - 1e-9 && m.center.y + m.size / 2 <= l.height - MARK_INSET + 1e-9);
      }
      assert.deepEqual(marks[0]!.center, { x: 16, y: 16 });
      assert.equal(marks[3]!.center.x, PAPER_MM[paper].width - 16);
      assert.equal(marks[3]!.center.y, PAPER_MM[paper].height - 16);
    }
  });

  test("lays the 48 squares of the code in a row between the top corner marks, centred, level with them", () => {
    for (const paper of PAPERS) {
      const l = layoutFor(paper, "standard");
      const cells = codeCells(l);
      assert.equal(cells.length, CODE_CELLS);
      cells.forEach((c, i) => {
        assert.equal(c.index, i);
        assert.equal(c.size, CODE_CELL);
        assert.equal(c.center.y, 16, "level with the marks' centres");
        if (i > 0) assert.ok(Math.abs(c.center.x - (cells[i - 1] as { center: { x: number } }).center.x - CODE_CELL) < 1e-9, "3 mm apart");
      });
      const left = cells[0]!.center.x - CODE_CELL / 2;
      const right = cells[47]!.center.x + CODE_CELL / 2;
      assert.ok(Math.abs(left - (l.width - right)) < 1e-9, "centred");
      const marks = cornerMarks(l);
      assert.ok(left > (marks[0] as { center: { x: number } }).center.x + MARK_SIZE / 2, "right of the top left mark");
      assert.ok(right < (marks[1] as { center: { x: number } }).center.x - MARK_SIZE / 2, "left of the top right mark");
    }
  });

  test("keeps every bubble and number clear of the edge, inside the marks, and apart from every other bubble", () => {
    for (const paper of PAPERS) {
      for (const style of STYLES) {
        const l = layoutFor(paper, style);
        const centers = [] as Array<{ x: number; y: number }>;
        for (let slot = 0; slot < l.questionsPerPage; slot++) {
          const bubbles = slotBubbles(l, slot);
          assert.equal(bubbles.length, l.places);
          const row = slotRow(l, slot);
          assert.ok(inside(row, l, 10), `${paper} ${style} slot ${slot}: the row is 10 mm from the edge`);
          for (const b of bubbles) {
            assert.ok(inside({ x: b.x - l.bubbleDiameter / 2, y: b.y - l.bubbleDiameter / 2, width: l.bubbleDiameter, height: l.bubbleDiameter }, l, 10));
            assert.ok(b.y - l.bubbleDiameter / 2 > l.gridTop, "below the header");
            assert.ok(b.y + l.bubbleDiameter / 2 < l.height - MARK_INSET - MARK_SIZE - 4, `${paper} ${style}: above the bottom marks with room`);
            // The line printed under the grid once ran into the last row of the large sheet; a bubble stays 3 mm clear of the top of its letters.
            assert.ok(b.y + l.bubbleDiameter / 2 + 3 < l.height - FOOTER_RISE - FOOTER_TEXT_HEIGHT, `${paper} ${style}: clear of the line under the grid`);
            centers.push(b);
          }
          // the row's bubbles are one pitch apart and level
          bubbles.forEach((b, p) => {
            assert.equal(b.y, bubbles[0]!.y);
            if (p > 0) assert.ok(Math.abs(b.x - bubbles[p - 1]!.x - l.placePitch) < 1e-9);
          });
          // the number sits left of the bubbles, in its own space
          const anchor = slotNumberAnchor(l, slot);
          assert.ok(anchor.x < bubbles[0]!.x - l.bubbleDiameter / 2);
          assert.ok(anchor.x >= row.x && anchor.x <= row.x + l.numberWidth);
          assert.equal(anchor.y, bubbles[0]!.y);
        }
        // no two bubbles touch: the nearest centres are further apart than a bubble is wide, with a gap of at least a millimetre
        let nearest = Infinity;
        for (let i = 0; i < centers.length; i++) {
          for (let j = i + 1; j < centers.length; j++) {
            const a = centers[i] as { x: number; y: number };
            const b = centers[j] as { x: number; y: number };
            if (Math.abs(a.x - b.x) > 20 || Math.abs(a.y - b.y) > 20) continue;
            nearest = Math.min(nearest, Math.hypot(a.x - b.x, a.y - b.y));
          }
        }
        assert.ok(nearest >= l.bubbleDiameter + 1, `${paper} ${style}: nearest centres ${nearest.toFixed(2)} mm apart for ${l.bubbleDiameter} mm bubbles`);
      }
    }
  });

  test("keeps the columns apart from one another and the rows apart from one another", () => {
    for (const paper of PAPERS) {
      for (const style of STYLES) {
        const l = layoutFor(paper, style);
        const rows = Array.from({ length: l.questionsPerPage }, (_x, slot) => slotRow(l, slot));
        for (let a = 0; a < rows.length; a++) {
          for (let b = a + 1; b < rows.length; b++) {
            const r = rows[a] as Rect;
            const s = rows[b] as Rect;
            const overlapX = r.x < s.x + s.width - 1e-9 && s.x < r.x + r.width - 1e-9;
            const overlapY = r.y < s.y + s.height - 1e-9 && s.y < r.y + r.height - 1e-9;
            assert.ok(!(overlapX && overlapY), `${paper} ${style}: rows ${a} and ${b} overlap`);
          }
        }
        // a gap between columns
        const firstOfNext = slotRow(l, l.rowsPerColumn);
        const lastOfFirst = slotRow(l, 0);
        assert.ok(firstOfNext.x >= lastOfFirst.x + lastOfFirst.width + l.columnGap - 1e-9);
      }
    }
  });

  test("centres the grid: as much paper to the left of the first column as to the right of the last", () => {
    for (const paper of PAPERS) {
      for (const style of STYLES) {
        const l = layoutFor(paper, style);
        const first = slotRow(l, 0);
        const last = slotRow(l, (l.columns - 1) * l.rowsPerColumn);
        assert.ok(Math.abs(first.x - (l.width - (last.x + last.width))) < 1e-9, `${paper} ${style}: ${first.x} to the left, ${l.width - (last.x + last.width)} to the right`);
      }
    }
  });

  test("places slots down a column and then across, as the booklet numbers them", () => {
    const l = layoutFor("letter", "standard");
    assert.deepEqual(placeOf(l, 1), { page: 0, slot: 0 });
    assert.deepEqual(placeOf(l, 25), { page: 0, slot: 24 });
    assert.deepEqual(placeOf(l, 26), { page: 0, slot: 25 });
    assert.deepEqual(placeOf(l, 100), { page: 0, slot: 99 });
    assert.deepEqual(placeOf(l, 101), { page: 1, slot: 0 });
    assert.deepEqual(placeOf(l, 250), { page: 2, slot: 49 });
    // the second column starts at the top again, to the right
    assert.ok(slotBubbles(l, 25)[0]!.x > slotBubbles(l, 24)[0]!.x);
    assert.equal(slotBubbles(l, 25)[0]!.y, slotBubbles(l, 0)[0]!.y);
    assert.ok(slotBubbles(l, 1)[0]!.y > slotBubbles(l, 0)[0]!.y);
    assert.equal(slotBubbles(l, 1)[0]!.x, slotBubbles(l, 0)[0]!.x);
  });

  test("counts the pages a test needs", () => {
    const standard = layoutFor("letter", "standard");
    assert.deepEqual([0, 1, 100, 101, 200, 201, 800].map((q) => pagesNeeded(standard, q)), [1, 1, 1, 2, 2, 3, 8]);
    assert.equal(pagesNeeded(layoutFor("a4", "wide"), 51), 2);
    assert.equal(pagesNeeded(layoutFor("a4", "large"), 51), 1);
    assert.equal(pagesNeeded(layoutFor("a4", "large"), 52), 2);
  });

  test("keeps the name box, the version bubbles, the instructions and the examples apart, inside the page, and clear of the strip", () => {
    for (const paper of PAPERS) {
      const l = layoutFor(paper, "standard");
      const name = nameBox(l);
      const versions = versionBubbles(l);
      const area = instructionArea(l);
      const examples = exampleMarks(l);
      assert.equal(versions.length, 4);
      assert.deepEqual(versions.map((v) => v.label), ["A", "B", "C", "D"]);
      assert.ok(inside(name, l, 10), "name box");
      assert.ok(inside(area, l, 10), "instruction area");
      assert.ok(name.y > 16 + CODE_CELL / 2 + 2, "below the strip");
      assert.ok(name.x + name.width < versions[0]!.center.x - 5, "the name box ends before the version bubbles");
      for (const v of versions) assert.ok(v.center.x + 2.5 <= l.width - 10 - 1e-9 && v.center.y > name.y && v.center.y < name.y + name.height);
      for (let i = 1; i < versions.length; i++) assert.ok(versions[i]!.center.x - versions[i - 1]!.center.x >= 6.5, "bubbles do not touch");
      assert.ok(area.x + area.width < examples[0]!.center.x - 4, "the instructions end before the examples");
      assert.ok(area.y > name.y + name.height, "instructions below the name box");
      for (const e of examples) {
        assert.ok(e.center.x + 2.5 <= l.width - 10 && e.center.y + 8 < l.gridTop, `an example and its caption are above the grid (${e.kind})`);
      }
      assert.deepEqual(examples.map((e) => e.kind), ["right", "tick", "cross", "half"]);
    }
  });

  test("says when a test has a question with more answers than a sheet holds", () => {
    assert.equal(styleProblem("standard", 5), undefined);
    assert.equal(styleProblem("wide", 8), undefined);
    assert.match(styleProblem("standard", 6) ?? "", /5 bubbles/);
    assert.match(styleProblem("large", 6) ?? "", /large sheet has 5 bubbles/);
    assert.match(styleProblem("wide", 9) ?? "", /8 bubbles/);
  });
});
