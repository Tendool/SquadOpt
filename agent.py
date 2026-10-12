"""SquadOpt agent: a local Qwen model (via Ollama) that turns a request like
"EUR 400M, counter-attacking, Messi must play" into a call of the notebook's optimiser.

The LLM never picks players itself. It only fills in the optimiser's inputs through tools:
  search_players(name)  -> look a player up in the dataset
  build_squad(...)      -> run the exact ILP (squad_engine.run_scenario) with budget, formation, required players ...
and then explains the optimiser's answer. Every number shown to the user comes from the optimiser."""
import os, re, json, time, urllib.request, urllib.error
from dataclasses import dataclass
from typing import Callable

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("SQUAD_AGENT_MODEL", "qwen3.5:4b")
MAX_STEPS = 6

STRATEGY_GUIDE = """balanced / no style given -> 4-3-3
possession, tiki-taka, control the midfield -> 4-3-3 (DM)
high press, gegenpress, modern -> 4-2-3-1
all-out attack, lots of goals -> 4-2-4 or 3-4-3 (wide)
counter-attack, fast breaks, direct -> 4-4-2 or 4-2-1-3
wing play, crossing, width -> 4-4-2 (wingers) or 3-5-2 (wing-backs)
defensive, park the bus, solid, compact -> 5-4-1 or 5-3-2
narrow, central overload, through the middle -> 4-4-2 diamond or 4-2-3-1 (narrow)
two strikers, target man -> 3-5-2 or 4-4-2
an explicit formation like "3-5-2" -> use exactly that"""

TOOLS = [
    {"type": "function", "function": {
        "name": "search_players",
        "description": "Look up players in the FC 26 database by name. Use it when a requested player's name is ambiguous or you want to check who they are.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string", "description": "Player name or part of it, e.g. 'Messi'"}},
                       "required": ["name"]}}},
    {"type": "function", "function": {
        "name": "build_squad",
        "description": "Run the exact integer-programming optimiser and build the best squad and starting XI. This is the ONLY way to build a squad.",
        "parameters": {"type": "object", "properties": {
            "budget_m": {"type": "number", "description": "Transfer budget in millions of euros (EUR 1.2 billion = 1200)"},
            "formation": {"type": "string", "description": "One formation name copied exactly from the allowed list"},
            "must_start": {"type": "array", "items": {"type": "string"}, "description": "Names of players who MUST play in the starting XI (use this when the user says a player must be in the team / must play)"},
            "must_include": {"type": "array", "items": {"type": "string"}, "description": "Names of players who must be in the squad but may sit on the bench"},
            "exclude": {"type": "array", "items": {"type": "string"}, "description": "Names of players who must NOT be in the squad"},
            "max_age": {"type": "integer", "description": "Oldest allowed age; omit for no limit. Required players are exempt."},
            "squad_size": {"type": "integer", "description": "Squad size 18-30, default 23"},
            "absence_risk": {"type": "number", "description": "Chance a player misses a match, 0-0.5. Default 0.10; 0.2 for a deep, rotation-proof squad; 0 = only the XI matters"}},
            "required": ["budget_m", "formation"]}}},
]


@dataclass
class Tools:
    search: Callable          # name -> list of player cards (best first)
    build: Callable           # params dict (as /api/optimise) -> payload, raises on failure
    formations: list


def system_prompt(formations, context):
    last = ""
    if context:
        last = ("\nThe squad currently on screen was built with: " + json.dumps(context, ensure_ascii=False) +
                "\nIf the user asks for a change (cheaper, younger, another formation, add/remove a player), call build_squad again "
                "with the same settings except what they asked to change.")
    return f"""You are SquadOpt, a football squad-building assistant for an Operations Research project.
Squads are built ONLY by the build_squad tool, which runs an exact integer-programming optimiser over the FC 26 player database.
Never invent players, prices or ratings: use only what the tools return.

How to work:
1. Read the request: budget, playing strategy, players that must be included or excluded, age limit, squad size.
2. Translate the strategy into ONE formation from the allowed list using the guide.
3. Call build_squad once with those settings. A player the user insists on ("must have Messi", "Messi in my team") goes in
   must_start (just the name, e.g. "Messi"). Use must_include only if the user says the bench is fine.
4. When the tool returns, reply in 3-6 short sentences: the formation and why it fits the strategy, where each required player plays,
   two or three key signings, money spent and left, and the expected quality. Copy names, slots and numbers exactly from the
   tool result (the "starting_xi" lines say which slot each player plays).
If no budget is given, ask for one in a single short question.
If build_squad returns an error, do NOT call it again with the same settings. Explain the error in plain words and suggest
one concrete change. Never state a number (budget, price, rating) that did not come from the user or a tool result.
Budgets are in millions of euros. Treat pounds or dollars as euros and say so.

Strategy -> formation guide:
{STRATEGY_GUIDE}

Other settings: "young"/"for the future" -> max_age 24 unless a number is given; "experienced" -> no age limit;
"deep squad", "rotation", "injury-proof" -> absence_risk 0.2; "only the first eleven matters" -> absence_risk 0.

Allowed formations: {", ".join(formations)}{last}"""


# ---------------------------------------------------------------- Ollama
def _post(path, body, timeout=300):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def status():
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3) as r:
            names = [m["name"] for m in json.loads(r.read().decode()).get("models", [])]
    except Exception:
        return dict(ok=False, model=MODEL, error=f"Ollama is not running at {OLLAMA}. Start the Ollama app, then reload.")
    if MODEL not in names and MODEL + ":latest" not in names:
        return dict(ok=False, model=MODEL, error=f"Model {MODEL} is not pulled. Run: ollama pull {MODEL}")
    return dict(ok=True, model=MODEL)


def chat(messages, think=False):
    body = dict(model=MODEL, messages=messages, tools=TOOLS, stream=False, think=think,
                options=dict(temperature=0.2, num_ctx=8192), keep_alive="30m")
    try:
        return _post("/api/chat", body)["message"]
    except urllib.error.HTTPError as e:                 # older Ollama builds reject the `think` flag
        if e.code == 400 and "think" in body:
            body.pop("think")
            return _post("/api/chat", body)["message"]
        raise


_TOOL_TXT = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>|```(?:json)?\s*(\{\s*\"name\".*?\})\s*```", re.S)


def tool_calls(msg):
    """Native tool calls, or calls a small model wrote as text."""
    calls = [(c["function"]["name"], c["function"].get("arguments") or {}) for c in msg.get("tool_calls") or []]
    if calls:
        return calls
    for m in _TOOL_TXT.finditer(msg.get("content") or ""):
        try:
            d = json.loads(m.group(1) or m.group(2))
            calls.append((d["name"], d.get("arguments") or d.get("parameters") or {}))
        except Exception:
            pass
    return calls


def strip_think(text):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    return _TOOL_TXT.sub("", text).strip()


# ---------------------------------------------------------------- tool execution
def _num(v, default=None):
    if v is None or v == "":
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).lower().replace(",", "")
    m = re.search(r"[\d.]+", s)
    if not m:
        return default
    x = float(m.group())
    if re.search(r"\d\s*(b|bn|billion)\b", s):
        x *= 1000
    return x


def _formation(name, formations):
    if not name:
        return None
    if name in formations:
        return name
    key = lambda s: re.sub(r"[^0-9a-z]", "", s.lower())
    for f in formations:
        if key(f) == key(name):
            return f
    digits = "-".join(re.findall(r"\d", name))
    return digits if digits in formations else None


def _names(v):
    if isinstance(v, str):
        v = [s for s in re.split(r",| and ", v) if s.strip()]
    return [str(s).strip() for s in (v or []) if str(s).strip()]


_BUDGET_WORDS = re.compile(r"\d|million|billion|\bbn\b|\bmil\b|unlimited|no limit|any budget|whatever it costs|money is no", re.I)


def budget_given(history, context):
    """Did the user state a budget (or is one carried over from the squad on screen)? Small models invent one otherwise."""
    return bool(context and context.get("budget_m")) or any(m["role"] == "user" and _BUDGET_WORDS.search(m["content"]) for m in history)


def run_build(args, tools: Tools, budget_ok=True):
    """Validate the model's arguments, resolve names to dataset rows, run the optimiser.
    Generator: yields UI events as they happen and returns the tool reply for the model."""
    budget = _num(args.get("budget_m", args.get("budget")))
    if not budget or not budget_ok:
        return {"ok": False, "error": "The user has not given a budget. Do not guess one: ask the user how much they want to spend."}
    form = _formation(str(args.get("formation") or ""), tools.formations)
    if form is None:
        return {"ok": False, "error": f"Unknown formation '{args.get('formation')}'. Pick one from: {', '.join(tools.formations)}"}
    ids = {}
    for key in ("must_start", "must_include", "exclude"):
        ids[key] = []
        for n in _names(args.get(key)):
            hits = tools.search(n, 5)
            if not hits:
                return {"ok": False, "error": f"No player called '{n}' in the database. Ask the user to check the spelling."}
            p = hits[0]
            ids[key].append(p["id"])
            yield dict(type="resolved", role=key, query=n, player=p, alternatives=hits[1:4])
    max_age = _num(args.get("max_age"))
    params = dict(budget=budget, formation=form, size=int(_num(args.get("squad_size"), 23)), max_age=int(max_age) if max_age else 45,
                  p_abs=_num(args.get("absence_risk"), 0.10), must=ids["must_include"], must_start=ids["must_start"], exclude=ids["exclude"])
    params["size"] = min(max(params["size"], 18), 30)
    yield dict(type="solving", params=params)
    t0 = time.time()
    try:
        payload = tools.build(params)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    yield dict(type="squad", data=payload, seconds=round(time.time() - t0, 1))
    k = payload["kpis"]
    exp_key = next((n for n in k if n.startswith("Expected")), None)
    slot = {p["id"]: p["slot"] for p in payload["pitch"]}
    # plain one-line strings: a 4B model copies these far more faithfully than nested objects
    signings = sorted(payload["pitch"], key=lambda p: -p["value_m"])[:3]
    reply = {"ok": True, "formation": form, "budget": f"EUR {budget:g}M",
             "spent": f"EUR {k['Squad value (€M)']:.1f}M", "left": f"EUR {k['Remaining budget (€M)']:.1f}M",
             "xi_quality": round(k["XI quality"], 1), "average_xi_rating": round(k["Average XI rating"], 1),
             "expected_quality_with_absences": round(k[exp_key], 1) if exp_key else None, "mean_age": round(k["Mean age"], 1),
             "required_players": [f"{p['name']}: " + (f"starts at {slot[p['id']]}" if p["id"] in slot else "in the squad, on the bench") for p in payload["required"]],
             "excluded_players": [p["name"] for p in payload["excluded"]],
             "starting_xi": [f"{p['slot']}: {p['name']} (rating {round(p['rating'])}, EUR {p['value_m']:.1f}M)" for p in payload["pitch"]],
             "most_expensive_starters": [f"{p['name']} ({p['slot']}, EUR {p['value_m']:.1f}M)" for p in signings],
             "bench": [s["Player"] for s in payload["squad"] if s["Role"] != "Starting XI"],
             "max_age": params["max_age"] if params["max_age"] < 45 else None, "absence_risk": params["p_abs"]}
    if (ids["must_include"] or ids["must_start"]) and params["max_age"] < 45:
        reply["note"] = "Required players are exempt from the age limit."
    if payload["model"].get("tiebreak_done") is False:
        reply["note_tiebreak"] = "The AHP tie-break timed out; the squad is still optimal for expected quality."
    return reply


def run_search(args, tools: Tools):
    n = str(args.get("name") or args.get("query") or "").strip()
    hits = tools.search(n, 5) if n else []
    yield dict(type="searched", query=n, players=hits)
    return {"query": n, "matches": [
        {k: p[k] for k in ("name", "long_name", "age", "club", "positions", "overall", "value_m")} for p in hits]}


# ---------------------------------------------------------------- the loop
def run(history, context, tools: Tools, think=False):
    """Generator of UI events: status / tool / resolved / searched / solving / squad / tool_error / message / error / done."""
    st = status()
    if not st["ok"]:
        yield dict(type="error", text=st["error"]); yield dict(type="done"); return
    messages = [{"role": "system", "content": system_prompt(tools.formations, context)}] + history
    asks_for_build = bool(re.search(r"\d|budget|million|€|\$|£|\bbn\b|cheaper|younger|formation|add|remove|without|include|team|squad",
                                     history[-1]["content"], re.I))
    built, nudged, failed = False, False, {}
    for step in range(MAX_STEPS):
        yield dict(type="status", text="Qwen is reading your request…" if step == 0 else "Qwen is reading the optimiser's answer…")
        t0 = time.time()
        try:
            msg = chat(messages, think)
        except Exception as e:
            yield dict(type="error", text=f"Could not reach {MODEL} through Ollama: {e}"); break
        calls = tool_calls(msg)
        if not calls:
            text = strip_think(msg.get("content"))
            if asks_for_build and not built and not nudged and not failed and budget_given(history, context) and not text.rstrip().endswith("?"):
                nudged = True                         # small models sometimes answer in prose: ask once for the tool call
                messages += [{"role": "assistant", "content": msg.get("content") or ""},
                             {"role": "user", "content": "Call the build_squad tool now with the settings from my request."}]
                continue
            yield dict(type="message", text=text or "(no reply)", seconds=round(time.time() - t0, 1)); break
        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         "tool_calls": [{"function": {"name": n, "arguments": a}} for n, a in calls]})
        for name, args in calls:
            if isinstance(args, str):
                try: args = json.loads(args)
                except Exception: args = {}
            key = name + json.dumps(args, sort_keys=True, default=str)
            if key in failed:                         # a 4B model likes to retry the exact same failing call
                messages.append({"role": "tool", "tool_name": name, "content": json.dumps(
                    {"ok": False, "error": f"You already made this exact call and it failed: {failed[key]} Do not retry; explain it to the user."})})
                continue
            yield dict(type="tool", name=name, args=args)
            if name == "build_squad":
                reply = yield from run_build(args, tools, budget_given(history, context))
                built = built or reply.get("ok", False)
                if not reply.get("ok", False):
                    failed[key] = reply.get("error", "")
            elif name == "search_players":
                reply = yield from run_search(args, tools)
            else:
                reply = {"ok": False, "error": f"Unknown tool {name}"}
            if reply.get("ok") is False:
                yield dict(type="tool_error", name=name, text=reply["error"])
            messages.append({"role": "tool", "tool_name": name, "content": json.dumps(reply, ensure_ascii=False)})
    else:
        yield dict(type="message", text="I stopped after several steps without finishing. Try rephrasing with a budget and a style.")
    yield dict(type="done")
