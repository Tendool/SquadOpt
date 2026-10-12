"""Flask backend: loads the FC26 CSV once, serves the 3D page, runs the notebook's optimiser and the Qwen squad agent."""
import os, json, threading, unicodedata, numpy as np
from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context
import squad_engine as se
import agent as ag

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.environ.get("FC26_CSV") or next((p for p in (os.path.join(HERE, "data", "FC26_20250921.csv"), os.path.join(HERE, "FC26_20250921.csv")) if os.path.exists(p)), None)
if CSV is None:
    raise SystemExit("Put FC26_20250921.csv in the data/ folder (or set FC26_CSV=path).")
print("Loading", CSV, "...")
DF = se.add_utilities(se.load_players(CSV, rating_mode="calibrated", value_policy="impute")); DF.attrs["tag"] = "base"
print(f"Ready: {len(DF):,} players")
# ---- extra formations (the engine accepts any 11-slot shape; these are added to the notebook's 13 presets) ----
BACK = {3: ["CB"] * 3, 4: ["FB", "CB", "CB", "FB"], 5: ["WB", "CB", "CB", "CB", "WB"]}
EXTRA = {
 "3-4-1-2": (3, [["WB","CM","CM","WB"], ["AM"], ["ST","ST"]]), "3-1-4-2": (3, [["DM"], ["WM","CM","CM","WM"], ["ST","ST"]]),
 "3-4-3 (wide)": (3, [["WM","CM","CM","WM"], ["W","ST","W"]]), "3-5-2 (wing-backs)": (3, [["WB","CM","CM","CM","WB"], ["ST","ST"]]),
 "3-5-1-1": (3, [["WM","CM","DM","CM","WM"], ["AM"], ["ST"]]), "3-2-4-1": (3, [["DM","DM"], ["WM","AM","AM","WM"], ["ST"]]),
 "4-4-1-1": (4, [["WM","CM","CM","WM"], ["AM"], ["ST"]]), "4-5-1": (4, [["WM","CM","CM","CM","WM"], ["ST"]]),
 "4-1-2-3": (4, [["DM"], ["CM","CM"], ["W","ST","W"]]), "4-2-1-3": (4, [["DM","DM"], ["AM"], ["W","ST","W"]]),
 "4-2-4": (4, [["CM","CM"], ["W","ST","ST","W"]]), "4-3-1-2": (4, [["CM","CM","CM"], ["AM"], ["ST","ST"]]),
 "4-4-2 (wingers)": (4, [["W","CM","CM","W"], ["ST","ST"]]), "4-1-3-2": (4, [["DM"], ["WM","CM","WM"], ["ST","ST"]]),
 "4-2-3-1 (narrow)": (4, [["DM","DM"], ["AM","AM","AM"], ["ST"]]),
 "5-2-3": (5, [["CM","CM"], ["W","ST","W"]]), "5-2-1-2": (5, [["CM","CM"], ["AM"], ["ST","ST"]]),
 "5-3-2 (DM)": (5, [["DM"], ["CM","CM"], ["ST","ST"]]), "5-4-1 (diamond)": (5, [["DM"], ["CM","CM"], ["AM"], ["ST"]]),
}
for _n, (_b, _r) in EXTRA.items():
    se.FORMATIONS.setdefault(_n, [["GK"], BACK[_b], *_r]); se.validate_formation(se.FORMATIONS[_n])

app, LOCK = Flask(__name__, static_folder="static"), threading.Lock()
TIME_LIMIT = float(os.environ.get("SOLVER_TIME_LIMIT", 120))     # seconds per solver stage


# ---------------------------------------------------------------- helpers
def clean(v):
    if isinstance(v, (np.integer,)): return int(v)
    if isinstance(v, (np.floating, float)): return None if v != v else float(v)
    if isinstance(v, (np.bool_,)): return bool(v)
    return v


def _norm(s):
    return "".join(c for c in unicodedata.normalize("NFKD", str(s)) if not unicodedata.combining(c)).lower()


# a real NumPy unicode array (pandas 3 string columns give an extension array that np.char cannot search)
SEARCH = np.array([f"{_norm(a)} | {_norm(b)}" for a, b in zip(DF.short_name, DF.long_name)], dtype=str)
CLUB = DF.club_name.fillna("Free agent").values if "club_name" in DF else np.full(len(DF), "")


OUT_STATS = [("PAC", "pace"), ("SHO", "shooting"), ("PAS", "passing"), ("DRI", "dribbling"), ("DEF", "defending"), ("PHY", "physic")]
GK_STATS = [("DIV", "goalkeeping_diving"), ("HAN", "goalkeeping_handling"), ("KIC", "goalkeeping_kicking"),
            ("REF", "goalkeeping_reflexes"), ("SPD", "goalkeeping_speed"), ("POS", "goalkeeping_positioning")]
NATION = DF.nationality_name.fillna("").values if "nationality_name" in DF else np.full(len(DF), "")
FOOT = DF.preferred_foot.fillna("").values if "preferred_foot" in DF else np.full(len(DF), "")


def _stats(i):
    """Six card stats for the UI (FC-style). Missing columns or NaN -> None, so any dataset version works."""
    cols = GK_STATS if DF.group[i] == "GK" else OUT_STATS
    out = []
    for lab, c in cols:
        v = DF[c].iat[i] if c in DF else None
        out.append([lab, None if v is None or v != v else int(v)])
    return out


POS_GRID = ["LW", "ST", "RW", "LM", "AM", "RM", "CM", "DM", "LWB", "RWB", "LB", "CB", "RB"]   # attack -> defence
LAMBDA = 3                                                                                    # out-of-position penalty


def listed_at(i, label):
    """Is `label` (LB, RW, CM ...) one of the positions player i is listed for?"""
    return bool(DF.natural[i] & se.NATURAL.get(label, {label}))


def position_ratings(i):
    """Calibrated rating of player i at every position, flagged when listed. This is what the optimiser uses
    (minus LAMBDA when not listed), so the UI can show why a player plays where."""
    labels = ["GK"] if DF.group[i] == "GK" else POS_GRID
    return [[t, int(round(DF["r_" + t].iat[i])), listed_at(i, t)] for t in labels]


def player_card(i):
    return dict(id=int(i), name=DF.short_name[i], long_name=DF.long_name[i], age=int(DF.age[i]), club=str(CLUB[i]),
                positions=DF.player_positions[i], overall=int(DF.overall[i]), potential=int(DF.potential[i]),
                value_m=round(float(DF.value_m[i]), 2), group=DF.group[i], price_imputed=bool(DF.value_missing[i]),
                nation=str(NATION[i]), foot=str(FOOT[i]), stats=_stats(i))


def search_players(q, limit=8):
    toks = _norm(q).replace(".", " ").split()
    if not toks:
        return []
    hit = np.ones(len(DF), bool)
    for t in toks:
        hit &= np.char.find(SEARCH, t) >= 0
    idx = np.where(hit)[0]
    if not len(idx) and len(toks) > 1:                 # "Leo Messi" -> fall back to the most specific word
        idx = np.where(np.char.find(SEARCH, max(toks, key=len)) >= 0)[0]
    idx = idx[np.argsort(-DF.overall.values[idx], kind="stable")][:limit]
    return [player_card(i) for i in idx]


class BadInput(ValueError):
    pass


def _ids(v):
    out = []
    for x in v or []:
        i = int(x)
        if not 0 <= i < len(DF):
            raise BadInput(f"Unknown player id {i}")
        out.append(i)
    return sorted(set(out))


def parse_params(b):
    """Validate a request body into run_scenario arguments (shared by the form and the agent)."""
    try:
        custom = b.get("custom")
        if custom:                                   # free-form formation: list of lines of outfield slot types
            form = [["GK"]] + [[str(t) for t in line] for line in custom if line]; se.validate_formation(form)
        else:
            form = b["formation"]
            if form not in se.FORMATIONS: raise BadInput(f"Unknown formation '{form}'")
        budget = float(b["budget"]); N = int(b.get("size", 23)); age = int(b.get("max_age") or 45); p = float(b.get("p_abs", 0.10))
        if not 18 <= N <= 30: raise BadInput("Squad size must be 18-30")
        if not 1 <= budget <= 20000: raise BadInput("Budget must be 1-20000 (EUR m)")
        if p != p: raise BadInput("Absence probability must be a number")
        must, banned, start = _ids(b.get("must")), _ids(b.get("exclude")), _ids(b.get("must_start"))
        must = sorted(set(must) | set(start))
    except BadInput:
        raise
    except (AssertionError, KeyError, TypeError, ValueError) as e:
        raise BadInput(str(e) or e.__class__.__name__)
    if set(must) & set(banned):
        raise BadInput("A player cannot be both required and excluded")
    if len(must) > N:
        raise BadInput(f"{len(must)} required players do not fit in a squad of {N}")
    if len(start) > 11:
        raise BadInput("At most 11 players can be required to start")
    return dict(form=form, budget=budget, N=N, max_age=None if age >= 45 else age, p_abs=min(max(p, 0), 0.5), must=must, banned=banned, start=start)


def solve(P):
    """Run the notebook model; returns (payload, None) or (None, (message, http_status))."""
    need = float(DF.value_m.values[P["must"]].sum()) if P["must"] else 0.0
    if need > P["budget"]:
        names = ", ".join(DF.short_name[i] for i in P["must"])
        return None, (f"The required players ({names}) cost EUR {need:.1f}M on their own, more than the EUR {P['budget']:g}M budget.", 422)
    try:
        with LOCK:
            out = se.run_scenario(DF, P["form"], P["budget"], N=P["N"], p_abs=P["p_abs"], max_age=P["max_age"],
                                  must=P["must"], banned=P["banned"], must_start=P["start"], time_limit=TIME_LIMIT, sides=True)
    except ValueError as e:                           # e.g. a required starter who has no eligible slot
        return None, (str(e), 422)
    if out is None:
        last = se.LAST_STATUSES[-1][0] if se.LAST_STATUSES else "?"
        if last == "Infeasible":
            extra = " and the required players" if P["must"] else ""
            return None, (f"No valid squad of {P['N']} fits EUR {P['budget']:g}M with these limits{extra}. Raise the budget or relax the age limit.", 422)
        return None, (f"The solver stopped at its time limit before proving an optimal squad (status: {last}). "
                      "Try again, or use a simpler setting (fewer required players, a different formation).", 504)
    r, d = out["result"], out["df"]
    pitch = []
    for q in se.lineup_layout(d, r):
        c = player_card(q["i"])
        listed = q["slot"] == "GK" or listed_at(q["i"], q["slot"])
        pitch.append(dict(c, x=q["x"], y=q["y"], slot=q["slot"], rating=clean(q["eff"]), listed=listed,
                          slot_base=int(round(DF["r_" + q["slot"]].iat[q["i"]])) if "r_" + q["slot"] in DF else None))
    sq = out["squad"].reset_index().rename(columns={"index": "id"})
    squad = [{k: clean(v) for k, v in row.items()} for row in sq.to_dict("records")]
    for s in squad:
        i = s["id"]
        s.update(group=DF.group[i], club=str(CLUB[i]), required=i in P["must"], nation=str(NATION[i]), foot=str(FOOT[i]), stats=_stats(i),
                 pos_ratings=position_ratings(i))
    model = dict(pool_size=r["pool_size"], n_vars=r["n_vars"], n_cons=r["n_cons"], n_pairs=r["n_pairs"], n_bpairs=r["n_bpairs"],
                 xi_quality=clean(r["xi_quality"]), depth=clean(r["depth"]), eq=clean(r["eq"]), p_abs=r["p_abs"], util=clean(r["util"]),
                 statuses=[[s, round(t, 2)] for s, t in r["statuses"]], time_limit_hit=bool(r["time_limit_hit"]),
                 tiebreak_done=r.get("tiebreak_done"),
                 backups={t: DF.short_name[i] for t, i in r["backups"].items()})
    params = dict(budget=P["budget"], formation=P["form"] if isinstance(P["form"], str) else None,
                  custom=[row for row in P["form"][1:]] if not isinstance(P["form"], str) else None,
                  size=P["N"], max_age=P["max_age"], p_abs=P["p_abs"], must=P["must"], exclude=P["banned"], must_start=P["start"])
    return dict(pitch=pitch, squad=squad, kpis={k: clean(v) for k, v in out["kpis"].items()}, budget=P["budget"],
                formation=P["form"] if isinstance(P["form"], str) else "Custom", rows=r["rows"],
                checks=[dict(name=n, ok=bool(o)) for n, o in out["checks"]], solve_s=clean(r["solve_time"]), model=model,
                required=[dict(player_card(i), start=i in P["start"]) for i in P["must"]], excluded=[player_card(i) for i in P["banned"]], params=params), None


# ---------------------------------------------------------------- routes
@app.get("/")
def index(): return send_from_directory("static", "index.html")


@app.get("/api/meta")
def meta():
    w, cr = se.ahp_weights(se.AHP_MATRIX)
    return jsonify(formations=se.FORMATIONS, players=len(DF), dataset=os.path.basename(CSV),
                   default=dict(formation="4-3-3", budget=300, size=23, max_age=32, p_abs=0.10),
                   ahp=dict(criteria=["Overall", "Potential", "Versatility"], matrix=se.AHP_MATRIX, weights=[float(x) for x in w], cr=float(cr)),
                   offsets={k: clean(v) for k, v in DF.attrs.get("offsets", {}).items()}, agent_model=ag.MODEL)


@app.get("/api/players")
def players():
    return jsonify(players=search_players(request.args.get("q", ""), min(int(request.args.get("limit", 8)), 25)))


@app.post("/api/optimise")
def optimise():
    try:
        P = parse_params(request.get_json(force=True) or {})
    except BadInput as e:
        return jsonify(error=f"Bad input: {e}"), 400
    try:
        payload, err = solve(P)
    except Exception as e:                            # never hand the page an HTML error page
        app.logger.exception("optimise failed")
        return jsonify(error=f"The optimiser failed: {e}"), 500
    return (jsonify(error=err[0]), err[1]) if err else jsonify(payload)


@app.get("/api/agent/status")
def agent_status():
    return jsonify(ag.status())


@app.post("/api/agent")
def agent():
    b = request.get_json(force=True) or {}
    history = [m for m in b.get("messages", []) if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)][-12:]
    if not history or history[-1]["role"] != "user":
        return jsonify(error="Send at least one user message"), 400

    def build(args):
        P = parse_params(args)
        payload, err = solve(P)
        if err:
            raise BadInput(err[0])
        return payload

    tools = ag.Tools(search=search_players, build=build, formations=list(se.FORMATIONS))
    gen = ag.run(history, b.get("context"), tools, think=bool(b.get("think")))
    return Response(stream_with_context((json.dumps(ev, default=clean) + "\n" for ev in gen)), mimetype="application/x-ndjson")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False, threaded=True)
