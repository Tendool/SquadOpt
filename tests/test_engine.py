"""Correctness of the optimisation model (squad_engine.py) on synthetic data.

The key guarantees:
  * pruning never changes the optimum (compared with the unpruned model)
  * two different MILP solvers (HiGHS, CBC) reach the same optimum
  * every returned squad passes an independent re-computation of all constraints
  * the reported objective, XI quality and depth are consistent with the chosen players
  * required / required-to-start / excluded players and the age exemption behave as documented"""
import numpy as np, pulp, pytest

SCENARIOS = [
    ("4-3-3", 120, {}),
    ("3-5-2", 80, {"max_age": 27}),
    ("4-2-3-1", 150, {"must_start": [0]}),          # L. Messi (38) must start, no age limit
    ("5-3-2", 100, {"banned": [8], "must": [7]}),   # no T. Courtois, V. van Dijk in the squad
    ("4-4-2", 90, {"must_start": [0], "max_age": 28}),
]


def eq_of(se, df, r):
    """Objective recomputed from the solution: (1-p) * sum of starter ratings + p * sum_t n_t * backup rating."""
    E = se.eff_table(df, 3, False)
    cnt = se.formation_counts(r["rows"])
    q = sum(E[t][i] for i, t in r["xi"])
    d = sum(cnt[t] * E[t][b] for t, b in r["backups"].items())
    return (1 - r["p_abs"]) * q + r["p_abs"] * d, q, d


@pytest.mark.parametrize("form,budget,kw", SCENARIOS)
def test_pruning_is_exact(se, df, form, budget, kw):
    full = se.optimise(df, form, 23, budget, prune=False, **kw)
    fast = se.optimise(df, form, 23, budget, **kw)
    legacy = se.optimise(df, form, 23, budget, prune_starters=False, **kw)
    assert full is not None and fast is not None and legacy is not None
    assert fast["eq"] == pytest.approx(full["eq"], abs=1e-6)
    assert legacy["eq"] == pytest.approx(full["eq"], abs=1e-6)
    assert fast["util"] == pytest.approx(full["util"], abs=1e-4)      # the AHP tie-break optimum is preserved too
    assert fast["pool_size"] <= legacy["pool_size"] <= full["pool_size"]


@pytest.mark.parametrize("form,budget,kw", SCENARIOS[:3])
def test_highs_and_cbc_agree(se, df, form, budget, kw, monkeypatch):
    highs = se.optimise(df, form, 23, budget, **kw)
    monkeypatch.setattr(se, "get_solver", lambda time_limit=120: pulp.PULP_CBC_CMD(msg=False, timeLimit=300))
    cbc = se.optimise(df, form, 23, budget, **kw)
    assert highs["eq"] == pytest.approx(cbc["eq"], abs=1e-6)
    assert highs["util"] == pytest.approx(cbc["util"], abs=1e-4)


@pytest.mark.parametrize("form,budget,kw", SCENARIOS)
def test_solution_is_consistent_and_valid(se, df, form, budget, kw):
    r = se.optimise(df, form, 23, budget, **kw)
    assert all(s == "Optimal" for s, _ in r["statuses"])
    eq, q, d = eq_of(se, df, r)
    assert r["eq"] == pytest.approx(eq) and r["xi_quality"] == pytest.approx(q) and r["depth"] == pytest.approx(d)
    starters = {i for i, _ in r["xi"]}
    assert set(r["backups"].values()).isdisjoint(starters)
    assert r["cost"] <= budget + 1e-6
    checks = se.validate(df, r, max_age=kw.get("max_age"))
    assert all(ok for _, ok in checks), [n for n, ok in checks if not ok]


def test_xi_objective_matches_hungarian(se, df):
    """With objective='xi' the ILP's XI must be the best lineup the chosen squad can field (assignment problem)."""
    r = se.optimise(df, "4-3-3", 23, 120, objective="xi")
    assert r["xi_quality"] == pytest.approx(se.lineup_quality(df, r["squad"], r["rows"]))


def test_depth_model_never_beats_xi_only_on_xi(se, df):
    """The expected-quality model may trade XI quality for depth, so its XI can't be better than the XI-only optimum."""
    xi = se.optimise(df, "4-3-3", 23, 120, objective="xi")
    ex = se.optimise(df, "4-3-3", 23, 120)
    assert ex["xi_quality"] <= xi["xi_quality"] + 1e-6


def test_required_player_and_age_exemption(se, df):
    r = se.optimise(df, "4-3-3", 23, 150, must=[0], max_age=28)
    assert 0 in r["squad"]
    assert all(df.age[i] <= 28 for i in r["squad"] if i != 0)
    assert df.age[0] > 28


def test_required_starter_is_in_xi(se, df):
    r = se.optimise(df, "4-4-2", 23, 150, must_start=[0])
    assert 0 in {i for i, _ in r["xi"]}


def test_excluded_player_never_selected(se, df):
    base = se.optimise(df, "4-3-3", 23, 300)
    star = base["squad"][0]
    r = se.optimise(df, "4-3-3", 23, 300, banned=[star])
    assert star not in r["squad"]


def test_starter_without_eligible_slot_raises(se, df):
    weak = int(df.index[(df.group != "GK") & (df.overall < 60)][0])
    with pytest.raises(ValueError):
        se.optimise(df, "4-3-3", 23, 300, must_start=[weak])


def test_infeasible_budget_reports_infeasible(se, df):
    assert se.optimise(df, "4-3-3", 23, 1) is None
    assert se.LAST_STATUSES[-1][0] == "Infeasible"


def test_tiebreak_timeout_keeps_stage1_optimum(se, df, monkeypatch):
    normal = se.optimise(df, "4-3-3", 23, 120)
    calls = {"n": 0}
    real_opt, real_name = se._is_optimal, se._status_name

    def fake_opt(m):
        calls["n"] += 1
        return real_opt(m) if calls["n"] == 1 else False

    monkeypatch.setattr(se, "_is_optimal", fake_opt)
    monkeypatch.setattr(se, "_status_name", lambda m: real_name(m) if calls["n"] == 0 else "Not Solved")
    r = se.optimise(df, "4-3-3", 23, 120)
    assert r is not None and r["tiebreak_done"] is False
    assert r["eq"] == pytest.approx(normal["eq"], abs=1e-6)
    assert all(ok for _, ok in se.validate(df, r))


def test_ahp_weights(se):
    w, cr = se.ahp_weights(se.AHP_MATRIX)
    assert w.sum() == pytest.approx(1) and cr < 0.10
    assert list(np.argsort(-w)) == [0, 1, 2]                 # overall > potential > versatility


def test_price_imputation(se, df):
    miss = df[df.value_missing]
    assert len(miss) > 0 and (miss.value_m > 0).all()


def test_monte_carlo_is_reproducible(se, df):
    r = se.optimise(df, "4-3-3", 23, 120)
    a = se.evaluate_squad(df, r["squad"], "4-3-3", S=100)
    b = se.evaluate_squad(df, r["squad"], "4-3-3", S=100)
    assert a == b
    assert a["P5"] <= a["E[Q] (p=10%)"] <= a["XI quality"] + 1e-9


# ---------------------------------------------------------------- side-specific positions (sides=True, used by the website)
def test_sided_rows(se):
    rows = se.sided_rows(se.FORMATIONS["4-3-3"])
    assert rows == [["GK"], ["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST", "RW"]]
    assert se.sided_rows([["GK"], ["W", "ST", "ST"]])[1] == ["LW", "ST", "ST"]          # single flank left of centre
    assert se.sided_rows([["GK"], ["ST", "W", "ST"]])[1] == ["ST", "W", "ST"]           # dead centre stays generic


@pytest.mark.parametrize("form,budget,kw", SCENARIOS[:4])
def test_sides_pruning_exact_and_valid(se, df, form, budget, kw):
    full = se.optimise(df, form, 23, budget, prune=False, sides=True, **kw)
    fast = se.optimise(df, form, 23, budget, sides=True, **kw)
    assert fast["eq"] == pytest.approx(full["eq"], abs=1e-6) and fast["util"] == pytest.approx(full["util"], abs=1e-4)
    checks = se.validate(df, fast, max_age=kw.get("max_age"))
    assert all(ok for _, ok in checks), [n for n, ok in checks if not ok]


def test_sides_highs_and_cbc_agree(se, df, monkeypatch):
    highs = se.optimise(df, "4-4-2", 23, 150, sides=True)
    monkeypatch.setattr(se, "get_solver", lambda time_limit=120: pulp.PULP_CBC_CMD(msg=False, timeLimit=300))
    cbc = se.optimise(df, "4-4-2", 23, 150, sides=True)
    assert highs["eq"] == pytest.approx(cbc["eq"], abs=1e-6)


@pytest.mark.parametrize("form", ["4-3-3", "4-4-2", "3-4-3", "5-3-2", "4-2-3-1", "3-5-2"])
def test_every_starter_uses_that_position_rating(se, df, form):
    """The rating a starter contributes is exactly the dataset rating for that slot, minus 3 only if not listed there."""
    r = se.optimise(df, form, 23, 200, sides=True)
    for i, t in r["xi"]:
        listed = bool(df.natural[i] & se.NATURAL[t])
        assert r["eff"][(i, t)] == pytest.approx(df["r_" + t][i] - (0 if listed else 3)), (df.short_name[i], t)


@pytest.mark.parametrize("form", ["4-3-3", "4-4-2", "3-4-3", "4-2-3-1"])
def test_pitch_labels_are_the_solved_positions(se, df, form):
    r = se.optimise(df, form, 23, 200, sides=True)
    solved = {i: t for i, t in r["xi"]}
    for q in se.lineup_layout(df, r):
        assert q["slot"] == solved[q["i"]]


def test_right_sided_star_starts_on_the_right(se, df):
    r = se.optimise(df, "4-3-3", 23, 300, must_start=[0], sides=True)       # L. Messi: listed RW, CAM; left-footed
    assert dict((i, t) for i, t in r["xi"])[0] == "RW"


def test_merged_mode_layout_respects_listed_side(se, df):
    """Notebook mode (sides=False): the model may pick two players for one flank pair; the layout must arrange each
    pair so that as many of them as possible stand on a side they are listed for."""
    listed = lambda i, lab: bool(df.natural[i] & se.NATURAL[lab])
    other = lambda lab: {"L": "R", "R": "L"}[lab[0]] + lab[1:]
    for form in ["4-3-3", "4-4-2", "4-2-3-1", "3-4-3"]:
        lay = {q["slot"]: q["i"] for q in se.lineup_layout(df, se.optimise(df, form, 23, 250))}
        for lab, i in lay.items():
            if lab in se.SIDE_TYPES and lab[0] == "L" and other(lab) in lay:
                j = lay[other(lab)]
                assert listed(i, lab) + listed(j, other(lab)) >= listed(j, lab) + listed(i, other(lab)), (form, lab)


# ---------------------------------------------------------------- randomised scenarios
@pytest.mark.parametrize("seed", range(12))
def test_random_scenarios_are_valid_and_exact(se, df, seed):
    rng = np.random.default_rng(seed)
    form = rng.choice(sorted(se.FORMATIONS))
    budget = float(rng.choice([90, 130, 200, 320]))
    stars = list(range(10))
    kw = {}
    if rng.random() < .5:
        kw["must_start"] = [int(rng.choice(stars))]
    if rng.random() < .4:
        kw["banned"] = [int(x) for x in rng.choice([s for s in stars if s not in kw.get("must_start", [])], 2, replace=False)]
    if rng.random() < .4:
        kw["max_age"] = int(rng.choice([25, 28, 31]))
    try:
        r = se.optimise(df, form, 23, budget, sides=True, **kw)
    except ValueError:                                   # a required starter with no eligible slot in this shape
        return
    if r is None:
        assert se.LAST_STATUSES[-1][0] == "Infeasible"
        return
    checks = se.validate(df, r, max_age=kw.get("max_age"))
    assert all(ok for _, ok in checks), (form, kw, [n for n, ok in checks if not ok])
    if seed % 3 == 0:                                    # spot-check optimality against the unpruned model
        full = se.optimise(df, form, 23, budget, sides=True, prune=False, **kw)
        assert r["eq"] == pytest.approx(full["eq"], abs=1e-6)
