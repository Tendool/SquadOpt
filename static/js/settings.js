// Persistent user settings (audio, graphics, motion). Stored per browser; safe if storage is blocked.
const KEY = "squadopt.settings.v2";
export const QUALITY = {
  low: { pixelRatio: 1, shadows: false, shadowMap: 512, bloom: false, crowd: 3500, cones: false },
  medium: { pixelRatio: 1.25, shadows: true, shadowMap: 1024, bloom: true, crowd: 7000, cones: true },
  high: { pixelRatio: 1.75, shadows: true, shadowMap: 2048, bloom: true, crowd: 10000, cones: true },
  ultra: { pixelRatio: 2, shadows: true, shadowMap: 4096, bloom: true, crowd: 14000, cones: true },
};
const DEFAULTS = {
  muted: false, master: .8, ui: .7, sfx: .9, amb: .35,
  quality: "high", labels: true, reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, autoQuality: true,
  kit: 0,
};

let state = { ...DEFAULTS };
try { state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* storage blocked */ }
const subs = new Set();

export const settings = {
  get: k => state[k],
  all: () => ({ ...state }),
  set(k, v) {
    if (state[k] === v) return;
    state[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked */ }
    subs.forEach(f => f(k, v));
  },
  on(f) { subs.add(f); return () => subs.delete(f); },
};
