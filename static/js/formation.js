// Formation geometry and slot labels. Pure functions, shared by the 3D pitch, the formation diagrams and the tests.
// Mirrors squad_engine.lineup_layout / sided_rows so every view names a slot the same way the optimiser does.

export const SIDE_OF = { FB: ["LB", "RB"], WB: ["LWB", "RWB"], WM: ["LM", "RM"], W: ["LW", "RW"] };
export const GROUP_OF = {
  GK: "GK", FB: "DEF", WB: "DEF", CB: "DEF", LB: "DEF", RB: "DEF", LWB: "DEF", RWB: "DEF",
  DM: "MID", CM: "MID", AM: "MID", WM: "MID", LM: "MID", RM: "MID", ANY: "MID",
  W: "FWD", LW: "FWD", RW: "FWD", ST: "FWD",
};
export const TYPE_NAME = {
  GK: "Goalkeeper", FB: "Full-back", WB: "Wing-back", CB: "Centre-back", DM: "Holding midfielder", CM: "Central midfielder",
  AM: "Attacking midfielder", WM: "Wide midfielder", W: "Winger", ST: "Striker",
  LB: "Left-back", RB: "Right-back", LWB: "Left wing-back", RWB: "Right wing-back", LM: "Left midfielder",
  RM: "Right midfielder", LW: "Left winger", RW: "Right winger",
};

/** Flank types become side-specific by where they stand in their row (same rule as squad_engine.sided_rows). */
export function sidedRows(rows) {
  return rows.map(row => {
    const out = row.slice(), c = (row.length - 1) / 2;
    for (const [t, [left, right]] of Object.entries(SIDE_OF)) {
      const idx = row.map((x, j) => (x === t ? j : -1)).filter(j => j >= 0);
      if (idx.length >= 2) { out[idx[0]] = left; out[idx[idx.length - 1]] = right; }
      else if (idx.length === 1 && idx[0] !== c) out[idx[0]] = idx[0] < c ? left : right;
    }
    return out;
  });
}

/** Slot positions: rows back -> front, x across the row (0-100), y up the pitch (8-88), as in lineup_layout. */
export function layout(rows) {
  const labels = sidedRows(rows), nR = rows.length, out = [];
  rows.forEach((row, r) => {
    const y = 8 + r * (80 / Math.max(nR - 1, 1));
    row.forEach((t, j) => out.push({ type: t, label: labels[r][j], x: (j + 1) * 100 / (row.length + 1), y, row: r, j }));
  });
  return out;
}

/** "4-3-3 (DM)" -> { shape: "4-3-3", variant: "DM" } */
export function splitName(name) {
  const m = /^([\d-]+)\s*(?:\((.+)\))?\s*(.*)$/.exec(name) || [];
  return { shape: m[1] || name, variant: (m[2] || m[3] || "").trim() };
}

/** Back line size (3/4/5) from the formation rows. */
export const backLine = rows => (rows[1] || []).length;

/** SVG diagram of a formation (vertical pitch, attack up). */
export function diagram(rows, { w = 120, h = 150, dot = 4.2, labels = false } = {}) {
  const pad = 10, slots = layout(rows);
  const X = x => pad + (w - 2 * pad) * x / 100, Y = y => h - pad - (h - 2 * pad) * (y - 4) / 88;
  let s = `<svg class="fdiag" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<rect class="fd-pitch" x="1" y="1" width="${w - 2}" height="${h - 2}" rx="6"/>` +
    `<line class="fd-line" x1="1" y1="${h / 2}" x2="${w - 1}" y2="${h / 2}"/>` +
    `<circle class="fd-line" cx="${w / 2}" cy="${h / 2}" r="${w * .11}"/>` +
    `<rect class="fd-line" x="${w * .3}" y="${h - 1 - h * .12}" width="${w * .4}" height="${h * .12}"/>` +
    `<rect class="fd-line" x="${w * .3}" y="1" width="${w * .4}" height="${h * .12}"/>`;
  for (const p of slots) {
    s += `<circle class="fd-dot g-${GROUP_OF[p.type] || "MID"}" cx="${X(p.x)}" cy="${Y(p.y)}" r="${dot}"/>`;
    if (labels) s += `<text class="fd-lab" x="${X(p.x)}" y="${Y(p.y) + dot + 9}" text-anchor="middle">${p.label}</text>`;
  }
  return s + "</svg>";
}
