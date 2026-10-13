// End-to-end test: drives a real headless Chrome/Edge through SquadOpt over the DevTools protocol.
// No npm packages: Node 22+ (built-in WebSocket and fetch).
//
//   node tests/e2e/e2e.mjs                      # server must already run (python app.py), default http://127.0.0.1:5055
//   E2E_BASE=http://127.0.0.1:5000 node tests/e2e/e2e.mjs --agent   # also exercise the Qwen agent (needs Ollama)
//
// Screenshots go to tests/e2e/out/. Exit code 0 = every check passed.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.E2E_BASE || "http://127.0.0.1:5055";
const WITH_AGENT = process.argv.includes("--agent");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const PORT = 9300 + Math.floor(Math.random() * 500);
mkdirSync(OUT, { recursive: true });

const CANDIDATES = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const CHROME = CANDIDATES.find(p => existsSync(p));
if (!CHROME) { console.error("No Chrome/Edge found; set CHROME=/path/to/chrome"); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ browser + CDP
const profile = mkdtempSync(join(tmpdir(), "squadopt-e2e-"));
const proc = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--window-size=1440,900",
  "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
  "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "about:blank"], { stdio: "ignore" });

let ws, seq = 0;
const pending = new Map(), errors = [];
async function connect() {
  for (let i = 0; i < 60; i++) {
    try { const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()); const page = list.find(t => t.type === "page"); if (page) return page.webSocketDebuggerUrl; }
    catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome did not start");
}
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, timeout = 15000, every = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await evaluate(expr)) return true; } catch { /* page navigating */ } await sleep(every); }
  return false;
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name + ".png"), Buffer.from(data, "base64"));
}
async function clickSel(sel) {
  const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:"center"}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  if (!box) throw new Error("not found: " + sel);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}
async function typeInto(sel, text) {
  await evaluate(`document.querySelector(${JSON.stringify(sel)}).focus()`);
  await send("Input.insertText", { text });
}
async function key(k, code = k) { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: k === "Enter" ? 13 : k === "Escape" ? 27 : k.charCodeAt(0) }); }

// ------------------------------------------------------------------ the scenario
async function run() {
  ws = new WebSocket(await connect());
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
  });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log(`SquadOpt end-to-end · ${BASE} · ${CHROME.split(/[\\/]/).pop()}`);
  await send("Page.navigate", { url: BASE });
  const ready = `location.href.startsWith(${JSON.stringify(BASE)}) && document.readyState === "complete" && !!document.querySelector("#start.ready")`;
  check("title screen becomes ready", await waitFor(ready, 30000));
  await evaluate("document.fonts.ready.then(() => true)");
  check("web font loaded", await evaluate(`document.fonts.check("700 20px Archivo")`));
  check("3D stage rendered (WebGL)", await evaluate(`typeof window.stadium?.frameMs === "number" && !document.querySelector("#fallback:not([hidden])")`));
  await sleep(1200); await shot("01-title");
  await key("Enter");
  check("entering shows the app", await waitFor(`!document.body.classList.contains("booting") && !document.querySelector("#start")`, 8000));
  await sleep(2600); await shot("02-builder");

  // formation stepper + browser
  const f0 = await evaluate(`document.querySelector("#formName").textContent`);
  await clickSel("#formNext"); await sleep(300);
  const f1 = await evaluate(`document.querySelector("#formName").textContent + document.querySelector("#formVariant").textContent`);
  check("formation stepper moves", f1 !== f0, `${f0} -> ${f1}`);
  await clickSel("#browseForms");
  check("formation browser opens with 32 shapes", await waitFor(`document.querySelector("#formsDlg").open && document.querySelectorAll("#formGrid .fcard").length === 32`, 3000));
  await sleep(500); check("formation browser is a true modal (above panels)", await evaluate(`document.querySelector("#formsDlg").matches(":modal")`));
  await shot("03-formations");
  await clickSel('#formsTabs [data-ft="custom"]'); await sleep(300);
  check("custom shape editor starts empty and cannot be applied", await evaluate(`document.querySelectorAll("#lines .cx").length === 0 && document.querySelector("#useCustom").disabled && /^0 of 10/.test(document.querySelector("#ccount").textContent) && document.querySelectorAll("#customPreview .fd-dot").length === 1`));
  check("each custom line offers only its own positions", await evaluate(`(() => { const o = i => [...document.querySelectorAll('#lines [data-i="' + i + '"][data-add]')].map(b => b.dataset.add).join(","); return o(0) === "LB,CB,RB,LWB,RWB" && o(1) === "DM,CM,AM,LM,RM" && o(2) === "LW,ST,RW"; })()`));
  const addSlot = (i, t) => evaluate(`document.querySelector('#lines [data-i="${i}"][data-add="${t}"]').click()`);
  for (const [i, t] of [[0, "RB"], [0, "CB"], [0, "CB"], [0, "LB"], [1, "CM"], [1, "CM"], [1, "CM"], [2, "RW"], [2, "ST"]]) await addSlot(i, t);
  check("9 positions: counter and preview follow, apply still blocked", await evaluate(`document.querySelectorAll("#lines .cx").length === 9 && document.querySelectorAll("#customPreview .fd-dot").length === 10 && /9 of 10/.test(document.querySelector("#ccount").textContent) && document.querySelector("#useCustom").disabled`));
  await addSlot(2, "LW");
  check("10 positions: ordered left to right and ready to apply", await evaluate(`[...document.querySelectorAll("#lines .cx")].map(b => b.textContent.trim()).join(",") === "LB,CB,CB,RB,CM,CM,CM,LW,ST,RW" && !document.querySelector("#useCustom").disabled && [...document.querySelectorAll('#lines [data-add]')].every(b => b.disabled)`));
  await evaluate(`document.querySelector("#lines .cx").click()`);
  check("removing a position updates the counter and blocks apply again", await evaluate(`document.querySelectorAll("#lines .cx").length === 9 && document.querySelector("#useCustom").disabled && document.querySelectorAll("#customPreview .fd-dot").length === 10`));
  await addSlot(0, "LB"); await clickSel("#useCustom");
  check("a valid custom shape is applied", await waitFor(`!document.querySelector("#formsDlg").open && document.querySelector("#formName").textContent === "4-3-3" && document.querySelector("#formVariant").textContent === "custom shape"`, 3000));
  await clickSel("#browseForms"); await sleep(300);
  await clickSel('#formsTabs [data-ft="4"]'); await sleep(200);
  await clickSel('#formGrid .fcard[data-f="4-3-3"]');
  check("picking a formation closes the browser", await waitFor(`!document.querySelector("#formsDlg").open && document.querySelector("#formName").textContent === "4-3-3"`, 3000));

  // player search: Messi must start, Ronaldo excluded
  await typeInto("#playerSearch input", "messi");
  check("player search finds Messi", await waitFor(`[...document.querySelectorAll("#playerSearch .r-name")].some(e => e.textContent === "L. Messi")`, 5000));
  await clickSel('#playerSearch li[data-i="0"] button[data-act="start"]');
  check("Messi added as a starter", await waitFor(`document.querySelector("#picks .role")?.textContent === "Starts"`, 3000));
  await typeInto("#playerSearch input", "ronaldo");
  await waitFor(`document.querySelectorAll("#playerSearch li[data-i]").length > 0`, 5000);
  await clickSel('#playerSearch li[data-i="0"] button[data-act="excl"]');
  check("Ronaldo excluded", await waitFor(`[...document.querySelectorAll("#picks .role")].some(b => b.textContent === "Excluded")`, 3000));
  check("picked players show name and details on separate lines", await evaluate(`[...document.querySelectorAll("#picks .pick")].every(li => li.querySelector(".r-meta").getBoundingClientRect().top > li.querySelector(".r-name").getBoundingClientRect().bottom - 2)`));

  // build
  await clickSel("#go");
  check("solver overlay shows while optimising", await waitFor(`!document.querySelector("#solver").hidden`, 3000));
  check("squad built", await waitFor(`!document.querySelector("#go").disabled && !document.querySelector("#results").hidden`, 240000, 500));
  const res = await evaluate(`(() => { const rows = [...document.querySelectorAll("#plist .prow")];
      return { xi: rows.length, names: rows.map(r => r.querySelector(".nm span").textContent), pos: rows.map(r => r.querySelector(".pos").textContent),
               rating: document.querySelector("#teamOvr").textContent, checks: document.querySelector("#checksN").textContent }; })()`);
  check("starting XI lists 11 players", res.xi === 11, `${res.xi}`);
  const mi = res.names.indexOf("L. Messi");
  check("Messi starts on the right wing (listed RW)", mi >= 0 && res.pos[mi] === "RW", mi >= 0 ? res.pos[mi] : "missing");
  check("Ronaldo is not in the squad", !(await evaluate(`[...document.querySelectorAll("#plist .nm span")].some(e => e.textContent === "Cristiano Ronaldo")`)));
  check("all constraint checks passed", /checks$/.test(res.checks), res.checks);
  const sides = await evaluate(`(async () => { const d = await fetch("/api/optimise", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({formation:"4-4-2", budget:250})}).then(r => r.json());
      return d.pitch.map(p => ({ slot: p.slot, pos: p.positions, listed: p.listed, rating: p.rating, base: p.slot_base })); })()`);
  check("API: every flank player stands on a side consistent with the penalty", sides.every(p => p.rating === p.base - (p.listed ? 0 : 3)));
  await sleep(3500); await shot("04-result");

  // player card with position ratings
  await clickSel(`#plist .prow:nth-child(${mi + 1})`);
  check("player card opens with a 13-position ratings map", await waitFor(`document.querySelector("#inspect").open && document.querySelectorAll("#insInfo .posmap div").length === 13`, 3000));
  check("card highlights the slot he plays", await evaluate(`document.querySelector("#insInfo .posmap div.here span")?.textContent === "RW"`));
  await sleep(700); check("player card is a true modal after its animation", await evaluate(`document.querySelector("#inspect").matches(":modal")`));
  await shot("05-player");
  await key("Escape"); await sleep(300);

  // views
  for (const [view, sel, name] of [["insights", "#chSlots svg", "06-insights"], ["compare", "#histRows tr", "07-compare"], ["model", "#ilpStats .mstat", "08-model"]]) {
    await clickSel(`#views [data-view="${view}"]`);
    check(`${view} view renders`, await waitFor(`!document.querySelector("#sheet-${view}").hidden && !!document.querySelector(${JSON.stringify(sel)})`, 4000));
    await sleep(700); await shot(name);
  }
  await clickSel('#views [data-view="pitch"]'); await sleep(400);

  // camera + kit + settings
  for (const cam of ["broadcast", "top", "orbit", "tactical"]) await clickSel(`#camSeg [data-cam="${cam}"]`);
  await clickSel('#kits button[data-i="1"]');
  check("camera and kit controls respond", await evaluate(`document.querySelector('#camSeg [data-cam="tactical"]').getAttribute("aria-selected") === "true" && document.querySelector('#kits [data-i="1"]').getAttribute("aria-pressed") === "true"`));
  await clickSel("#settingsBtn");
  check("settings dialog opens", await waitFor(`document.querySelector("#settingsDlg").open`, 2000));
  await sleep(400); await shot("09-settings");
  await key("Escape"); await sleep(300);

  // agent (optional: needs Ollama)
  if (WITH_AGENT) {
    await clickSel('#modeSeg [data-mode="agent"]');
    await typeInto("#prompt", "I want a team for 350 million euros that plays wing play, and Messi must play");
    await key("Enter");
    check("agent answers and builds a squad", await waitFor(`document.querySelectorAll("#chat .msg.bot").length >= 2 && !document.querySelector("#go").disabled`, 360000, 1000));
    const ag = await evaluate(`({ text: [...document.querySelectorAll("#chat .msg.bot .bubble")].pop().textContent, form: document.querySelector("#resForm").textContent,
                                 messi: [...document.querySelectorAll("#plist .prow")].find(r => r.querySelector(".nm span").textContent === "L. Messi")?.querySelector(".pos").textContent })`);
    check("agent's squad starts Messi on a listed side", ag.messi === "RW", `formation ${ag.form}, Messi at ${ag.messi}`);
    await sleep(3500); await shot("10-agent");
  }

  // phone layout
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.reload"); await sleep(500);
  check("phone: title screen ready", await waitFor(ready, 30000));
  await sleep(800); await shot("11-phone-title");
  await clickSel("#start");
  await waitFor(`!document.querySelector("#start")`, 5000); await sleep(2200);
  check("phone: no horizontal scrolling", await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`));
  await shot("12-phone");

  check("no JavaScript errors", errors.length === 0, errors.slice(0, 3).join(" | "));
}

try { await run(); }
catch (e) { check("scenario completed", false, e.message); }
finally {
  try { ws?.close(); } catch { /* closed */ }
  proc.kill();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${OUT}`);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}
