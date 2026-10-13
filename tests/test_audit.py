"""Backup policy, solver-status reporting and regression tests (added with the model audit).

  * distinct_backups=True: every designated backup covers one slot type, so D never counts one reserve for two
    absences that can happen at the same time; the model stays exact under pruning and agrees with CBC
  * backup eligibility: out-of-position backups are allowed at rating - 3 (the same rule as starters and as the
    Monte Carlo lineups); backup_listed_only=True restricts them to listed positions
  * a solve that stops at its time limit is never reported as optimal
  * a time-out or failure in stage 1 returns None; one in the stage-2 tie-break keeps the stage-1 optimum"""
import collections, os, types
import numpy as np, pulp, pytest

FORMS = ["4-4-2 diamond", "4-3-3", "3-5-2", "4-2-3-1", "5-3-2"]


def recompute(se, df, r):
    """Objective, XI quality and D from the raw ratings, without using anything the solver returned except the choices."""
    cnt = se.formation_counts(r["rows"])
    nat = lambda i, t: t == "GK" or bool(df.natural.values[i] & se.NATURAL[t])
    rating = lambda i, t: float(df["r_" + t].values[i]) - (0 if nat(i, t) else r["lam"])
    q = sum(rating(i, t) for i, t in r["xi"])
    d = sum(cnt[t] * rating(b, t) for t, b in r["backups"].items())
    return (1 - r["p_abs"]) * q + r["p_abs"] * d, q, d


def check_all(se, df, r, budget, N=23, max_age=None, must=(), banned=()):
    """Every constraint re-derived from the dataset."""
    cnt = se.formation_counts(r["rows"])
    sq = set(r["squad"])
    assert len(r["squad"]) == len(sq) == N                                         # size, uniqueness
    assert float(df.value_m.values[r["squad"]].sum()) <= budget + 1e-6               # budget
    assert collections.Counter(t for _, t in r["xi"]) == cnt                          # formation
    starters = [i for i, _ in r["xi"]]
    assert len(set(starters)) == 11 and set(starters) <= sq                          # one slot per starter
    if max_age is not None:
        assert all(df.age.values[i] <= max_age for i in sq - set(must))              # age (required players exempt)
    assert set(must) <= sq and not (set(banned) & sq)
    assert set(r["backups"]) == {t for t in cnt if t != "ANY"}                       # one backup per slot type
    for t, b in r["backups"].items():
        assert b in sq and b not in starters                                         # backups are reserves
        assert df.group.values[b] != "GK" or t == "GK"
        assert t != "GK" or df.group.values[b] == "GK"
    eq, q, d = recompute(se, df, r)
    assert r["xi_quality"] == pytest.approx(q, abs=1e-6) and r["depth"] == pytest.approx(d, abs=1e-6)
    assert r["eq"] == pytest.approx(eq, abs=1e-6)
    assert r["eq_solver"] == pytest.approx(eq, abs=1e-4)                             # what HiGHS reported
    for t, b in r["backups"].items():
        assert float(df["r_" + t].values[b]) - (0 if t == "GK" or df.natural.values[b] & se.NATURAL[t] else 3) >= r["backup_floor"] - 1e-9
    bad = [n for n, ok in se.validate(df, r, max_age=max_age) if not ok]
    assert not bad, bad


# ---------------------------------------------------------------- distinct backups
@pytest.mark.parametrize("form", FORMS)
@pytest.mark.parametrize("budget", [70, 150, 400])
def test_distinct_backups_valid_and_one_type_each(se, df, form, budget):
    r = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True)
    assert r is not None, se.LAST_STATUSES
    assert all(s == "Optimal" for s, _ in r["statuses"])
    assert len(set(r["backups"].values())) == len(r["backups"])
    check_all(se, df, r, budget)
    assert ("Each designated backup covers one position", True) in se.validate(df, r)


@pytest.mark.parametrize("form,budget,kw", [("4-4-2 diamond", 150, {"max_age": 30}), ("4-3-3", 120, {"must_start": [0]}),
                                            ("3-5-2", 90, {"banned": [8], "must": [7]})])
def test_distinct_backups_pruning_exact_and_cbc_agrees(se, df, form, budget, kw, monkeypatch):
    fast = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True, **kw)
    full = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True, prune=False, **kw)
    assert fast["eq"] == pytest.approx(full["eq"], abs=1e-6) and fast["util"] == pytest.approx(full["util"], abs=1e-4)
    assert fast["pool_size"] <= full["pool_size"]
    monkeypatch.setattr(se, "get_solver", lambda time_limit=120: pulp.PULP_CBC_CMD(msg=False, timeLimit=300))
    cbc = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True, **kw)
    assert cbc["eq"] == pytest.approx(fast["eq"], abs=1e-6)
    check_all(se, df, fast, budget, max_age=kw.get("max_age"), must=kw.get("must", []) + kw.get("must_start", []), banned=kw.get("banned", []))


@pytest.mark.parametrize("N,cap", [(18, 2), (19, 2), (20, 1), (23, 1)])
def test_small_squads_use_the_smallest_feasible_cap(se, df, N, cap):
    """4-2-3-1 has 9 slot types; with N - 11 reserves the tightest feasible cap is ceil(9 / (N - 11))."""
    r = se.optimise(df, "4-2-3-1", N, 200, sides=True, distinct_backups=True)
    assert r is not None, se.LAST_STATUSES
    assert r["backup_cap"] == cap and len(r["backups"]) == 9
    assert max(collections.Counter(r["backups"].values()).values()) <= cap
    check_all(se, df, r, 200, N=N)


def test_api_small_squad(client):
    d = client.post("/api/optimise", json={"formation": "4-2-3-1", "budget": 200, "size": 18}).get_json()
    assert d["model"]["backup_cap"] == 2 and all(c["ok"] for c in d["checks"])


def test_distinct_is_a_restriction_of_shared(se, df):
    """Distinctness only removes options: the distinct optimum can never beat the shared one on the model objective."""
    for form, budget in [("4-4-2 diamond", 150), ("4-3-3", 300), ("3-5-2", 80)]:
        sh = se.optimise(df, form, 23, budget, sides=True)
        di = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True)
        assert di["eq"] <= sh["eq"] + 1e-6
        assert max(collections.Counter(di["backups"].values()).values()) == 1


def test_shared_mode_can_overload_one_reserve(se, df):
    """Regression for the audit finding (one reserve designated for 7 slot types): in the original shared model
    one reserve may cover several types; the distinct model never does. Fixed synthetic data, so deterministic."""
    sh = se.optimise(df, "4-4-2 diamond", 23, 150, max_age=30, sides=True)
    di = se.optimise(df, "4-4-2 diamond", 23, 150, max_age=30, sides=True, distinct_backups=True)
    assert max(collections.Counter(sh["backups"].values()).values()) > 1
    assert max(collections.Counter(di["backups"].values()).values()) == 1


def test_validate_flags_a_shared_backup_under_the_distinct_policy(se, df):
    r = dict(se.optimise(df, "4-3-3", 23, 200, sides=True, distinct_backups=True))
    t1, t2 = [t for t in r["backups"] if t != "GK"][:2]
    r["backups"] = dict(r["backups"], **{t2: r["backups"][t1]})
    names = {n: ok for n, ok in se.validate(df, r)}
    assert names["Each designated backup covers one position"] is False


def test_validate_flags_an_ineligible_backup(se, df):
    r = dict(se.optimise(df, "4-3-3", 23, 200, sides=True, distinct_backups=True))
    gk_reserve = next(i for i in r["squad"] if df.group.values[i] == "GK" and i not in {j for j, _ in r["xi"]})
    r["backups"] = dict(r["backups"], ST=gk_reserve)                    # a goalkeeper as cover for the striker
    ok = dict(se.validate(df, r))
    assert not all(ok.values())
    assert ok[next(n for n in ok if n.startswith("Designated backups are eligible"))] is False


# ---------------------------------------------------------------- backup eligibility
def test_out_of_position_backup_is_penalised_like_a_starter(se, df):
    """Default rule: a reserve may cover a position they are not listed at, counted at their dataset rating minus 3
    (the same rule as for starters and in the Monte Carlo lineups). These two cases do pick such a backup."""
    for form, budget in [("4-2-3-1", 50), ("3-4-3", 70)]:
        r = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True)
        cnt = se.formation_counts(r["rows"])
        unlisted = [(t, b) for t, b in r["backups"].items() if t != "GK" and not (df.natural.values[b] & se.NATURAL[t])]
        assert unlisted, (form, budget)
        d = sum(cnt[t] * (float(df["r_" + t].values[b]) - (3 if (t, b) in unlisted else 0)) for t, b in r["backups"].items())
        assert r["depth"] == pytest.approx(d)
        check_all(se, df, r, budget)


@pytest.mark.parametrize("form,budget", [("4-4-2 diamond", 150), ("4-3-3", 300), ("3-5-2", 120)])
def test_listed_only_backups(se, df, form, budget):
    r = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True, backup_listed_only=True)
    assert r is not None
    for t, b in r["backups"].items():
        assert t == "GK" or bool(df.natural.values[b] & se.NATURAL[t]), (t, df.short_name[b])
    check_all(se, df, r, budget)
    pen = se.optimise(df, form, 23, budget, sides=True, distinct_backups=True)
    assert r["eq"] <= pen["eq"] + 1e-6                                  # a restriction of the penalised rule


# ---------------------------------------------------------------- solver status reporting
def _fake_model(status, sol_status):
    return types.SimpleNamespace(status=status, sol_status=sol_status)


def test_time_limit_is_not_reported_as_optimal(se):
    """PuLP maps a HiGHS/CBC time-limit stop with an incumbent to status Optimal + solution IntegerFeasible."""
    tl = _fake_model(pulp.LpStatusOptimal, pulp.LpSolutionIntegerFeasible)
    assert se._is_optimal(tl) is False
    assert "time limit" in se._status_name(tl).lower() and se._status_name(tl) != "Optimal"
    ok = _fake_model(pulp.LpStatusOptimal, pulp.LpSolutionOptimal)
    assert se._is_optimal(ok) is True and se._status_name(ok) == "Optimal"
    inf = _fake_model(pulp.LpStatusInfeasible, pulp.LpSolutionInfeasible)
    assert se._is_optimal(inf) is False and se._status_name(inf) == "Infeasible"


def test_real_time_limit_on_the_unpruned_model(se, df):
    """A real HiGHS run with a tiny time limit: whatever it returns must not claim optimality it has not proven."""
    r = se.optimise(df, "4-3-3", 23, 200, sides=True, distinct_backups=True, prune=False, time_limit=0.05)
    names = [s for s, _ in se.LAST_STATUSES]
    if r is None:
        assert names[-1] != "Optimal"                                 # a failed stage is never labelled optimal
    else:
        assert names[0] == "Optimal"                                  # a squad is only returned when stage 1 is proven
        assert r["tiebreak_done"] is (names[-1] == "Optimal")


def test_stage1_timeout_returns_none_and_is_not_infeasible(se, df, monkeypatch):
    monkeypatch.setattr(se, "_is_optimal", lambda m: False)
    monkeypatch.setattr(se, "_status_name", lambda m: "Not proven optimal (time limit)")
    assert se.optimise(df, "4-3-3", 23, 200, sides=True, distinct_backups=True) is None
    assert se.LAST_STATUSES == [se.LAST_STATUSES[0]] and se.LAST_STATUSES[0][0] == "Not proven optimal (time limit)"


@pytest.mark.parametrize("failure", ["Not proven optimal (time limit)", "Not Solved", "Infeasible"])
def test_stage2_failure_keeps_stage1_optimum(se, df, monkeypatch, failure):
    normal = se.optimise(df, "4-4-2 diamond", 23, 150, sides=True, distinct_backups=True)
    real_opt, real_name, n = se._is_optimal, se._status_name, {"opt": 0, "name": 0}

    def fake_opt(m):
        n["opt"] += 1
        return real_opt(m) if n["opt"] == 1 else False

    def fake_name(m):
        n["name"] += 1
        return real_name(m) if n["name"] == 1 else failure

    monkeypatch.setattr(se, "_is_optimal", fake_opt)
    monkeypatch.setattr(se, "_status_name", fake_name)
    r = se.optimise(df, "4-4-2 diamond", 23, 150, sides=True, distinct_backups=True)
    assert r is not None and r["tiebreak_done"] is False
    assert [s for s, _ in r["statuses"]] == ["Optimal", failure]
    assert r["eq"] == pytest.approx(normal["eq"], abs=1e-6)                     # the stage-1 optimum is kept
    assert r["eq_solver"] == pytest.approx(normal["eq_solver"], abs=1e-6)
    check_all(se, df, r, 150)


def test_api_reports_stage1_timeout_as_504_not_infeasible(client, app_module, monkeypatch):
    se = app_module.se
    monkeypatch.setattr(se, "_is_optimal", lambda m: False)
    monkeypatch.setattr(se, "_status_name", lambda m: "Not proven optimal (time limit)")
    r = client.post("/api/optimise", json={"formation": "4-3-3", "budget": 200})
    assert r.status_code == 504
    msg = r.get_json()["error"]
    assert "time limit" in msg and "No valid squad" not in msg


def test_api_reports_tiebreak_failure_and_policy(client, app_module, monkeypatch):
    se = app_module.se
    real_opt, n = se._is_optimal, {"k": 0}

    def fake_opt(m):
        n["k"] += 1
        return real_opt(m) if n["k"] == 1 else False

    monkeypatch.setattr(se, "_is_optimal", fake_opt)
    d = client.post("/api/optimise", json={"formation": "4-4-2 diamond", "budget": 150}).get_json()
    m = d["model"]
    assert m["tiebreak_done"] is False and m["statuses"][0][0] == "Optimal"
    assert m["distinct_backups"] is True and m["backup_penalty"] == 3
    assert all(c["ok"] for c in d["checks"]), [c for c in d["checks"] if not c["ok"]]


def test_api_backup_detail(client):
    d = client.post("/api/optimise", json={"formation": "4-4-2 diamond", "budget": 150}).get_json()
    m = d["model"]
    ids = [b["id"] for b in m["backup_detail"]]
    assert len(ids) == len(set(ids)) == len(m["backups"])
    names = {c["name"] for c in d["checks"]}
    assert "Each designated backup covers one position" in names and "Objective matches the solver" in names
    for b in m["backup_detail"]:
        assert b["rating"] == pytest.approx(b["base"] - (0 if b["listed"] else 3))
        assert b["rating"] >= 65


# ---------------------------------------------------------------- deterministic regression on the fixed synthetic data
def test_regression_synthetic_diamond(se, df):
    """Exact numbers on the fixed synthetic dataset (seed 3); the Monte Carlo is seeded, so all of this is repeatable."""
    a = se.run_scenario(df, "4-4-2 diamond", 150, N=23, max_age=30, p_abs=0.10, sides=True, distinct_backups=True)
    b = se.run_scenario(df, "4-4-2 diamond", 150, N=23, max_age=30, p_abs=0.10, sides=True, distinct_backups=True)
    ra, rb = a["result"], b["result"]
    assert ra["squad"] == rb["squad"] and ra["backups"] == rb["backups"] and ra["xi"] == rb["xi"]
    assert a["kpis"] == b["kpis"]
    assert all(ok for _, ok in a["checks"])
    # pinned values (synthetic seed 3): distinct backups keep the XI and lower the modelled D, 820 -> 795
    assert ra["xi_quality"] == 866 and ra["depth"] == 795 and ra["eq"] == pytest.approx(858.9)
    assert a["kpis"]["Expected quality (p=10%)"] == pytest.approx(857.94, abs=0.01)
    sh = se.run_scenario(df, "4-4-2 diamond", 150, N=23, max_age=30, p_abs=0.10, sides=True)
    assert sh["result"]["xi_quality"] == 866 and sh["result"]["depth"] == 820 and sh["result"]["eq"] == pytest.approx(861.4)
    assert sh["kpis"]["Expected quality (p=10%)"] == pytest.approx(859.825, abs=0.01)
    # the model's objective minus the simulated expected quality: the overstatement shrinks with distinct backups
    assert ra["eq"] - a["kpis"]["Expected quality (p=10%)"] < sh["result"]["eq"] - sh["kpis"]["Expected quality (p=10%)"]


# ---------------------------------------------------------------- the audited real-data scenario (skipped without the CSV)
REAL = os.environ.get("FC26_CSV") if os.environ.get("FC26_CSV", "").lower().endswith(".csv") and "synthetic" not in os.environ.get("FC26_CSV", "") else None
REAL = REAL or next((p for p in [os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "FC26_20250921.csv")] if os.path.exists(p)), None)


@pytest.mark.skipif(REAL is None or not os.path.exists(REAL or ""), reason="real FC26 CSV not available (set FC26_CSV or put data/FC26_20250921.csv)")
def test_real_fc26_diamond_475(se):
    df = se.add_utilities(se.load_players(REAL)); df.attrs["tag"] = "real"
    for distinct in (False, True):
        out = se.run_scenario(df, "4-4-2 diamond", 475, N=23, max_age=30, p_abs=0.10, time_limit=600, sides=True, distinct_backups=distinct)
        r = out["result"]
        assert [s for s, _ in r["statuses"]] == ["Optimal", "Optimal"]
        check_all(se, df, r, 475, max_age=30)
        if distinct:
            assert max(collections.Counter(r["backups"].values()).values()) == 1
        else:
            assert r["xi_quality"] == pytest.approx(921) and r["eq"] == pytest.approx(916.4, abs=0.05)   # audited numbers
