// Chat panel for the Qwen squad agent: streams NDJSON events from /api/agent and renders each step
import { $, esc, fmt, toast, REDUCED } from "./ui.js";

const gsap = window.gsap;
const IC = {
  search: `<svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  check: `<svg class="ic" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>`,
  x: `<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  bolt: `<svg class="ic" viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>`,
};
const START = [
  "€400M, counter-attacking football, and Messi must be in the team",
  "Young high-pressing side for €250M, nobody older than 24",
  "Park the bus with €150M, no Cristiano Ronaldo",
  "Wing play for €1 billion with Mbappé and Haaland",
];
const FOLLOW = ["Make it €100M cheaper", "Same budget but younger", "Switch to a 3-5-2", "Add Vini Jr. to the squad"];

/** tiny, safe markdown: escape first, then **bold**, `code`, bullets, paragraphs */
function md(text) {
  const blocks = esc(text).split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split("\n");
    if (lines.every(l => /^\s*([-*•]|\d+\.)\s+/.test(l)))
      return "<ul>" + lines.map(l => "<li>" + l.replace(/^\s*([-*•]|\d+\.)\s+/, "") + "</li>").join("") + "</ul>";
    return "<p>" + lines.join("<br>") + "</p>";
  }).join("").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function createAgent({ onSolving, onSquad, context, busy, sfx = { play() {} } }) {
  const chat = $("#chat"), input = $("#prompt"), sendBtn = $("#send");
  let history = [], ctrl = null, ok = false, hadSquad = false;

  const scroll = () => chat.scrollTo({ top: chat.scrollHeight, behavior: REDUCED ? "auto" : "smooth" });
  function bubble(role, html) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "bot");
    el.innerHTML = `<div class="av">${role === "user" ? "You"[0] : "Q"}</div><div class="bubble">${html}</div>`;
    chat.append(el); gsap.from(el, { y: 10, opacity: 0, duration: REDUCED ? 0 : .3 }); scroll();
    return el;
  }
  function stepsBox() { const el = document.createElement("div"); el.className = "steps"; chat.append(el); return el; }
  function step(box, cls, icon, html) {
    const el = document.createElement("div"); el.className = "step " + cls;
    el.innerHTML = `<span class="si">${cls === "run" ? "" : icon}</span><span>${html}</span>`;
    box.append(el); gsap.from(el, { x: -8, opacity: 0, duration: REDUCED ? 0 : .25 }); scroll();
    return el;
  }
  function finish(el, cls, icon, html) { el.className = "step " + cls; el.querySelector(".si").innerHTML = icon; if (html != null) el.lastElementChild.innerHTML = html; }

  function suggestions() {
    const list = hadSquad ? FOLLOW : START;
    $("#sugg").innerHTML = list.map(s => `<button type="button">${esc(s)}</button>`).join("");
  }
  $("#sugg").onclick = e => { const b = e.target.closest("button"); if (b) { input.value = b.textContent; send(); } };

  async function typeOut(el, text) {
    const html = md(text);
    if (REDUCED || text.length > 1200) { el.innerHTML = html; return; }
    const words = text.split(/(\s+)/); let shown = "";
    for (let i = 0; i < words.length; i++) {
      shown += words[i];
      if (i % 3 === 0) { el.innerHTML = md(shown); scroll(); if (i % 6 === 0) sfx.play("type"); await new Promise(r => setTimeout(r, 14)); }
    }
    el.innerHTML = html; scroll();
  }

  async function send() {
    const text = input.value.trim();
    if (!text || ctrl) return;
    if (busy()) { toast("The optimiser is already running. Wait for it to finish.", "err"); sfx.play("error"); return; }
    if (!ok) await checkStatus();
    input.value = ""; bubble("user", esc(text)); sfx.play("send");
    history.push({ role: "user", content: text });
    $("#sugg").innerHTML = "";
    const box = stepsBox();
    let thinking = step(box, "run", "", `<b>Qwen</b> is reading your request<span class="typing"><i></i><i></i><i></i></span>`);
    let current = null, timer = null, reply = "";
    ctrl = new AbortController(); sendBtn.textContent = "Stop"; sendBtn.classList.remove("primary");
    const stopTimer = () => { clearInterval(timer); timer = null; };
    try {
      const r = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ messages: history, context: context(), think: $("#think").checked }) });
      if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Server error ${r.status}`); }
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      const handle = ev => {
        switch (ev.type) {
          case "status":
            if (thinking) finish(thinking, "run", "", `<b>Qwen</b> ${esc(ev.text.replace(/^Qwen /, ""))}<span class="typing"><i></i><i></i><i></i></span>`);
            else thinking = step(box, "run", "", `<b>Qwen</b> ${esc(ev.text.replace(/^Qwen /, ""))}<span class="typing"><i></i><i></i><i></i></span>`);
            break;
          case "tool":
            if (thinking) { thinking.remove(); thinking = null; }
            sfx.play("step");
            if (ev.name === "search_players") current = step(box, "run", "", `Looking up <b>${esc(ev.args.name || "")}</b>`);
            else if (ev.name === "build_squad") {
              const a = ev.args, chips = [a.budget_m != null && `€${a.budget_m}M`, a.formation, ...(a.must_start || []).map(n => "★ " + n), ...(a.must_include || []).map(n => "+ " + n), ...(a.exclude || []).map(n => "− " + n),
                a.max_age && `age ≤ ${a.max_age}`, a.squad_size && `${a.squad_size} players`, a.absence_risk != null && `p=${a.absence_risk}`].filter(Boolean);
              step(box, "ok", IC.bolt, `Calling <b>build_squad</b> <span class="params">${chips.map(c => `<span>${esc(c)}</span>`).join("")}</span>`);
            }
            break;
          case "searched":
            finish(current, "ok", IC.search, `Found ${ev.players.length ? ev.players.slice(0, 3).map(p => `<span class="pc">${esc(p.name)} · ${p.overall}</span>`).join(" ") : "nobody"} for “${esc(ev.query)}”`);
            break;
          case "resolved": {
            const p = ev.player; sfx.play("pop");
            step(box, "ok", IC.search, `“${esc(ev.query)}” → <span class="pc">${esc(p.name)}</span> ${p.overall} OVR · ${p.age}y · ${esc(p.positions)} · €${fmt(p.value_m)}M <b>${{ must_start: "must start", must_include: "in squad", exclude: "excluded" }[ev.role]}</b>`);
            break;
          }
          case "solving": {
            const p = ev.params;
            const nreq = p.must.length + p.must_start.length;
            current = step(box, "run", "", `Optimising: €${p.budget}M · ${esc(p.formation)}${nreq ? ` · ${nreq} required` : ""}<span class="tm">0.0s</span>`);
            const t0 = performance.now(), tm = current.querySelector(".tm");
            timer = setInterval(() => (tm.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s"), 100);
            sfx.play("engage");
            onSolving(true, `Qwen asked for ${p.formation} at €${p.budget}M${nreq ? ` with ${nreq} required player(s)` : ""}. Solving the ILP…`);
            break;
          }
          case "squad": {
            stopTimer(); onSolving(false);
            const k = ev.data.kpis;
            finish(current, "ok", IC.check, `Squad built: XI quality <b>${fmt(k["XI quality"], 0)}</b> · €${fmt(k["Squad value (€M)"])}M spent<span class="tm">${ev.seconds}s</span>`);
            hadSquad = true; onSquad(ev.data);
            break;
          }
          case "tool_error":
            stopTimer(); onSolving(false); sfx.play("error");
            if (current && current.classList.contains("run")) finish(current, "err", IC.x, esc(ev.text));
            else step(box, "err", IC.x, esc(ev.text));
            break;
          case "message":
            if (thinking) { thinking.remove(); thinking = null; }
            reply = ev.text; sfx.play("receive");
            typeOut(bubble("bot", "").querySelector(".bubble"), ev.text);
            break;
          case "error":
            if (thinking) { thinking.remove(); thinking = null; }
            stopTimer(); onSolving(false); sfx.play("error");
            bubble("bot", `<div class="err-box">${md(ev.text)}</div>`);
            break;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); }
      }
    } catch (e) {
      if (thinking) thinking.remove();
      stopTimer(); onSolving(false);
      if (e.name !== "AbortError") bubble("bot", `<div class="err-box">${esc(e.message)}</div>`);
      else step(box, "err", IC.x, "Stopped. The optimiser may still finish in the background.");
    } finally {
      if (reply) history.push({ role: "assistant", content: reply });
      else history.pop();                                 // keep the conversation well-formed (user/assistant alternating)
      ctrl = null; sendBtn.textContent = "Send"; sendBtn.classList.add("primary");
      suggestions();
    }
  }

  async function checkStatus() {
    const pill = $("#aiPill");
    try {
      const s = await fetch("/api/agent/status").then(r => r.json());
      ok = s.ok;
      pill.classList.toggle("ok", s.ok); pill.classList.toggle("bad", !s.ok);
      $("span", pill).textContent = s.ok ? s.model : "Qwen offline";
      pill.dataset.tip = s.ok ? `Agent model ${s.model} via Ollama` : s.error;
      if (!s.ok && !$("#chat .err-box.status")) bubble("bot", `<div class="err-box status">${md(s.error)}</div>`);
    } catch { ok = false; pill.classList.add("bad"); $("span", pill).textContent = "Qwen offline"; }
    return ok;
  }

  $("#composer").addEventListener("submit", e => { e.preventDefault(); if (ctrl) ctrl.abort(); else send(); });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!ctrl) send(); } });
  $("#newChat").onclick = () => { if (ctrl) ctrl.abort(); history = []; hadSquad = false; [...chat.children].slice(1).forEach(n => n.remove()); suggestions(); };
  suggestions();
  return { checkStatus };
}
