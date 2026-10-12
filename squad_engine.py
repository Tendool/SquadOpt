"""squad_engine.py -- the optimisation model, extracted automatically from or_final.ipynb (cells 3-11, 12, 78).
Nothing about the maths is changed. Needs PuLP 3.x (pip install "pulp<4" highspy).
Website extension (not in the notebook): optimise / run_scenario / validate accept `must` (player rows forced into the
squad, x_i = 1, exempt from the age limit), `must_start` (forced into the XI, sum_t y_it = 1) and `banned` (rows removed
from the pool). With all three empty the model is identical.
If only the AHP tie-break (stage 2) hits the time limit, the stage-1 optimal squad is kept (tiebreak_done=False) instead of None."""
import pulp
if int(pulp.__version__.split(".")[0]) >= 4:
    raise ImportError("PuLP 4 is not supported by this model. Run:  pip install 'pulp<4' highspy")

# ---- constants that the notebook defines in its settings cell ----
HEADLINE_FORMATION, HEADLINE_BUDGET, SQUAD_SIZE = "3-5-2", 500.0, 23
P_ABS, MAX_AGE_REAL, MC_SCENARIOS, SEED = 0.10, 32, 300, 7


# ======== notebook cell 3 ========
# ======== ENGINE v3 : data layer, utilities, formations, optimiser, evaluation ========
import pandas as pd, numpy as np, pulp, time, itertools, warnings
from scipy.optimize import linear_sum_assignment
warnings.filterwarnings("ignore")


# ---- PuLP 3.x / 4.x compatibility layer ------------------------------------------
import inspect
_VAR_STYLES = [dict(cat="Binary"), dict(cat="Integer", lowBound=0, upBound=1),
               dict(var_type="Binary"), dict(var_type="Integer", low_bound=0, up_bound=1),
               dict(category="Binary"), dict(category="Integer", lowBound=0, upBound=1)]
_VAR_STYLE = []                       # remembers the first style that works


def _sig_styles():
    """Candidate keyword sets derived from the installed LpVariable signature."""
    try:
        params = [p for p in inspect.signature(pulp.LpVariable.__init__).parameters if p not in ("self", "name", "args", "kwargs")]
    except Exception:
        return []
    lo = [p for p in params if p.lower() in ("lb", "low", "lower") or p.lower().startswith(("low", "lower", "min"))]
    up = [p for p in params if p.lower() in ("ub", "up", "upper", "high") or p.lower().startswith(("up", "upper", "max"))]
    cat = [p for p in params if any(w in p.lower() for w in ("cat", "type", "kind"))]
    flag_bin = [p for p in params if any(w in p.lower() for w in ("binary", "bool"))]
    flag_int = [p for p in params if "int" in p.lower()]
    bnd = {}
    if lo: bnd[lo[0]] = 0
    if up: bnd[up[0]] = 1
    out = []
    for f in flag_bin: out.append({f: True})
    for c in cat:
        for val in ("Binary", getattr(pulp, "LpBinary", "Binary"), "Integer", getattr(pulp, "LpInteger", "Integer"), "integer", "binary", "INTEGER", "BINARY"):
            out.append({c: val, **({} if val in ("Binary", "binary", "BINARY") else bnd)})
    for f in flag_int: out.append({f: True, **bnd})
    if bnd: out.append(dict(bnd))                      # last resort: continuous 0..1 (still correct for 0/1 optima only if the solver rounds)
    return out


def _bin_var(name):
    """Create a binary variable regardless of the PuLP version's keyword names."""
    cands = _VAR_STYLE[:1] or (_VAR_STYLES + _sig_styles())
    for kw in cands:
        try:
            v = pulp.LpVariable(name, **kw)
            if not _VAR_STYLE:
                _VAR_STYLE.append(kw)
            return v
        except Exception:
            continue
    try:
        sig = str(inspect.signature(pulp.LpVariable.__init__))
    except Exception:
        sig = "?"
    raise RuntimeError(f"Could not create a binary variable with PuLP {getattr(pulp, '__version__', '?')}. "
                       f"LpVariable signature: {sig}. Quick fix: run  !pip install 'pulp<4'  then Runtime > Restart session and run all cells.")


def _is_optimal(m):
    try:
        return pulp.LpStatus[m.status] == "Optimal"
    except Exception:
        return "optimal" in str(getattr(m, "status", "")).lower()


def _status_name(m):
    try:
        return pulp.LpStatus[m.status]
    except Exception:
        return str(getattr(m, "status", "?"))
# ======== notebook cell 4 ========
# ---------------------------------------------------------------- 1. DATA LAYER
TYPES = ["GK", "FB", "WB", "CB", "DM", "CM", "AM", "WM", "W", "ST"]
RATING_COL = {"GK": "gk", "FB": "lb", "WB": "lwb", "CB": "cb", "DM": "cdm",
              "CM": "cm", "AM": "cam", "WM": "lm", "W": "lw", "ST": "st"}
NATURAL = {"GK": {"GK"}, "FB": {"LB", "RB"}, "WB": {"LB", "RB"}, "CB": {"CB"},
           "DM": {"CDM"}, "CM": {"CM"}, "AM": {"CAM"}, "WM": {"LM", "RM"},
           "W": {"LW", "RW"}, "ST": {"ST"}}
GROUP_OF_POS = {"GK": "GK", "CB": "DEF", "LB": "DEF", "RB": "DEF",
                "CDM": "MID", "CM": "MID", "CAM": "MID", "LM": "MID", "RM": "MID",
                "LW": "FWD", "RW": "FWD", "ST": "FWD"}
GROUP_OF_TYPE = {"GK": "GK", "FB": "DEF", "WB": "DEF", "CB": "DEF", "DM": "MID",
                 "CM": "MID", "AM": "MID", "WM": "MID", "W": "FWD", "ST": "FWD", "ANY": "MID"}
GROUPS = ["GK", "DEF", "MID", "FWD"]
OUTFIELD = [t for t in TYPES if t != "GK"]
# FB/WB and W/WM ratings are >0.99 correlated in the data -> one "family" each, so versatility does not double-count
FAMILY = {"FB": "FB", "WB": "FB", "CB": "CB", "DM": "DM", "CM": "CM", "AM": "AM", "WM": "WIDE", "W": "WIDE", "ST": "ST"}
FAMILIES = ["FB", "CB", "DM", "CM", "AM", "WIDE", "ST"]
FILLER = 55.0          # rating of an emergency academy player used when a squad cannot fill a slot (simulation only)


import itertools as _it
_TOK = _it.count(1)
_NAT_CACHE, _EFF_CACHE = {}, {}


def _token(df):
    if "_tok" not in df.attrs:
        df.attrs["_tok"] = next(_TOK)
    return df.attrs["_tok"]


def split_rating(series):
    p = series.astype(str).str.split("+", expand=True).astype(int)
    return p[0], p[1]


def load_players(path, rating_mode="calibrated", value_policy="impute"):
    """rating_mode: 'calibrated' (default) | 'raw_sum' (v1 reading) | 'base'.
       value_policy : 'impute' (default) | 'exclude' | 'keep' (v1: missing price = free)."""
    df = pd.read_csv(path, low_memory=False)
    prim = df.player_positions.str.split(",").str[0].str.strip()
    df["primary_pos"] = prim
    df["group"] = prim.map(GROUP_OF_POS)
    assert df.group.notna().all(), "unknown primary position label"
    df["natural"] = df.player_positions.apply(lambda s: {p.strip() for p in s.split(",")})
    offsets, ratings = {}, {}
    for t in TYPES:
        base, mod = split_rating(df[RATING_COL[t]])
        if rating_mode == "raw_sum":
            ratings[t] = (base + mod).astype(float); offsets[t] = np.nan
        elif rating_mode == "base":
            ratings[t] = base.astype(float); offsets[t] = 0
        else:
            if t == "WB":   # nobody lists LWB/RWB as a position: borrow the full-back offset
                offsets[t] = offsets["FB"]
            else:
                idx = prim.isin(NATURAL[t])
                offsets[t] = int(round((df.overall - base)[idx].mean()))
            ratings[t] = (base + offsets[t]).astype(float)
    R = pd.DataFrame(ratings)
    for t in TYPES:
        df["r_" + t] = R[t].values
    df["value_missing"] = df.value_eur <= 0
    df["value_m"] = df.value_eur / 1e6
    df["wage_m_year"] = df.wage_eur.fillna(0) * 52 / 1e6          # wage_eur is weekly in this dataset
    if value_policy == "impute":
        nz = df[~df.value_missing]
        f = lambda d: np.c_[np.ones(len(d)), d.overall, d.potential, d.age, d.age ** 2]
        beta = np.linalg.lstsq(f(nz), np.log(nz.value_eur), rcond=None)[0]
        smear = float(np.mean(np.exp(np.log(nz.value_eur) - f(nz) @ beta)))   # Duan smearing: removes log-retransformation bias
        df.loc[df.value_missing, "value_m"] = smear * np.exp(f(df[df.value_missing]) @ beta) / 1e6
        df.attrs["smearing"] = smear
    elif value_policy == "exclude":
        df = df[~df.value_missing].copy()
    df = df.reset_index(drop=True)
    df.attrs["offsets"] = offsets
    df.attrs["_tok"] = next(_TOK)
    return df
# ======== notebook cell 5 ========
# ---------------------------------------------------------------- 2. PLAYER UTILITY (AHP)
def ahp_weights(M):
    M = np.array(M, float)
    vals, vecs = np.linalg.eig(M)
    k = np.argmax(vals.real)
    w = np.abs(vecs[:, k].real); w /= w.sum()
    n = len(M)
    CI = (vals[k].real - n) / (n - 1) if n > 2 else 0.0
    RI = {1: 0, 2: 0, 3: 0.58, 4: 0.90, 5: 1.12}[n]
    return w, (CI / RI if RI else 0.0)


AHP_MATRIX = [[1, 3, 5], [1 / 3, 1, 2], [1 / 5, 1 / 2, 1]]
VERSATILITY_BAND = 5      # a position family counts if rating >= best - 5


def add_utilities(df, weights=None):
    """overall_n, potential_n, versatility (over 7 position FAMILIES), and the AHP squad utility `ahp`."""
    fam = np.column_stack([df[["r_" + t for t in OUTFIELD if FAMILY[t] == f]].max(axis=1).values for f in FAMILIES])
    best = fam.max(axis=1, keepdims=True)
    df["versatility"] = (fam >= best - VERSATILITY_BAND).sum(axis=1)
    df.loc[df.group == "GK", "versatility"] = 1
    mm = lambda s: (s - s.min()) / (s.max() - s.min())
    df["overall_n"], df["potential_n"], df["versatility_n"] = mm(df.overall), mm(df.potential), mm(df.versatility)
    df["overall_only"] = df.overall_n
    if weights is None:
        weights, _ = ahp_weights(AHP_MATRIX)
    return set_ahp(df, weights)


def set_ahp(df, weights):
    w = np.array(weights, float); w = w / w.sum()
    df["ahp"] = w[0] * df.overall_n + w[1] * df.potential_n + w[2] * df.versatility_n
    return df
# ======== notebook cell 6 ========
# ---------------------------------------------------------------- 3. FORMATIONS (rows back -> front, entries = slot TYPES)
FORMATIONS = {
    "4-3-3":         [["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "W"]],
    "4-3-3 (DM)":    [["GK"], ["FB", "CB", "CB", "FB"], ["DM"], ["CM", "CM"], ["W", "ST", "W"]],
    "4-4-2":         [["GK"], ["FB", "CB", "CB", "FB"], ["WM", "CM", "CM", "WM"], ["ST", "ST"]],
    "4-4-2 diamond": [["GK"], ["FB", "CB", "CB", "FB"], ["DM"], ["CM", "CM"], ["AM"], ["ST", "ST"]],
    "4-2-3-1":       [["GK"], ["FB", "CB", "CB", "FB"], ["DM", "DM"], ["W", "AM", "W"], ["ST"]],
    "4-1-4-1":       [["GK"], ["FB", "CB", "CB", "FB"], ["DM"], ["WM", "CM", "CM", "WM"], ["ST"]],
    "4-2-2-2":       [["GK"], ["FB", "CB", "CB", "FB"], ["DM", "DM"], ["AM", "AM"], ["ST", "ST"]],
    "4-3-2-1":       [["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["AM", "AM"], ["ST"]],
    "3-5-2":         [["GK"], ["CB", "CB", "CB"], ["WM", "CM", "CM", "CM", "WM"], ["ST", "ST"]],
    "3-4-3":         [["GK"], ["CB", "CB", "CB"], ["WB", "CM", "CM", "WB"], ["W", "ST", "W"]],
    "3-4-2-1":       [["GK"], ["CB", "CB", "CB"], ["WB", "CM", "CM", "WB"], ["AM", "AM"], ["ST"]],
    "5-3-2":         [["GK"], ["WB", "CB", "CB", "CB", "WB"], ["CM", "CM", "CM"], ["ST", "ST"]],
    "5-4-1":         [["GK"], ["WB", "CB", "CB", "CB", "WB"], ["WM", "CM", "CM", "WM"], ["ST"]],
}


def formation_counts(rows):
    c = {}
    for r in rows:
        for t in r:
            c[t] = c.get(t, 0) + 1
    return c


def validate_formation(rows):
    c = formation_counts(rows)
    assert sum(c.values()) == 11, "A formation needs exactly 11 slots"
    assert c.get("GK", 0) == 1, "A formation needs exactly one GK"
    assert all(t in TYPES + ["ANY"] for t in c), f"Unknown slot type. Allowed: {TYPES}"
    return c
# ======== notebook cell 7 ========
# ---------------------------------------------------------------- 4. EFFECTIVE RATINGS
def _natural_mask(df, t):
    key = (_token(df), t)
    if key not in _NAT_CACHE:
        _NAT_CACHE[key] = df.natural.apply(lambda s: bool(s & NATURAL[t])).values
    return _NAT_CACHE[key]


def effective_rating(df, t, lam, strict):
    """Eligibility + effective rating of every player in slot type t (rating minus lambda if not a listed position)."""
    r = df["r_" + t].values.astype(float).copy() if t != "ANY" else df[["r_" + x for x in OUTFIELD]].values.max(axis=1)
    if t == "ANY":
        return r, ~(df.group.values == "GK")
    nat = _natural_mask(df, t)
    if t == "GK":
        return r, nat
    if strict:
        return r, nat
    return r - lam * (~nat), ~(df.group.values == "GK")


def eff_table(df, lam, strict):
    """dict t -> array of effective ratings, NaN where the player may not play slot type t (cached)."""
    key = (_token(df), lam, strict)
    if key not in _EFF_CACHE:
        out = {}
        for t in TYPES:
            r, ok = effective_rating(df, t, lam, strict)
            out[t] = np.where(ok, r, np.nan)
        _EFF_CACHE[key] = out
    return _EFF_CACHE[key]
# ======== notebook cell 8 ========
# ---------------------------------------------------------------- 5. POOL PRUNING (exact dominance)
def dominance_prune(cost, vec, group, N, allowed):
    """Keep player i unless >= N other allowed players of the same group are cheaper-or-equal AND >= on every
       component of `vec`. Exact for players who can only be reserves: if i is in a squad, at least one of its
       N dominators is outside the squad and can replace i without changing cost, composition or any rating."""
    n = len(cost); keep = np.ones(n, bool)
    cost = np.where(allowed, cost, np.inf)
    for g in np.unique(group):
        idx = np.where(group == g)[0]
        cc, VV = cost[idx], vec[idx]
        order = np.arange(len(idx)); cnt = np.zeros(len(idx), int)
        for s in range(0, len(idx), 800):
            sl = slice(s, min(s + 800, len(idx)))
            dom = cc[None, :] <= cc[sl, None]
            for k in range(VV.shape[1]):
                dom &= VV[None, :, k] >= VV[sl, None, k]
            same = cc[None, :] == cc[sl, None]
            for k in range(VV.shape[1]):
                same &= VV[None, :, k] == VV[sl, None, k]
            dom &= ~(same & (order[None, :] >= order[sl, None]))
            dom[np.arange(dom.shape[0]), np.arange(s, s + dom.shape[0])] = False
            cnt[sl] = dom.sum(axis=1)
        keep[idx] = cnt < N
    return keep & allowed


_POOL_CACHE = {}
LAST_STATUSES = []        # website: solver statuses of the latest optimise() call, also when it returns None


def get_solver(time_limit=120):
    try:
        avail = pulp.listSolvers(onlyAvailable=True)
    except Exception:
        avail = []
    if "HiGHS" in avail:
        for kw in (dict(msg=False, timeLimit=time_limit, gapRel=1e-5),
                   dict(msg=False, time_limit=time_limit, gap_rel=1e-5),
                   dict(msg=False, timeLimit=time_limit),
                   dict(msg=False, time_limit=time_limit)):
            try:
                return pulp.HiGHS(**kw)
            except Exception:
                continue
    try:
        return pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
    except Exception:
        return pulp.PULP_CBC_CMD(msg=False)


def default_cover(rows, N):
    """Minimum squad composition by primary-position group."""
    c = formation_counts(rows)
    start = {g: sum(n for t, n in c.items() if GROUP_OF_TYPE[t] == g) for g in GROUPS}
    if N >= 18:
        return {"GK": 2, **{g: start[g] + 1 for g in ["DEF", "MID", "FWD"]}}
    if N >= 12:
        return {"GK": 2}
    return {}


class Result(dict):
    pass
# ======== notebook cell 9 ========
# ---------------------------------------------------------------- 6. THE OPTIMISER
def optimise(df, formation, N=23, budget=500.0, lam=3, strict=False, floor=70,
             objective="expected", p_abs=0.10, delta=0.0, tiebreak=True, cover="auto", gk_max=3,
             max_age=None, cost=None, backup_floor=65, bench_col="ahp", bench_mode="utility",
             time_limit=120, nogood=None, reference=False, stage2=True, must=None, banned=None, must_start=None,
             prune=True, prune_starters=True):
    """objective:
         'xi'        stage 1 only: maximise the starting-XI rating sum Q_XI                    (stage2=False also gives this)
         'xi_first'  v2 model: Q_XI first, then sum of AHP utility with Q_XI >= Q* - delta
         'expected'  v3 model: maximise first-order expected XI quality under player absence probability p_abs
                         EQ = (1-p) Q_XI + p D ,  D = sum_t n_t * rating of the designated backup of slot type t
                     then (tiebreak=True) among EQ-optimal squads maximise the AHP utility.
       reference=True also solves stage 1 so that 'q_xi_max' (the price of depth) is reported."""
    rows = FORMATIONS[formation] if isinstance(formation, str) else formation
    cnt = validate_formation(rows)
    mins = default_cover(rows, N) if cover == "auto" else (cover or {})
    n = len(df)
    c_arr = df.value_m.values if cost is None else np.asarray(cost, float)
    allowed = np.ones(n, bool) if max_age is None else (df.age.values <= max_age)
    must_start = sorted({int(i) for i in (must_start or [])})
    must = sorted({int(i) for i in (must or [])} | set(must_start))
    banned = sorted({int(i) for i in (banned or [])} - set(must))
    if banned:
        allowed[banned] = False
    if must:
        allowed[must] = True                               # required players are exempt from the age limit
    E = eff_table(df, lam, strict)

    pairs, eff = {}, {}
    for t in cnt:
        if t == "ANY":
            r, ok = effective_rating(df, t, lam, strict)
        else:
            r = E[t]; ok = ~np.isnan(r)
        m = ok & allowed & (np.nan_to_num(r, nan=-1) >= floor)
        for i in np.where(m)[0]:
            pairs[(i, t)] = 1; eff[(i, t)] = float(r[i])
    starters = {i for (i, t) in pairs}

    use_depth = objective == "expected"
    u = df[bench_col].values
    # backup candidate pairs (only for the depth model)
    bpairs = {}
    if use_depth:
        for t in cnt:
            if t == "ANY":
                continue
            r = E[t]
            for i in np.where(allowed & ~np.isnan(r) & (np.nan_to_num(r, nan=-1) >= backup_floor))[0]:
                bpairs[(i, t)] = float(r[i])

    # exact pool pruning --------------------------------------------------------
    types_used = [t for t in cnt if t != "ANY"]
    need_u = (objective == "xi_first" and stage2) or (use_depth and tiebreak)
    comps = ([np.nan_to_num(E[t], nan=-1) for t in types_used] if use_depth else []) + ([u] if need_u else [])
    vec = np.column_stack(comps) if comps else np.zeros((n, 1))
    key = (n, N, use_depth, need_u, tuple(types_used), lam, strict, backup_floor, bench_col,
           hash(c_arr.tobytes()), hash(u.tobytes()), hash(allowed.tobytes()))
    if key not in _POOL_CACHE:
        if len(_POOL_CACHE) > 6:
            _POOL_CACHE.clear()
        _POOL_CACHE[key] = dominance_prune(c_arr, vec, df.group.values, N, allowed)
    bench_ok = _POOL_CACHE[key]
    # website: with the depth objective `vec` holds every used slot rating (+ utility), so the same dominance argument
    # also holds for starters: a dominated starter can be swapped for an unused dominator into the same slot/backup
    # role at no extra cost and no lower rating or utility. Not valid for "ANY" slots or no-good cuts.
    if not prune:
        pool = sorted(set(np.where(allowed)[0]) | set(must))
    elif prune_starters and use_depth and "ANY" not in cnt and not nogood:
        pool = sorted(set(np.where(bench_ok)[0]) | set(must))
    else:
        pool = sorted(starters | set(np.where(bench_ok)[0]) | set(must))
    pool_set = set(pool)
    bpairs = {k: v for k, v in bpairs.items() if k[0] in pool_set}
    pairs = {k: v for k, v in pairs.items() if k[0] in pool_set}

    # model --------------------------------------------------------------------
    m = pulp.LpProblem("squad", pulp.LpMaximize)
    x = {i: _bin_var(f"x{i}") for i in pool}
    y = {k: _bin_var(f"y{k[0]}_{k[1]}") for k in pairs}
    z = {k: _bin_var(f"z{k[0]}_{k[1]}") for k in bpairs}
    m += pulp.lpSum(x.values()) == N
    m += pulp.lpSum(c_arr[i] * x[i] for i in pool) <= budget
    for i in must:
        m += x[i] == 1
    for i in must_start:                                   # required starter: exactly one XI slot
        ys = [y[(i, t)] for t in cnt if (i, t) in y]
        if not ys:
            raise ValueError(f"{df.short_name[i]} cannot start in this formation: no slot where their rating reaches {floor}.")
        m += pulp.lpSum(ys) == 1
    for t, cc in cnt.items():
        m += pulp.lpSum(y[k] for k in y if k[1] == t) == cc
    by_player = {}
    for (i, t) in y:
        by_player.setdefault(i, []).append(y[(i, t)])
    for i, ys in by_player.items():
        m += pulp.lpSum(ys) <= x[i]
    grp = df.group.values
    for g, mn in mins.items():
        m += pulp.lpSum(x[i] for i in pool if grp[i] == g) >= mn
    if gk_max is not None and N >= 12:
        m += pulp.lpSum(x[i] for i in pool if grp[i] == "GK") <= gk_max
    if use_depth:
        zt = {}
        for (i, t) in z:
            zt.setdefault(t, []).append(z[(i, t)])
        for t in types_used:
            m += pulp.lpSum(zt.get(t, [])) == 1              # one designated backup per slot type
        for (i, t) in z:                                   # a backup must be in the squad and not a starter
            m += z[(i, t)] <= x[i] - pulp.lpSum(by_player.get(i, []))
    xi_obj = pulp.lpSum(eff[k] * y[k] for k in y)
    depth_obj = pulp.lpSum(cnt[t] * bpairs[(i, t)] * z[(i, t)] for (i, t) in z) if use_depth else 0
    if nogood:
        for S in nogood:
            m += pulp.lpSum(y[(i, t)] for (i, t) in y if i in S) <= 10
    solver = get_solver(time_limit)
    t0 = time.time(); stat = []
    tiebreak_done = None

    def solve(obj):
        m.setObjective(obj); s0 = time.time(); m.solve(solver)
        stat.append((_status_name(m), time.time() - s0))
        LAST_STATUSES[:] = stat
        return _is_optimal(m)

    q_ref = None
    if objective in ("xi", "xi_first") or reference or not stage2:
        if not solve(xi_obj):
            return None
        q_ref = round(pulp.value(m.objective))
    if objective == "xi" or not stage2:
        pass
    elif objective == "xi_first":
        m += xi_obj >= q_ref - delta - 1e-6
        obj = pulp.lpSum(-c_arr[i] * x[i] for i in pool) if bench_mode == "cheapest" else pulp.lpSum(u[i] * x[i] for i in pool)
        if not solve(obj):
            return None
    elif objective == "expected":
        if not solve((1 - p_abs) * xi_obj + p_abs * depth_obj):
            return None
        eq_star = pulp.value(m.objective)
        if tiebreak:
            # website: if only the AHP tie-break times out, keep the stage-1 squad (still EQ-optimal) instead of
            # returning None, and report tiebreak_done=False
            best = {v.name: v.varValue for v in m.variables()}
            m += (1 - p_abs) * xi_obj + p_abs * depth_obj >= eq_star - 1e-6
            tiebreak_done = solve(pulp.lpSum(u[i] * x[i] for i in pool))
            if not tiebreak_done:
                if stat[-1][0] == "Infeasible":
                    return None
                for v in m.variables():
                    v.varValue = best.get(v.name)
    sel = [i for i in pool if x[i].value() > 0.5]
    xi = [(i, t) for (i, t) in y if y[(i, t)].value() > 0.5]
    backups = {t: [i for (i, tt) in z if tt == t and z[(i, tt)].value() > 0.5][0] for t in types_used} if use_depth else {}
    qxi = sum(eff[k] for k in xi)
    D = sum(cnt[t] * bpairs[(backups[t], t)] for t in backups) if use_depth else np.nan
    res = Result(formation=formation if isinstance(formation, str) else "custom", rows=rows, N=N, budget=budget,
                 stage1_q=q_ref, xi_quality=qxi, depth=D,
                 eq=((1 - p_abs) * qxi + p_abs * D) if use_depth else np.nan, p_abs=p_abs,
                 squad=sorted(sel), xi=xi, eff=eff, backups=backups, cost=float(c_arr[sel].sum()),
                 util=float(u[sel].sum()), pool_size=len(pool), n_pairs=len(pairs), n_bpairs=len(bpairs),
                 solve_time=time.time() - t0, statuses=stat, objective=objective,
                 time_limit_hit=any(s[1] >= 0.95 * time_limit for s in stat), must=must, banned=banned, must_start=must_start, tiebreak_done=tiebreak_done,
                 n_vars=len(x) + len(y) + len(z), n_cons=len(m.constraints))
    return res
# ======== notebook cell 10 ========
# ---------------------------------------------------------------- 7. LINEUPS, VALIDATION, SIMULATION
def _slot_matrix(df, squad, rows, lam, strict):
    slots = [t for r in rows for t in r]
    E = eff_table(df, lam, strict)
    sq = np.asarray(list(squad), int)
    M = np.full((len(slots), len(sq)), np.nan)
    for k, t in enumerate(slots):
        M[k] = E[t][sq] if t != "ANY" else np.where(df.group.values[sq] == "GK", np.nan, df[["r_" + x for x in OUTFIELD]].values[sq].max(axis=1))
    return slots, sq, M


def lineup_quality(df, squad, rows, lam=3, strict=False, filler=None, avail=None):
    """Optimal assignment (Hungarian) of `squad` to the slots. filler=None -> NaN if the XI cannot be fielded;
       filler=x -> missing slots are filled by an academy player rated x. avail = boolean mask over `squad`."""
    slots, sq, M = _slot_matrix(df, squad, rows, lam, strict)
    if avail is not None:
        M = M[:, avail]
    BIG = -1e6
    A = np.nan_to_num(M, nan=BIG)
    if filler is not None:
        A = np.hstack([A, np.full((len(slots), len(slots)), float(filler))])
    elif A.shape[1] < len(slots):
        return np.nan
    r, c = linear_sum_assignment(A, maximize=True)
    v = A[r, c]
    if (v <= BIG / 2).any():
        return np.nan
    return float(v.sum())


def best_xi_from_squad(df, squad, formation, lam=3, strict=False):
    rows = FORMATIONS[formation] if isinstance(formation, str) else formation
    slots, sq, M = _slot_matrix(df, squad, rows, lam, strict)
    A = np.nan_to_num(M, nan=-1e6)
    if A.shape[1] < len(slots):
        return None, np.nan
    r, c = linear_sum_assignment(A, maximize=True)
    if (A[r, c] <= -5e5).any():
        return None, np.nan
    return [(int(sq[j]), slots[k]) for k, j in zip(r, c)], float(A[r, c].sum())


def simulate_absence(df, squad, formation, p=0.10, S=500, seed=7, lam=3, strict=False, filler=FILLER):
    """Monte-Carlo: every squad member is independently unavailable with probability p; the best lineup is
       re-optimised from whoever is available (assignment problem). Returns the S simulated XI qualities."""
    rows = FORMATIONS[formation] if isinstance(formation, str) else formation
    rng = np.random.default_rng(seed)
    U = rng.random((S, len(squad)))
    slots, sq, M = _slot_matrix(df, squad, rows, lam, strict)
    A0 = np.nan_to_num(M, nan=-1e6)
    F = np.full((len(slots), len(slots)), float(filler))
    out = np.empty(S)
    for s in range(S):
        av = U[s] >= p
        A = np.hstack([A0[:, av], F])
        r, c = linear_sum_assignment(A, maximize=True)
        out[s] = A[r, c].sum()
    return out


def validate(df, res, lam=3, floor=70, strict=False, cover="auto", gk_max=3, max_age=None, cost=None, tol=1e-6):
    """Independent re-computation of every constraint from the returned solution."""
    squad, xi, rows, N, B = res["squad"], res["xi"], res["rows"], res["N"], res["budget"]
    cnt = validate_formation(rows)
    mins = default_cover(rows, N) if cover == "auto" else (cover or {})
    chk = [("Squad size == N", len(squad) == N),
           ("Total cost <= budget", float((df.value_m.values if cost is None else np.asarray(cost))[squad].sum()) <= B + 1e-6),
           ("XI has 11 distinct players", len({i for i, _ in xi}) == 11 == len(xi))]
    got = {}
    for _, t in xi:
        got[t] = got.get(t, 0) + 1
    chk += [("Formation slots exactly filled", got == cnt), ("Every starter is in the squad", all(i in set(squad) for i, _ in xi))]
    ok_e, ok_f, q = True, True, 0.0
    for i, t in xi:
        r, ok = effective_rating(df, t, lam, strict)
        ok_e &= bool(ok[i]); ok_f &= bool(r[i] >= floor - 1e-9); q += r[i]
    chk += [("Eligibility respected", ok_e), (f"Starter rating >= {floor}", ok_f), ("XI quality matches objective", abs(q - res["xi_quality"]) < 1e-6)]
    g = df.group.values[squad]
    for grp_, mn in mins.items():
        chk.append((f"Squad has >= {mn} {grp_}", int((g == grp_).sum()) >= mn))
    if gk_max is not None and N >= 12:
        chk.append((f"Squad has <= {gk_max} GK", int((g == "GK").sum()) <= gk_max))
    must = set(res.get("must") or [])
    if must:
        chk.append(("Required players are in the squad", must <= set(squad)))
    if res.get("must_start"):
        chk.append(("Required starters are in the XI", set(res["must_start"]) <= {i for i, _ in xi}))
    if res.get("banned"):
        chk.append(("Excluded players are not in the squad", not (set(res["banned"]) & set(squad))))
    if max_age is not None:
        free = [i for i in squad if i not in must]
        chk.append((f"All players aged <= {max_age}" + (" (required players exempt)" if must else ""),
                    bool((df.age.values[free] <= max_age).all())))
    if res.get("backups"):
        starters = {i for i, _ in xi}
        chk.append(("Designated backups are squad members and not starters",
                    all((b in set(squad)) and (b not in starters) for b in res["backups"].values())))
    return chk
# ======== notebook cell 11 ========
# ======== BASELINES, TOPSIS, BUDGET SCALE, EVALUATION HELPERS ========
RESERVE_PER_SPOT = 0.5   # EUR m kept back for each unfilled place (realistic floor price of a squad filler)


def greedy_squad(df, N, budget, key, mins=None, max_age=None):
    """Greedy: best `key` first (ties -> cheaper), keeping RESERVE_PER_SPOT per unfilled place.
       mins=None -> position-blind; mins={group:k} -> composition-aware."""
    v, g = df.value_m.values, df.group.values
    ok = np.ones(len(df), bool) if max_age is None else df.age.values <= max_age
    order = df.assign(_k=df[key]).sort_values(["_k", "value_m"], ascending=[False, True]).index.values
    order = order[ok[order]]
    chosen, spent = [], 0.0

    def try_add(i):
        nonlocal spent
        left = N - len(chosen) - 1
        if spent + v[i] + RESERVE_PER_SPOT * left <= budget + 1e-9:
            chosen.append(int(i)); spent += v[i]; return True
        return False
    if mins:
        for grp, k in mins.items():
            for i in order[g[order] == grp]:
                if sum(g[j] == grp for j in chosen) >= k:
                    break
                try_add(i)
    for i in order:
        if len(chosen) >= N:
            break
        if i not in chosen:
            try_add(i)
    for i in np.argsort(v):                                # safety: complete with the cheapest players
        if len(chosen) >= N:
            break
        if ok[i] and i not in chosen:
            chosen.append(int(i))
    return chosen


def sequential_knapsack(df, formation, N, budget, key="ahp", lam=3, max_age=None, time_limit=60):
    """The v1 / original-PPT pipeline: STAGE K (knapsack) picks the squad that maximises total `key` under budget,
       size and composition, WITHOUT looking at formation slots; STAGE A (assignment) then lines the XI up."""
    rows = FORMATIONS[formation] if isinstance(formation, str) else formation
    mins = default_cover(rows, N)
    allowed = np.ones(len(df), bool) if max_age is None else df.age.values <= max_age
    keep = dominance_prune(df.value_m.values, df[key].values[:, None], df.group.values, N, allowed)
    pool = np.where(keep)[0]
    m = pulp.LpProblem("knap", pulp.LpMaximize)
    x = {i: _bin_var(f"k{i}") for i in pool}
    m += pulp.lpSum(df[key].values[i] * x[i] for i in pool)
    m += pulp.lpSum(x.values()) == N
    m += pulp.lpSum(df.value_m.values[i] * x[i] for i in pool) <= budget
    g = df.group.values
    for grp, mn in mins.items():
        m += pulp.lpSum(x[i] for i in pool if g[i] == grp) >= mn
    m += pulp.lpSum(x[i] for i in pool if g[i] == "GK") <= 3
    m.solve(get_solver(time_limit))
    return [i for i in pool if x[i].value() > 0.5]


def coach_heuristic(df, formation, N, budget, lam=3, xi_share=0.75, max_age=None):
    """'Manual football' baseline: cap = share*budget/11 per slot, buy the best-rated affordable player per slot
       (scarce types first), then fill the bench by AHP utility (composition minimums first)."""
    rows = FORMATIONS[formation] if isinstance(formation, str) else formation
    slots = [t for r in rows for t in r]
    cap = budget * xi_share / 11
    v, g = df.value_m.values, df.group.values
    ok_age = np.ones(len(df), bool) if max_age is None else df.age.values <= max_age
    squad = []
    for t in sorted(slots, key=lambda t: {"GK": 0, "CB": 1, "ST": 2}.get(t, 3)):
        r, ok = effective_rating(df, t, lam, False)
        for i in np.argsort(-r):
            if ok[i] and ok_age[i] and i not in squad and v[i] <= cap:
                squad.append(int(i)); break
    mins = default_cover(rows, N)
    order = df.sort_values("ahp", ascending=False).index.values
    order = order[ok_age[order]]

    def add(i):
        left = N - len(squad) - 1
        if v[squad].sum() + v[i] + RESERVE_PER_SPOT * left <= budget:
            squad.append(int(i)); return True
        return False
    for grp, k in mins.items():
        for i in order[g[order] == grp]:
            if sum(g[j] == grp for j in squad) >= k:
                break
            if i not in squad:
                add(i)
    for i in order:
        if len(squad) >= N:
            break
        if i not in squad and g[i] != "GK":
            add(i)
    for i in np.argsort(v):
        if len(squad) >= N:
            break
        if ok_age[i] and i not in squad:
            squad.append(int(i))
    return squad[:N]


def tuned_coach(df, formation, N, budget, lam=3, max_age=None, shares=(0.6, 0.7, 0.8, 0.9)):
    """Coach heuristic with the XI money share tuned (best XI quality over the grid)."""
    best, bq = None, -1
    for sh in shares:
        s = coach_heuristic(df, formation, N, budget, lam, sh, max_age)
        q = best_xi_from_squad(df, s, formation, lam)[1]
        if q == q and q > bq:
            best, bq = s, q
    return best if best is not None else coach_heuristic(df, formation, N, budget, lam, 0.75, max_age)


def topsis(df, weights, cols=("overall_n", "potential_n", "versatility_n")):
    X = df[list(cols)].values.astype(float)
    V = X / np.sqrt((X ** 2).sum(axis=0)) * np.array(weights)
    ideal, anti = V.max(axis=0), V.min(axis=0)
    dp, dm = np.sqrt(((V - ideal) ** 2).sum(axis=1)), np.sqrt(((V - anti) ** 2).sum(axis=1))
    return dm / (dp + dm)


def club_budget_scale(df, N=23):
    """Data-grounded budgets: market value of the best-N players of every club in the dataset."""
    g = (df.dropna(subset=["club_name"]).sort_values("overall", ascending=False)
           .groupby("club_name").head(N).groupby("club_name").agg(n=("value_m", "size"), value=("value_m", "sum")))
    return g[g.n >= N].value.sort_values(ascending=False)


def jaccard(a, b):
    a, b = set(a), set(b); return len(a & b) / len(a | b)


def evaluate_squad(df, squad, formation, p=0.10, S=300, seed=7, lam=3, label="", ref_squad=None, res=None):
    """Common yardstick for EVERY method, independent of how the squad was built:
         XI quality  = best lineup the squad can field (assignment problem)
         E[Q]        = mean best-lineup quality when each player is unavailable with probability p (Monte-Carlo)
         P5          = 5th percentile of that simulation (bad-luck scenario)"""
    xi, q = best_xi_from_squad(df, squad, formation, lam)
    sim = simulate_absence(df, squad, formation, p=p, S=S, seed=seed, lam=lam)
    ids = {i for i, _ in xi} if xi else set()
    g = df.group.values
    return {"Method": label, "XI quality": q, f"E[Q] (p={p:.0%})": float(sim.mean()), "P5": float(np.percentile(sim, 5)),
            "Cost (€M)": float(df.value_m.values[squad].sum()), "Mean age": float(df.age.values[squad].mean()),
            "GKs": int((g[squad] == "GK").sum()),
            "Overlap with model": jaccard(squad, ref_squad) if ref_squad is not None else np.nan}
# ======== notebook cell 12 (UI helpers) ========
SIDE_LABEL = {"FB": ("LB", "RB"), "WB": ("LWB", "RWB"), "WM": ("LM", "RM"), "W": ("LW", "RW")}

def lineup_layout(d, res):
    pools = {}
    for i, t in res["xi"]:
        pools.setdefault(t, []).append((i, res["eff"][(i, t)]))
    for t in pools:
        pools[t].sort(key=lambda p: (d.preferred_foot[p[0]] != "Left", d.short_name[p[0]]))
    out, nR = [], len(res["rows"])
    for r_idx, row in enumerate(res["rows"]):
        y = 8 + r_idx * (80 / max(nR - 1, 1))
        for j, t in enumerate(row):
            i, e = pools[t].pop(0)
            lab = SIDE_LABEL[t][0 if j == 0 else 1] if t in SIDE_LABEL else t
            out.append(dict(x=(j + 1) * 100 / (len(row) + 1), y=y, slot=lab, i=i, eff=e))
    return out

def squad_table(d, res):
    slot = {i: t for i, t in res["xi"]}
    back = {}
    for t, i in res.get("backups", {}).items():
        back.setdefault(i, []).append(t)
    t_ = d.loc[res["squad"], ["short_name", "age", "player_positions", "overall", "potential", "value_m", "ahp", "value_missing"]].copy()
    t_["Role"] = np.where(t_.index.isin(slot), "Starting XI", "Reserve")
    t_["Slot"] = [slot.get(i, "") for i in t_.index]
    t_["Slot rating"] = [res["eff"].get((i, slot[i]), np.nan) if i in slot else np.nan for i in t_.index]
    t_["Backup for"] = [", ".join(back.get(i, [])) for i in t_.index]
    t_ = t_.rename(columns={"short_name": "Player", "age": "Age", "player_positions": "Natural positions", "overall": "Overall", "potential": "Potential",
                            "value_m": "Value (€M)", "ahp": "Utility", "value_missing": "Price imputed"})
    t_["_o"] = (t_.Role != "Starting XI").astype(int)
    return t_.sort_values(["_o", "Overall"], ascending=[True, False]).drop(columns="_o")


# ======== notebook cell 78 ========
def run_scenario(df, formation, budget, N=23, lam=3, p_abs=0.10, max_age=None, overall_weight=None, strict=False, objective="expected", delta=0.0,
                 must=None, banned=None, must_start=None, time_limit=60):
    # Everything a UI needs for one scenario, returned as plain tables + the result object.
    d = df
    if overall_weight is not None:
        w0, _ = ahp_weights(AHP_MATRIX); d = df.copy()
        set_ahp(d, np.r_[overall_weight, w0[1:] / w0[1:].sum() * (1 - overall_weight)])
    r = optimise(d, formation, N, budget, lam=lam, p_abs=p_abs, max_age=max_age, strict=strict, objective=objective, delta=delta, time_limit=time_limit,
                 must=must, banned=banned, must_start=must_start)
    if r is None:
        return None
    ev = evaluate_squad(d, r["squad"], formation, p=p_abs, S=200, lam=lam)
    return {"result": r, "df": d, "squad": squad_table(d, r), "checks": validate(d, r, lam=lam, strict=strict, max_age=max_age),
            "kpis": {"Squad value (€M)": r["cost"], "Remaining budget (€M)": budget - r["cost"], "XI quality": r["xi_quality"], "Average XI rating": r["xi_quality"] / 11,
                     f"Expected quality (p={p_abs:.0%})": ev[f"E[Q] (p={p_abs:.0%})"], "5th-percentile quality": ev["P5"], "Mean age": ev["Mean age"]}}
