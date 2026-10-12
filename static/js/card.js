// FC-style player card, stat radar and position-ratings pitch
import { esc, fmt } from "./ui.js";

export const tier = (ovr, required) => (required ? "icon" : ovr >= 85 ? "elite" : ovr >= 75 ? "gold" : ovr >= 65 ? "silver" : "bronze");

export function radar(stats, size = 160) {
  const vals = stats.map(([, v]) => (v == null ? 0 : v / 99)), n = vals.length, c = size / 2, R = size / 2 - 22;
  const pt = (i, r) => [c + Math.sin(i / n * Math.PI * 2) * r, c - Math.cos(i / n * Math.PI * 2) * r];
  const ring = k => stats.map((_, i) => pt(i, R * k).join(",")).join(" ");
  let s = `<svg class="radar" viewBox="0 0 ${size} ${size}" role="img" aria-label="Attribute radar">`;
  for (const k of [.25, .5, .75, 1]) s += `<polygon points="${ring(k)}" class="rg"/>`;
  stats.forEach(([lab, v], i) => { const [x, y] = pt(i, R + 12); s += `<text x="${x}" y="${y + 3}" text-anchor="middle">${esc(lab)} ${v ?? ""}</text>`; });
  s += `<polygon class="rv" points="${vals.map((v, i) => pt(i, R * v).join(",")).join(" ")}"/>`;
  return s + "</svg>";
}

/** Every position's rating on a mini pitch. pr: [[label, rating, listed], ...]; here: the slot the player fills. */
export function posMap(pr, here) {
  if (!pr?.length) return "";
  return `<div class="posmap${pr.length === 1 ? " gk" : ""}">` + pr.map(([t, r, listed]) =>
    `<div style="grid-area:${t}" class="${listed ? "listed" : ""}${t === here ? " here" : ""}" title="${t}: ${r}${listed ? " (listed)" : ""}"><b>${r}</b><span>${t}</span></div>`).join("") + "</div>";
}

/** p: squad row or player card. ctx: {slot} */
export function cardHTML(p, ctx = {}) {
  const name = p.Player ?? p.name, ovr = p.Overall ?? p.overall, pos = ctx.slot || String(p["Natural positions"] ?? p.positions ?? "").split(",")[0];
  const stats = p.stats || [];
  return `<div class="fc ${tier(ovr, p.required)}">
    <div class="fc-shine"></div>
    <div class="fc-top"><div class="fc-ovr">${ovr}</div><div class="fc-pos">${esc(pos)}</div>
      <div class="fc-meta">${esc(p.nation || "")}<br>${esc(p.club || "")}</div></div>
    <div class="fc-face" aria-hidden="true"><svg viewBox="0 0 80 80"><circle cx="40" cy="27" r="15"/><path d="M11 80c2-18 14-29 29-29s27 11 29 29z"/></svg></div>
    <div class="fc-name">${esc(name)}</div>
    <div class="fc-stats">${stats.map(([l, v]) => `<div><b>${v ?? "–"}</b><span>${esc(l)}</span></div>`).join("")}</div>
    <div class="fc-foot"><span>€${fmt(p["Value (€M)"] ?? p.value_m)}M${(p["Price imputed"] ?? p.price_imputed) ? "*" : ""}</span><span>${p.Age ?? p.age} yrs</span><span>${esc(p.foot || "")}</span></div>
  </div>`;
}

export function attachTilt(el) {
  const card = el.querySelector(".fc"); if (!card) return;
  el.addEventListener("pointermove", e => {
    const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    card.style.transform = `rotateY(${x * 8}deg) rotateX(${-y * 8}deg)`;
  });
  el.addEventListener("pointerleave", () => (card.style.transform = ""));
}
