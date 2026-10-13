"""Custom formation builder (static/js/formation.js CUSTOM_LINES) against the optimiser (squad_engine).

Every position the builder offers must be a slot type the engine knows, with its own rating column, in the line
(group) the engine puts it in; a shape built from them must reach the optimiser unchanged, and the explicit
left/right codes must give exactly what the generic flank codes give under sides=True."""
import json, os, shutil, subprocess, pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed")
LINE_GROUP = {"Defence": "DEF", "Midfield": "MID", "Attack": "FWD"}


def js(expr):
    url = "file:///" + os.path.join(ROOT, "static", "js", "formation.js").replace("\\", "/")
    script = f"import({json.dumps(url)}).then(m => console.log(JSON.stringify({expr})))"
    return json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout)


@needs_node
def test_builder_positions_are_engine_slot_types_in_the_right_line(se, df):
    lines = js("m.CUSTOM_LINES")
    offered = [t for line in lines for t in line["options"]]
    assert len(offered) == len(set(offered))
    for line in lines:
        for t in line["options"]:
            assert t in se.ALL_TYPES, t                                   # validate_formation accepts it
            assert se.GROUP_OF_TYPE[t] == LINE_GROUP[line["name"]], t     # same line as the engine's squad minimums
            assert "r_" + t in df and t in se.NATURAL, t                  # own rating column and listing rule
    # every engine slot type is offered once: as itself, or (flank types) as its explicit left/right pair
    covered = set(offered) | {t for t, pair in se.SIDE_OF.items() if set(pair) <= set(offered)}
    assert covered == set(se.ALL_TYPES) - {"GK"}
    assert not set(offered) & ({"GK", "ANY"} | set(se.SIDE_OF))           # GK is fixed; no generic duplicates


SHAPES = {   # builder lines (Defence, Midfield, Attack) for standard shapes; the builder groups lines as the engine does,
            # so 3-4-3's wing-backs sit in the back line. Slot types and counts, and so the optimum, are the same.
    "4-3-3": [["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST", "RW"]],
    "4-4-2": [["LB", "CB", "CB", "RB"], ["LM", "CM", "CM", "RM"], ["ST", "ST"]],
    "4-4-2 diamond": [["LB", "CB", "CB", "RB"], ["DM", "CM", "CM", "AM"], ["ST", "ST"]],
    "3-4-3": [["LWB", "CB", "CB", "CB", "RWB"], ["CM", "CM"], ["LW", "ST", "RW"]],
}


@needs_node
@pytest.mark.parametrize("name", sorted(SHAPES))
def test_builder_shape_equals_the_standard_formation(se, df, name):
    """The builder's explicit codes are what sided_rows makes of the standard shape, so the optimum is identical."""
    custom = [["GK"]] + SHAPES[name]
    assert js(f"m.customStatus({json.dumps(SHAPES[name])}).ok") is True
    assert se.sided_rows(custom) == custom                                   # explicit sides are kept as they are
    assert se.formation_counts(custom) == se.formation_counts(se.sided_rows(se.FORMATIONS[name]))
    a = se.optimise(df, custom, 23, 150, sides=True, distinct_backups=True)
    b = se.optimise(df, name, 23, 150, sides=True, distinct_backups=True)
    assert a["eq"] == pytest.approx(b["eq"], abs=1e-6) and a["squad"] == b["squad"] and sorted(a["xi"]) == sorted(b["xi"])


@needs_node
def test_custom_shape_reaches_the_optimiser_and_the_pitch(client):
    lines = [["LWB", "CB", "CB", "CB", "RWB"], ["DM", "AM"], ["LW", "ST", "RW"]]          # 5-2-3, unusual but valid
    assert js(f"m.customStatus({json.dumps(lines)}).ok") is True
    d = client.post("/api/optimise", json={"custom": lines, "budget": 150}).get_json()
    assert d["formation"] == "Custom" and d["rows"] == [["GK"]] + lines
    assert sorted(p["slot"] for p in d["pitch"]) == sorted(["GK"] + [t for l in lines for t in l])
    assert all(c["ok"] for c in d["checks"])
    by_slot = {}
    for p in d["pitch"]:
        by_slot.setdefault(p["slot"], []).append(p)
    for p in by_slot["LWB"] + by_slot["RW"]:                       # a flank slot is scored with that side's rating
        assert p["rating"] == pytest.approx(p["slot_base"] - (0 if p["listed"] else 3))


@needs_node
def test_incomplete_or_wrong_shapes_are_blocked(client):
    for lines in ([[], [], []], [["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST"]],
                  [[], ["DM", "DM", "CM", "CM", "AM", "LM", "RM"], ["LW", "ST", "RW"]],
                  [["LB", "CB", "CB", "RB"], ["LM", "CM", "CM", "CM", "AM", "RM"], []],
                  [["LB", "CB", "CB", "ST"], ["CM", "CM", "CM"], ["LW", "ST", "RW"]]):
        assert js(f"m.customStatus({json.dumps(lines)}).ok") is False, lines
    # the API still refuses a shape that is not 10 outfield slots (unchanged server-side check)
    r = client.post("/api/optimise", json={"custom": [["LB", "CB", "CB", "RB"], ["CM", "CM", "CM"], ["LW", "ST"]], "budget": 150})
    assert r.status_code == 400


def test_standard_formations_unchanged(se):
    assert se.FORMATIONS["4-3-3"] == [["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "W"]]
    assert se.FORMATIONS["4-4-2 diamond"] == [["GK"], ["FB", "CB", "CB", "FB"], ["DM"], ["CM", "CM"], ["AM"], ["ST", "ST"]]
