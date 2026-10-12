# SquadOpt

**Name the budget. An integer program finds the eleven.**

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
- **Constraints you control**: budget, 32 formations or your own shape, squad size, age limit, absence probability,
  players who **must start**, players who must be **in the squad**, and players to **exclude**.
- **Qwen agent** (`agent.py`): turns a request into optimiser inputs (strategy → formation, names → players),
  runs the model and explains the result. It never invents players or numbers: everything comes from the optimiser.
- **3D stadium** (Three.js): bloom-lit night stadium, floodlight beams, animated crowd, LED boards, kit-coloured
  players with shirt numbers who run out from the tunnel, formation previews, four camera views.
- **Game-style interface**: start screen, squad reveal, FC-style player cards with stat radars, Insights, scenario
  Compare (budget/formation sensitivity), and a Model view with the real model size and constraint checks.
- **Procedural sound design**: every sound (UI ticks, whooshes, referee whistle, stadium horn, crowd roar, solver
  tension loop, impacts) is synthesised live with the Web Audio API. No audio files. Separate volume buses and mute.
- **Settings**: graphics quality (Low → Ultra) with automatic step-down if the frame rate drops, labels, reduced motion.
- **Verified**: a pytest suite checks the model's optimality and every constraint on each push (see below).

## Quick start

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000. Put the dataset in `data/FC26_20250921.csv` first (see [data/README.md](data/README.md)),
or set `FC26_CSV=path/to/file.csv`. Each optimisation takes roughly 10–60 s.

### The agent (optional)

1. Install [Ollama](https://ollama.com) and pull the model once: `ollama pull qwen3.5:4b`
2. Keep Ollama running and open the **Agent** tab.

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

- **Variables**: `x_i` (player in squad), `y_it` (player starts in slot type *t*), `z_it` (designated backup for *t*)
- **Objective**: maximise `EQ = (1 − p)·Q_XI + p·D`, where `Q_XI` is the sum of starters' slot ratings and `D` sums
  the backups' ratings weighted by how many slots of that type the formation has. A second stage keeps EQ at its
  optimum and maximises total AHP utility (overall · potential · versatility, CR = 0.003).
- **Constraints**: `Σx = N`, `Σc·x ≤ B`, every formation slot filled exactly, a starter or backup must be in the squad
  and a backup cannot start, group minimums (2 GK, one spare per outfield line), at most 3 GK, optional age limit,
  required (`x_i = 1`) / required-to-start (`Σ_t y_it = 1`) / excluded players.
- **Position ratings** are calibrated to `overall`, with a 3-point penalty for unlisted positions and a 70 floor
  for starters. Missing prices are imputed with a log-price regression (Duan smearing).
- **Exact pruning**: a player is dropped only if ≥ N same-group players are cheaper or equal and at least as good on
  every rating the model uses, so the optimum can never change.
- **Evaluation**: 200 Monte-Carlo absence scenarios; the best XI is re-picked each time (Hungarian algorithm).

### Verification

```bash
pip install -r requirements-dev.txt
pytest -q
```

The suite runs on synthetic data (`tests/synthetic.py`, invented names and ratings) and needs no LLM. It checks that:
- pruning never changes the optimum (pruned vs. full model, including the tie-break);
- HiGHS and CBC reach the same optimum;
- every solution passes an independent re-computation of all constraints, with consistent objective numbers;
- required, must-start and excluded players and the age exemption behave as documented;
- infeasibility and time-limit cases are reported correctly;
- the API validates input, and the agent loop handles a scripted model (bad budgets, retries, missing Ollama).

## Keyboard

`Ctrl+Enter` build · `1`–`4` cameras · `F1`–`F4` views · `A` builder/agent · `M` mute · `?` help · `Esc` close

## Project layout

```
app.py              Flask API: /api/meta, /api/optimise, /api/players, /api/agent (NDJSON stream)
squad_engine.py     The optimisation model (from or_final.ipynb, plus marked "website" extensions)
agent.py            Qwen tool-calling agent via Ollama
static/             index.html, css/app.css, js/{main,stadium,audio,agent,card,settings,ui}.js
tests/              pytest suite + synthetic data generator
data/               put the FC 26 CSV here (not committed)
```

Three.js 0.169, GSAP 3.12 and the fonts load from public CDNs, so the page needs internet access. The optimiser
and the agent run fully offline.
