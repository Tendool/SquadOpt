// node --test tests/js   (no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { sidedRows, layout, splitName, backLine, diagram, CUSTOM_LINES, orderLine, customStatus, GROUP_OF, TYPE_NAME } from "../../static/js/formation.js";

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

// ---------------------------------------------------------------- custom formation builder
test("custom builder: each line offers only positions of that line, no duplicates or generic flank codes", () => {
  const want = { Defence: "DEF", Midfield: "MID", Attack: "FWD" };
  assert.deepEqual(CUSTOM_LINES.map(l => l.name), ["Defence", "Midfield", "Attack"]);
  const all = CUSTOM_LINES.flatMap(l => l.options);
  assert.equal(new Set(all).size, all.length);
  for (const { name, options } of CUSTOM_LINES)
    for (const t of options) { assert.equal(GROUP_OF[t], want[name], `${t} in ${name}`); assert.ok(TYPE_NAME[t], t); }
  for (const t of ["GK", "FB", "WB", "WM", "W", "ANY", "CDM", "CAM", "CF"]) assert.ok(!all.includes(t), t);
});

test("custom builder: starts empty and cannot be applied until 10 outfield slots with a defender and an attacker", () => {
  const empty = customStatus([[], [], []]);
  assert.equal(empty.n, 0); assert.equal(empty.ok, false); assert.match(empty.message, /0 of 10/);
  assert.equal(customStatus([["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST"]]).ok, false);          // 9
  assert.equal(customStatus([["LB", "CB", "CB", "RB"], ["CM", "CM", "CM", "DM"], ["LW", "ST", "RW"]]).ok, false); // 11
  assert.match(customStatus([[], ["DM", "DM", "CM", "CM", "AM", "AM", "LM"], ["LW", "ST", "RW"]]).message, /defender/);
  assert.match(customStatus([["LB", "CB", "CB", "RB"], ["LM", "CM", "CM", "CM", "AM", "RM"], []]).message, /attacker/);
  assert.equal(customStatus([["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST", "RW"]]).ok, true);
  assert.equal(customStatus([["LWB", "CB", "CB", "CB", "RWB"], [], ["LW", "ST", "ST", "ST", "RW"]]).ok, true);  // unusual but valid
});

test("custom builder: positions in the wrong line or unknown codes are rejected", () => {
  assert.match(customStatus([["LB", "CB", "CB", "ST"], ["CM", "CM", "CM"], ["LW", "ST", "RW"]]).message, /ST/);
  assert.match(customStatus([["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "W"]]).message, /FB/);
  assert.equal(customStatus([["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST", "LB"]]).ok, false);
});

test("custom builder: lines are ordered left to right and keep their explicit side in the preview", () => {
  assert.deepEqual(orderLine(["RB", "CB", "LB", "CB"]), ["LB", "CB", "CB", "RB"]);
  assert.deepEqual(orderLine(["RW", "ST", "LW"]), ["LW", "ST", "RW"]);
  assert.deepEqual(orderLine(["RM", "DM", "LWB"]), ["LWB", "DM", "RM"]);
  const rows = [["GK"], ...[["RB", "CB", "LB", "CB"], ["CM", "CM", "CM"], ["RW", "ST", "LW"]].map(orderLine)];
  assert.deepEqual(sidedRows(rows), rows);                  // explicit sides are never relabelled
  const svg = diagram(rows, { labels: true });
  assert.equal((svg.match(/class="fd-dot/g) || []).length, 11);
  assert.equal((diagram([["GK"]]).match(/class="fd-dot/g) || []).length, 1);   // empty builder: goalkeeper only
});
