// Procedural sound engine (Web Audio API). Every effect is synthesised at runtime: no audio files to download or license.
// Buses: ui (clicks, hovers), sfx (impacts, horn, whistle, solver loop), amb (crowd bed). All -> master -> limiter.

const st = {
  ctx: null, master: null, bus: {}, verb: null, noise: null, pink: null,
  vol: { master: .8, ui: .7, sfx: .9, amb: .35 }, muted: false,
  amb: null, solve: null, last: {},
};
const now = () => st.ctx.currentTime;
const rnd = (a, b) => a + Math.random() * (b - a);

function build() {
  const ctx = st.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -10; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = .003; lim.release.value = .2;
  st.master = ctx.createGain(); st.master.connect(lim); lim.connect(ctx.destination);
  for (const b of ["ui", "sfx", "amb"]) { st.bus[b] = ctx.createGain(); st.bus[b].connect(st.master); }
  // stadium reverb (generated impulse response)
  st.verb = ctx.createConvolver();
  const len = ctx.sampleRate * 2.6, ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
  st.verb.buffer = ir;
  const vg = ctx.createGain(); vg.gain.value = .32; st.verb.connect(vg); vg.connect(st.bus.sfx);
  // noise buffers
  const n = ctx.sampleRate * 2;
  st.noise = ctx.createBuffer(1, n, ctx.sampleRate); const w = st.noise.getChannelData(0);
  for (let i = 0; i < n; i++) w[i] = Math.random() * 2 - 1;
  st.pink = ctx.createBuffer(1, n, ctx.sampleRate); const p = st.pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.random() * 2 - 1;
    b0 = .99886 * b0 + x * .0555179; b1 = .99332 * b1 + x * .0750759; b2 = .969 * b2 + x * .153852;
    b3 = .8665 * b3 + x * .3104856; b4 = .55 * b4 + x * .5329522; b5 = -.7616 * b5 - x * .016898;
    p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * .5362) * .11; b6 = x * .115926;
  }
  applyVolumes();
}

function applyVolumes() {
  if (!st.ctx) return;
  const t = now();
  st.master.gain.setTargetAtTime(st.muted ? 0 : st.vol.master, t, .05);
  for (const b of ["ui", "sfx", "amb"]) st.bus[b].gain.setTargetAtTime(st.vol[b], t, .05);
}

// ------------------------------------------------------------------ primitives
function out(bus, pan = 0, verb = 0) {
  const g = st.ctx.createGain(), p = st.ctx.createStereoPanner();
  p.pan.value = pan; g.connect(p); p.connect(st.bus[bus]);
  if (verb) { const s = st.ctx.createGain(); s.gain.value = verb; g.connect(s); s.connect(st.verb); }
  return g;
}
function env(g, t, a, peak, d, hold = 0) {
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + a + hold); g.gain.exponentialRampToValueAtTime(.0001, t + a + hold + d);
  return t + a + hold + d;
}
function tone({ type = "sine", f0, f1 = f0, dur = .1, gain = .2, bus = "ui", t = now(), a = .004, pan = 0, verb = 0, lp, detune = 0, curve = "exp" }) {
  const o = st.ctx.createOscillator(), g = out(bus, pan, verb);
  o.type = type; o.detune.value = detune; o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) curve === "exp" ? o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur) : o.frequency.linearRampToValueAtTime(f1, t + dur);
  let node = o;
  if (lp) { const f = st.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; o.connect(f); node = f; }
  const amp = st.ctx.createGain(); node.connect(amp); amp.connect(g);
  const end = env(amp, t, a, gain, dur);
  o.start(t); o.stop(end + .05);
  return o;
}
function noise({ type = "bandpass", f0 = 1000, f1 = f0, q = 1, dur = .2, gain = .2, bus = "sfx", t = now(), a = .005, pan = 0, verb = 0, pink = false, hold = 0 }) {
  const s = st.ctx.createBufferSource(), f = st.ctx.createBiquadFilter(), g = out(bus, pan, verb), amp = st.ctx.createGain();
  s.buffer = pink ? st.pink : st.noise; s.loop = true; s.loopStart = Math.random();
  f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + a + hold + dur);
  s.connect(f); f.connect(amp); amp.connect(g);
  const end = env(amp, t, a, gain, dur, hold);
  s.start(t, Math.random()); s.stop(end + .05);
  return s;
}
const throttle = (key, ms) => { const t = performance.now(); if (t - (st.last[key] || 0) < ms) return true; st.last[key] = t; return false; };

// ------------------------------------------------------------------ the sound bank
const SOUNDS = {
  hover() { if (throttle("hover", 45)) return; tone({ f0: 2700, f1: 2300, dur: .035, gain: .045 }); },
  click() { noise({ type: "highpass", f0: 2500, dur: .025, gain: .16, bus: "ui" }); tone({ type: "triangle", f0: 1150, f1: 640, dur: .06, gain: .16 }); },
  tab() { const t = now(); tone({ type: "square", f0: 660, dur: .05, gain: .05, lp: 2400, t }); tone({ type: "square", f0: 990, dur: .07, gain: .05, lp: 2400, t: t + .045 }); },
  toggleOn() { tone({ type: "triangle", f0: 700, f1: 1100, dur: .08, gain: .12 }); },
  toggleOff() { tone({ type: "triangle", f0: 1100, f1: 650, dur: .08, gain: .12 }); },
  tick(v = .5) { if (throttle("tick", 28)) return; tone({ f0: 1500 + v * 1300, dur: .018, gain: .05, a: .001 }); },
  select() {
    const t = now();
    noise({ type: "bandpass", f0: 500, f1: 3200, q: 1.4, dur: .16, gain: .1, bus: "ui", t });
    tone({ f0: 1318, dur: .28, gain: .07, t: t + .05 }); tone({ f0: 1976, dur: .32, gain: .045, t: t + .08 });
  },
  pop() { tone({ f0: 380, f1: 980, dur: .09, gain: .18, a: .002 }); },
  popDown() { tone({ f0: 900, f1: 320, dur: .1, gain: .16, a: .002 }); },
  whoosh() { noise({ type: "bandpass", f0: 300, f1: 2600, q: .9, dur: .32, gain: .2, bus: "ui", a: .06, pan: -.4 }); },
  whooshDown() { noise({ type: "bandpass", f0: 2400, f1: 280, q: .9, dur: .3, gain: .16, bus: "ui", a: .04, pan: .4 }); },
  camera() {
    const t = now();
    noise({ type: "lowpass", f0: 220, f1: 1400, q: .7, dur: .55, gain: .22, a: .12, t, pink: true });
    tone({ f0: 70, f1: 46, dur: .5, gain: .18, bus: "sfx", t, a: .08 });
  },
  kit() { const t = now(); [1568, 2093, 2637].forEach((f, i) => tone({ f0: f, dur: .18, gain: .05, t: t + i * .045 })); noise({ type: "highpass", f0: 5000, dur: .2, gain: .04, bus: "ui", t }); },
  engage() {                                         // "build squad" pressed
    const t = now();
    for (const [f, d] of [[110, 0], [110.6, 7], [220, -5]]) {
      const o = st.ctx.createOscillator(), fl = st.ctx.createBiquadFilter(), g = out("sfx", 0, .2), a = st.ctx.createGain();
      o.type = "sawtooth"; o.frequency.value = f; o.detune.value = d; fl.type = "lowpass"; fl.Q.value = 6;
      fl.frequency.setValueAtTime(200, t); fl.frequency.exponentialRampToValueAtTime(4200, t + .55);
      o.connect(fl); fl.connect(a); a.connect(g); env(a, t, .02, .07, .6, .25); o.start(t); o.stop(t + 1);
    }
    SOUNDS.impact(.5, t + .55);
  },
  impact(k = 1, t = now()) {
    tone({ f0: 95, f1: 32, dur: .9 * k + .2, gain: .7 * k, bus: "sfx", t, a: .003, verb: .3 });
    noise({ type: "lowpass", f0: 1600, f1: 200, dur: .45 * k, gain: .32 * k, t, a: .002, verb: .4 });
  },
  thud(i = 0) {
    const t = now(), f = rnd(140, 175) * (1 + (i % 3) * .04);
    tone({ f0: f, f1: 52, dur: .18, gain: .3, bus: "sfx", t, a: .002, pan: rnd(-.5, .5) });
    noise({ type: "lowpass", f0: 900, dur: .06, gain: .12, t, pan: rnd(-.5, .5) });
  },
  horn() {                                           // stadium air horn chord
    const t = now();
    for (const f of [233.1, 293.7, 349.2, 466.2]) {
      const o = st.ctx.createOscillator(), fl = st.ctx.createBiquadFilter(), a = st.ctx.createGain(), g = out("sfx", rnd(-.3, .3), .45), lfo = st.ctx.createOscillator(), lg = st.ctx.createGain();
      o.type = "sawtooth"; o.frequency.value = f; lfo.frequency.value = 5.5; lg.gain.value = 3; lfo.connect(lg); lg.connect(o.frequency);
      fl.type = "lowpass"; fl.frequency.value = 1900; o.connect(fl); fl.connect(a); a.connect(g);
      env(a, t, .06, .055, .5, .75); o.start(t); lfo.start(t); o.stop(t + 1.5); lfo.stop(t + 1.5);
    }
  },
  cheer(len = 3.2) {                                 // crowd roar swell
    const t = now();
    noise({ type: "bandpass", f0: 650, f1: 950, q: .6, dur: len * .6, hold: len * .25, a: .5, gain: .5, t, pink: true, verb: .35 });
    noise({ type: "bandpass", f0: 1900, f1: 2600, q: 1.2, dur: len * .5, hold: len * .2, a: .7, gain: .16, t: t + .2, pink: true, verb: .4 });
    for (let i = 0; i < 6; i++) noise({ type: "bandpass", f0: rnd(2500, 4200), q: 6, dur: .25, gain: .05, t: t + .4 + Math.random() * len * .6, pan: rnd(-.8, .8) }); // whistles in the crowd
  },
  whistle() {                                        // referee whistle (kick-off)
    const t = now();
    const blast = (t0, d) => {
      const o = st.ctx.createOscillator(), lfo = st.ctx.createOscillator(), lg = st.ctx.createGain(), a = st.ctx.createGain(), g = out("sfx", 0, .5);
      o.frequency.value = 2950; lfo.frequency.value = 28; lg.gain.value = 140; lfo.connect(lg); lg.connect(o.frequency);
      o.connect(a); a.connect(g); env(a, t0, .015, .1, .08, d); o.start(t0); lfo.start(t0); o.stop(t0 + d + .2); lfo.stop(t0 + d + .2);
      noise({ type: "bandpass", f0: 3000, q: 3, dur: .08, hold: d, gain: .05, t: t0, a: .015 });
    };
    blast(t, .12); blast(t + .2, .65);
  },
  slam() {
    SOUNDS.impact(1.1);
    const t = now();
    for (const [f, g] of [[880, .09], [1318, .05], [2217, .03]]) tone({ f0: f, dur: 1.4, gain: g, bus: "sfx", t: t + .02, verb: .5 });
  },
  success() { const t = now(); [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone({ type: "triangle", f0: f, dur: .35, gain: .12, bus: "sfx", t: t + i * .075, verb: .25 })); },
  error() { const t = now(); tone({ type: "square", f0: 220, dur: .13, gain: .07, lp: 1200, bus: "sfx", t }); tone({ type: "square", f0: 164.8, dur: .22, gain: .07, lp: 1200, bus: "sfx", t: t + .13 }); },
  notify() { const t = now(); tone({ f0: 1046.5, dur: .14, gain: .07, t }); tone({ f0: 1568, dur: .2, gain: .05, t: t + .07 }); },
  send() { noise({ type: "bandpass", f0: 800, f1: 4000, q: 1.5, dur: .18, gain: .1, bus: "ui", a: .02 }); tone({ f0: 900, f1: 1500, dur: .1, gain: .07 }); },
  receive() { const t = now(); tone({ f0: 620, f1: 1240, dur: .08, gain: .12, t, a: .002 }); tone({ f0: 830, f1: 1660, dur: .1, gain: .09, t: t + .08, a: .002 }); },
  type() { if (throttle("type", 38)) return; noise({ type: "highpass", f0: 3500, dur: .012, gain: .03, bus: "ui", a: .001 }); },
  step() { tone({ type: "triangle", f0: 880, f1: 1320, dur: .07, gain: .07 }); },
  open() { SOUNDS.whoosh(); const t = now(); tone({ f0: 1760, dur: .25, gain: .04, t: t + .12 }); },
  close() { SOUNDS.whooshDown(); },
  card() {
    const t = now();
    noise({ type: "bandpass", f0: 1200, f1: 5000, q: 2, dur: .22, gain: .1, bus: "ui", t });
    [1568, 1976, 2349, 3136].forEach((f, i) => tone({ f0: f, dur: .4, gain: .04, bus: "sfx", t: t + .08 + i * .05, verb: .4 }));
  },
};

// ------------------------------------------------------------------ loops
function startAmbience() {
  if (!st.ctx || st.amb) return;
  const ctx = st.ctx, t = now();
  const src = ctx.createBufferSource(); src.buffer = st.pink; src.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 650; bp.Q.value = .5;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
  const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.55, t + 2.5);
  const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = .07; lg.gain.value = .12; lfo.connect(lg); lg.connect(g.gain);
  src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(st.bus.amb); src.start(); lfo.start();
  const swell = () => {                              // random crowd swells and murmurs
    if (!st.amb) return;
    const tt = now(), k = rnd(.15, .35);
    g.gain.cancelScheduledValues(tt); g.gain.setTargetAtTime(.55 + k, tt, .8); g.gain.setTargetAtTime(.55, tt + rnd(1.5, 3), 1.2);
    st.amb.timer = setTimeout(swell, rnd(6000, 13000));
  };
  st.amb = { src, g, lfo, timer: setTimeout(swell, 5000) };
}
function stopAmbience() {
  if (!st.amb) return;
  const { src, g, lfo, timer } = st.amb; clearTimeout(timer); st.amb = null;
  g.gain.cancelScheduledValues(now()); g.gain.setTargetAtTime(0, now(), .4);
  setTimeout(() => { src.stop(); lfo.stop(); }, 1500);
}

function startSolving() {                            // tension loop while the ILP solves
  if (!st.ctx || st.solve) return;
  const ctx = st.ctx, t0 = now();
  const pad = [55, 55.4, 82.4].map(f => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; return o; });
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(220, t0); lp.frequency.linearRampToValueAtTime(900, t0 + 40); lp.Q.value = 4;
  const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.07, t0 + 1.2);
  pad.forEach(o => { o.connect(lp); o.start(); }); lp.connect(g); g.connect(st.bus.sfx);
  let beat = 0;
  const step = () => {
    const t = now();
    if (beat % 2 === 0) tone({ f0: 140, f1: 44, dur: .26, gain: .32, bus: "sfx", t, a: .002 });
    noise({ type: "highpass", f0: 7500, dur: .03, gain: beat % 2 ? .05 : .03, t, pan: beat % 4 < 2 ? -.3 : .3 });
    if (beat % 8 === 6) tone({ type: "triangle", f0: 1760, f1: 1660, dur: .12, gain: .03, t });
    beat++;
  };
  step();
  st.solve = { pad, g, timer: setInterval(step, 375) };
}
function stopSolving() {
  if (!st.solve) return;
  const { pad, g, timer } = st.solve; clearInterval(timer); st.solve = null;
  g.gain.cancelScheduledValues(now()); g.gain.setTargetAtTime(0, now(), .15);
  setTimeout(() => pad.forEach(o => o.stop()), 800);
}

// ------------------------------------------------------------------ public API
export const sfx = {
  /** Must be called from a user gesture (browsers block audio until then). */
  unlock() { if (!st.ctx) build(); if (st.ctx.state !== "running") st.ctx.resume(); },
  ready: () => !!st.ctx && st.ctx.state === "running",
  play(name, ...args) { if (!st.ctx || st.muted || st.ctx.state !== "running") return; try { SOUNDS[name]?.(...args); } catch (e) { console.warn("sfx", name, e); } },
  setVolume(bus, v) { st.vol[bus] = v; applyVolumes(); },
  setMuted(m) { st.muted = m; applyVolumes(); },
  get muted() { return st.muted; },
  startAmbience, stopAmbience, startSolving, stopSolving,
  names: Object.keys(SOUNDS),
};
