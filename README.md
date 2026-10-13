# SquadOpt

SquadOpt picks the strongest football squad and starting XI that fit a transfer budget, a formation and your
constraints, using an exact integer-programming model over the FC 26 player database. A 3D stadium shows the
result, and a local **Qwen 3.5 4B** agent lets you ask in plain English:

> "I want a team for €400M that plays counter-attacking football, and Messi must play."

*23MNG336 Operations Research · Team AA01 · Amrita Vishwa Vidyapeetham, Coimbatore*
Rupali K · S Mahadev · Tendool Srivatsav · Sarang U

---

## Features

- **Exact optimiser** (`squad_engine.py`): one integrated ILP selects the squad, the starting XI and a designated
  backup per position, maximising expected XI quality when players can be absent. AHP utility breaks ties. Solved with HiGHS.
- **Correct positions**: left and right are separate positions (LB/RB, LWB/RWB, LM/RM, LW/RW). Every starter is scored
  with the dataset rating for that exact position, minus 3 only if the player is not listed there, and the pitch shows
  each player where the model put them. The player card shows all position ratings so you can see why.
- **Constraints you control**: budget, 32 formations or your own shape, squad size, age limit, absence risk,
  players who **start**, players who must be **in the squad**, and players to **exclude**.
- **Qwen agent** (`agent.py`): turns a request into optimiser inputs (style of play → formation, names → players),
  runs the model and explains the result. It never invents players or numbers: everything comes from the optimiser.
- **3D stadium** (Three.js): night stadium with floodlights, crowd and LED boards; kit-coloured players with shirt
  numbers run out from the tunnel; formation previews; tactical, broadcast, top-down and orbit cameras.
- **Interface**: title screen, formation stepper and browser (with a custom-shape editor), one player search with
  inline *starts / in squad / exclude* actions, squad reveal, FC-style player cards, Insights, Compare (what more
  budget or another shape buys) and a Model view with the real model size and constraint checks.
- **Sound**: every effect (interface, whistle, stadium horn, crowd, solver loop) is synthesised with the Web Audio API.
- **Settings**: sound buses, graphics quality with automatic step-down, labels, reduced motion.

## Quick start

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000. Put the dataset in `data/FC26_20250921.csv` first (see [data/README.md](data/README.md)),
or set `FC26_CSV=path/to/file.csv`. Each optimisation takes roughly 10–60 s.

### The agent (optional)

1. Install [Ollama](https://ollama.com) and pull the model once: `ollama pull qwen3.5:4b`
2. Keep Ollama running and open **Ask the agent**.

Try: *"Young high-pressing side for €250M, nobody older than 24"*, *"Park the bus with €150M, no Cristiano Ronaldo"*,
then follow-ups like *"make it €100M cheaper"* or *"switch to a 3-5-2"*.

| Setting | Default | Meaning |
|---|---|---|
| `FC26_CSV` | `data/FC26_20250921.csv` | Dataset path |
| `PORT` | `5000` | Web server port |
| `SOLVER_TIME_LIMIT` | `120` | Seconds per solver stage |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server |
| `SQUAD_AGENT_MODEL` | `qwen3.5:4b` | Agent model |

## The model

For squad size *N*, budget *B* and absence probability *p*:

- **Variables**: `x_i` (player in squad), `y_it` (player starts at position *t*), `z_it` (designated backup for *t*)
- **Objective**: maximise `EQ = (1 − p)·Q_XI + p·D`, where `Q_XI` is the sum of starters' position ratings and `D`
  sums the backups' ratings weighted by how many slots of that position the formation has. A second stage keeps EQ at
  its optimum and maximises total AHP utility (overall · potential · versatility, CR = 0.003).
- **Constraints**: `Σx = N`, `Σc·x ≤ B`, every formation slot filled exactly, a starter or backup must be in the squad
  and a backup cannot start, line minimums (2 GK, one spare per outfield line), at most 3 GK, optional age limit,
  required (`x_i = 1`) / required-to-start (`Σ_t y_it = 1`) / excluded players.
- **Backups** (website, `distinct_backups=True`): `Σ_t z_it ≤ k·(x_i − Σ_t y_it)` with `k = 1`, so each reserve is
  the designated backup for one position only. `D` is a first-order term: it assumes the backup is free whenever a
  starter at that position is missing. If one reserve covered seven positions, `D` would count them for absences that
  happen at the same time (at p = 0.1, two or more of 10 covered starters are out in about 26% of matches), so the
  objective would overstate depth. Squads with fewer reserves than positions (N = 18 or 19 in a 9-position shape)
  use the smallest feasible cap, `k = ⌈T / (N − 11)⌉`. `distinct_backups=False` reproduces the notebook.
- **Backup eligibility**: a backup needs a rating of at least 65 at that position. Cover at a position the player is
  not listed for is allowed at rating − 3, the same rule as for starters and for the simulated lineups.
  `backup_listed_only=True` restricts backups to listed positions.
- **Solver status**: PuLP reports a HiGHS or CBC time-limit stop that has an incumbent as "Optimal". The engine
  only accepts a stage when the solution status is `LpSolutionOptimal`, and reports anything else as not proven.
  If stage 1 is not proven optimal no squad is returned (HTTP 504, not "infeasible"). If only the stage-2 tie-break
  fails, the stage-1 optimum is kept and flagged.
- **Positions**: ratings are calibrated to `overall`; a position the player is not listed for costs 3 points; starters
  need at least 70. With `sides=True` (the website) each flank is its own position, so a right-back at left-back pays
  the penalty. `sides=False` reproduces the notebook exactly.
- **Prices**: missing values are imputed with a log-price regression (Duan smearing).
- **Exact pruning**: a player is dropped only if ≥ N same-line players are cheaper or equal and at least as good on
  every rating the model uses, so the optimum cannot change.
- **Evaluation**: 200 Monte-Carlo absence scenarios; the best XI is re-picked each time (Hungarian algorithm).

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q                                   # 115 model, API, agent and parity tests (synthetic data, no LLM)
node --test "tests/js/*.test.mjs"           # front-end formation logic
python app.py & node tests/e2e/e2e.mjs      # headless-Chrome walk through the real app (add --agent with Ollama)
```

The Python suite runs on synthetic data (`tests/synthetic.py`, invented names and ratings). It checks that:
- pruning never changes the optimum, and HiGHS and CBC reach the same optimum;
- every solution passes an independent re-computation of all constraints, with consistent objective numbers;
- every starter is scored with that exact position's rating (minus 3 only when unlisted), every one of the 32
  formations labels each slot as the model solved it, and the browser labels slots exactly like the engine;
- required, must-start and excluded players and the age exemption behave as documented, also across random scenarios;
- infeasibility and time-limit cases are reported correctly: a time-limit stop is never labelled optimal, a stage-1
  failure returns no squad, and a stage-2 failure keeps the stage-1 optimum;
- backups follow the policy (one position each, eligible, out-of-position cover at −3), the objective recomputed from
  the raw ratings equals the solver's value, and pinned regression numbers for a fixed scenario stay the same;
- with the real FC26 CSV (`FC26_CSV` or `data/FC26_20250921.csv`), the audited 4-4-2 diamond / €475M / 23 / age-30
  scenario is re-solved (skipped otherwise);
- the API validates input, and the agent loop handles a scripted model (bad budgets, retries, missing Ollama).

The end-to-end test (31 checks, 33 with `--agent`) drives Chrome through the title screen, formations, player search, a build,
the player card, every view, settings, the agent and a phone layout, and fails on any JavaScript error.
GitHub Actions runs all of this on every push.

## Keyboard

`Ctrl+Enter` build · `←` `→` formation · `1`–`4` cameras · `F1`–`F4` views · `A` builder/agent · `M` sound · `?` help

## Project layout

```
app.py              Flask API: /api/meta, /api/optimise, /api/players, /api/agent (NDJSON stream)
squad_engine.py     The optimisation model (from or_final.ipynb, plus marked "website" extensions)
agent.py            Qwen tool-calling agent via Ollama
static/             index.html, css/app.css, js/{main,stadium,formation,audio,agent,card,settings,ui}.js
tests/              pytest suite, synthetic data, js/ unit tests, e2e/ browser test
data/               put the FC 26 CSV here (not committed)
```

Three.js 0.169, GSAP 3.12 and the Archivo font load from public CDNs, so the page needs internet access. The
optimiser and the agent run fully offline.
