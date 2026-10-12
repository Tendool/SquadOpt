import { Stadium } from "./stadium.js";
import { $, $$, esc, fmt, toast as baseToast, countUp, segmented, select, fillRange, typeahead, playerChip, miniFormation, hbars, vbars, scatter, histogram, GROUP_COLOR } from "./ui.js";
import { createAgent } from "./agent.js";
import { sfx } from "./audio.js";
import { settings, QUALITY } from "./settings.js";
import { cardHTML, attachTilt, radar, tier } from "./card.js";

const gsap = window.gsap;
const RM = () => settings.get("reduceMotion");
const D = s => (RM() ? 0 : s);
const TYPES = { FB: "Full-back", WB: "Wing-back", CB: "Centre-back", DM: "Holding mid", CM: "Central mid", AM: "Attacking mid", WM: "Wide mid", W: "Winger", ST: "Striker", GK: "Goalkeeper" };
const SLOT_GROUP = s => (s === "GK" ? "GK" : /^(LB|RB|LWB|RWB|CB)$/.test(s) ? "DEF" : /^(LW|RW|ST)$/.test(s) ? "FWD" : "MID");
const KITS = [
  { name: "Home", shirt: "#eef0f2", shorts: "#1d232b", socks: "#eef0f2", num: "#1d232b" },
  { name: "Crimson", shirt: "#a8262b", shorts: "#eef0f2", socks: "#a8262b", num: "#eef0f2" },
  { name: "Sky", shirt: "#6f9fc9", shorts: "#eef0f2", socks: "#1f2f4d", num: "#1f2f4d" },
  { name: "Forest", shirt: "#2f5d4a", shorts: "#eef0f2", socks: "#2f5d4a", num: "#eef0f2" },
  { name: "Charcoal", shirt: "#2a3038", shorts: "#2a3038", socks: "#d4772e", num: "#e7e9ec" },
  { name: "Royal", shirt: "#34488f", shorts: "#eef0f2", socks: "#34488f", num: "#eef0f2" },
];
const toast = (text, kind = "") => { baseToast(text, kind); sfx.play(kind === "err" ? "error" : "notify"); };

const S = {
  meta: null, form: "4-3-3", fmode: "pre", back: "all", cus: [["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "W"]],
  must: [], excl: [], result: null, busy: false, list: "xi", view: "pitch", history: [], entered: false,
};

// ------------------------------------------------------------------ stage (with WebGL fallback)
let stadium;
try {
  stadium = new Stadium($("#stage"), $("#labels"), { quality: QUALITY[settings.get("quality")], kit: KITS[settings.get("kit")] || KITS[0] });
  stadium.setLabels(settings.get("labels")); stadium.setReducedMotion(RM()); stadium.intro();
  bootStep("stage", "ok", "ready");
} catch (e) {
  console.error(e); $("#fallback").hidden = false; bootStep("stage", "warn", "2D mode");
  stadium = new Proxy({}, { get: () => () => {} });            // every call becomes a no-op
}
window.stadium = stadium;
document.body.classList.toggle("reduce-motion", RM());

const tip = $("#ptip");
stadium.onHoverChange = d => { if (d) sfx.play("hover"); };
stadium.onHover = (d, x, y) => {
  if (!d) { tip.hidden = true; hot(null); return; }
  const s = S.result?.squad.find(r => r.id === d.id) || {}, slot = S.result?.pitch.find(p => p.id === d.id);
  tip.innerHTML = `<h4>${esc(s.Player || d.name)}</h4><div class="tm">${esc(s.club || d.club || "")}${s.required ? " · <b style='color:var(--info)'>REQUIRED</b>" : ""}</div><dl>
    <dt>Role</dt><dd>${slot ? "XI · " + esc(slot.slot) : "Bench"}</dd>${slot ? `<dt>Slot rating</dt><dd>${fmt(slot.rating, 0)}</dd>` : ""}
    <dt>Overall / Pot.</dt><dd>${s.Overall ?? "–"} / ${s.Potential ?? "–"}</dd><dt>Positions</dt><dd>${esc(s["Natural positions"] || "")}</dd>
    <dt>Age</dt><dd>${s.Age ?? "–"}</dd><dt>Value</dt><dd>€${fmt(s["Value (€M)"])}M${s["Price imputed"] ? "*" : ""}</dd></dl><div class="hint">Click to inspect</div>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - r.width - 12, x + 16) + "px";
  tip.style.top = Math.min(innerHeight - r.height - 12, y + 16) + "px";
  hot(d.id);
};
stadium.onSelect = d => inspect(d.id);
function hot(id) { $$(".prow").forEach(r => r.classList.toggle("hot", +r.dataset.id === id)); }

// ------------------------------------------------------------------ boot + start screen
function bootStep(k, cls, text) {
  const li = $(`#boot li[data-k="${k}"]`); if (!li) return;
  li.className = cls; li.querySelector("em").textContent = text;
  const done = $$("#boot li").filter(l => l.className).length;
  $("#bootBar").style.width = (done / 3 * 100) + "%";
}
async function boot() {
  try {
    const m = await fetch("/api/meta").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    S.meta = m; S.form = m.default.formation;
    $("#dataPill").classList.add("ok"); $("#dataPill span").textContent = `${m.players.toLocaleString()} players`;
    $("#dataPill").dataset.tip = `Dataset: ${m.dataset}`;
    buildForms(); buildCustom(); setBudget(m.default.budget);
    $("#size").value = m.default.size; $("#age").value = m.default.max_age; $("#pabs").value = m.default.p_abs;
    ["size", "age", "pabs"].forEach(id => $("#" + id).dispatchEvent(new Event("input")));
    renderModelStatic(); applyFormation();
    bootStep("data", "ok", `${m.players.toLocaleString()} players`);
  } catch {
    $("#dataPill").classList.add("bad"); $("#dataPill span").textContent = "offline";
    bootStep("data", "bad", "backend offline");
  }
  try { S.history = JSON.parse(localStorage.getItem("squadopt.history") || "[]"); } catch { S.history = []; }
  renderHistory();
  const ai = await agent.checkStatus();
  bootStep("ai", ai ? "ok" : "warn", ai ? "ready" : "offline");
  const btn = $("#enter"); btn.disabled = false; btn.querySelector("span").textContent = matchMedia("(pointer:coarse)").matches ? "Tap to start" : "Press any key";
  addEventListener("keydown", enter, { once: true }); btn.addEventListener("click", enter, { once: true });
  $("#start").addEventListener("pointerdown", enter, { once: true });
}
function enter(e) {
  if (S.entered) return; S.entered = true;
  e?.preventDefault?.();
  sfx.unlock();
  sfx.play("whistle"); setTimeout(() => sfx.play("cheer", 2.6), 250);
  if (settings.get("amb") > 0) setTimeout(() => sfx.startAmbience(), 600);
  gsap.to("#start", { opacity: 0, duration: D(.7), onComplete: () => $("#start").remove() });
  gsap.to(".logo span", { y: -30, opacity: 0, stagger: .06, duration: D(.4) });
  document.body.classList.remove("booting");
  stadium.setView("tactical");
  const tl = gsap.timeline({ delay: D(.6) });
  tl.from(".topbar", { y: -30, opacity: 0, duration: D(.6), ease: "power3.out" })
    .from(".dock.left", { x: -60, opacity: 0, duration: D(.8), ease: "power3.out" }, "<.1")
    .from(".dock.right", { x: 60, opacity: 0, duration: D(.8), ease: "power3.out" }, "<")
    .from(".hud", { y: 40, opacity: 0, duration: D(.7), ease: "power3.out" }, "<.15")
    .from("#leftDock .sec", { x: -20, opacity: 0, stagger: .07, duration: D(.4) }, "<.2");
  setTimeout(moveNavInd, 50);
}

// ------------------------------------------------------------------ global sound wiring
let lastHoverEl = null;
document.addEventListener("pointerover", e => {
  const el = e.target.closest("button:not(:disabled), .fb, .prow, .ta-list li, summary, .kits button");
  if (el && el !== lastHoverEl) { lastHoverEl = el; sfx.play("hover"); }
  if (!el) lastHoverEl = null;
});
document.addEventListener("click", e => {
  const el = e.target.closest("button, summary, .prow, .ta-list li");
  if (!el || el.disabled || el.id === "enter") return;
  const tab = el.closest(".seg, .navtabs");
  sfx.play(el.dataset.sfx || (tab ? "tab" : "click"));
}, true);
document.addEventListener("input", e => {
  if (e.target.matches("input[type=range]")) { const r = e.target; sfx.play("tick", (r.value - r.min) / (r.max - r.min)); }
  else if (e.target.matches("textarea, input[type=search], input[type=number]")) sfx.play("type");
});
document.addEventListener("change", e => { if (e.target.matches(".tog input")) sfx.play(e.target.checked ? "toggleOn" : "toggleOff"); });

// ------------------------------------------------------------------ budget + sliders
function setBudget(v) {
  v = Math.max(20, Math.min(5000, Math.round(+v || 0)));
  $("#budget").value = v; $("#slider").value = Math.min(v, 1500); fillRange($("#slider"));
}
$("#budget").addEventListener("input", e => { $("#slider").value = Math.min(+e.target.value || 0, 1500); fillRange($("#slider")); });
$("#budget").addEventListener("change", e => setBudget(e.target.value));
$("#slider").addEventListener("input", e => setBudget(e.target.value));
$("#budgetChips").innerHTML = [100, 300, 500, 1000, 2000].map(v => `<button type="button" data-v="${v}">€${v >= 1000 ? v / 1000 + "B" : v + "M"}</button>`).join("");
$("#budgetChips").onclick = e => { const b = e.target.closest("button"); if (!b) return; const o = { v: +$("#budget").value };
  gsap.to(o, { v: +b.dataset.v, duration: D(.5), ease: "power2.out", onUpdate: () => { setBudget(o.v); sfx.play("tick", Math.min(1, o.v / 1500)); } }); };
const sliderOut = { size: v => v, age: v => (+v >= 45 ? "none" : v), pabs: v => Math.round(v * 100) + "%" };
for (const id of ["size", "age", "pabs"]) $("#" + id).addEventListener("input", e => { $("#" + id + "V").textContent = sliderOut[id](e.target.value); fillRange(e.target); });

// ------------------------------------------------------------------ formations
function rowsOf() { return S.fmode === "pre" ? S.meta?.formations[S.form] : [["GK"], ...S.cus.filter(r => r.length)]; }
function applyFormation() {
  const rows = rowsOf(); if (!rows) return;
  if (S.fmode === "cus" && rows.flat().length !== 11) return;
  stadium.setFormation(rows);
  if (!S.result) { $("#hudForm").textContent = S.fmode === "pre" ? S.form : "Custom"; $("#hudInfo").textContent = "Preview · set a budget and build your squad"; }
}
function buildForms() {
  const names = Object.keys(S.meta.formations).filter(n => S.back === "all" || n[0] === S.back).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $("#formGrid").innerHTML = names.map(n => `<button type="button" class="fb" data-f="${esc(n)}" data-sfx="select" aria-pressed="${n === S.form}" title="${esc(n)}">${miniFormation(S.meta.formations[n])}<span>${esc(n)}</span></button>`).join("");
  gsap.from($$(".fb"), { opacity: 0, y: 8, duration: D(.3), stagger: .012 });
}
$("#formGrid").onclick = e => { const b = e.target.closest(".fb"); if (!b) return; S.form = b.dataset.f;
  $$(".fb").forEach(x => x.setAttribute("aria-pressed", x === b)); applyFormation(); };
segmented($("#backFilter"), b => { S.back = b.dataset.back; buildForms(); });
segmented($("[aria-label='Formation mode']"), b => { S.fmode = b.dataset.fmode; $("#formPresets").hidden = S.fmode !== "pre"; $("#formCustom").hidden = S.fmode !== "cus"; applyFormation(); });
function buildCustom() {
  $("#lines").innerHTML = ["Defence", "Midfield", "Attack"].map((t, i) => `<div class="ln"><b>${t}</b><div>` +
    S.cus[i].map((x, j) => `<button type="button" class="cx" data-i="${i}" data-j="${j}" data-sfx="popDown" title="Remove ${TYPES[x]}">${x} ×</button>`).join("") +
    `<select data-i="${i}" aria-label="Add to ${t}"><option value="">+</option>${Object.entries(TYPES).filter(([k]) => k !== "GK").map(([k, v]) => `<option value="${k}">${k} · ${v}</option>`).join("")}</select></div></div>`).join("");
  const n = S.cus.flat().length;
  $("#ccount").textContent = `${n} / 10 outfield players` + (n === 10 ? " ✓" : ""); $("#ccount").className = "cnt" + (n === 10 ? " ok" : "");
}
$("#lines").onclick = e => { const b = e.target.closest(".cx"); if (b) { S.cus[b.dataset.i].splice(b.dataset.j, 1); buildCustom(); applyFormation(); } };
$("#lines").onchange = e => { const s = e.target.closest("select"); if (s?.value && S.cus.flat().length < 10) { S.cus[s.dataset.i].push(s.value); sfx.play("pop"); } buildCustom(); applyFormation(); };

// ------------------------------------------------------------------ required / excluded players
function renderPicks() {
  const draw = (box, arr, kind) => { box.innerHTML = ""; arr.forEach((p, i) => box.append(playerChip(p, kind, () => { arr.splice(i, 1); sfx.play("popDown"); renderPicks(); },
    kind === "must" ? () => { p.start = !p.start; sfx.play(p.start ? "toggleOn" : "toggleOff"); renderPicks(); } : null))); };
  draw($("#mustChips"), S.must, "must"); draw($("#exclChips"), S.excl, "excl");
}
typeahead($("#mustTa"), p => { if (!S.must.some(x => x.id === p.id)) { S.must.push({ ...p, start: true }); S.excl = S.excl.filter(x => x.id !== p.id); sfx.play("pop"); renderPicks(); } });
typeahead($("#exclTa"), p => { if (!S.excl.some(x => x.id === p.id)) { S.excl.push(p); S.must = S.must.filter(x => x.id !== p.id); sfx.play("pop"); renderPicks(); } });

// ------------------------------------------------------------------ kits + camera
$("#kits").innerHTML = KITS.map((k, i) => `<button type="button" data-sfx="kit" style="background:${k.shirt};box-shadow:inset 0 -7px 0 ${k.shorts}" aria-label="${k.name} kit" title="${k.name} kit" aria-pressed="${i === settings.get("kit")}" data-i="${i}"></button>`).join("");
$("#kits").onclick = e => { const b = e.target.closest("button"); if (!b) return; $$("#kits button").forEach(x => x.setAttribute("aria-pressed", x === b)); settings.set("kit", +b.dataset.i); stadium.setKit(KITS[+b.dataset.i]); };
segmented($("#camSeg"), b => { stadium.setView(b.dataset.cam); sfx.play("camera"); });
function camera(name) { const b = $(`#camSeg [data-cam=${name}]`); select($("#camSeg"), b); stadium.setView(name); sfx.play("camera"); }

// ------------------------------------------------------------------ solve
let solveTimer;
function setSolving(on, msg) {
  S.busy = on;
  $("#go").disabled = on; $("#go").classList.toggle("busy", on); $(".cta-t").textContent = on ? "Optimising…" : "Build squad";
  stadium.setSolving(on);
  clearInterval(solveTimer);
  if (on) {
    sfx.startSolving();
    $("#solverMsg").textContent = msg || "Pruning dominated players, then solving the integer program with HiGHS…";
    $("#solver").hidden = false; gsap.fromTo("#solver .solver-card", { y: -16, opacity: 0 }, { y: 0, opacity: 1, duration: D(.4) });
    const t0 = performance.now();
    solveTimer = setInterval(() => ($("#solverTime").textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s"), 100);
    $("#hudInfo").textContent = "Optimising…";
  } else { sfx.stopSolving(); $("#solver").hidden = true; }
}
async function build() {
  if (S.busy) return;
  const body = { budget: +$("#budget").value, size: +$("#size").value, max_age: +$("#age").value, p_abs: +$("#pabs").value,
                 must: S.must.filter(p => !p.start).map(p => p.id), must_start: S.must.filter(p => p.start).map(p => p.id), exclude: S.excl.map(p => p.id) };
  if (S.fmode === "cus") {
    if (S.cus.flat().length !== 10) { toast("Add exactly 10 outfield players to your formation.", "err"); return; }
    body.custom = S.cus;
  } else body.formation = S.form;
  sfx.play("engage");
  setSolving(true);
  try {
    const r = await fetch("/api/optimise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: `Server error (${r.status})` }));
    if (!r.ok) throw new Error(d.error || "Server error");
    setSolving(false);
    showResult(d, "builder");
  } catch (e) { setSolving(false); toast(e.message, "err"); applyFormation(); }
}
$("#go").dataset.sfx = "none";
$("#go").onclick = build;

// ------------------------------------------------------------------ results + reveal
function teamOvr(d) { return Math.round(d.kpis["Average XI rating"]); }
function showResult(d, source, record = true) {
  S.result = d;
  const bench = d.squad.filter(s => s.Role !== "Starting XI").map(s => ({ ...s, name: s.Player, overall: s.Overall }));
  sfx.play("impact");
  const last = stadium.showSquad(d.pitch, bench, d.required.map(p => p.id), {
    onLand: i => sfx.play("thud", i),
    onDone: () => reveal(d),
  });
  const k = d.kpis, spent = k["Squad value (€M)"], pct = Math.min(1, spent / d.budget);
  $("#emptyState").hidden = true; $("#results").hidden = false;
  countUp($("#spent"), spent, 1); $("#budgetOut").textContent = fmt(d.budget, 0);
  $("#leftOut").textContent = `€${fmt(d.budget - spent)}M left`;
  $("#formOut").textContent = `${d.formation} · ${source === "agent" ? "via agent" : "builder"}`;
  gsap.fromTo("#ringFg", { attr: { "stroke-dashoffset": 314.16 } }, { attr: { "stroke-dashoffset": 314.16 * (1 - pct) }, duration: D(1.2), ease: "power3.out" });
  countUp($("#ringPct"), pct * 100, 0); setTimeout(() => ($("#ringPct").textContent = Math.round(pct * 100) + "%"), D(1.15) * 1000);
  countUp($("#teamOvr b"), teamOvr(d), 0);
  const expK = Object.keys(k).find(n => n.startsWith("Expected"));
  const kp = [["XI quality", k["XI quality"], 0, "sum of slots", true], ["Expected", k[expK], 1, "with absences"], ["Bad luck P5", k["5th-percentile quality"], 1, "5th pct"],
              ["Avg rating", k["Average XI rating"], 1, "starting XI"], ["Mean age", k["Mean age"], 1, "squad"], ["Solve", d.solve_s, 1, "sec · HiGHS"]];
  $("#kpis").innerHTML = kp.map(([n, v, dp, s, hl]) => `<div class="kpi${hl ? " hl" : ""}"><div class="v" data-v="${v}" data-dp="${dp}">0</div><div class="n">${esc(n)} · ${esc(s)}</div></div>`).join("");
  $$("#kpis .v").forEach(el => countUp(el, +el.dataset.v, +el.dataset.dp));
  gsap.from("#kpis .kpi", { y: 12, opacity: 0, duration: D(.4), stagger: .05 });
  renderList();
  $("#hudForm").textContent = d.formation;
  $("#hudInfo").textContent = `€${fmt(spent)}M / €${fmt(d.budget, 0)}M · XI ${fmt(k["XI quality"], 0)} · ${fmt(d.solve_s)}s`;
  syncControls(d.params, d);
  renderInsights(); renderModelRun();
  if (record) pushHistory(d, source);
  $$(".checks").forEach(ul => (ul.innerHTML = d.checks.map(c => `<li class="${c.ok ? "ok" : "no"}"><i>${c.ok ? "✓" : "✗"}</i>${esc(c.name)}</li>`).join("")));
  const bad = d.checks.filter(c => !c.ok).length;
  $("#checksN").textContent = bad ? `${bad} ✗` : `${d.checks.length} ✓`;
  if (bad) setTimeout(() => toast(`${bad} constraint check(s) failed. Open Checks.`, "err"), 400);
  if (d.model.tiebreak_done === false) setTimeout(() => toast("Tie-break by AHP utility timed out. The squad is still optimal for expected quality."), last * 1000 + 2500);
}

function reveal(d) {
  const el = $("#reveal");
  $("#rvNum").textContent = teamOvr(d);
  $("#rvSub").textContent = `${d.formation} · €${fmt(d.kpis["Squad value (€M)"])}M · ${d.checks.every(c => c.ok) ? "all checks passed" : "check warnings"}`;
  el.hidden = false;
  sfx.play("slam"); sfx.play("horn"); setTimeout(() => sfx.play("cheer"), 150); setTimeout(() => sfx.play("success"), 450);
  if (RM()) { setTimeout(() => (el.hidden = true), 1600); return; }
  const tl = gsap.timeline({ onComplete: () => (el.hidden = true) });
  tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: .15 })
    .fromTo(".rv-num", { scale: 2.2, opacity: 0 }, { scale: 1, opacity: 1, duration: .45, ease: "power4.out" }, 0)
    .fromTo(".rv-k", { letterSpacing: "1em", opacity: 0 }, { letterSpacing: ".3em", opacity: 1, duration: .5 }, .1)
    .fromTo([".rv-l", ".rv-sub"], { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: .4, stagger: .08 }, .25)
    .fromTo(".rv-wave", { scale: .2, opacity: .9 }, { scale: 3.2, opacity: 0, duration: 1, ease: "power2.out" }, 0)
    .fromTo("#stage", { x: -6 }, { x: 0, duration: .4, ease: "elastic.out(1,.3)" }, 0)
    .to(el, { opacity: 0, duration: .45 }, 1.9);
}

function renderList() {
  const d = S.result; if (!d) return;
  const bySlot = new Map(d.pitch.map(p => [p.id, p]));
  const rows = S.list === "xi" ? d.pitch.map(p => d.squad.find(s => s.id === p.id)) : S.list === "bench" ? d.squad.filter(s => s.Role !== "Starting XI") : d.squad;
  $("#plist").innerHTML = rows.map(s => {
    const p = bySlot.get(s.id);
    return `<li class="prow" data-id="${s.id}" data-sfx="none"><span class="ov t-${tier(s.Overall, s.required)}"><b>${s.Overall}</b><small>${esc(p ? p.slot : s["Natural positions"].split(",")[0])}</small></span>
      <span style="min-width:0"><span class="nm"><span>${esc(s.Player)}</span>${s.required ? `<span class="badge">REQ</span>` : ""}${s["Backup for"] ? `<span class="badge bk" title="Designated backup">BK ${esc(s["Backup for"])}</span>` : ""}</span>
      <span class="meta">${esc(s["Natural positions"])} · ${s.Age}y · ${esc(s.club)}</span></span>
      <span class="val">€${fmt(s["Value (€M)"])}M${s["Price imputed"] ? "*" : ""}<small>${p ? "slot " + fmt(p.rating, 0) : "bench"}</small></span></li>`;
  }).join("");
  gsap.from("#plist .prow", { x: 14, opacity: 0, duration: D(.3), stagger: .025 });
}
segmented($("#listTabs"), b => { S.list = b.dataset.list; renderList(); });
$("#plist").addEventListener("mouseover", e => { const r = e.target.closest(".prow"); stadium.highlight(r ? +r.dataset.id : null); });
$("#plist").addEventListener("mouseleave", () => stadium.highlight(null));
$("#plist").addEventListener("click", e => { const r = e.target.closest(".prow"); if (r) inspect(+r.dataset.id); });

function inspect(id) {
  const d = S.result; if (!d) return;
  const s = d.squad.find(r => r.id === id); if (!s) return;
  const p = d.pitch.find(q => q.id === id);
  stadium.select(id);
  $("#insCard").innerHTML = cardHTML(s, { slot: p?.slot });
  attachTilt($("#insCard"));
  const role = p ? `Starting XI · ${p.slot}` : s["Backup for"] ? `Bench · designated backup` : "Bench";
  $("#insInfo").innerHTML = `<h4>${esc(s.Player)}</h4><div class="sub">${esc(s.club)}${s.nation ? " · " + esc(s.nation) : ""}</div>
    <div class="ins-row">${s.stats?.some(x => x[1] != null) ? radar(s.stats) : ""}<dl>
      <dt>Role</dt><dd>${esc(role)}</dd>${p ? `<dt>Slot rating</dt><dd>${fmt(p.rating, 0)}</dd>` : ""}
      ${s["Backup for"] ? `<dt>Backup for</dt><dd>${esc(s["Backup for"].split(", ").map(t => TYPES[t] || t).join(", "))}</dd>` : ""}
      <dt>Overall</dt><dd>${s.Overall} <span class="muted">(potential ${s.Potential})</span></dd>
      <dt>Positions</dt><dd>${esc(s["Natural positions"])}</dd><dt>Age</dt><dd>${s.Age}</dd>
      <dt>Value</dt><dd>€${fmt(s["Value (€M)"])}M${s["Price imputed"] ? " <span class='muted'>(estimated)</span>" : ""}</dd>
      <dt>AHP utility</dt><dd>${fmt(s.Utility, 3)}</dd>${s.required ? `<dt>Required</dt><dd style="color:var(--info)">Yes${d.required.find(r => r.id === id)?.start ? ", must start" : ""}</dd>` : ""}</dl></div>`;
  openDlg($("#inspect"));
  sfx.play("card");
  gsap.fromTo("#insCard .fc", { rotateY: -90, opacity: 0 }, { rotateY: 0, opacity: 1, duration: D(.6), ease: "back.out(1.6)" });
}

/** Reflect the parameters of a result (from the builder or the agent) in the builder controls. */
function syncControls(p, d) {
  if (!p) return;
  setBudget(p.budget);
  $("#size").value = p.size; $("#age").value = p.max_age ?? 45; $("#pabs").value = p.p_abs;
  ["size", "age", "pabs"].forEach(id => $("#" + id).dispatchEvent(new Event("input")));
  if (p.formation) {
    S.fmode = "pre"; S.form = p.formation; select($("[aria-label='Formation mode']"), $("[data-fmode=pre]"));
    $("#formPresets").hidden = false; $("#formCustom").hidden = true;
    $$(".fb").forEach(x => x.setAttribute("aria-pressed", x.dataset.f === p.formation));
  }
  S.must = d.required.slice(); S.excl = d.excluded.slice(); renderPicks();
}

// ------------------------------------------------------------------ copy / csv / checks
$("#copyBtn").onclick = async () => {
  const d = S.result; if (!d) return;
  const t = d.squad.map(s => `${s.Role === "Starting XI" ? "XI   " : "Bench"} ${s.Player} (${s.Slot || "res"}) ${s.Overall} €${fmt(s["Value (€M)"])}M`).join("\n");
  try { await navigator.clipboard.writeText(`${d.formation} · €${d.budget}M\n${t}`); toast("Squad copied", "ok"); } catch { toast("Clipboard not available", "err"); }
};
$("#csvBtn").onclick = () => {
  const d = S.result; if (!d) return;
  const cols = ["Role", "Slot", "Player", "Age", "Natural positions", "Overall", "Potential", "Value (€M)", "Price imputed", "Slot rating", "Backup for", "club", "required"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...d.squad.map(s => cols.map(c => q(s[c])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: `squad_${d.formation}_${d.budget}M.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); sfx.play("success");
};
$("#checksBtn").onclick = () => openDlg($("#checksDlg"));

// ------------------------------------------------------------------ dialogs
function openDlg(dlg) { if (!dlg.matches(":modal")) { if (dlg.open) dlg.close(); dlg.showModal(); sfx.play("open"); gsap.fromTo(dlg, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: D(.3), ease: "power3.out" }); } }
for (const dlg of $$("dialog")) {
  dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
  dlg.addEventListener("close", () => { sfx.play("close"); if (dlg.id === "inspect") stadium.select(null); });
}

// ------------------------------------------------------------------ settings
function initSettings() {
  const vols = [["volMaster", "master"], ["volSfx", "sfx"], ["volUi", "ui"], ["volAmb", "amb"]];
  for (const [id, key] of vols) {
    const el = $("#" + id); el.value = settings.get(key); fillRange(el); $(`#${id}V`).textContent = Math.round(el.value * 100);
    sfx.setVolume(key, +el.value);
    el.addEventListener("input", () => { settings.set(key, +el.value); sfx.setVolume(key, +el.value); fillRange(el); $(`#${id}V`).textContent = Math.round(el.value * 100);
      if (key === "amb") +el.value > 0 && S.entered ? sfx.startAmbience() : sfx.stopAmbience(); });
  }
  const mute = m => { settings.set("muted", m); sfx.setMuted(m); $("#muteBtn").classList.toggle("muted", m); $("#setMute").checked = m; };
  mute(settings.get("muted"));
  $("#muteBtn").onclick = () => mute(!settings.get("muted"));
  $("#setMute").onchange = e => mute(e.target.checked);
  $("#testSound").onclick = () => { sfx.unlock(); sfx.play("horn"); setTimeout(() => sfx.play("cheer"), 120); };
  const q = settings.get("quality");
  select($("#qualSeg"), $(`#qualSeg [data-q=${q}]`));
  segmented($("#qualSeg"), b => { settings.set("quality", b.dataset.q); stadium.setQuality(QUALITY[b.dataset.q]); });
  $("#setAuto").checked = settings.get("autoQuality"); $("#setAuto").onchange = e => settings.set("autoQuality", e.target.checked);
  $("#setLabels").checked = settings.get("labels"); $("#setLabels").onchange = e => { settings.set("labels", e.target.checked); stadium.setLabels(e.target.checked); };
  $("#setMotion").checked = RM(); $("#setMotion").onchange = e => { settings.set("reduceMotion", e.target.checked); stadium.setReducedMotion(e.target.checked); document.body.classList.toggle("reduce-motion", e.target.checked); };
  $("#settingsBtn").onclick = () => openDlg($("#settingsDlg"));
  $("#helpBtn").onclick = () => openDlg($("#helpDlg"));
  // frame-rate readout and automatic quality step-down
  const order = ["low", "medium", "high", "ultra"]; let slow = 0;
  setInterval(() => {
    const ms = stadium.frameMs; if (typeof ms !== "number" || !ms) return;
    $("#fpsOut").textContent = `${Math.round(1000 / ms)} FPS · ${settings.get("quality").toUpperCase()}`;
    if (!settings.get("autoQuality") || document.hidden || !S.entered) return;
    slow = ms > 34 ? slow + 1 : 0;
    const i = order.indexOf(settings.get("quality"));
    if (slow >= 4 && i > 0) {
      const nq = order[i - 1]; settings.set("quality", nq); stadium.setQuality(QUALITY[nq]); select($("#qualSeg"), $(`#qualSeg [data-q=${nq}]`)); slow = 0;
      baseToast(`Graphics lowered to ${nq} to keep the frame rate smooth`);
    }
  }, 1000);
}

// ------------------------------------------------------------------ views / sheets
function moveNavInd() {
  const b = $("#views [aria-selected=true]"), ind = $(".navind"); if (!b) return;
  gsap.to(ind, { x: b.offsetLeft, width: b.offsetWidth, duration: D(.35), ease: "power3.out" });
}
segmented($("#views"), b => setView(b.dataset.view));
function setView(v) {
  if (v === S.view) return;
  S.view = v; select($("#views"), $(`#views [data-view=${v}]`)); moveNavInd();
  sfx.play(v === "pitch" ? "close" : "open");
  for (const name of ["insights", "compare", "model"]) {
    const el = $("#sheet-" + name), on = name === v;
    if (on) { el.hidden = false; gsap.fromTo(el, { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: D(.45), ease: "power3.out" });
              gsap.from($$(".card", el), { y: 16, opacity: 0, duration: D(.4), stagger: .05, delay: .1 }); }
    else el.hidden = true;
  }
  document.body.classList.toggle("view-sheet", v !== "pitch");
  if (v !== "pitch") scrollTo({ top: 0 });
}
addEventListener("resize", moveNavInd);

function renderInsights() {
  const d = S.result, el = $("#sheet-insights"); if (!d) return;
  el.classList.add("has");
  const xi = new Set(d.pitch.map(p => p.id));
  hbars($("#chMoney"), ["GK", "DEF", "MID", "FWD"].map(g => ({ label: g, color: GROUP_COLOR[g],
    a: d.squad.filter(s => s.group === g && xi.has(s.id)).reduce((t, s) => t + s["Value (€M)"], 0),
    b: d.squad.filter(s => s.group === g && !xi.has(s.id)).reduce((t, s) => t + s["Value (€M)"], 0) })));
  const r = d.pitch.map(p => p.rating);
  vbars($("#chSlots"), d.pitch.map(p => ({ label: p.slot, v: p.rating, color: GROUP_COLOR[SLOT_GROUP(p.slot)] })), Math.floor(Math.min(...r) / 5) * 5 - 5, Math.ceil(Math.max(...r) / 5) * 5);
  scatter($("#chScatter"), d.squad.map(s => ({ x: s.Overall, y: s["Value (€M)"], color: s.required ? "#5b8fbf" : xi.has(s.id) ? "#d4772e" : "#7d8691",
    label: `${s.Player}: ${s.Overall} OVR, €${fmt(s["Value (€M)"])}M`, r: xi.has(s.id) ? 5 : 3.5 })), "Overall", "Value €M");
  $("#chScatter").insertAdjacentHTML("beforeend", `<div class="legend"><span><i style="background:#d4772e"></i>XI</span><span><i style="background:#7d8691"></i>Bench</span><span><i style="background:#5b8fbf"></i>Required</span></div>`);
  $("#chBackups").innerHTML = `<div class="bk-row">${Object.entries(d.model.backups).map(([t, n]) => `<div class="bk"><span>${esc(TYPES[t] || t)}</span><b>${esc(n)}</b></div>`).join("")}</div>`;
  const ages = d.squad.map(s => s.Age);
  histogram($("#chAge"), ages, "#a7b4c2", Math.floor(Math.min(...ages) / 2) * 2, Math.max(...ages) + 2);
}
function renderModelStatic() {
  const a = S.meta.ahp, ab = c => c.slice(0, 3).toUpperCase();
  $("#ahpBars").innerHTML = a.criteria.map((c, i) => `<div class="hbar" title="${esc(c)}"><span>${ab(c)}</span><div class="tr"><i style="width:${a.weights[i] * 100}%;background:#d4772e;transform:scaleX(1)"></i></div><b>${fmt(a.weights[i] * 100, 1)}%</b></div>`).join("") +
    `<p class="muted" style="margin-top:8px">Consistency ratio CR = <b style="color:var(--accent)">${a.cr.toFixed(4)}</b> (must be &lt; 0.10)</p>`;
  const n = a.criteria.length, f = v => (v >= 1 ? +v.toFixed(2) : "1/" + Math.round(1 / v));
  $("#ahpMatrix").innerHTML = `<div class="matrix" style="grid-template-columns:repeat(${n + 1},1fr)"><div class="h"></div>${a.criteria.map(c => `<div class="h">${ab(c)}</div>`).join("")}` +
    a.matrix.map((row, i) => `<div class="h">${ab(a.criteria[i])}</div>` + row.map(v => `<div>${f(v)}</div>`).join("")).join("") + `</div>`;
  renderPipe();
  $("#ilpStats").innerHTML = `<p class="muted">Run the optimiser to see the model size.</p>`;
  $("#evalStats").innerHTML = `<p class="muted">Run the optimiser to see the simulation.</p>`;
}
function renderPipe(m) {
  const st = [["Data", `${S.meta.players.toLocaleString()} players`, "FC 26 CSV"], ["Calibrate", "position ratings + price imputation", "load_players"],
    ["AHP", "overall · potential · versatility", "add_utilities"], ["Prune", m ? `${m.pool_size.toLocaleString()} players kept` : "exact dominance", "dominance_prune"],
    ["ILP", m ? `${m.n_vars.toLocaleString()} vars · ${m.n_cons.toLocaleString()} cons` : "x · y · z binaries", "optimise · HiGHS"],
    ["Tie-break", "max AHP utility at optimum", "stage 2"], ["Evaluate", "200 Monte-Carlo absences", "evaluate_squad"]];
  $("#pipe").innerHTML = st.map(([b, s, e], i) => (i ? `<div class="ar">→</div>` : "") + `<div class="st"><em>0${i + 1}</em><b>${b}</b><span>${s}</span><span><code>${e}</code></span></div>`).join("");
}
function renderModelRun() {
  const d = S.result, m = d.model, k = d.kpis, expK = Object.keys(k).find(n => n.startsWith("Expected"));
  renderPipe(m);
  $("#ilpStats").innerHTML = `<div class="stats">
    <div class="stat"><b>${m.pool_size.toLocaleString()}</b><span>players after pruning</span></div><div class="stat"><b>${m.n_vars.toLocaleString()}</b><span>binary variables</span></div>
    <div class="stat"><b>${m.n_cons.toLocaleString()}</b><span>constraints</span></div><div class="stat"><b>${m.n_pairs.toLocaleString()}</b><span>(player, slot) pairs</span></div></div>
    <p class="muted" style="margin-top:10px">${m.statuses.map(([s, t], i) => `Stage ${i + 1}: <b style="color:var(--accent)">${esc(s)}</b> in ${fmt(t)}s`).join(" · ")}${m.tiebreak_done === false ? "<br><b style='color:var(--warn)'>AHP tie-break hit the time limit:</b> the squad is still optimal for expected quality, but ties were not broken by utility." : ""}</p>`;
  $("#evalStats").innerHTML = `<div class="stats">
    <div class="stat"><b>${fmt(m.xi_quality, 0)}</b><span>Q XI (starting XI)</span></div><div class="stat"><b>${fmt(m.depth, 0)}</b><span>D (backup depth)</span></div>
    <div class="stat"><b>${fmt(m.eq, 1)}</b><span>objective, p=${Math.round(m.p_abs * 100)}%</span></div><div class="stat"><b>${fmt(k[expK], 1)}</b><span>simulated E[Q]</span></div>
    <div class="stat"><b>${fmt(k["5th-percentile quality"], 1)}</b><span>bad-luck P5</span></div><div class="stat"><b>${fmt(m.util, 2)}</b><span>squad AHP utility</span></div></div>`;
}

// ------------------------------------------------------------------ history / compare
function pushHistory(d, source) {
  const k = d.kpis, expK = Object.keys(k).find(n => n.startsWith("Expected"));
  S.history.unshift({ t: Date.now(), source, formation: d.formation, budget: d.budget, spent: k["Squad value (€M)"], xi: k["XI quality"], eq: k[expK],
    p5: k["5th-percentile quality"], age: k["Mean age"], req: d.required.map(p => p.name), payload: d });
  S.history = S.history.slice(0, 12);
  try { localStorage.setItem("squadopt.history", JSON.stringify(S.history)); } catch { /* storage full or blocked */ }
  renderHistory();
}
function renderHistory() {
  const el = $("#sheet-compare"); el.classList.toggle("has", S.history.length > 0);
  if (!S.history.length) return;
  const best = Math.max(...S.history.map(h => h.xi));
  $("#histRows").innerHTML = S.history.map((h, i) => `<tr><td>${new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
    <td><span class="src ${h.source === "agent" ? "ai" : ""}">${h.source === "agent" ? "AGENT" : "BUILDER"}</span></td><td><b>${esc(h.formation)}</b></td>
    <td class="r">€${fmt(h.budget, 0)}M</td><td class="r">€${fmt(h.spent)}M</td><td class="r" style="${h.xi === best ? "color:var(--accent);font-weight:700" : ""}">${fmt(h.xi, 0)}</td>
    <td class="r">${fmt(h.eq)}</td><td class="r">${fmt(h.p5)}</td><td class="r">${fmt(h.age)}</td><td>${esc(h.req.join(", ")) || "–"}</td>
    <td><button class="btn ghost sm" data-load="${i}">Load</button></td></tr>`).join("");
  scatterBudget($("#chCompare"), S.history.map(h => ({ x: h.budget, y: h.xi, color: h.source === "agent" ? "#a7b4c2" : "#d4772e", label: `${h.formation} · €${h.budget}M → XI ${fmt(h.xi, 0)}` })));
}
function scatterBudget(el, pts) {
  const w = 320, h = 200, pl = 34, pb = 26, pt = 10, pr = 12;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = 0, x1 = Math.max(...xs) * 1.1, y0 = Math.floor((Math.min(...ys) - 10) / 10) * 10, y1 = Math.ceil((Math.max(...ys) + 5) / 10) * 10;
  const X = v => pl + (w - pl - pr) * (v - x0) / (x1 - x0), Y = v => pt + (h - pt - pb) * (1 - (v - y0) / (y1 - y0));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="XI quality against budget">`;
  for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4; s += `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="0" y="${Y(v) + 3}">${Math.round(v)}</text>`; }
  for (let i = 0; i <= 4; i++) { const v = x1 * i / 4; s += `<text x="${X(v)}" y="${h - 8}" text-anchor="middle">€${Math.round(v)}M</text>`; }
  pts.forEach(p => (s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5.5" fill="${p.color}" stroke="#0e1114"><title>${esc(p.label)}</title></circle>`));
  el.innerHTML = `<div class="chart">${s}</svg></div><div class="legend"><span><i style="background:#d4772e"></i>Builder</span><span><i style="background:#a7b4c2"></i>Agent</span></div>`;
}
$("#histRows").onclick = e => { const b = e.target.closest("[data-load]"); if (!b) return; const h = S.history[+b.dataset.load];
  setView("pitch"); showResult(h.payload, h.source, false); };
$("#clearHist").onclick = () => { S.history = []; try { localStorage.removeItem("squadopt.history"); } catch { /* blocked */ } renderHistory(); sfx.play("popDown"); };

// ------------------------------------------------------------------ left-dock mode (builder / agent)
const modeSeg = $(".dock.left .seg");
function setMode(agentMode) {
  select(modeSeg, $(`[data-mode=${agentMode ? "agent" : "build"}]`, modeSeg));
  $("#buildPane").hidden = agentMode; $("#agentPane").hidden = !agentMode;
  gsap.from(agentMode ? "#agentPane" : "#buildPane", { opacity: 0, x: agentMode ? 16 : -16, duration: D(.35), ease: "power2.out" });
  if (agentMode) $("#prompt").focus();
}
segmented(modeSeg, b => setMode(b.dataset.mode === "agent"));

const agent = createAgent({
  onSolving: (on, msg) => setSolving(on, msg),
  onSquad: d => showResult(d, "agent"),
  context: () => {
    const p = S.result?.params; if (!p) return null;
    return { budget_m: p.budget, formation: p.formation || "custom", must_start: S.result.required.filter(x => x.start).map(x => x.name),
             must_include: S.result.required.filter(x => !x.start).map(x => x.name), exclude: S.result.excluded.map(x => x.name),
             max_age: p.max_age, squad_size: p.size, absence_risk: p.p_abs };
  },
  busy: () => S.busy,
  sfx,
});

// ------------------------------------------------------------------ keyboard
addEventListener("keydown", e => {
  if (!S.entered) return;
  const typing = e.target.matches("input, textarea, select");
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if ($("#agentPane").hidden) build(); return; }
  if (/^F[1-4]$/.test(e.key)) { e.preventDefault(); setView(["pitch", "insights", "compare", "model"][+e.key[1] - 1]); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $("dialog[open]")) return;
  if ("1234".includes(e.key) && e.key.length === 1) camera(["tactical", "broadcast", "top", "orbit"][+e.key - 1]);
  else if (e.key === "m" || e.key === "M") $("#muteBtn").click();
  else if (e.key === "?") openDlg($("#helpDlg"));
  else if (e.key === "a" || e.key === "A") { sfx.play("tab"); setMode($("#agentPane").hidden); }
});

initSettings();
boot();
