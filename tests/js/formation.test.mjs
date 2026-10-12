// node --test tests/js   (no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { sidedRows, layout, splitName, backLine, diagram } from "../../static/js/formation.js";

test("flank slots get the side they stand on", () => {
  assert.deepEqual(sidedRows([["GK"], ["FB", "CB", "CB", "FB"], ["W", "ST", "W"]]),
    [["GK"], ["LB", "CB", "CB", "RB"], ["LW", "ST", "RW"]]);
  assert.deepEqual(sidedRows([["WB", "CB", "CB", "CB", "WB"]]), [["LWB", "CB", "CB", "CB", "RWB"]]);
  assert.deepEqual(sidedRows([["WM", "CM", "CM", "WM"]]), [["LM", "CM", "CM", "RM"]]);
});

test("a single flank slot follows its side, the exact centre stays generic", () => {
  assert.deepEqual(sidedRows([["W", "ST", "ST"]]), [["LW", "ST", "ST"]]);
  assert.deepEqual(sidedRows([["ST", "ST", "W"]]), [["ST", "ST", "RW"]]);
  assert.deepEqual(sidedRows([["ST", "W", "ST"]]), [["ST", "W", "ST"]]);
});

test("layout matches lineup_layout geometry", () => {
  const s = layout([["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "W"]]);
  assert.equal(s.length, 11);
  assert.deepEqual(s[0], { type: "GK", label: "GK", x: 50, y: 8, row: 0, j: 0 });
  assert.equal(s[1].label, "LB"); assert.equal(s[4].label, "RB");
  assert.equal(s.at(-1).y, 88); assert.equal(s.at(-1).label, "RW");
  for (const p of s) { assert.ok(p.x > 0 && p.x < 100); assert.ok(p.y >= 8 && p.y <= 88); }
});

test("names and back lines", () => {
  assert.deepEqual(splitName("4-3-3 (DM)"), { shape: "4-3-3", variant: "DM" });
  assert.deepEqual(splitName("4-4-2 diamond"), { shape: "4-4-2", variant: "diamond" });
  assert.deepEqual(splitName("3-5-2"), { shape: "3-5-2", variant: "" });
  assert.equal(backLine([["GK"], ["WB", "CB", "CB", "CB", "WB"]]), 5);
});

test("diagram draws one dot per slot", () => {
  const svg = diagram([["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "W"]], { labels: true });
  assert.equal((svg.match(/class="fd-dot/g) || []).length, 11);
  assert.match(svg, />LB</); assert.match(svg, />RW</);
});
