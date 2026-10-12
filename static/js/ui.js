// Small UI kit: DOM helpers, toasts, count-up, segmented controls, range fill, player search, SVG charts
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmt = (n, dp = 1) => (n == null || Number.isNaN(+n) ? "–" : (+n).toFixed(dp));
export const money = m => (m == null ? "–" : m >= 1000 ? `€${(m / 1000).toFixed(2)}B` : `€${(+m).toFixed(1)}M`);
export const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsap = window.gsap;
export const GROUP_COLOR = { GK: "#d9a63c", DEF: "#6f9fd8", MID: "#4caf7d", FWD: "#e0584f" };
export const ACCENT = "#e26a2c";
const ICON = id => `<svg class="ic"><use href="#${id}"/></svg>`;

export function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = text;
  $("#toasts").append(el);
  gsap.from(el, { y: 16, opacity: 0, duration: REDUCED ? 0 : .3, ease: "power3.out" });
  setTimeout(() => gsap.to(el, { opacity: 0, y: 8, duration: .25, onComplete: () => el.remove() }), kind === "err" ? 6000 : 3200);
}

export function countUp(el, value, dp = 0) {
  if (value == null || Number.isNaN(+value)) { el.textContent = "–"; return; }
  if (REDUCED) { el.textContent = (+value).toFixed(dp); return; }
  const o = { v: 0 };
  gsap.to(o, { v: +value, duration: 1, ease: "power3.out", onUpdate: () => (el.textContent = o.v.toFixed(dp)) });
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
  input.style.setProperty("--p", ((input.value - input.min) / (input.max - input.min) * 100) + "%");
}

/** Player search with inline actions. onAction(player, "start" | "squad" | "excl"); roleOf(id) -> current role or null. */
export function playerSearch(root, { onAction, roleOf }) {
  const input = $("input", root), list = $(".results", root);
  let items = [], active = -1, timer, seq = 0;
  const LABEL = { start: "Starts", squad: "In squad", excl: "Exclude" };
  const render = () => {
    if (!items.length) { list.innerHTML = input.value.trim().length > 1 ? `<li class="none">No player found</li>` : ""; return; }
    list.innerHTML = items.map((p, i) => {
      const role = roleOf(p.id);
      return `<li role="option" data-i="${i}" class="${i === active ? "active" : ""}">
        <span class="r-ovr" style="background:${GROUP_COLOR[p.group]}">${p.overall}</span>
        <span class="r-main"><span class="r-name">${esc(p.name)}</span><span class="r-meta">${esc(p.positions)} · ${p.age} · ${esc(p.club)} · ${money(p.value_m)}</span></span>
        <span class="r-acts">${["start", "squad", "excl"].map(a => `<button type="button" data-act="${a}" class="${a === "start" ? "go-start" : ""}"${role === a ? " disabled" : ""}>${LABEL[a]}</button>`).join("")}</span></li>`;
    }).join("");
  };
  const act = (i, a) => { const p = items[i]; if (!p) return; onAction(p, a); input.value = ""; items = []; render(); input.focus(); };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = []; render(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try { const r = await fetch(`/api/players?q=${encodeURIComponent(q)}&limit=8`).then(r => r.json()); if (my === seq) { items = r.players || []; active = 0; render(); } }
      catch { items = []; render(); }
    }, 160);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; items = []; render(); return; }
    if (!items.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === "Enter") { act(active, "start"); e.preventDefault(); }
  });
  list.addEventListener("mousedown", e => {
    const b = e.target.closest("button[data-act]"), li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    if (b && !b.disabled) act(+li.dataset.i, b.dataset.act);
  });
  document.addEventListener("pointerdown", e => { if (!root.contains(e.target)) { items = []; render(); } });
  return { icon: ICON };
}

// ------------------------------------------------------------------ charts (plain SVG/HTML, no gradients)
/** rows: [{label, a, b, color}] two-part horizontal bars (a = starting XI, b = bench) */
export function hbars(el, rows) {
  const max = Math.max(1e-9, ...rows.map(r => r.a + r.b));
  el.innerHTML = rows.map(r => `<div class="hbar"><span>${esc(r.label)}</span><div class="tr">
      <i style="width:${r.a / max * 100}%;background:${r.color}"></i><i style="width:${r.b / max * 100}%;background:${r.color}"></i></div>
      <b>${money(r.a + r.b)}</b></div>`).join("") +
    `<div class="legend"><span><i style="background:${ACCENT}"></i>Starting XI</span><span><i style="background:${ACCENT};opacity:.45"></i>Bench</span></div>`;
  gsap.to($$(".tr i", el), { scaleX: 1, duration: REDUCED ? 0 : .8, stagger: .04, ease: "power3.out" });
}

/** vertical bars: [{label, v, color}] with y range [lo, hi] */
export function vbars(el, data, lo, hi) {
  const w = 320, h = 170, pb = 26, pt = 14, pl = 22, bw = (w - pl) / data.length;
  const y = v => pt + (h - pb - pt) * (1 - (v - lo) / (hi - lo));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Slot ratings">`;
  for (let g = Math.ceil(lo / 5) * 5; g <= hi; g += 5) s += `<line class="grid" x1="${pl}" x2="${w}" y1="${y(g)}" y2="${y(g)}"/><text x="0" y="${y(g) + 3}">${g}</text>`;
  data.forEach((d, i) => {
    const x = pl + i * bw + bw * .2, bh = h - pb - y(d.v);
    s += `<rect x="${x}" y="${y(d.v)}" width="${bw * .6}" height="${Math.max(0, bh)}" rx="3" fill="${d.color}" class="vb" style="transform-origin:${x}px ${h - pb}px"/>
      <text class="val" x="${x + bw * .3}" y="${y(d.v) - 4}" text-anchor="middle">${Math.round(d.v)}</text>
      <text x="${x + bw * .3}" y="${h - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  el.innerHTML = `<div class="chart">${s}</svg></div>`;
  gsap.from($$(".vb", el), { scaleY: 0, duration: REDUCED ? 0 : .7, stagger: .03, ease: "power3.out" });
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
  s += `<text x="${w - pr}" y="${h}" text-anchor="end">${esc(xl)}</text>`;
  pts.forEach(p => (s += `<circle class="dotp" cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.r || 4.5}" fill="${p.color}" fill-opacity=".9" stroke="#0f1012"><title>${esc(p.label)}</title></circle>`));
  el.innerHTML = `<div class="chart">${s}</svg></div>`;
  gsap.from($$(".dotp", el), { attr: { r: 0 }, duration: REDUCED ? 0 : .5, stagger: .015, ease: "back.out(2)" });
}

/** histogram of integers */
export function histogram(el, values, color, lo, hi, step = 2) {
  const bins = []; for (let a = lo; a < hi; a += step) bins.push({ label: `${a}`, v: values.filter(v => v >= a && v < a + step).length });
  const w = 320, h = 150, pb = 22, pt = 14, bw = w / bins.length, m = Math.max(1, ...bins.map(b => b.v));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Age histogram">`;
  bins.forEach((b, i) => {
    const bh = (h - pb - pt) * b.v / m, x = i * bw + 2;
    s += `<rect class="vb" x="${x}" y="${h - pb - bh}" width="${bw - 4}" height="${bh}" rx="3" fill="${color}" style="transform-origin:${x}px ${h - pb}px"/>`;
    if (b.v) s += `<text class="val" x="${x + bw / 2 - 2}" y="${h - pb - bh - 3}" text-anchor="middle">${b.v}</text>`;
    s += `<text x="${x + bw / 2 - 2}" y="${h - 6}" text-anchor="middle">${b.label}</text>`;
  });
  el.innerHTML = `<div class="chart">${s}</svg></div>`;
  gsap.from($$(".vb", el), { scaleY: 0, duration: REDUCED ? 0 : .6, stagger: .03, ease: "power3.out" });
}
