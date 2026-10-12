"""The browser labels slots with static/js/formation.js; the optimiser with squad_engine.sided_rows. They must agree
for every formation the site offers, or the pitch would show a player at a different position than the model chose."""
import json, os, shutil, subprocess, pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_js_and_python_side_labels_agree(app_module, se):
    forms = {name: rows for name, rows in se.FORMATIONS.items()}
    forms["custom: single winger"] = [["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["W", "ST", "ST"]]
    forms["custom: centre winger"] = [["GK"], ["FB", "CB", "CB", "FB"], ["CM", "CM", "CM"], ["ST", "W", "ST"]]
    url = "file:///" + os.path.join(ROOT, "static", "js", "formation.js").replace("\\", "/")
    script = (f"import({json.dumps(url)}).then(m => {{ const f = JSON.parse(process.argv[1]); const o = {{}};"
              "for (const k in f) o[k] = m.sidedRows(f[k]); console.log(JSON.stringify(o)); })")
    out = subprocess.run([NODE, "-e", script, json.dumps(forms)], capture_output=True, text=True, check=True).stdout
    js = json.loads(out)
    assert len(js) == len(forms) >= 34
    for name, rows in forms.items():
        assert js[name] == se.sided_rows(rows), name
