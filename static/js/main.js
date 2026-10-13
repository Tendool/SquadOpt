import { Stadium } from "./stadium.js";
import { $, $$, esc, fmt, money, toast as baseToast, countUp, segmented, select, fillRange, playerSearch, hbars, vbars, scatter, histogram, GROUP_COLOR, ACCENT } from "./ui.js";
import { createAgent } from "./agent.js";
import { sfx } from "./audio.js";
import { settings, QUALITY } from "./settings.js";
import { cardHTML, attachTilt, radar, posMap } from "./card.js";
import { diagram, splitName, backLine, TYPE_NAME, GROUP_OF, CUSTOM_LINES, orderLine, customStatus } from "./formation.js";

const gsap = window.gsap;
const RM = () => settings.get("reduceMotion");
const D = s => (RM() ? 0 : s);
const KITS = [
  { name: "Home", shirt: "#eef0f2", shorts: "#1d232b", socks: "#eef0f2", num: "#1d232b" },
  { name: "Crimson", shirt: "#a8262b", shorts: "#eef0f2", socks: "#a8262b", num: "#eef0f2" },
  { name: "Sky", shirt: "#6f9fc9", shorts: "#eef0f2", socks: "#1f2f4d", num: "#1f2f4d" },
  { name: "Forest", shirt: "#2f5d4a", shorts: "#eef0f2", socks: "#2f5d4a", num: "#eef0f2" },
  { name: "Charcoal", shirt: "#2a3038", shorts: "#2a3038", socks: "#e26a2c", num: "#e7e9ec" },
  { name: "Royal", shirt: "#34488f", shorts: "#eef0f2", socks: "#34488f", num: "#eef0f2" },
];
const ROLE_LABEL = { start: "Starts", squad: "In squad", excl: "Excluded" };
const ROLE_NEXT = { start: "squad", squad: "excl", excl: "start" };
const toast = (text, kind = "") => { baseToast(text, kind); sfx.play(kind === "err" ? "error" : "notify"); };
const ic = id => `<svg class="ic"><use href="#${id}"/></svg>`;

const S = {
  meta: null, forms: [], form: "4-3-3", custom: null, cus: [[], [], []],
  picks: new Map(), result: null, busy: false, list: "xi", view: "pitch", history: [], entered: false, formsTab: "all",
};

// ------------------------------------------------------------------ stage (with WebGL fallback)
let stadium;
const boot = { stage: false, data: false, ai: false };
try {
  stadium = new Stadium($("#stage"), $("#labels"), { quality: QUALITY[settings.get("quality")], kit: KITS[settings.get("kit")] || KITS[0] });
  stadium.setLabels(settings.get("labels")); stadium.setReducedMotion(RM()); stadium.intro();
  boot.stage = true;
} catch (e) {
  console.error(e); $("#fallback").hidden = false; boot.stage = true;
  stadium = new Proxy({}, { get: () => () => {} });             // every call becomes a no-op
}
window.stadium = stadium;
document.body.classList.toggle("reduce-motion", RM());

const tip = $("#ptip");
stadium.onHoverChange = d => { if (d) sfx.play("hover"); };
stadium.onHover = (d, x, y) => {
  if (!d) { tip.hidden = true; hot(null); return; }
  const s = S.result?.squad.find(r => r.id === d.id) || {}, slot = S.result?.pitch.find(p => p.id === d.id);
  const where = slot ? `${slot.slot} · rated ${fmt(slot.rating, 0)}${slot.listed ? "" : ` (${slot.slot_base} − 3, not a listed position)`}` : "Bench";
  tip.innerHTML = `<h4>${esc(s.Player || d.name)}</h4><div class="tm">${esc(s["Natural positions"] || "")} · ${esc(s.club || "")}</div><dl>
    <dt>Plays</dt><dd>${esc(where)}</dd><dt>Overall</dt><dd>${s.Overall ?? "–"}</dd><dt>Age</dt><dd>${s.Age ?? "–"}</dd>
    <dt>Value</dt><dd>${money(s["Value (€M)"])}${s["Price imputed"] ? "*" : ""}</dd></dl><div class="hint">Click for details</div>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - r.width - 12, x + 16) + "px";
  tip.style.top = Math.min(innerHeight - r.height - 12, y + 16) + "px";
  hot(d.id);
};
stadium.onSelect = d => inspect(d.id);
function hot(id) { $$(".prow").forEach(r => r.classList.toggle("hot", +r.dataset.id === id)); }

// ------------------------------------------------------------------ title screen
function bootStatus(text) {
  const done = Object.values(boot).filter(Boolean).length;
  $("#bootBar").style.width = (done / 3 * 100) + "%";
  $("#bootText").textContent = text;
}
async function start() {
  bootStatus("Loading players");
  try {
    const m = await fetch("/api/meta").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    S.meta = m; S.form = m.default.formation;
    S.forms = Object.keys(m.formations).sort((a, b) => backLine(m.formations[a]) - backLine(m.formations[b]) || a.localeCompare(b, undefined, { numeric: true }));
    $("#dataPill").classList.add("ok"); $("#dataPill span").textContent = `${m.players.toLocaleString()} players`;
    $("#dataPill").dataset.tip = `Player database: ${m.dataset}`;
    setBudget(m.default.budget);
    setRule("size", m.default.size); setRule("age", m.default.max_age); $("#pabs").value = m.default.p_abs; $("#pabs").dispatchEvent(new Event("input"));
    renderFormation(); renderModelStatic();
  } catch {
    $("#dataPill").classList.add("bad"); $("#dataPill span").textContent = "Server offline";
    toast("Can't reach the server. Start it with python app.py", "err");
  }
  boot.data = true; bootStatus("Checking the agent");
  try { S.history = JSON.parse(localStorage.getItem("squadopt.history.v3") || "[]"); } catch { S.history = []; }
  renderHistory();
  await agent.checkStatus();
  boot.ai = true; bootStatus("Ready");
  $("#start").classList.add("ready");
  const btn = $("#enter");
  btn.disabled = false; btn.textContent = matchMedia("(pointer:coarse)").matches ? "Tap to start" : "Press any key";
  addEventListener("keydown", enter, { once: true });
  $("#start").addEventListener("pointerdown", enter, { once: true });
}
function enter(e) {
  if (S.entered) return; S.entered = true;
  e?.preventDefault?.();
  sfx.unlock();
  sfx.play("whistle"); setTimeout(() => sfx.play("cheer", 2.6), 250);
  if (settings.get("amb") > 0) setTimeout(() => sfx.startAmbience(), 600);
  gsap.to("#start", { opacity: 0, duration: D(.6), onComplete: () => $("#start").remove() });
  document.body.classList.remove("booting");
  stadium.resize(); stadium.setView("tactical");
  gsap.timeline({ delay: D(.5) })
    .from(".topbar", { y: -20, opacity: 0, duration: D(.5), ease: "power3.out" })
    .from(".panel.left", { x: -40, opacity: 0, duration: D(.7), ease: "power3.out" }, "<.1")
    .from(".panel.right", { x: 40, opacity: 0, duration: D(.7), ease: "power3.out" }, "<")
    .from(".hud", { y: 30, opacity: 0, duration: D(.6), ease: "power3.out" }, "<.15");
  setTimeout(moveTabInd, 60);
}

// ------------------------------------------------------------------ global sound wiring
let lastHoverEl = null;
document.addEventListener("pointerover", e => {
  const el = e.target.closest("button:not(:disabled), .prow, .results li, summary, .fcard");
  if (el && el !== lastHoverEl) { lastHoverEl = el; sfx.play("hover"); }
  if (!el) lastHoverEl = null;
});
document.addEventListener("click", e => {
  const el = e.target.closest("button, summary");
  if (!el || el.disabled || el.id === "enter") return;
  sfx.play(el.dataset.sfx || (el.closest(".seg, .tabs, .cams") ? "tab" : "click"));
}, true);
document.addEventListener("input", e => {
  if (e.target.matches("input[type=range]")) { const r = e.target; sfx.play("tick", (r.value - r.min) / (r.max - r.min)); }
  else if (e.target.matches("textarea, input[type=search], input[type=number]")) sfx.play("type");
});
document.addEventListener("change", e => { if (e.target.matches(".tog input")) sfx.play(e.target.checked ? "toggleOn" : "toggleOff"); });

// ------------------------------------------------------------------ budget
const QUICK = [100, 300, 500, 1000, 2000];
function setBudget(v) {
  v = Math.max(20, Math.min(5000, Math.round(+v || 0)));
  $("#budget").value = v; $("#slider").value = Math.min(v, 1500); fillRange($("#slider"));
  $$("#budgetChips button").forEach(b => b.classList.toggle("on", +b.dataset.v === v));
}
$("#budgetChips").innerHTML = QUICK.map(v => `<button type="button" data-v="${v}">${v >= 1000 ? v / 1000 + "B" : v + "M"}</button>`).join("");
$("#budget").addEventListener("input", e => { $("#slider").value = Math.min(+e.target.value || 0, 1500); fillRange($("#slider")); });
$("#budget").addEventListener("change", e => setBudget(e.target.value));
$("#slider").addEventListener("input", e => setBudget(e.target.value));
$("#budgetChips").onclick = e => { const b = e.target.closest("button"); if (!b) return; const o = { v: +$("#budget").value };
  gsap.to(o, { v: +b.dataset.v, duration: D(.45), ease: "power2.out", onUpdate: () => setBudget(o.v), onComplete: () => setBudget(+b.dataset.v) }); };

// ------------------------------------------------------------------ squad rules
function setRule(id, v) {
  const el = $("#" + id), min = +el.dataset.min, max = +el.dataset.max;
  v = Math.max(min, Math.min(max, +v)); el.value = v;
  $("#" + id + "V").textContent = id === "age" && v >= 45 ? "No limit" : v;
  rulesSummary();
}
function rulesSummary() {
  const age = +$("#age").value;
  $("#rulesSummary").textContent = `${$("#size").value} players · ${age >= 45 ? "any age" : "max " + age} · ${Math.round($("#pabs").value * 100)}% absence`;
}
$$(".stepper").forEach(st => st.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  setRule(st.dataset.for, +$("#" + st.dataset.for).value + +b.dataset.d);
}));
$("#pabs").addEventListener("input", e => { $("#pabsV").textContent = Math.round(e.target.value * 100) + "%"; fillRange(e.target); rulesSummary(); });

// ------------------------------------------------------------------ formation
const formRows = () => (S.custom ? [["GK"], ...S.custom.filter(r => r.length)] : S.meta?.formations[S.form]);
function renderFormation(animate = false) {
  const rows = formRows(); if (!rows) return;
  const nm = S.custom ? { shape: S.custom.map(r => r.length).filter(Boolean).join("-"), variant: "custom shape" } : splitName(S.form);
  $("#formName").textContent = nm.shape; $("#formVariant").textContent = nm.variant;
  $("#formPreview").innerHTML = diagram(rows, { w: 220, h: 170, dot: 6, labels: true });
  if (animate) gsap.from("#formPreview .fd-dot", { scale: .3, transformOrigin: "center", opacity: 0, duration: D(.35), stagger: .015, ease: "back.out(2)" });
  stadium.setFormation(rows);
}
function stepForm(d) {
  const i = S.custom ? (d > 0 ? -1 : 0) : S.forms.indexOf(S.form);
  S.custom = null;
  S.form = S.forms[(i + d + S.forms.length) % S.forms.length];
  renderFormation(true); sfx.play("select");
}
$("#formPrev").onclick = () => stepForm(-1);
$("#formNext").onclick = () => stepForm(1);
$("#browseForms").onclick = () => { renderFormGrid(); openDlg($("#formsDlg")); };
segmented($("#formsTabs"), b => { S.formsTab = b.dataset.ft; renderFormGrid(); });
function renderFormGrid() {
  const custom = S.formsTab === "custom";
  $("#formGrid").hidden = custom; $("#formCustom").hidden = !custom;
  if (custom) { renderCustom(); return; }
  const names = S.forms.filter(n => S.formsTab === "all" || backLine(S.meta.formations[n]) === +S.formsTab);
  $("#formGrid").innerHTML = names.map(n => { const sp = splitName(n);
    return `<button type="button" class="fcard" data-f="${esc(n)}" data-sfx="select" aria-pressed="${!S.custom && n === S.form}">${diagram(S.meta.formations[n], { w: 74, h: 92, dot: 3.6 })}<b>${esc(sp.shape)}</b><span>${esc(sp.variant)}</span></button>`; }).join("");
}
$("#formGrid").onclick = e => { const b = e.target.closest(".fcard"); if (!b) return;
  S.custom = null; S.form = b.dataset.f; renderFormation(true); $("#formsDlg").close(); };
function renderCustom() {
  S.cus = S.cus.map(orderLine);                          // each line left to right, as it is drawn and solved
  const st = customStatus(S.cus), n = st.n;
  $("#lines").innerHTML = CUSTOM_LINES.map(({ name, options }, i) => `<div class="ln"><h4>${name}</h4><div class="ln-slots">` +
    S.cus[i].map((x, j) => `<button type="button" class="cx" data-i="${i}" data-j="${j}" data-sfx="popDown" title="Remove ${TYPE_NAME[x] || x}">${x}${ic("i-x")}</button>`).join("") +
    `</div><div class="addmenu">${options.map(k => `<button type="button" data-add="${k}" data-i="${i}" data-sfx="pop" title="${TYPE_NAME[k]}"${n >= 10 ? " disabled" : ""}>+ ${k}</button>`).join("")}</div></div>`).join("");
  $("#customPreview").innerHTML = diagram([["GK"], ...S.cus.filter(r => r.length)], { w: 210, h: 260, dot: 7, labels: true });
  $("#ccount").textContent = st.message;
  $("#ccount").className = "cnt" + (st.ok ? " ok" : ""); $("#useCustom").disabled = !st.ok;
}
$("#lines").onclick = e => {
  const rm = e.target.closest(".cx"), add = e.target.closest("[data-add]");
  if (rm) S.cus[rm.dataset.i].splice(rm.dataset.j, 1);
  else if (add && !add.disabled && CUSTOM_LINES[add.dataset.i].options.includes(add.dataset.add)) S.cus[add.dataset.i].push(add.dataset.add);
  else return;
  renderCustom();
};
$("#useCustom").onclick = () => { if (!customStatus(S.cus).ok) return; S.custom = S.cus.map(r => r.slice()); renderFormation(true); $("#formsDlg").close(); };

// ------------------------------------------------------------------ players
function renderPicks() {
  const list = [...S.picks.values()];
  $("#picksHint").textContent = list.length ? `${list.length} selected` : "optional";
  $("#picks").innerHTML = list.map(({ p, role }) => `<li class="pick" data-id="${p.id}">
    <span class="r-ovr" style="background:${GROUP_COLOR[p.group]}">${p.overall}</span>
    <span class="r-main"><span class="r-name">${esc(p.name)}</span><span class="r-meta">${esc(p.positions)} · ${money(p.value_m)}</span></span>
    <button type="button" class="role ${role}" data-act="cycle" title="Change: starts, in squad or excluded">${ROLE_LABEL[role]}</button>
    <button type="button" class="icon-btn" data-act="rm" data-sfx="popDown" aria-label="Remove ${esc(p.name)}">${ic("i-x")}</button></li>`).join("");
}
playerSearch($("#playerSearch"), {
  roleOf: id => S.picks.get(id)?.role || null,
  onAction: (p, role) => { S.picks.set(p.id, { p, role }); sfx.play("pop"); renderPicks(); },
});
$("#picks").onclick = e => {
  const b = e.target.closest("button[data-act]"), li = e.target.closest(".pick"); if (!b || !li) return;
  const id = +li.dataset.id, entry = S.picks.get(id);
  if (b.dataset.act === "rm") S.picks.delete(id);
  else { entry.role = ROLE_NEXT[entry.role]; sfx.play("toggleOn"); }
  renderPicks();
};

// ------------------------------------------------------------------ kits + camera
$("#kits").innerHTML = KITS.map((k, i) => `<button type="button" data-sfx="kit" style="background:${k.shirt}" aria-label="${k.name} kit" data-tip="${k.name} kit" aria-pressed="${i === settings.get("kit")}" data-i="${i}"></button>`).join("");
$("#kits").onclick = e => { const b = e.target.closest("button"); if (!b) return; $$("#kits button").forEach(x => x.setAttribute("aria-pressed", x === b)); settings.set("kit", +b.dataset.i); stadium.setKit(KITS[+b.dataset.i]); };
segmented($("#camSeg"), b => { stadium.setView(b.dataset.cam); sfx.play("camera"); });
function camera(name) { select($("#camSeg"), $(`#camSeg [data-cam=${name}]`)); stadium.setView(name); sfx.play("camera"); }

// ------------------------------------------------------------------ solve
let solveTimer;
function setSolving(on, msg) {
  S.busy = on;
  $("#go").disabled = on; $(".cta-t").textContent = on ? "Optimising…" : "Build squad";
  stadium.setSolving(on);
  clearInterval(solveTimer);
  if (on) {
    sfx.startSolving();
    $("#solverMsg").textContent = msg || "Searching every player for the best squad that fits";
    $("#solver").hidden = false; gsap.fromTo("#solver", { y: -12, opacity: 0 }, { y: 0, opacity: 1, duration: D(.35) });
    const t0 = performance.now();
    solveTimer = setInterval(() => ($("#solverTime").textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s"), 100);
  } else { sfx.stopSolving(); $("#solver").hidden = true; }
}
async function build() {
  if (S.busy || !S.meta) return;
  const picks = [...S.picks.values()], ids = r => picks.filter(x => x.role === r).map(x => x.p.id);
  const body = { budget: +$("#budget").value, size: +$("#size").value, max_age: +$("#age").value, p_abs: +$("#pabs").value,
                 must: ids("squad"), must_start: ids("start"), exclude: ids("excl") };
  if (S.custom) body.custom = S.custom; else body.formation = S.form;
  sfx.play("engage");
  setSolving(true);
  try {
    const r = await fetch("/api/optimise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: `Server error (${r.status})` }));
    if (!r.ok) throw new Error(d.error || "Server error");
    setSolving(false);
    showResult(d, "builder");
  } catch (e) { setSolving(false); toast(e.message.replace(/^Bad input: /, ""), "err"); renderFormation(); }
}
$("#go").dataset.sfx = "none";
$("#go").onclick = build;

// ------------------------------------------------------------------ results
const teamOvr = d => Math.round(d.kpis["Average XI rating"]);
const expKey = k => Object.keys(k).find(n => n.startsWith("Expected"));
function showResult(d, source, record = true) {
  S.result = d;
  const bench = d.squad.filter(s => s.Role !== "Starting XI").map(s => ({ ...s, name: s.Player, overall: s.Overall }));
  sfx.play("impact");
  const last = stadium.showSquad(d.pitch, bench, d.required.map(p => p.id), { onLand: i => sfx.play("thud", i), onDone: () => reveal(d) });
  const k = d.kpis, spent = k["Squad value (€M)"];
  $("#emptyState").hidden = true; $("#results").hidden = false;
  const nm = d.formation === "Custom" ? { shape: d.rows.slice(1).map(r => r.length).join("-"), variant: "custom" } : splitName(d.formation);
  $("#resForm").textContent = nm.shape + (nm.variant ? ` ${nm.variant}` : "");
  $("#formOut").textContent = source === "agent" ? "Built by the agent" : "Built by the optimiser";
  countUp($("#teamOvr"), teamOvr(d), 0); countUp($("#spent"), spent, 1);
  $("#budgetOut").textContent = fmt(d.budget, 0); $("#leftOut").textContent = `${money(d.budget - spent)} left`;
  requestAnimationFrame(() => ($("#meterFill").style.width = Math.min(100, spent / d.budget * 100) + "%"));
  const oop = d.pitch.filter(p => p.listed === false).length;
  const kp = [["XI quality", k["XI quality"], 0, true], ["Expected", k[expKey(k)], 1], ["Worst 5%", k["5th-percentile quality"], 1],
              ["Mean age", k["Mean age"], 1], ["Out of position", oop, 0], ["Solved in", d.solve_s, 1, false, "s"]];
  $("#kpis").innerHTML = kp.map(([n, v, dp, hl, unit]) => `<div><dt>${n}</dt><dd class="${hl ? "hl" : ""}"><span data-v="${v}" data-dp="${dp}">0</span>${unit || ""}</dd></div>`).join("");
  $$("#kpis [data-v]").forEach(el => countUp(el, +el.dataset.v, +el.dataset.dp));
  renderList();
  syncControls(d);
  renderInsights(); renderModelRun();
  if (record) pushHistory(d, source);
  $$(".checks").forEach(ul => (ul.innerHTML = d.checks.map(c => `<li class="${c.ok ? "ok" : "no"}">${ic(c.ok ? "i-check" : "i-x")}${esc(humanCheck(c.name))}</li>`).join("")));
  const bad = d.checks.filter(c => !c.ok).length;
  $("#checksN").textContent = bad ? `${bad} failed` : `${d.checks.length} checks`;
  $("#checksBtn").classList.toggle("warn", bad > 0);
  if (bad) setTimeout(() => toast(`${bad} constraint check(s) failed`, "err"), 400);
  if (d.model.tiebreak_done === false) setTimeout(() => toast("The tie-break by utility did not finish. The squad is still optimal for expected quality."), last * 1000 + 2500);
}

/** Engine check names read like code ("Squad size == N"); say them in words. */
function humanCheck(n) {
  return n.replace("Squad size == N", "Squad has exactly the chosen size").replace(/ == /g, " equals ").replace(/ >= /g, " at least ").replace(/ <= /g, " at most ")
    .replace("Total cost at most budget", "Total cost within budget").replace("XI quality matches objective", "XI quality matches the objective");
}

function reveal(d) {
  const el = $("#reveal");
  $("#rvNum").textContent = teamOvr(d);
  const nm = splitName(d.formation);
  $("#rvSub").textContent = `${d.formation === "Custom" ? "Custom shape" : nm.shape + (nm.variant ? " " + nm.variant : "")} · ${money(d.kpis["Squad value (€M)"])} · ${d.checks.every(c => c.ok) ? "all checks passed" : "check warnings"}`;
  el.hidden = false;
  sfx.play("slam"); sfx.play("horn"); setTimeout(() => sfx.play("cheer"), 150); setTimeout(() => sfx.play("success"), 450);
  if (RM()) { setTimeout(() => (el.hidden = true), 1600); return; }
  gsap.timeline({ onComplete: () => (el.hidden = true) })
    .fromTo(".rv-card", { scale: .92, opacity: 0 }, { scale: 1, opacity: 1, duration: .35, ease: "power3.out" })
    .fromTo(".rv-num", { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: .45, ease: "power3.out" }, .08)
    .fromTo([".rv-l", ".rv-sub"], { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: .35, stagger: .06 }, .2)
    .to(".rv-card", { opacity: 0, scale: .97, duration: .4 }, 1.9);
}

function renderList() {
  const d = S.result; if (!d) return;
  const bySlot = new Map(d.pitch.map(p => [p.id, p]));
  const rows = S.list === "xi" ? d.pitch.map(p => d.squad.find(s => s.id === p.id)) : S.list === "bench" ? d.squad.filter(s => s.Role !== "Starting XI") : d.squad;
  $("#plist").innerHTML = rows.map(s => {
    const p = bySlot.get(s.id), pos = p ? p.slot : s["Natural positions"].split(",")[0];
    const tags = (s.required ? `<span class="tag req">Required</span>` : "") + (p && p.listed === false ? `<span class="tag oop" title="Not a listed position: rated ${p.slot_base} − 3">−3</span>` : "") +
      (s["Backup for"] ? `<span class="tag bk" title="Designated backup">Cover ${esc(s["Backup for"])}</span>` : "");
    return `<li class="prow" data-id="${s.id}"><span class="pos" style="background:${GROUP_COLOR[GROUP_OF[pos] || s.group]}">${esc(pos)}</span>
      <span style="min-width:0"><span class="nm"><span>${esc(s.Player)}</span>${tags}</span><span class="meta">${esc(s["Natural positions"])} · ${s.Age} · ${esc(s.club)}</span></span>
      <span class="val"><b>${p ? fmt(p.rating, 0) : s.Overall}</b><small>${money(s["Value (€M)"])}${s["Price imputed"] ? "*" : ""}</small></span></li>`;
  }).join("");
  gsap.from("#plist .prow", { x: 10, opacity: 0, duration: D(.25), stagger: .02 });
}
segmented($("#listTabs"), b => { S.list = b.dataset.list; renderList(); });
$("#plist").addEventListener("mouseover", e => { const r = e.target.closest(".prow"); stadium.highlight(r ? +r.dataset.id : null); });
$("#plist").addEventListener("mouseleave", () => stadium.highlight(null));
$("#plist").addEventListener("click", e => { const r = e.target.closest(".prow"); if (r) inspect(+r.dataset.id); });

function inspect(id) {
  const d = S.result; if (!d) return;
  const s = d.squad.find(r => r.id === id); if (!s) return;
  const p = d.pitch.find(q => q.id === id), req = d.required.find(r => r.id === id);
  stadium.select(id);
  $("#insCard").innerHTML = cardHTML(s, { slot: p?.slot });
  attachTilt($("#insCard"));
  const role = p ? `Starts at ${TYPE_NAME[p.slot] ? TYPE_NAME[p.slot].toLowerCase() : p.slot} (${p.slot})` : s["Backup for"] ? "Bench, designated cover" : "Bench";
  const why = p ? (p.listed ? `Listed at ${p.slot}, so the model uses the ${p.slot} rating of ${p.slot_base}.`
                            : `Not listed at ${p.slot}: the model uses the ${p.slot} rating of ${p.slot_base} minus the 3-point out-of-position penalty.`)
                : "Not in the starting XI.";
  $("#insInfo").innerHTML = `<h4>${esc(s.Player)}</h4><div class="sub">${esc(s["Natural positions"])} · ${esc(s.club)}${s.nation ? " · " + esc(s.nation) : ""}</div>
    <div class="ins-sec"><h5>Role in this squad</h5><dl class="ins-dl">
      <dt>Role</dt><dd>${esc(role)}</dd>${p ? `<dt>Slot rating</dt><dd>${fmt(p.rating, 0)}</dd>` : ""}
      ${s["Backup for"] ? `<dt>Covers</dt><dd>${esc(s["Backup for"].split(", ").map(t => TYPE_NAME[t] || t).join(", "))}</dd>` : ""}
      ${req ? `<dt>Required</dt><dd>${req.start ? "Must start" : "Must be in the squad"}</dd>` : ""}</dl></div>
    <div class="ins-sec"><h5>Position ratings</h5>${posMap(s.pos_ratings, p?.slot)}<p class="posmap-note">${esc(why)} White tiles are listed positions.</p></div>
    <div class="ins-sec"><h5>Profile</h5><div class="ins-row">${s.stats?.some(x => x[1] != null) ? radar(s.stats) : ""}<dl class="ins-dl">
      <dt>Overall</dt><dd>${s.Overall}</dd><dt>Potential</dt><dd>${s.Potential}</dd><dt>Age</dt><dd>${s.Age}</dd>
      <dt>Value</dt><dd>${money(s["Value (€M)"])}${s["Price imputed"] ? " (estimated)" : ""}</dd><dt>Utility</dt><dd>${fmt(s.Utility, 3)}</dd></dl></div></div>`;
  openDlg($("#inspect"));
  sfx.play("card");
  gsap.fromTo("#insCard .fc", { rotateY: -70, opacity: 0 }, { rotateY: 0, opacity: 1, duration: D(.5), ease: "power3.out" });
}

/** Reflect a result's parameters (from the builder or the agent) in the builder controls. */
function syncControls(d) {
  const p = d.params; if (!p) return;
  setBudget(p.budget); setRule("size", p.size); setRule("age", p.max_age ?? 45);
  $("#pabs").value = p.p_abs; $("#pabs").dispatchEvent(new Event("input"));
  if (p.formation) { S.custom = null; S.form = p.formation; } else if (p.custom) S.custom = p.custom.map(r => r.slice());
  renderFormation();
  S.picks.clear();
  for (const r of d.required) S.picks.set(r.id, { p: r, role: r.start ? "start" : "squad" });
  for (const x of d.excluded) S.picks.set(x.id, { p: x, role: "excl" });
  renderPicks();
}

// ------------------------------------------------------------------ copy / csv
$("#copyBtn").onclick = async () => {
  const d = S.result; if (!d) return;
  const slot = new Map(d.pitch.map(p => [p.id, p.slot]));
  const t = d.squad.map(s => `${slot.has(s.id) ? slot.get(s.id).padEnd(4) : "SUB "} ${s.Player} (${s.Overall}) ${money(s["Value (€M)"])}`).join("\n");
  try { await navigator.clipboard.writeText(`${d.formation} · budget ${money(d.budget)}\n${t}`); toast("Squad copied", "ok"); } catch { toast("Clipboard not available", "err"); }
};
$("#csvBtn").onclick = () => {
  const d = S.result; if (!d) return;
  const slot = new Map(d.pitch.map(p => [p.id, p]));
  const cols = ["Role", "Position", "Player", "Age", "Natural positions", "Overall", "Potential", "Slot rating", "Listed at position", "Value (€M)", "Price imputed", "Backup for", "club", "required"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = d.squad.map(s => { const p = slot.get(s.id);
    return { ...s, Position: p?.slot || "", "Slot rating": p ? p.rating : "", "Listed at position": p ? (p.listed ? "yes" : "no") : "" }; });
  const csv = [cols.join(","), ...rows.map(s => cols.map(c => q(s[c])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: `squadopt_${d.formation.replace(/\W+/g, "-")}_${d.budget}M.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); sfx.play("success");
};
$("#checksBtn").onclick = () => openDlg($("#checksDlg"));

// ------------------------------------------------------------------ dialogs
function openDlg(dlg) {
  if (dlg.matches(":modal")) return;
  if (dlg.open) dlg.close();
  dlg.showModal(); sfx.play("open");
  // the entrance is a CSS animation: GSAP measures position:fixed elements by moving them to <html> and back,
  // which takes a modal dialog out of the top layer and leaves it open but no longer modal
}
for (const dlg of $$("dialog")) {
  dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
  dlg.addEventListener("close", () => { sfx.play("close"); if (dlg.id === "inspect") stadium.select(null); });
}

// ------------------------------------------------------------------ settings
function initSettings() {
  for (const [id, key] of [["volMaster", "master"], ["volSfx", "sfx"], ["volUi", "ui"], ["volAmb", "amb"]]) {
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
  select($("#qualSeg"), $(`#qualSeg [data-q=${settings.get("quality")}]`));
  segmented($("#qualSeg"), b => { settings.set("quality", b.dataset.q); stadium.setQuality(QUALITY[b.dataset.q]); });
  $("#setAuto").checked = settings.get("autoQuality"); $("#setAuto").onchange = e => settings.set("autoQuality", e.target.checked);
  $("#setLabels").checked = settings.get("labels"); $("#setLabels").onchange = e => { settings.set("labels", e.target.checked); stadium.setLabels(e.target.checked); };
  $("#setMotion").checked = RM(); $("#setMotion").onchange = e => { settings.set("reduceMotion", e.target.checked); stadium.setReducedMotion(e.target.checked); document.body.classList.toggle("reduce-motion", e.target.checked); };
  $("#settingsBtn").onclick = () => openDlg($("#settingsDlg"));
  $("#helpBtn").onclick = () => openDlg($("#helpDlg"));
  const order = ["low", "medium", "high", "ultra"]; let slow = 0;
  setInterval(() => {
    const ms = stadium.frameMs; if (typeof ms !== "number" || !ms) return;
    $("#fpsOut").textContent = `${Math.round(1000 / ms)} frames per second · ${settings.get("quality")} quality`;
    if (!settings.get("autoQuality") || document.hidden || !S.entered) return;
    slow = ms > 34 ? slow + 1 : 0;
    const i = order.indexOf(settings.get("quality"));
    if (slow >= 4 && i > 0) {
      const nq = order[i - 1]; settings.set("quality", nq); stadium.setQuality(QUALITY[nq]); select($("#qualSeg"), $(`#qualSeg [data-q=${nq}]`)); slow = 0;
      baseToast(`Graphics set to ${nq} to keep things smooth`);
    }
  }, 1000);
}

// ------------------------------------------------------------------ views
function moveTabInd() {
  const b = $("#views [aria-selected=true]"), ind = $(".tab-ind"); if (!b) return;
  gsap.to(ind, { x: b.offsetLeft + 10, width: b.offsetWidth - 20, duration: D(.3), ease: "power3.out" });
}
segmented($("#views"), b => setView(b.dataset.view));
function setView(v) {
  if (v === S.view) return;
  S.view = v; select($("#views"), $(`#views [data-view=${v}]`)); moveTabInd();
  sfx.play(v === "pitch" ? "close" : "open");
  for (const name of ["insights", "compare", "model"]) {
    const el = $("#sheet-" + name), on = name === v;
    el.hidden = !on;
    if (on) gsap.fromTo($$(".card, .pipe, .sheet-h", el), { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: D(.35), stagger: .04, ease: "power3.out" });
  }
  document.body.classList.toggle("view-sheet", v !== "pitch");
  if (v !== "pitch") scrollTo({ top: 0 });
}
addEventListener("resize", moveTabInd);

function renderInsights() {
  const d = S.result; if (!d) return;
  $("#sheet-insights").classList.add("has");
  const xi = new Set(d.pitch.map(p => p.id));
  hbars($("#chMoney"), ["GK", "DEF", "MID", "FWD"].map(g => ({ label: g, color: GROUP_COLOR[g],
    a: d.squad.filter(s => s.group === g && xi.has(s.id)).reduce((t, s) => t + s["Value (€M)"], 0),
    b: d.squad.filter(s => s.group === g && !xi.has(s.id)).reduce((t, s) => t + s["Value (€M)"], 0) })));
  const r = d.pitch.map(p => p.rating);
  vbars($("#chSlots"), d.pitch.map(p => ({ label: p.slot, v: p.rating, color: GROUP_COLOR[GROUP_OF[p.slot] || "MID"] })), Math.floor(Math.min(...r) / 5) * 5 - 5, Math.ceil(Math.max(...r) / 5) * 5);
  scatter($("#chScatter"), d.squad.map(s => ({ x: s.Overall, y: s["Value (€M)"], color: s.required ? "#6f9fd8" : xi.has(s.id) ? ACCENT : "#7d828b",
    label: `${s.Player}: ${s.Overall} overall, ${money(s["Value (€M)"])}`, r: xi.has(s.id) ? 5 : 3.5 })), "Overall", "Value €M");
  $("#chScatter").insertAdjacentHTML("beforeend", `<div class="legend"><span><i style="background:${ACCENT}"></i>Starting XI</span><span><i style="background:#7d828b"></i>Bench</span><span><i style="background:#6f9fd8"></i>Required</span></div>`);
  const bd = d.model.backup_detail || Object.entries(d.model.backups).map(([slot, name]) => ({ slot, name, listed: true }));
  $("#chBackups").innerHTML = `<div class="bk-row">${bd.map(b => `<div class="bk"><span>${esc(TYPE_NAME[b.slot] || b.slot)}</span><b>${esc(b.name)}</b>` +
    (b.rating != null ? `<em title="${b.listed ? "Listed at this position" : `Not listed here: ${b.base} minus ${d.model.backup_penalty}`}">${fmt(b.rating, 0)}${b.listed ? "" : ` <i>−${d.model.backup_penalty}</i>`}</em>` : "") + `</div>`).join("")}</div>` +
    `<p class="mnote">${!d.model.distinct_backups ? "One backup may cover several positions." : d.model.backup_cap > 1 ? `With ${d.squad.length - 11} reserves for ${bd.length} positions, each backup covers at most ${d.model.backup_cap}.` : "Each backup covers one position, so two absences never count on the same player."} ` +
    `${d.model.backup_listed_only ? "Backups are listed at the position they cover." : `Out-of-position cover counts ${d.model.backup_penalty} below the player's rating there, as it does for starters.`}</p>`;
  const ages = d.squad.map(s => s.Age);
  histogram($("#chAge"), ages, "#6f9fd8", Math.floor(Math.min(...ages) / 2) * 2, Math.max(...ages) + 2);
}
function renderModelStatic() {
  const a = S.meta.ahp;
  $("#ahpBars").innerHTML = a.criteria.map((c, i) => `<div class="hbar wl"><span>${c}</span><div class="tr"><i style="width:${a.weights[i] * 100}%;background:${ACCENT};transform:scaleX(1)"></i></div><b>${fmt(a.weights[i] * 100, 1)}%</b></div>`).join("") +
    `<p class="muted" style="margin:10px 0 0">Consistency ratio ${a.cr.toFixed(4)}, below the 0.10 limit.</p>`;
  const n = a.criteria.length, f = v => (v >= 1 ? +v.toFixed(2) : "1/" + Math.round(1 / v));
  $("#ahpMatrix").innerHTML = `<div class="matrix" style="grid-template-columns:repeat(${n + 1},1fr)"><div class="h"></div>${a.criteria.map(c => `<div class="h">${c}</div>`).join("")}` +
    a.matrix.map((row, i) => `<div class="h">${a.criteria[i]}</div>` + row.map(v => `<div>${f(v)}</div>`).join("")).join("") + `</div>`;
  renderPipe();
  $("#ilpStats").innerHTML = `<p class="muted" style="margin:0">Build a squad to see the size of the model.</p>`;
  $("#evalStats").innerHTML = `<p class="muted" style="margin:0">Build a squad to see the simulation.</p>`;
}
function renderPipe(m) {
  const st = [["Data", `${S.meta.players.toLocaleString()} players`, "FC 26 CSV"], ["Calibrate", "position ratings, missing prices", "load_players"],
    ["Utility", "overall, potential, versatility", "add_utilities"], ["Prune", m ? `${m.pool_size.toLocaleString()} players kept` : "exact dominance", "dominance_prune"],
    ["Solve", m ? `${m.n_vars.toLocaleString()} variables` : "x, y, z binaries", "optimise · HiGHS"],
    ["Tie-break", "most utility at the optimum", "stage 2"], ["Evaluate", "200 simulated absences", "evaluate_squad"]];
  $("#pipe").innerHTML = st.map(([b, s, e], i) => `<li><em>${i + 1}</em><b>${b}</b><span>${s}</span><span><code>${e}</code></span></li>`).join("");
}
function renderModelRun() {
  const d = S.result, m = d.model, k = d.kpis;
  renderPipe(m);
  $("#ilpStats").innerHTML = `<div class="mgrid">
    <div class="mstat"><b>${m.pool_size.toLocaleString()}</b><span>players after pruning</span></div><div class="mstat"><b>${m.n_vars.toLocaleString()}</b><span>binary variables</span></div>
    <div class="mstat"><b>${m.n_cons.toLocaleString()}</b><span>constraints</span></div><div class="mstat"><b>${m.n_pairs.toLocaleString()}</b><span>player-position options</span></div></div>
    <p class="mnote">${m.statuses.map(([s, t], i) => `Stage ${i + 1} <b${s === "Optimal" ? "" : ' class="warn"'}>${esc(s.toLowerCase())}</b> in ${fmt(t)}s`).join(" · ")}${m.tiebreak_done === false ? `<br><span class="warn">The tie-break did not finish; the squad is the stage 1 optimum for expected quality.</span>` : ""}</p>`;
  $("#evalStats").innerHTML = `<div class="mgrid">
    <div class="mstat"><b>${fmt(m.xi_quality, 0)}</b><span>starting XI quality</span></div><div class="mstat"><b>${fmt(m.depth, 0)}</b><span>backup depth D</span></div>
    <div class="mstat"><b>${fmt(m.eq, 1)}</b><span>objective at p = ${Math.round(m.p_abs * 100)}%</span></div><div class="mstat"><b>${fmt(k[expKey(k)], 1)}</b><span>simulated expected quality</span></div>
    <div class="mstat"><b>${fmt(k["5th-percentile quality"], 1)}</b><span>worst 5% of matches</span></div><div class="mstat"><b>${fmt(m.util, 2)}</b><span>squad utility</span></div></div>`;
}

// ------------------------------------------------------------------ history / compare
function pushHistory(d, source) {
  const k = d.kpis;
  S.history.unshift({ t: Date.now(), source, formation: d.formation, budget: d.budget, spent: k["Squad value (€M)"], xi: k["XI quality"], eq: k[expKey(k)],
    p5: k["5th-percentile quality"], age: k["Mean age"], req: d.required.map(p => p.name), payload: d });
  S.history = S.history.slice(0, 12);
  try { localStorage.setItem("squadopt.history.v3", JSON.stringify(S.history)); } catch { /* storage full or blocked */ }
  renderHistory();
}
function renderHistory() {
  $("#sheet-compare").classList.toggle("has", S.history.length > 0);
  if (!S.history.length) return;
  const best = Math.max(...S.history.map(h => h.xi));
  $("#histRows").innerHTML = S.history.map((h, i) => `<tr><td>${new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
    <td><span class="src ${h.source === "agent" ? "ai" : ""}">${h.source === "agent" ? "Agent" : "Builder"}</span></td><td>${esc(h.formation)}</td>
    <td class="r">${money(h.budget)}</td><td class="r">${money(h.spent)}</td><td class="r" style="${h.xi === best ? `color:${ACCENT};font-weight:700` : ""}">${fmt(h.xi, 0)}</td>
    <td class="r">${fmt(h.eq)}</td><td class="r">${fmt(h.p5)}</td><td class="r">${fmt(h.age)}</td><td>${esc(h.req.join(", ")) || "–"}</td>
    <td><button class="btn-text" data-load="${i}" type="button">Open</button></td></tr>`).join("");
  scatterBudget($("#chCompare"), S.history.map(h => ({ x: h.budget, y: h.xi, color: h.source === "agent" ? "#6f9fd8" : ACCENT, label: `${h.formation} · ${money(h.budget)}: XI ${fmt(h.xi, 0)}` })));
}
function scatterBudget(el, pts) {
  const w = 320, h = 200, pl = 34, pb = 26, pt = 10, pr = 12;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x1 = Math.max(...xs) * 1.1, y0 = Math.floor((Math.min(...ys) - 10) / 10) * 10, y1 = Math.ceil((Math.max(...ys) + 5) / 10) * 10;
  const X = v => pl + (w - pl - pr) * v / x1, Y = v => pt + (h - pt - pb) * (1 - (v - y0) / (y1 - y0));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="XI quality against budget">`;
  for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4; s += `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="0" y="${Y(v) + 3}">${Math.round(v)}</text>`; }
  for (let i = 0; i <= 4; i++) { const v = x1 * i / 4; s += `<text x="${X(v)}" y="${h - 8}" text-anchor="middle">€${Math.round(v)}M</text>`; }
  pts.forEach(p => (s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5.5" fill="${p.color}" stroke="#0f1012"><title>${esc(p.label)}</title></circle>`));
  el.innerHTML = `<div class="chart">${s}</svg></div><div class="legend"><span><i style="background:${ACCENT}"></i>Builder</span><span><i style="background:#6f9fd8"></i>Agent</span></div>`;
}
$("#histRows").onclick = e => { const b = e.target.closest("[data-load]"); if (!b) return; const h = S.history[+b.dataset.load];
  setView("pitch"); showResult(h.payload, h.source, false); };
$("#clearHist").onclick = () => { S.history = []; try { localStorage.removeItem("squadopt.history.v3"); } catch { /* blocked */ } renderHistory(); sfx.play("popDown"); };

// ------------------------------------------------------------------ builder / agent mode
function setMode(agentMode) {
  select($("#modeSeg"), $(`#modeSeg [data-mode=${agentMode ? "agent" : "build"}]`));
  $("#buildPane").hidden = agentMode; $("#agentPane").hidden = !agentMode;
  gsap.from(agentMode ? "#agentPane" : "#buildPane", { opacity: 0, x: agentMode ? 12 : -12, duration: D(.3), ease: "power2.out" });
  if (agentMode) $("#prompt").focus();
}
segmented($("#modeSeg"), b => setMode(b.dataset.mode === "agent"));

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
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && S.view === "pitch" && !$("#buildPane").hidden) stepForm(e.key === "ArrowLeft" ? -1 : 1);
  else if (e.key === "m" || e.key === "M") $("#muteBtn").click();
  else if (e.key === "?") openDlg($("#helpDlg"));
  else if (e.key === "a" || e.key === "A") { sfx.play("tab"); setMode($("#agentPane").hidden); }
});

initSettings();
rulesSummary();
start();
