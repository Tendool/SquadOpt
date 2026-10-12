// Small UI component kit: DOM helpers, toasts, count-up, segmented controls, range fill, player typeahead, SVG charts
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmt = (n, dp = 1) => (n == null || Number.isNaN(+n) ? "–" : (+n).toFixed(dp));
export const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsap = window.gsap;
export const GROUP_COLOR = { GK: "#ffc23d", DEF: "#3fe0ff", MID: "#d4ff3a", FWD: "#ff5470" };

export function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = text;
  $("#toasts").append(el);
  gsap.from(el, { y: 20, opacity: 0, duration: REDUCED ? 0 : .35, ease: "back.out(2)" });
  setTimeout(() => gsap.to(el, { opacity: 0, y: 10, duration: .3, onComplete: () => el.remove() }), kind === "err" ? 6000 : 3200);
}

export function countUp(el, value, dp = 0, prefix = "") {
  if (value == null || Number.isNaN(+value)) { el.textContent = "–"; return; }
  if (REDUCED) { el.textContent = prefix + (+value).toFixed(dp); return; }
  const o = { v: 0 };
  gsap.to(o, { v: +value, duration: 1.1, ease: "power3.out", onUpdate: () => (el.textContent = prefix + o.v.toFixed(dp)) });
}

/** Segmented control: buttons with aria-selected inside `root`; calls onChange(button) on click. */
export function segmented(root, onChange) {
  root.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || !root.contains(b)) return;
    select(root, b); onChange(b);
  });
}
export function select(root, b) { $$("button", root).forEach(x => x.setAttribute("aria-selected", x === b)); }

export function fillRange(input) {
  const p = (input.value - input.min) / (input.max - input.min) * 100;
  input.style.setProperty("--p", p + "%");
}

/** Player search box with keyboard navigation. onPick(player) */
export function typeahead(root, onPick) {
  const input = $("input", root), list = $(".ta-list", root);
  let items = [], active = -1, timer, seq = 0;
  const render = () => {
    list.innerHTML = items.length ? items.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">
      <span class="ov" style="background:${GROUP_COLOR[p.group]}">${p.overall}</span>
      <span><span class="nm">${esc(p.name)}</span><small>${esc(p.positions)} · ${p.age}y · ${esc(p.club)}</small></span>
      <span class="vl">€${fmt(p.value_m)}M</span></li>`).join("")
      : (input.value.trim().length > 1 ? `<li class="none">No player found</li>` : "");
  };
  const pick = i => { const p = items[i]; if (!p) return; onPick(p); input.value = ""; items = []; render(); };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = []; render(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try { const r = await fetch(`/api/players?q=${encodeURIComponent(q)}&limit=8`).then(r => r.json()); if (my === seq) { items = r.players || []; active = 0; render(); } }
      catch { items = []; render(); }
    }, 180);
  });
  input.addEventListener("keydown", e => {
    if (!items.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(active); e.preventDefault(); }
    else if (e.key === "Escape") { items = []; render(); }
  });
  list.addEventListener("mousedown", e => { const li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  input.addEventListener("blur", () => setTimeout(() => { items = []; render(); }, 120));
}

export function playerChip(p, kind, onRemove, onToggle) {
  const el = document.createElement("span");
  el.className = "chip " + kind;
  el.innerHTML = `<span class="av" style="background:${GROUP_COLOR[p.group]}">${p.overall}</span>${esc(p.name)}` +
    (onToggle ? `<button type="button" class="mode" aria-pressed="${!!p.start}" title="${p.start ? "Must start in the XI. Click: squad is enough" : "Squad is enough. Click: must start"}">${p.start ? "XI" : "SQUAD"}</button>` : "") +
    `<button type="button" class="rm" aria-label="Remove ${esc(p.name)}">×</button>`;
  $(".rm", el).onclick = onRemove;
  if (onToggle) $(".mode", el).onclick = onToggle;
  return el;
}

export function miniFormation(rows) {
  const n = rows.length; let d = "";
  rows.forEach((r, i) => { const y = 40 - i * (36 / Math.max(n - 1, 1)); r.forEach((_, j) => (d += `<circle cx="${(j + 1) * 34 / (r.length + 1)}" cy="${y}" r="2.6"/>`)); });
  return `<svg viewBox="0 0 34 44" aria-hidden="true">${d}</svg>`;
}

// ------------------------------------------------------------------ charts (plain SVG/HTML)
/** rows: [{label, a, b, color}] two-part horizontal bars (a solid = XI, b faded = bench) */
export function hbars(el, rows, unit = "€", suffix = "M") {
  const max = Math.max(1e-9, ...rows.map(r => r.a + r.b));
  el.innerHTML = rows.map(r => `<div class="hbar"><span>${esc(r.label)}</span><div class="tr">
      <i style="width:${r.a / max * 100}%;background:${r.color}"></i><i style="width:${r.b / max * 100}%;background:${r.color}"></i></div>
      <b>${unit}${fmt(r.a + r.b)}${suffix}</b></div>`).join("") +
    `<div class="legend"><span><i style="background:#d4ff3a"></i>Starting XI</span><span><i style="background:#d4ff3a;opacity:.45"></i>Bench</span></div>`;
  gsap.to($$(".tr i", el), { scaleX: 1, duration: REDUCED ? 0 : .9, stagger: .05, ease: "power3.out" });
}

/** vertical bars: [{label, v, color}] with y range [lo, hi] */
export function vbars(el, data, lo, hi) {
  const w = 320, h = 170, pb = 26, pt = 14, pl = 20, bw = (w - pl) / data.length;
  const y = v => pt + (h - pb - pt) * (1 - (v - lo) / (hi - lo));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Slot ratings">`;
  for (let g = Math.ceil(lo / 5) * 5; g <= hi; g += 5) s += `<line class="grid" x1="${pl}" x2="${w}" y1="${y(g)}" y2="${y(g)}"/><text x="0" y="${y(g) + 3}">${g}</text>`;
  data.forEach((d, i) => {
    const x = pl + i * bw + bw * .18, bh = h - pb - y(d.v);
    s += `<rect x="${x}" y="${y(d.v)}" width="${bw * .64}" height="${Math.max(0, bh)}" rx="3" fill="${d.color}" class="vb" style="transform-origin:${x}px ${h - pb}px"/>
      <text class="val" x="${x + bw * .32}" y="${y(d.v) - 4}" text-anchor="middle">${Math.round(d.v)}</text>
      <text x="${x + bw * .32}" y="${h - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  el.innerHTML = `<div class="chart">${s}</svg></div>`;
  gsap.from($$(".vb", el), { scaleY: 0, duration: REDUCED ? 0 : .8, stagger: .04, ease: "power3.out" });
}

/** scatter: [{x, y, color, label, r}] */
export function scatter(el, pts, xl, yl) {
  const w = 320, h = 200, pl = 30, pb = 26, pt = 10, pr = 10;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.floor(Math.min(...xs) - 1), x1 = Math.ceil(Math.max(...xs) + 1), y0 = 0, y1 = Math.max(...ys) * 1.1 || 1;
  const X = v => pl + (w - pl - pr) * (v - x0) / (x1 - x0), Y = v => pt + (h - pt - pb) * (1 - (v - y0) / (y1 - y0));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(yl)} against ${esc(xl)}">`;
  for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4; s += `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="0" y="${Y(v) + 3}">${Math.round(v)}</text>`; }
  const st = Math.max(2, Math.ceil((x1 - x0) / 7));
  for (let v = Math.ceil(x0 / st) * st; v <= x1; v += st) s += `<text x="${X(v)}" y="${h - 10}" text-anchor="middle">${v}</text>`;
  s += `<text x="${w - pr}" y="${h}" text-anchor="end">${esc(xl)} →</text>`;
  pts.forEach(p => (s += `<circle class="dotp" cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.r || 4.5}" fill="${p.color}" fill-opacity=".85" stroke="#05080f"><title>${esc(p.label)}</title></circle>`));
  el.innerHTML = `<div class="chart">${s}</svg></div>`;
  gsap.from($$(".dotp", el), { attr: { r: 0 }, duration: REDUCED ? 0 : .6, stagger: .02, ease: "back.out(3)" });
}

/** histogram of integers */
export function histogram(el, values, color, lo, hi, step = 2) {
  const bins = []; for (let a = lo; a < hi; a += step) bins.push({ label: `${a}`, v: values.filter(v => v >= a && v < a + step).length, color });
  const w = 320, h = 150, pb = 22, pt = 14, bw = w / bins.length, m = Math.max(1, ...bins.map(b => b.v));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Age histogram">`;
  bins.forEach((b, i) => {
    const bh = (h - pb - pt) * b.v / m, x = i * bw + 2;
    s += `<rect class="vb" x="${x}" y="${h - pb - bh}" width="${bw - 4}" height="${bh}" rx="3" fill="${color}" style="transform-origin:${x}px ${h - pb}px"/>`;
    if (b.v) s += `<text class="val" x="${x + bw / 2 - 2}" y="${h - pb - bh - 3}" text-anchor="middle">${b.v}</text>`;
    s += `<text x="${x + bw / 2 - 2}" y="${h - 6}" text-anchor="middle">${b.label}</text>`;
  });
  el.innerHTML = `<div class="chart">${s}</svg></div>`;
  gsap.from($$(".vb", el), { scaleY: 0, duration: REDUCED ? 0 : .7, stagger: .03, ease: "power3.out" });
}
