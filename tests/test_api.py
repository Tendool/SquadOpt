"""Flask API on synthetic data: happy path, validation errors, search."""


def test_meta(client):
    m = client.get("/api/meta").get_json()
    assert m["players"] == 610 and "4-3-3" in m["formations"] and len(m["formations"]) == 32
    assert abs(sum(m["ahp"]["weights"]) - 1) < 1e-9 and m["ahp"]["cr"] < 0.1


def test_search_handles_accents_and_full_names(client):
    names = lambda q: [p["name"] for p in client.get("/api/players", query_string={"q": q}).get_json()["players"]]
    assert names("messi")[0] == "L. Messi"
    assert names("leo messi")[0] == "L. Messi"            # falls back to the most specific word
    assert names("mbappe")[0] == "K. Mbappé"              # accent-insensitive
    assert names("zzzz") == []


def test_optimise_happy_path(client):
    r = client.post("/api/optimise", json={"formation": "4-2-3-1", "budget": 150, "must_start": [0], "exclude": [1]})
    assert r.status_code == 200
    d = r.get_json()
    assert all(c["ok"] for c in d["checks"])
    assert 0 in {p["id"] for p in d["pitch"]}
    assert d["required"][0]["start"] is True and d["excluded"][0]["id"] == 1
    assert len(d["squad"]) == 23 and d["kpis"]["Squad value (€M)"] <= 150 + 1e-6
    assert d["model"]["tiebreak_done"] is True


def test_custom_formation(client):
    r = client.post("/api/optimise", json={"custom": [["FB", "CB", "CB", "FB"], ["DM", "CM", "AM"], ["W", "ST", "W"]], "budget": 120})
    assert r.status_code == 200 and r.get_json()["formation"] == "Custom"


def test_bad_inputs_return_json_errors(client):
    for body in ({"formation": "9-9-9", "budget": 100}, {"formation": "4-3-3", "budget": "lots"},
                 {"formation": "4-3-3", "budget": 100, "must": [0], "exclude": [0]},
                 {"formation": "4-3-3", "budget": 100, "size": 40},
                 {"formation": "4-3-3", "budget": 100, "must_start": list(range(12))},
                 {"custom": [["CB"]], "budget": 100}):
        r = client.post("/api/optimise", json=body)
        assert r.status_code == 400 and "error" in r.get_json(), body


def test_required_players_over_budget(client):
    r = client.post("/api/optimise", json={"formation": "4-3-3", "budget": 5, "must": [2]})
    assert r.status_code == 422 and "cost" in r.get_json()["error"]


def test_infeasible(client):
    r = client.post("/api/optimise", json={"formation": "4-3-3", "budget": 2})
    assert r.status_code == 422 and "No valid squad" in r.get_json()["error"]


def _formations(app_module):
    import squad_engine as se
    return sorted(se.FORMATIONS)


def test_every_formation_builds_with_correct_positions(client, app_module):
    """All 32 shapes: the squad is valid, every slot carries the side-specific label the model solved, and the
    reported rating is that position's dataset rating minus 3 only when the player is not listed there."""
    import squad_engine as se
    for name in _formations(app_module):
        r = client.post("/api/optimise", json={"formation": name, "budget": 200})
        assert r.status_code == 200, (name, r.get_json())
        d = r.get_json()
        assert all(c["ok"] for c in d["checks"]), (name, [c["name"] for c in d["checks"] if not c["ok"]])
        labels = [t for row in se.sided_rows(se.FORMATIONS[name]) for t in row]
        assert [p["slot"] for p in d["pitch"]] == labels, name
        for p in d["pitch"]:
            assert p["rating"] == p["slot_base"] - (0 if p["listed"] else 3), (name, p["name"], p["slot"])
        assert len({p["id"] for p in d["pitch"]}) == 11
        for s in d["squad"]:
            grid = s["pos_ratings"]
            assert grid and all(len(x) == 3 for x in grid)


def test_payload_explains_positions(client):
    d = client.post("/api/optimise", json={"formation": "4-3-3", "budget": 150, "must_start": [0]}).get_json()
    messi = next(p for p in d["pitch"] if p["id"] == 0)
    assert messi["slot"] == "RW" and messi["listed"] is True            # listed RW, CAM -> right wing, not left
    row = next(s for s in d["squad"] if s["id"] == 0)
    grid = {t: (r, listed) for t, r, listed in row["pos_ratings"]}
    assert grid["RW"][1] is True and grid["LW"][1] is False and grid["AM"][1] is True
