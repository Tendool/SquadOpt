// 3D stadium (Three.js r169): pitch, bowl, crowd, floodlights + light beams, LED boards, bloom, players, formation ghosts
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const L = 105, W = 68, CROWD_MAX = 14000;
const gsap = window.gsap;
let REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dur = s => (REDUCED ? 0 : s);

/** Same geometry as squad_engine.lineup_layout: rows back->front, x across the row (0-100), y up the pitch (8-88). */
export function layout(rows) {
  const out = [], nR = rows.length;
  rows.forEach((row, r) => {
    const y = 8 + r * (80 / Math.max(nR - 1, 1));
    row.forEach((t, j) => out.push({ type: t, x: (j + 1) * 100 / (row.length + 1), y, j, n: row.length }));
  });
  return out;
}
const SIDE = { FB: ["LB", "RB"], WB: ["LWB", "RWB"], WM: ["LM", "RM"], W: ["LW", "RW"] };
export const slotName = (t, j) => (SIDE[t] ? SIDE[t][j === 0 ? 0 : 1] : t);
const toWorld = (x, y) => new THREE.Vector3(-46 + y * 0.78, 0, (x - 50) * 0.64);

const CAMS = {
  tactical: { pos: [-96, 74, 0], tgt: [-3, 0, 0] },
  broadcast: { pos: [-9, 70, 82], tgt: [-9, 0, 4] },          // presets sit inside the rim (see _cameraOk)
  top: { pos: [-9, 122, 1], tgt: [-9, 0, 0] },
  intro: { pos: [150, 120, 170], tgt: [0, 0, 0] },
};
// traditional shirt numbers per slot, first free one wins
const NUMBERS = { GK: [1], RB: [2], RWB: [2], LB: [3], LWB: [3], CB: [4, 5, 15], DM: [6, 16], CM: [8, 14, 18], AM: [10, 20], RM: [7], RW: [7], LM: [11], LW: [11], ST: [9, 19] };

// ------------------------------------------------------------------ textures
function pitchTexture(renderer) {
  const s = 20, c = document.createElement("canvas"); c.width = L * s; c.height = W * s;
  const g = c.getContext("2d");
  for (let i = 0; i < 18; i++) { g.fillStyle = i % 2 ? "#1b8a4b" : "#1f9653"; g.fillRect(i * c.width / 18, 0, c.width / 18 + 1, c.height); }
  for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? "rgba(0,0,0,.035)" : "rgba(255,255,255,.025)"; g.fillRect(0, i * c.height / 12, c.width, c.height / 12 + 1); }
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - .5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.strokeStyle = "rgba(255,255,255,.92)"; g.lineWidth = 3.2; g.fillStyle = "#fff";
  const P = (x, y) => [(x + L / 2) * s, (y + W / 2) * s];
  const rect = (x0, y0, x1, y1) => { const [a, b] = P(x0, y0), [e, f] = P(x1, y1); g.strokeRect(a, b, e - a, f - b); };
  const arc = (x, y, r, a0 = 0, a1 = Math.PI * 2) => { const [a, b] = P(x, y); g.beginPath(); g.arc(a, b, r * s, a0, a1); g.stroke(); };
  const spot = (x, y) => { const [a, b] = P(x, y); g.beginPath(); g.arc(a, b, 5, 0, 7); g.fill(); };
  rect(-L / 2 + .1, -W / 2 + .1, L / 2 - .1, W / 2 - .1);
  g.beginPath(); g.moveTo(...P(0, -W / 2)); g.lineTo(...P(0, W / 2)); g.stroke();
  arc(0, 0, 9.15); spot(0, 0);
  for (const sgn of [-1, 1]) {
    const gx = sgn * L / 2;
    rect(Math.min(gx, gx - sgn * 16.5), -20.16, Math.max(gx, gx - sgn * 16.5), 20.16);
    rect(Math.min(gx, gx - sgn * 5.5), -9.16, Math.max(gx, gx - sgn * 5.5), 9.16);
    spot(gx - sgn * 11, 0);
    const a = Math.acos(5.5 / 9.15);
    sgn < 0 ? arc(gx + 11, 0, 9.15, -a, a) : arc(gx - 11, 0, 9.15, Math.PI - a, Math.PI + a);
    for (const sy of [-1, 1]) arc(gx, sy * W / 2, 1, 0, Math.PI * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function ledTexture() {
  const c = document.createElement("canvas"); c.width = 2048; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#0b0d10"; g.fillRect(0, 0, c.width, c.height);
  const words = ["SQUADOPT", "AHP", "INTEGER PROGRAMMING", "FC 26", "HiGHS", "EXPECTED QUALITY", "OPERATIONS RESEARCH", "QWEN AGENT"];
  g.font = "800 italic 40px 'Barlow Condensed', sans-serif"; g.textBaseline = "middle";
  let x = 20, k = 0;
  while (x < c.width) { const w = words[k % words.length]; g.fillStyle = k % 2 ? "#e7e9ec" : "#d4772e"; g.fillText(w, x, 34); x += g.measureText(w).width + 46; g.fillStyle = "#ffffff55"; g.fillText("•", x - 30, 34); k++; }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
  return t;
}
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(.2, "rgba(220,235,255,.6)"); r.addColorStop(1, "rgba(200,220,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function seatTexture() {
  const c = document.createElement("canvas"); c.width = 16; c.height = 256;
  const g = c.getContext("2d");
  for (let i = 0; i < 32; i++) { g.fillStyle = i % 2 ? "#1a1e24" : "#20252c"; g.fillRect(0, i * 8, 16, 8); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(60, 1);
  return t;
}
const NUM_TEX = new Map();
function numberTexture(n) {
  if (NUM_TEX.has(n)) return NUM_TEX.get(n);
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "800 92px 'Barlow Condensed', sans-serif"; g.fillText(String(n), 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; NUM_TEX.set(n, t);
  return t;
}
const BEAM_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
// clamp + multiply, not pow(): interpolated uv can dip below 0, pow() of a negative is NaN and bloom smears NaN into black holes
const BEAM_FS = `uniform vec3 color; uniform float opacity; varying vec2 vUv; void main(){ float a = clamp(vUv.y, 0.0, 1.0); gl_FragColor = vec4(color, opacity * a * a); }`;

// ------------------------------------------------------------------ the stadium
export class Stadium {
  constructor(canvas, labelsEl, { quality, kit } = {}) {
    this.canvas = canvas;
    this.players = []; this.bench = []; this.ghosts = []; this.hits = [];
    this.onHover = () => {}; this.onSelect = () => {};
    this.solving = false; this.clock = new THREE.Clock(); this.frameMs = 16;

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.labels = new CSS2DRenderer({ element: labelsEl });
    const sc = this.scene = new THREE.Scene();
    sc.background = new THREE.Color("#0b0d10");
    sc.fog = new THREE.FogExp2("#0b0d10", 0.0040);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 900);
    this.camera.position.set(...CAMS.intro.pos);
    const c = this.controls = new OrbitControls(this.camera, canvas);
    c.enableDamping = true; c.dampingFactor = 0.07; c.enablePan = false;
    c.minDistance = 35; c.maxDistance = 240; c.maxPolarAngle = 1.42; c.autoRotateSpeed = 0.5;
    c.target.set(...CAMS.intro.tgt);
    c.addEventListener("start", () => {
      if (this.view !== "orbit") c.autoRotate = false;
      if (this.view === "intro") this.view = "free";
      gsap.killTweensOf(this.camera.position); gsap.killTweensOf(c.target); this._camTween = false;
    });

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(sc, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), .32, .4, .88);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.kitMats = {
      shirt: new THREE.MeshStandardMaterial({ roughness: .5, metalness: .05 }), shorts: new THREE.MeshStandardMaterial({ roughness: .7 }),
      socks: new THREE.MeshStandardMaterial({ roughness: .8 }), num: new THREE.Color("#141a2a"),
    };
    this.gkMats = {
      shirt: new THREE.MeshStandardMaterial({ color: "#c9a23a", roughness: .5 }), shorts: new THREE.MeshStandardMaterial({ color: "#141821", roughness: .7 }),
      socks: new THREE.MeshStandardMaterial({ color: "#c9a23a", roughness: .8 }), num: new THREE.Color("#141821"),
    };
    this.matSkin = new THREE.MeshStandardMaterial({ color: "#c9cfdb", roughness: .55 });
    this.matBoot = new THREE.MeshStandardMaterial({ color: "#0b0e14", roughness: .4, metalness: .3 });
    this.geo = {
      torso: new THREE.CapsuleGeometry(.55, .85, 6, 16), shorts: new THREE.CylinderGeometry(.6, .56, .55, 18),
      thigh: new THREE.CylinderGeometry(.21, .17, .7, 10), sock: new THREE.CylinderGeometry(.17, .14, .5, 10), boot: new THREE.BoxGeometry(.42, .16, .24),
      arm: new THREE.CapsuleGeometry(.14, .7, 4, 8), head: new THREE.SphereGeometry(.4, 20, 16), num: new THREE.PlaneGeometry(.78, .78),
      ring: new THREE.RingGeometry(.95, 1.2, 48), disc: new THREE.CircleGeometry(.95, 40), sel: new THREE.RingGeometry(1.5, 1.75, 64),
    };
    this.setKit(kit || { shirt: "#eef1f7", shorts: "#141a2a", socks: "#eef1f7", num: "#141a2a" }, true);

    this._lights(); this._pitch(); this._bowl(); this._goals(); this._boards(); this._ball(); this._scan(); this._selector();

    this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2(); this.hover = null; this.down = null;
    canvas.addEventListener("pointermove", e => this._pointer(e));
    canvas.addEventListener("pointerleave", () => this._setHover(null));
    canvas.addEventListener("pointerdown", e => (this.down = [e.clientX, e.clientY]));
    canvas.addEventListener("pointerup", e => {
      if (this.down && Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 6 && this.hover) this.select(this.hover.userData.data.id, true);
      this.down = null;
    });
    addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.clock.getDelta(); });
    this.setQuality(quality);
    this.renderer.setAnimationLoop(() => this._tick());
  }

  // -------------------------------------------------------------- build
  _lights() {
    const sc = this.scene;
    sc.add(new THREE.HemisphereLight("#c9d2dc", "#0b1a10", 0.8));
    const d = this.sun = new THREE.DirectionalLight("#ffffff", 2.4);
    d.position.set(-30, 90, 45);
    Object.assign(d.shadow.camera, { left: -70, right: 70, top: 50, bottom: -50, near: 10, far: 220 });
    d.shadow.bias = -0.0005; d.shadow.radius = 4;
    sc.add(d);
    const d2 = new THREE.DirectionalLight("#d0d8e0", 0.7); d2.position.set(60, 70, -50); sc.add(d2);
    const glow = glowTexture(), poleM = new THREE.MeshStandardMaterial({ color: "#2a2f36", roughness: .6, metalness: .4 });
    const headM = new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#fff4e0", emissiveIntensity: 1.8 });
    this.flood = []; this.beams = [];
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const g = new THREE.Group(); g.position.set(sx * 84, 0, sz * 62);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.6, 1, 46, 10), poleM); pole.position.y = 23; g.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(9, 4.5, .8), headM); head.position.y = 47; head.lookAt(-sx * 84, -47, -sz * 62); g.add(head);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: "#fff1d6", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      sp.scale.set(14, 14, 1); sp.position.y = 47; g.add(sp); this.flood.push(sp);
      this.scene.add(g);
      // volumetric-looking light beam from the mast head to the pitch
      const top = new THREE.Vector3(sx * 84, 47, sz * 62), bot = new THREE.Vector3(sx * 22, 0, sz * 12), len = top.distanceTo(bot);
      const beam = new THREE.Mesh(new THREE.ConeGeometry(16, len, 40, 1, true), new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color("#fff1d6") }, opacity: { value: .06 } }, vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      beam.position.copy(top).add(bot).multiplyScalar(.5);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), bot.clone().sub(top).normalize());
      sc.add(beam); this.beams.push(beam);
    }
  }

  _pitch() {
    const sc = this.scene;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(150, 110), new THREE.MeshStandardMaterial({ color: "#145f36", roughness: 1 }));
    apron.rotation.x = -Math.PI / 2; apron.position.y = -.02; apron.receiveShadow = true; sc.add(apron);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(420, 64), new THREE.MeshStandardMaterial({ color: "#0d0f12", roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -.05; sc.add(ground);
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshStandardMaterial({ map: pitchTexture(this.renderer), roughness: .92 }));
    pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true; sc.add(pitch);
  }

  _bowl() {
    const sc = this.scene, k = 0.74;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(118, 74, 34, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: seatTexture(), color: "#8a9099", roughness: 1, side: THREE.DoubleSide }));
    bowl.scale.z = k; bowl.position.y = 17; sc.add(bowl);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(74, 74, 2.2, 96, 1, true), new THREE.MeshStandardMaterial({ color: "#15181d", side: THREE.DoubleSide }));
    wall.scale.z = k; wall.position.y = 1.1; sc.add(wall);
    const facade = new THREE.Mesh(new THREE.CylinderGeometry(118.5, 118.5, 34, 96, 1, true), new THREE.MeshStandardMaterial({ color: "#14171b", roughness: .9 }));
    facade.scale.z = k; facade.position.y = 17; sc.add(facade);
    const pts = []; for (let i = 0; i <= 160; i++) { const a = i / 160 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * 119, 34.5, Math.sin(a) * 119 * k)); }
    this.roof = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: "#4a525c", transparent: true, opacity: .5, fog: false }));
    sc.add(this.roof);
    const n = CROWD_MAX, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const pal = ["#d4772e", "#e7e9ec", "#5b8fbf", "#a8262b", "#c9a23a", "#6b7480", "#4a525c", "#2f353d"].map(h => new THREE.Color(h));
    this.crowdBase = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, t = .06 + Math.random() * .9, rr = 74 + t * 44;
      pos.set([Math.cos(a) * (rr - .6), 0.6 + t * 34, Math.sin(a) * (rr - .6) * k], i * 3);
      const c = pal[Math.random() < .55 ? 6 + (Math.random() < .5 ? 1 : 0) : Math.floor(Math.random() * 6)];
      col.set([c.r, c.g, c.b], i * 3);
    }
    this.crowdBase.set(col);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.crowd = new THREE.Points(g, new THREE.PointsMaterial({ size: .9, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: .9 }));
    sc.add(this.crowd);
  }

  _goals() {
    const m = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: .3 });
    const net = new THREE.MeshBasicMaterial({ color: "#ffffff", wireframe: true, transparent: true, opacity: .18 });
    for (const sgn of [-1, 1]) {
      const g = new THREE.Group(), x = sgn * L / 2;
      for (const z of [-3.66, 3.66]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 2.44, 8), m); p.position.set(x, 1.22, z); p.castShadow = true; g.add(p); }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 7.32, 8), m); bar.rotation.x = Math.PI / 2; bar.position.set(x, 2.44, 0); g.add(bar);
      const n = new THREE.Mesh(new THREE.BoxGeometry(2, 2.44, 7.32, 4, 4, 10), net); n.position.set(x + sgn * 1, 1.22, 0); g.add(n);
      this.scene.add(g);
    }
  }

  _boards() {
    const base = ledTexture(); this._leds = [];
    const mk = (len, rep) => { const t = base.clone(); t.needsUpdate = true; t.repeat.set(rep, 1); this._leds.push(t);
      return new THREE.Mesh(new THREE.PlaneGeometry(len, 1), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, toneMapped: false })); };
    for (const sz of [-1, 1]) { const b = mk(L + 6, 4); b.position.set(0, .5, sz * (W / 2 + 4)); if (sz > 0) b.rotation.y = Math.PI; this.scene.add(b); }
    for (const sx of [-1, 1]) { const b = mk(W - 10, 2.6); b.position.set(sx * (L / 2 + 4), .5, 0); b.rotation.y = sx * -Math.PI / 2; this.scene.add(b); }
  }

  _ball() {
    const c = document.createElement("canvas"); c.width = 128; c.height = 64; const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 128, 64); g.fillStyle = "#111";
    for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(10 + i * 19, i % 2 ? 18 : 46, 7, 0, 7); g.fill(); }
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(.42, 24, 18), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: .4 }));
    this.ball.position.set(0, .42, 0); this.ball.castShadow = true; this.scene.add(this.ball);
  }

  _scan() {
    this.scanRings = [0, 1, 2].map(i => {
      const m = new THREE.Mesh(new THREE.RingGeometry(.96, 1, 96), new THREE.MeshBasicMaterial({ color: "#d4772e", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.y = .06; m.userData.phase = i / 3; this.scene.add(m); return m;
    });
  }

  _selector() {
    this.sel = new THREE.Mesh(this.geo.sel, new THREE.MeshBasicMaterial({ color: "#e7e9ec", transparent: true, opacity: 0, depthWrite: false }));
    this.sel.rotation.x = -Math.PI / 2; this.sel.position.y = .07; this.scene.add(this.sel);
    this.selected = null;
  }

  // -------------------------------------------------------------- public API
  setQuality(q) {
    this.q = q;
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    if (r.shadowMap.enabled !== q.shadows) { r.shadowMap.enabled = q.shadows; this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); }
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowMap) { this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
    this.crowd.geometry.setDrawRange(0, q.crowd);
    for (const b of this.beams) b.visible = q.cones;
    this.resize();
  }
  setReducedMotion(on) { REDUCED = on; }
  setLabels(on) { this.labels.domElement.style.display = on ? "" : "none"; }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false); this.labels.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.fov = w / h < 1 ? 58 : 42;
    this._applyShift();
  }

  /** Shift the rendered image sideways by a fraction of the screen width (keeps the stadium beside the start column). */
  setFrameShift(frac, duration = 0) {
    this._shiftObj ??= { v: 0 };
    gsap.to(this._shiftObj, { v: frac, duration: dur(duration), ease: "power3.inOut", onUpdate: () => this._applyShift() });
    if (!duration || REDUCED) { this._shiftObj.v = frac; this._applyShift(); }
  }
  _applyShift() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight, f = this._shiftObj?.v || 0;
    if (f) this.camera.setViewOffset(w, h, -w * f / 2, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  setView(name, instant = false) {
    this.view = name;
    const c = this.controls;
    c.autoRotate = name === "orbit" || name === "intro";
    if (name === "orbit") return;
    const v = CAMS[name], d = instant ? 0 : dur(name === "tactical" && this._fromIntro ? 2.6 : 1.6);
    this._fromIntro = false;
    this._camTween = d > 0;
    gsap.to(this.camera.position, { x: v.pos[0], y: v.pos[1], z: v.pos[2], duration: d, ease: "power3.inOut", onComplete: () => (this._camTween = false),
      onInterrupt: () => (this._camTween = false) });
    gsap.to(c.target, { x: v.tgt[0], y: v.tgt[1], z: v.tgt[2], duration: d, ease: "power3.inOut" });
  }
  intro() { this.view = "intro"; this._fromIntro = true; this.controls.autoRotate = true; this.controls.autoRotateSpeed = .35; }

  setKit(k, instant = false) {
    this.kitDef = k;
    const m = this.kitMats;
    for (const [part, hex] of [["shirt", k.shirt], ["shorts", k.shorts], ["socks", k.socks]]) {
      const c = new THREE.Color(hex);
      instant ? m[part].color.copy(c) : gsap.to(m[part].color, { r: c.r, g: c.g, b: c.b, duration: dur(.5) });
    }
    m.num.set(k.num);
    for (const p of [...this.players, ...this.bench]) if (!p.userData.gk) p.userData.numMat.color.copy(m.num);
  }

  /** Ghost markers for a formation preview (rows of slot types). Morphs from the previous shape. */
  setFormation(rows) {
    const slots = layout(rows);
    while (this.ghosts.length < slots.length) this.ghosts.push(this._ghost());
    this.ghosts.forEach((gh, i) => {
      const s = slots[i];
      if (!s) { gh.visible = false; return; }
      gh.visible = true;
      const p = toWorld(s.x, s.y);
      gsap.to(gh.position, { x: p.x, z: p.z, duration: dur(.8), ease: "power3.inOut", delay: REDUCED ? 0 : i * .025 });
      gsap.to(gh.scale, { x: 1, y: 1, z: 1, duration: dur(.4) });
      gh.userData.label.element.textContent = slotName(s.type, s.j);
      gh.userData.disc.material.color.set(s.type === "GK" ? "#c9a23a" : "#ffffff");
    });
    this.ghostsVisible(this.players.length === 0);
  }

  ghostsVisible(on) {
    for (const g of this.ghosts) {
      gsap.to(g.userData.disc.material, { opacity: on ? .22 : 0, duration: dur(.4) });
      gsap.to(g.userData.ring.material, { opacity: on ? .7 : 0, duration: dur(.4) });
      g.userData.label.element.style.opacity = on ? 1 : 0;
    }
  }

  setSolving(on) {
    this.solving = on;
    if (on) { this.ghostsVisible(true); this._fadeOutPlayers(); this.select(null); if (this.view !== "orbit") this.controls.autoRotate = true; }
    else if (this.view !== "orbit") { this.controls.autoRotate = false; this.setView(this.view || "tactical"); }   // swing back for the reveal
  }

  /** pitch: [{id,x,y,slot,name,rating,...}] (server layout), bench: squad rows not in the XI. Calls onLand(i) per landing. */
  showSquad(pitch, bench, requiredIds = [], { onLand = () => {}, onDone = () => {} } = {}) {
    this._fadeOutPlayers(); this.select(null);
    this.ghostsVisible(false);
    const req = new Set(requiredIds), used = new Set();
    const shirtNo = slot => { const n = (NUMBERS[slot] || []).find(x => !used.has(x)) ?? [...Array(99).keys()].slice(12).find(x => !used.has(x)); used.add(n); return n; };
    const tunnel = new THREE.Vector3(0, 0, W / 2 + 3);
    let last = 0;
    pitch.forEach((p, i) => {
      const gk = p.slot === "GK";
      const pl = this._player({ ...p, gk, req: req.has(p.id) }, false, shirtNo(p.slot));
      const target = toWorld(p.x, p.y);
      pl.position.copy(tunnel); pl.scale.setScalar(.01);
      pl.rotation.y = Math.atan2(-(target.z - tunnel.z), target.x - tunnel.x);
      const d = REDUCED ? 0 : .35 + i * .11, run = dur(1.25);
      last = Math.max(last, d + run);
      gsap.to(pl.scale, { x: 1.5, y: 1.5, z: 1.5, duration: dur(.45), delay: d, ease: "back.out(2)" });
      gsap.to(pl.userData, { run: 1, duration: .2, delay: d });
      gsap.to(pl.position, { x: target.x, z: target.z, duration: run, delay: d, ease: "power2.inOut",
        onComplete: () => { pl.userData.run = 0; onLand(i, p); gsap.to(pl.rotation, { y: 0, duration: dur(.5) });
          gsap.fromTo(pl.userData.ring.scale, { x: 2.2, y: 2.2 }, { x: 1, y: 1, duration: dur(.5), ease: "power3.out" }); } });
      this.players.push(pl);
    });
    const nb = bench.length;
    bench.forEach((b, i) => {
      const pl = this._player({ ...b, gk: b.group === "GK", req: req.has(b.id) }, true, shirtNo("BENCH"));
      const x = (i - (nb - 1) / 2) * 2.6, z = W / 2 + 6.5;
      pl.position.set(x, 0, z + 6); pl.scale.setScalar(.01); pl.rotation.y = -Math.PI / 2;
      const d = REDUCED ? 0 : last * .6 + i * .05;
      gsap.to(pl.scale, { x: 1.05, y: 1.05, z: 1.05, duration: dur(.4), delay: d, ease: "back.out(2)" });
      gsap.to(pl.position, { z, duration: dur(.6), delay: d, ease: "power2.out" });
      this.bench.push(pl);
    });
    if (!REDUCED) gsap.fromTo(this.ball.position, { y: 6 }, { y: .42, duration: 1.2, ease: "bounce.out", delay: .2 });
    setTimeout(onDone, (last + .3) * 1000);
    return last;
  }

  highlight(id) {
    for (const p of [...this.players, ...this.bench]) {
      const on = id != null && p.userData.data.id === id, el = p.userData.label.element;
      el.classList.toggle("dim", id != null && !on);
      if (p.userData.isBench) el.classList.toggle("show", on || this.selected === p.userData.data.id);
      gsap.to(p.userData.ring.scale, { x: on ? 1.5 : 1, y: on ? 1.5 : 1, duration: dur(.25) });
      p.userData.ring.material.opacity = on ? 1 : .75;
    }
  }

  select(id, fromScene = false) {
    this.selected = id;
    const pl = [...this.players, ...this.bench].find(p => p.userData.data.id === id);
    gsap.to(this.sel.material, { opacity: pl ? .95 : 0, duration: dur(.25) });
    if (pl) { this.sel.position.x = pl.position.x; this.sel.position.z = pl.position.z; this.sel.scale.setScalar(pl.userData.isBench ? .7 : 1.5); }
    if (fromScene && pl) this.onSelect(pl.userData.data);
  }

  // -------------------------------------------------------------- internals
  _ghost() {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(this.geo.disc, new THREE.MeshBasicMaterial({ color: "#fff", transparent: true, opacity: .22, depthWrite: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.45, 48), new THREE.MeshBasicMaterial({ color: "#9aa2ab", transparent: true, opacity: .7, depthWrite: false }));
    for (const m of [disc, ring]) { m.rotation.x = -Math.PI / 2; m.position.y = .05; g.add(m); }
    disc.scale.setScalar(1.4);
    const el = document.createElement("div"); el.className = "slotlabel";
    const lab = new CSS2DObject(el); g.add(lab);
    g.userData = { disc, ring, label: lab };
    g.scale.setScalar(.01);
    this.scene.add(g);
    return g;
  }

  _player(p, isBench, number) {
    const M = p.gk ? this.gkMats : this.kitMats, g = new THREE.Group(), meshes = [];
    const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); meshes.push(m); return m; };
    const body = new THREE.Group(); g.add(body);
    add(this.geo.torso, M.shirt, 0, 2.05, 0, body);
    add(this.geo.shorts, M.shorts, 0, 1.28, 0, body);
    add(this.geo.head, this.matSkin, 0, 3.2, 0, body);
    const legs = [-.27, .27].map(z => {
      const hip = new THREE.Group(); hip.position.set(0, 1.1, z); body.add(hip);
      add(this.geo.thigh, this.matSkin, 0, -.35, 0, hip); add(this.geo.sock, M.socks, 0, -.8, 0, hip); add(this.geo.boot, this.matBoot, .08, -1.06, 0, hip);
      return hip;
    });
    const arms = [-.72, .72].map(z => { const sh = new THREE.Group(); sh.position.set(0, 2.6, z); body.add(sh); add(this.geo.arm, M.shirt, 0, -.45, 0, sh); sh.rotation.x = z < 0 ? .12 : -.12; return sh; });
    const numMat = new THREE.MeshBasicMaterial({ map: numberTexture(number), color: M.num, transparent: true, depthWrite: false });
    const num = new THREE.Mesh(this.geo.num, numMat); num.position.set(-.57, 2.12, 0); num.rotation.y = -Math.PI / 2; body.add(num);
    const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: p.req ? "#5b8fbf" : p.gk ? "#c9a23a" : "#d4772e", transparent: true, opacity: .75, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .04; g.add(ring);
    const el = document.createElement("div");
    el.className = "plabel" + (p.gk ? " gk" : "") + (p.req ? " req" : "") + (isBench ? " bench" : "");
    const rating = p.rating ?? p.Overall ?? p.overall;
    el.innerHTML = `<span class="top"><span class="rt">${Math.round(rating)}</span><span class="sl"></span></span><span class="nm"></span>`;
    el.querySelector(".nm").textContent = p.name ?? p.Player;
    el.querySelector(".sl").textContent = isBench ? `#${number}` : p.slot;
    const lab = new CSS2DObject(el); lab.position.y = 5.0; g.add(lab);
    g.userData = { data: p, ring, body, legs, arms, label: lab, isBench, gk: p.gk, numMat, phase: Math.random() * 6, run: 0, number };
    for (const m of meshes) { m.userData.owner = g; this.hits.push(m); }
    this.scene.add(g);
    return g;
  }

  _fadeOutPlayers() {
    const old = [...this.players, ...this.bench];
    this.players = []; this.bench = [];
    const oldSet = new Set(old);
    this.hits = this.hits.filter(m => !oldSet.has(m.userData.owner));
    old.forEach((pl, i) => {
      pl.userData.label.element.style.opacity = 0;
      gsap.to(pl.scale, { x: .01, y: .01, z: .01, duration: dur(.35), delay: REDUCED ? 0 : i * .012, ease: "back.in(2)",
        onComplete: () => {                      // CSS2D elements of children are not removed with the parent: do it here
          this.scene.remove(pl); pl.userData.ring.material.dispose(); pl.userData.numMat.dispose();
          pl.traverse(o => { if (o.isCSS2DObject) o.element.remove(); });
        } });
    });
  }

  /** The bowl is an elliptical cone (r 74 -> 118, height 34, z squashed by 0.74). A low orbit at a long distance puts the
   *  camera outside or inside the stands, where the dark outer wall fills the view. Pull the camera towards the target
   *  until it is inside the rim and above the seats. Skipped for the intro flyover and scripted camera moves. */
  _cameraOk(p) {
    const rho = Math.hypot(p.x / 118, p.z / (118 * .74));
    return rho <= .627 || (rho <= .98 && p.y >= 34 * (rho - .627) / .373 + 4);
  }
  _keepInsideStadium() {
    const cam = this.camera.position, tgt = this.controls.target;
    if (this.view === "intro" || this._camTween || this._cameraOk(cam)) return;
    const off = cam.clone().sub(tgt), p = cam.clone();
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) { const s = (lo + hi) / 2; p.copy(tgt).addScaledVector(off, s); this._cameraOk(p) ? (lo = s) : (hi = s); }
    cam.copy(tgt).addScaledVector(off, lo);
  }

  _pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const hit = this.ray.intersectObjects(this.hits, false)[0];
    this._setHover(hit ? hit.object.userData.owner : null, e.clientX, e.clientY);
  }
  _setHover(owner, x, y) {
    if (owner !== this.hover) {
      this.hover = owner;
      this.highlight(owner ? owner.userData.data.id : null);
      this.canvas.style.cursor = owner ? "pointer" : "";
      this.onHoverChange?.(owner ? owner.userData.data : null);
    }
    this.onHover(owner ? owner.userData.data : null, x, y);
  }

  _tick() {
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), .05), t = this.clock.elapsedTime;
    this.frameMs = this.frameMs * .95 + dt * 1000 * .05;
    this.controls.update();
    this._keepInsideStadium();
    for (const p of [...this.players, ...this.bench]) {
      const u = p.userData, sw = Math.sin(t * 13 + u.phase) * .75 * u.run;
      u.body.position.y = Math.sin(t * 2.2 + u.phase) * .04 + Math.abs(Math.sin(t * 13 + u.phase)) * .25 * u.run;
      u.legs[0].rotation.z = sw; u.legs[1].rotation.z = -sw;
      u.arms[0].rotation.z = -sw * .8; u.arms[1].rotation.z = sw * .8;
      if (!u.isBench) u.ring.rotation.z += dt * .6;
    }
    if (this.selected != null) this.sel.rotation.z -= dt * 1.2;
    for (const tx of this._leds) tx.offset.x = (tx.offset.x + dt * .035) % 1;
    for (const s of this.flood) s.material.opacity = .85 + Math.sin(t * 1.3 + s.id) * .08;
    this.roof.material.opacity = .4 + Math.sin(t * .8) * .15;
    for (const m of this.scanRings) {
      const k = (t * .45 + m.userData.phase) % 1;
      m.scale.setScalar(4 + k * 60);
      m.material.opacity = this.solving ? (1 - k) * .55 : Math.max(0, m.material.opacity - dt);
    }
    if (this.solving) {
      for (const g of this.ghosts) if (g.visible) g.userData.ring.material.opacity = .45 + Math.sin(t * 6 + g.position.x) * .35;
      this.ball.position.y = .42 + Math.abs(Math.sin(t * 4)) * 1.6; this.ball.rotation.z -= dt * 6;
    }
    const col = this.crowd.geometry.attributes.color, base = this.crowdBase, n = this.q.crowd;
    for (let i = 0; i < 160; i++) {
      const k = (Math.random() * n) | 0, f = Math.random() < .5 ? 1.35 : 1;
      col.array[k * 3] = Math.min(1, base[k * 3] * f); col.array[k * 3 + 1] = Math.min(1, base[k * 3 + 1] * f); col.array[k * 3 + 2] = Math.min(1, base[k * 3 + 2] * f);
    }
    col.needsUpdate = true;
    if (this.q.bloom) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
