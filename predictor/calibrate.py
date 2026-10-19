"""Test every link in the map against market history, and search for links the map is missing.

For a link A -> B, find days when A made an unusually large move (more than 2 rolling standard deviations).
Two questions are asked of B:

  * Does the link exist?  B's move over the 5 and 20 trading days starting on the shock day.
  * Does it predict?      B's move over the 5 and 20 trading days starting the day AFTER the shock,
                          which is what an investor could act on.

Hit rates are compared with B's own base rate of rising or falling over that horizon, so an asset that
usually rises gets no credit for rising.

    python -m predictor.calibrate
"""
import json
import math
import sys
from datetime import date

import numpy as np
import pandas as pd

from .config import GRAPH_FILE, KNOWLEDGE, PROXIES
from .series import forward_sum, returns, shock_days

SINCE = pd.Timestamp("2010-01-01")

# Pairs that are the same exposure in different wrappers; links between them are trivially true.
FAMILIES = [
    {"silver", "f_silver", "gold", "f_gold", "gold_miners"},
    {"brent", "f_oil", "jet_fuel", "oil_majors"},
    {"hh", "f_gas"},
    {"copper", "f_copper", "copper_miners"},
    {"uranium_miners", "f_uranium", "nuclear_smr"},
    {"airlines", "f_jets"},
    {"ai_chips", "f_semis", "memory"},
    {"us_yields", "f_bonds"},
    {"lithium_miners", "f_lithium", "f_rare", "re_miners"},
    {"wheat", "f_agri", "soybeans", "palm_oil"},
    {"defense", "f_defense"},
    {"bitcoin", "ether", "crypto_stocks"},
    {"india_omc", "india_paints", "indian_it", "f_india", "inr"},
    {"copper_miners", "alu_producers", "f_copper", "f_rare", "f_lithium", "f_uranium"},
]


def same_family(a, b):
    return any(a in f and b in f for f in FAMILIES)


def binom_two_sided(k, n, p):
    """Two-sided binomial test p-value (exact below n=30, normal approximation above)."""
    if n == 0:
        return 1.0
    if n < 30:
        pk = math.comb(n, k) * p ** k * (1 - p) ** (n - k)
        return min(1.0, sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(n + 1)
                            if math.comb(n, i) * p ** i * (1 - p) ** (n - i) <= pk + 1e-12))
    mu, sd = n * p, math.sqrt(n * p * (1 - p))
    zv = (abs(k - mu) - 0.5) / sd
    return min(1.0, math.erfc(max(zv, 0) / math.sqrt(2)))


_base_cache, _shock_cache = {}, {}


def base_rate(node, rt, h):
    key = (node, h)
    if key not in _base_cache:
        csum = rt.cumsum()
        w = (csum.shift(-h) - csum).dropna()
        w = w[w.index >= SINCE]
        _base_cache[key] = float((w > 0).mean()) if len(w) else 0.5
    return _base_cache[key]


def shocks_for(node):
    if node not in _shock_cache:
        rs = returns(node)
        _shock_cache[node] = [] if rs is None else [s for s in shock_days(rs[rs.index >= SINCE - pd.Timedelta(days=120)]) if s[0] >= SINCE]
    return _shock_cache[node]


def _measure(dst, rt, dates, dirs, sign, h, after):
    fw = forward_sum(rt, dates, h, after=after)
    ok = ~np.isnan(fw)
    n = int(ok.sum())
    if not n:
        return None
    exp = dirs[ok] * sign
    got = np.sign(fw[ok])
    hits = got == exp
    p_up = base_rate(dst, rt, h)
    base = float(np.mean(np.where(exp > 0, p_up, 1 - p_up)))
    scale = 1 if PROXIES.get(dst, ("", ""))[1] == "yield" else 100
    m = {"hit": round(float(hits.mean()), 3), "base": round(base, 3), "lift": round(float(hits.mean()) - base, 3),
         "p": round(binom_two_sided(int(hits.sum()), n, base), 5), "resp": round(float(np.mean(fw[ok] * exp)) * scale, 2), "n": n}
    if n >= 30:
        half = n // 2
        m["early"] = round(float(hits[:half].mean()), 3)
        m["late"] = round(float(hits[half:].mean()), 3)
    return m


def test_link(src, dst, sign):
    rt = returns(dst)
    shocks = shocks_for(src)
    if rt is None or len(shocks) < 15:
        return None
    dates = [d for d, _, _ in shocks]
    dirs = np.array([sg for _, sg, _ in shocks])
    out = {"n": len(shocks)}
    for h in (5, 20):
        for after, pre in ((False, ""), (True, "p")):
            m = _measure(dst, rt, dates, dirs, sign, h, after)
            if m:
                for k, v in m.items():
                    if k != "n":
                        out[f"{pre}{k}{h}"] = v
    rs = returns(src)
    both = pd.concat([rs, rt], axis=1, join="inner").dropna()
    both = both[both.index >= SINCE]
    out["corr"] = round(float(both.corr().iloc[0, 1]), 3) if len(both) > 250 else None
    return out


def verdict(res):
    """Does the link exist? Judged on the reaction that includes the shock day."""
    if res is None or "lift5" not in res:
        return "untestable"
    lift, p, lift20 = res["lift5"], res["p5"], res.get("lift20", 0)
    stable = "early5" not in res or (res["early5"] > res["base5"] - 0.02 and res["late5"] > res["base5"] - 0.02)
    if lift >= 0.07 and p < 0.01 and stable:
        return "confirmed"
    if lift >= 0.03 and p < 0.2:
        return "supported"
    if lift <= -0.07 and p < 0.01 and lift20 < 0:
        return "contradicted"
    return "unclear"


def predictive(res):
    """Does the link give an edge after the shock day? Strict, stable test."""
    if res is None or "plift5" not in res:
        return None
    for h in (5, 20):
        lift, p = res.get(f"plift{h}"), res.get(f"pp{h}")
        early, late, base = res.get(f"pearly{h}"), res.get(f"plate{h}"), res.get(f"pbase{h}")
        if lift is not None and lift >= 0.06 and p < 0.01 and early is not None and early > base and late > base:
            return f"{h}d"
    return "none"


def learned_weight(prior, res, v):
    if v == "confirmed":
        measured = min(1.0, 0.35 + 2.5 * res["lift5"] + 0.5 * abs(res.get("corr") or 0))
        return round((prior + measured) / 2, 3)
    if v == "contradicted":
        return round(prior * 0.3, 3)
    if v == "unclear" and res and res["n"] >= 40:
        return round(prior * 0.75, 3)
    return round(prior, 3)


def discover(existing, top=30):
    """Look for links that PREDICT: a shock in A followed (from the next trading day) by a move in B.
    About 9,000 pair-and-sign tests are run, so the bar is strict: p < 0.0001, a lift of at least 8
    points, and the effect must hold in both halves of the sample. Same-asset pairs are skipped."""
    nodes = [n for n in PROXIES if returns(n) is not None]
    found = []
    for a in nodes:
        for b in nodes:
            if a == b or (a, b) in existing or same_family(a, b):
                continue
            res = test_link(a, b, 1)
            if not res or res["n"] < 60 or "plift5" not in res:
                continue
            for sign in (1, -1):
                lift = res["plift5"] if sign == 1 else -res["plift5"]
                hit = res["phit5"] if sign == 1 else 1 - res["phit5"]
                base = res["pbase5"] if sign == 1 else 1 - res["pbase5"]
                early = res.get("pearly5") if sign == 1 else 1 - res.get("pearly5", 1)
                late = res.get("plate5") if sign == 1 else 1 - res.get("plate5", 1)
                if lift >= 0.08 and res["pp5"] < 1e-4 and early is not None and early > base + 0.03 and late > base + 0.03:
                    found.append({"s": a, "t": b, "sign": sign, "n": res["n"], "phit5": round(hit, 3), "pbase5": round(base, 3),
                                  "plift5": round(lift, 3), "pp5": res["pp5"], "corr": res.get("corr")})
    found.sort(key=lambda x: (-x["plift5"], x["pp5"]))
    return found[:top]


def main():
    g = json.loads(GRAPH_FILE.read_text())
    results, counts, pcounts = [], {}, {}
    for s, t, sign, w, lag, why in g["edges"]:
        res = test_link(s, t, sign)
        v = verdict(res)
        pv = predictive(res)
        counts[v] = counts.get(v, 0) + 1
        if pv:
            pcounts[pv] = pcounts.get(pv, 0) + 1
        results.append({"s": s, "t": t, "sign": sign, "prior": w, "w": learned_weight(w, res, v), "verdict": v, "predictive": pv, **(res or {})})
    existing = {(s, t) for s, t, *_ in g["edges"]}
    print("testing all pairs for predictive links...", file=sys.stderr)
    cands = discover(existing)
    report = {"asof": date.today().isoformat(),
              "method": "Event study since 2010: source shocks larger than 2 rolling SD; target move over 5 and 20 trading days vs its base rate. 'verdict' includes the shock day (does the link exist); 'predictive' starts the day after (could you act on it).",
              "counts": counts, "predictive_counts": pcounts, "edges": results, "candidates": cands}
    (KNOWLEDGE / "edges_learned.json").write_text(json.dumps(report, indent=1))
    print("link exists:", json.dumps(counts))
    print("predictive after the shock day:", json.dumps(pcounts))
    tested = [r for r in results if r["verdict"] != "untestable"]
    print("\npredictive links in the map:")
    for r in sorted([r for r in tested if r["predictive"] not in (None, "none")], key=lambda r: -r.get("plift5", 0)):
        print(f"  {r['s']:>14} -> {r['t']:<16} n={r['n']:3d} next5 hit={r['phit5']:.2f} base={r['pbase5']:.2f} lift={r['plift5']:+.2f} p={r['pp5']:.2g} | next20 lift={r.get('plift20', 0):+.2f}")
    print("\ncontradicted:")
    for r in [r for r in tested if r["verdict"] == "contradicted"]:
        print(f"  {r['s']:>14} -> {r['t']:<16} hit5={r['hit5']:.2f} base={r['base5']:.2f} lift={r['lift5']:+.2f} corr={r.get('corr')}")
    print("\ncandidate predictive links not in the map:")
    for c in cands[:20]:
        print(f"  {c['s']:>14} -> {c['t']:<16} sign={c['sign']:+d} n={c['n']} next5 hit={c['phit5']:.2f} base={c['pbase5']:.2f} lift={c['plift5']:+.2f} p={c['pp5']:.2g} corr={c['corr']}")


if __name__ == "__main__":
    main()
