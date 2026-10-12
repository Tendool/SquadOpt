"""SYNTHETIC test data in the FC 26 column layout. Names and ratings are invented; never use for results.

make_csv(path, n) writes a CSV that squad_engine.load_players can read. A few fixed "stars" (rows 0-9) give the
tests stable names to search for and require."""
import numpy as np, pandas as pd

COLS = ["gk", "lb", "lwb", "cb", "cdm", "cm", "cam", "lm", "lw", "st"]
XY = {"lb": (0, 1), "lwb": (.5, 1), "cb": (0, 0), "cdm": (1, 0), "cm": (2, 0), "cam": (3, 0), "lm": (2, 1), "lw": (3, 1), "st": (4, 0)}
PRIM = {"LB": "lb", "RB": "lb", "CB": "cb", "CDM": "cdm", "CM": "cm", "CAM": "cam", "LM": "lm", "RM": "lm", "LW": "lw", "RW": "lw", "ST": "st"}
NEAR = {"LB": ["LM", "CB"], "RB": ["RM", "CB"], "CB": ["CDM", "RB"], "CDM": ["CM", "CB"], "CM": ["CDM", "CAM"], "CAM": ["CM", "ST"],
        "LM": ["LW", "LB"], "RM": ["RW", "RB"], "LW": ["LM", "ST"], "RW": ["RM", "ST"], "ST": ["CAM", "LW"]}
SHARE = {"GK": 9, "CB": 18, "LB": 7, "RB": 7, "CDM": 8, "CM": 13, "CAM": 7, "LM": 5, "RM": 5, "LW": 4, "RW": 4, "ST": 13}
SYL = ["ka", "ro", "mi", "len", "dor", "sa", "vi", "to", "mar", "ez", "lu", "ber", "gon", "fa", "ri", "no", "tal", "chi", "ves", "an"]
STARS = [("L. Messi", "Lionel Andrés Messi Cuccittini", "RW, CAM", 38, 86, 86, "Left"),
         ("Cristiano Ronaldo", "Cristiano Ronaldo dos Santos Aveiro", "ST", 40, 85, 85, "Right"),
         ("K. Mbappé", "Kylian Mbappé Lottin", "ST, LW", 26, 91, 94, "Right"),
         ("E. Haaland", "Erling Braut Haaland", "ST", 25, 90, 93, "Left"),
         ("Vini Jr.", "Vinícius José Paixão de Oliveira Júnior", "LW", 25, 89, 91, "Right"),
         ("J. Bellingham", "Jude Victor William Bellingham", "CAM, CM", 22, 89, 93, "Right"),
         ("Rodri", "Rodrigo Hernández Cascante", "CDM", 29, 90, 90, "Right"),
         ("V. van Dijk", "Virgil van Dijk", "CB", 34, 88, 88, "Right"),
         ("T. Courtois", "Thibaut Courtois", "GK", 33, 89, 89, "Left"),
         ("Lamine Yamal", "Lamine Yamal Nasraoui Ebana", "RW", 18, 89, 95, "Left")]


def make_frame(n=3000, seed=1):
    rng = np.random.default_rng(seed)
    clubs = [f"FC {a}{b}".title() for a in SYL[:12] for b in SYL[12:]]

    def name():
        s = "".join(rng.choice(SYL, rng.integers(2, 4))).title()
        return f"{chr(65 + rng.integers(0, 26))}. {s}", f"{''.join(rng.choice(SYL, 2)).title()} {s}"

    def ratings(pos, ov):
        out = {}
        if pos[0] == "GK":
            return {c: ((ov - 2, 2) if c == "gk" else (int(rng.integers(25, 40)), 0)) for c in COLS}
        out["gk"] = (int(rng.integers(15, 22)), 0)
        p0, nat = np.array(XY[PRIM[pos[0]]]), {PRIM[p] for p in pos}
        for c in COLS[1:]:
            if c in nat:
                out[c] = (ov - 2 - (0 if c == PRIM[pos[0]] else int(rng.integers(0, 3))), 2)
            else:
                d = np.abs(np.array(XY[c]) - p0).sum()
                out[c] = (max(25, int(ov - 2 - 4 * d - rng.integers(0, 4))), int(rng.integers(0, 3)))
        return out

    rows = []
    for k in range(n + len(STARS)):
        if k < len(STARS):
            sn, ln, ps, age, ov, pot, foot = STARS[k]; pos = [p.strip() for p in ps.split(",")]
        else:
            sn, ln = name()
            p = rng.choice(list(SHARE), p=np.array(list(SHARE.values())) / sum(SHARE.values()))
            pos = [p] + ([] if p == "GK" or rng.random() < .45 else list(rng.choice(NEAR[p], rng.integers(1, 3), replace=False)))
            age = int(np.clip(rng.normal(25.5, 4.5), 17, 39))
            ov = int(np.clip(rng.normal(66, 7), 47, 88))
            pot = int(max(ov, min(95, ov + max(0, rng.normal(26 - age, 3)))))
            foot = "Left" if rng.random() < .25 else "Right"
        val = 3e6 * np.exp(.2 * (ov - 72)) * np.exp(-.08 * max(0, age - 28)) * (1 + .03 * (pot - ov)) * rng.uniform(.8, 1.2)
        if k >= len(STARS) and rng.random() < .02:
            val = 0                                    # missing price -> exercised by the imputation model
        att = int(np.clip(ov + rng.normal(0, 6), 30, 97))
        rows.append(dict(player_id=100000 + k, short_name=sn, long_name=ln, player_positions=", ".join(pos), overall=ov, potential=pot,
                         value_eur=round(val, -3), wage_eur=round(val / 400, -2), age=age, club_name=clubs[k % len(clubs)],
                         nationality_name="Testland", preferred_foot=foot,
                         pace=att, shooting=int(np.clip(ov + rng.normal(-3, 8), 25, 95)), passing=int(np.clip(ov + rng.normal(-2, 6), 25, 95)),
                         dribbling=int(np.clip(ov + rng.normal(0, 5), 25, 95)), defending=int(np.clip(ov + rng.normal(-12, 12), 20, 92)),
                         physic=int(np.clip(ov + rng.normal(-4, 7), 30, 92)),
                         **{c: f"{a}+{b}" for c, (a, b) in ratings(pos, ov).items()}))
    return pd.DataFrame(rows)


def make_csv(path, n=3000, seed=1):
    make_frame(n, seed).to_csv(path, index=False)
    return path


if __name__ == "__main__":
    import sys
    make_csv(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 12000)
