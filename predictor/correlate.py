"""Correlation engine: how assets move together, how stable that is, and whether one leads another.

Correlation and prediction are different questions:
  * Co-movement: do A and B move on the same day / week? (useful for risk and hedging)
  * Lead-lag:    does A's move THIS week tell you B's move NEXT week? (the only kind that predicts)
This module measures both, by year and by market regime, and controls for the common driver
(the S&P 500) so a shared "risk-on, risk-off" swing is not mistaken for a direct link.

    python -m predictor.correlate                 # full report -> knowledge/correlations.json
    python -m predictor.correlate --pair copper bitcoin
"""
import argparse
import json
import math
from datetime import date
from itertools import combinations

import numpy as np
import pandas as pd

from .config import GRAPH_FILE, KNOWLEDGE, PROXIES
from .series import returns

SINCE = pd.Timestamp("2015-01-01")
FAMOUS = [  # pairs people often quote, tested as stated
    ("copper", "bitcoin"), ("bitcoin", "risk_on"), ("bitcoin", "ai_chips"), ("bitcoin", "gold"),
    ("gold", "usd"), ("gold", "us_yields"), ("copper", "risk_on"), ("copper", "gold"),
    ("brent", "airlines"), ("brent", "risk_on"), ("usd", "em_fx"), ("brent", "inr"),
    ("ai_chips", "memory"), ("us_yields", "homebuilders"), ("silver", "copper"), ("wheat", "soybeans"),
    ("bitcoin", "ether"), ("bitcoin", "usd"), ("bitcoin", "us_yields"), ("copper", "aluminium"),
    ("copper", "em_fx"), ("aluminium", "beverages"), ("brent", "india_omc"), ("brent", "f_india"),
    ("inr", "indian_it"), ("gold", "inr"), ("brent", "oil_majors"), ("hh", "ttf"), ("ttf", "eu_chem"),
    ("cocoa", "chocolate"), ("us_yields", "f_bonds"), ("risk_on", "f_india"), ("usd", "copper"), ("brent", "gold"),
]


def weekly(node):
    r = returns(node)
    if r is None:
        return None
    return r.resample("W-FRI").sum(min_count=1).dropna()


def daily_frame(nodes, since=SINCE):
    cols = {n: returns(n) for n in nodes}
    df = pd.DataFrame({n: s for n, s in cols.items() if s is not None})
    return df[df.index >= since]


def _corr(a, b):
    m = a.notna() & b.notna()
    if m.sum() < 30:
        return None
    return float(np.corrcoef(a[m], b[m])[0, 1])


def _partial(a, b, c):
    """Correlation of a and b after removing what both share with c (least-squares residuals)."""
    df = pd.concat([a, b, c], axis=1).dropna()
    if len(df) < 60:
        return None
    X = np.column_stack([np.ones(len(df)), df.iloc[:, 2].values])
    ra = df.iloc[:, 0].values - X @ np.linalg.lstsq(X, df.iloc[:, 0].values, rcond=None)[0]
    rb = df.iloc[:, 1].values - X @ np.linalg.lstsq(X, df.iloc[:, 1].values, rcond=None)[0]
    return float(np.corrcoef(ra, rb)[0, 1])


def _t_p(r, n):
    """Two-sided p-value for a correlation r on n observations (normal approximation)."""
    if r is None or n < 10 or abs(r) >= 1:
        return 1.0
    t = r * math.sqrt((n - 2) / (1 - r * r))
    return math.erfc(abs(t) / math.sqrt(2))


def pair_report(a, b):
    ra, rb = returns(a), returns(b)
    if ra is None or rb is None:
        return None
    d = pd.concat([ra.rename("a"), rb.rename("b")], axis=1, join="inner").dropna()
    d = d[d.index >= SINCE]
    if len(d) < 250:
        return None
    wa, wb = weekly(a), weekly(b)
    w = pd.concat([wa.rename("a"), wb.rename("b")], axis=1, join="inner").dropna()
    w = w[w.index >= SINCE]
    ma = ra.resample("ME").sum(min_count=1)
    mb = rb.resample("ME").sum(min_count=1)
    m = pd.concat([ma.rename("a"), mb.rename("b")], axis=1, join="inner").dropna()
    m = m[m.index >= SINCE]
    spx_w = weekly("risk_on")
    rep = {
        "a": a, "b": b, "from": d.index[0].date().isoformat(), "to": d.index[-1].date().isoformat(),
        "daily_corr": round(_corr(d.a, d.b), 3), "weekly_corr": round(_corr(w.a, w.b), 3), "monthly_corr": round(_corr(m.a, m.b), 3),
        "weekly_corr_ex_spx": None if a == "risk_on" or b == "risk_on" else round(_partial(w.a, w.b, spx_w) or 0, 3),
        "n_weeks": int(len(w)),
    }
    # same-direction months: when A fell in a month, how often did B fall that month (and the next)?
    down = m[m.a < 0]
    up = m[m.a > 0]
    nxt = m.b.shift(-1)
    rep["months_a_down"] = int(len(down))
    rep["b_down_same_month"] = round(float((down.b < 0).mean()), 3) if len(down) else None
    rep["b_down_next_month"] = round(float((nxt.loc[down.index].dropna() < 0).mean()), 3) if len(down) else None
    rep["b_up_same_month_when_a_up"] = round(float((up.b > 0).mean()), 3) if len(up) else None
    rep["b_base_down_rate"] = round(float((m.b < 0).mean()), 3)
    # correlation by year (weekly) and a rolling 26-week series sampled monthly
    by_year = {}
    for y, g in w.groupby(w.index.year):
        if len(g) >= 26:
            by_year[str(y)] = round(_corr(g.a, g.b), 3)
    rep["weekly_corr_by_year"] = by_year
    roll = w.a.rolling(26).corr(w.b).dropna()
    rep["rolling26w"] = [[d.strftime("%Y-%m"), round(float(v), 2)] for d, v in roll.resample("ME").last().dropna().items()]
    vals = list(by_year.values())
    rep["corr_range_by_year"] = [min(vals), max(vals)] if vals else None
    rep["sign_flips"] = int(sum(1 for i in range(1, len(vals)) if np.sign(vals[i]) != np.sign(vals[i - 1])))
    # regime: weekly correlation when the VIX is high (top third) vs low
    from .fetch import load_prices
    vlev = load_prices("^VIX").resample("W-FRI").last().reindex(w.index, method="ffill")
    hi = vlev > vlev.quantile(2 / 3)
    rep["weekly_corr_high_vix"] = round(_corr(w.a[hi], w.b[hi]) or 0, 3)
    rep["weekly_corr_low_vix"] = round(_corr(w.a[~hi], w.b[~hi]) or 0, 3)
    # lead-lag: A this week vs B next week (and the reverse), split in halves to check stability
    lead = {}
    for k in (1, 2, 4):
        x, y = w.a, w.b.shift(-k)
        r_ab = _corr(x, y)
        n = int((x.notna() & y.notna()).sum())
        half = len(w) // 2
        r1 = _corr(x.iloc[:half], y.iloc[:half])
        r2 = _corr(x.iloc[half:], y.iloc[half:])
        lead[f"a_leads_b_{k}w"] = {"corr": round(r_ab, 3), "p": round(_t_p(r_ab, n), 4), "first_half": round(r1, 3), "second_half": round(r2, 3)}
        x2, y2 = w.b, w.a.shift(-k)
        r_ba = _corr(x2, y2)
        lead[f"b_leads_a_{k}w"] = {"corr": round(r_ba, 3), "p": round(_t_p(r_ba, n), 4)}
    rep["lead_lag"] = lead
    best = max((v for k, v in lead.items() if k.startswith("a_leads")), key=lambda v: abs(v["corr"]))
    rep["predictive"] = bool(abs(best["corr"]) > 0.1 and best["p"] < 0.01 and np.sign(best["first_half"]) == np.sign(best["second_half"]) and min(abs(best["first_half"]), abs(best["second_half"])) > 0.06)
    return rep


def lead_lag_scan(nodes):
    """All pairs: does A's weekly return predict B's next-week return? Strict: Bonferroni-adjusted p < 0.05 and same sign in both halves."""
    W = pd.DataFrame({n: weekly(n) for n in nodes}).loc[lambda x: x.index >= SINCE]
    tests = len(nodes) * (len(nodes) - 1)
    out = []
    for a in nodes:
        for b in nodes:
            if a == b:
                continue
            x, y = W[a], W[b].shift(-1)
            m = x.notna() & y.notna()
            n = int(m.sum())
            if n < 200:
                continue
            r = float(np.corrcoef(x[m], y[m])[0, 1])
            p = _t_p(r, n)
            if p * tests >= 0.05:
                continue
            idx = x[m].index
            h = len(idx) // 2
            r1 = float(np.corrcoef(x[idx[:h]], y[idx[:h]])[0, 1])
            r2 = float(np.corrcoef(x[idx[h:]], y[idx[h:]])[0, 1])
            if np.sign(r1) == np.sign(r2) == np.sign(r):
                out.append({"a": a, "b": b, "corr": round(r, 3), "p_adj": round(min(1, p * tests), 5), "first_half": round(r1, 3), "second_half": round(r2, 3), "n": n})
    out.sort(key=lambda x: -abs(x["corr"]))
    return out, tests


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", nargs=2)
    args = ap.parse_args(argv)
    if args.pair:
        print(json.dumps({k: v for k, v in pair_report(*args.pair).items() if k != "rolling26w"}, indent=1))
        return
    nodes = [n for n in PROXIES if returns(n) is not None]
    W = pd.DataFrame({n: weekly(n) for n in nodes}).loc[lambda x: x.index >= SINCE]
    C = W.corr(min_periods=150)
    spx = W["risk_on"]
    labels = {n[0]: n[2] for n in json.loads(GRAPH_FILE.read_text())["nodes"]}
    # strongest stable co-movement pairs (weekly), with and without the S&P 500 removed
    pairs = []
    yearly = {y: g.corr(min_periods=26) for y, g in W.groupby(W.index.year) if len(g) >= 40}
    for a, b in combinations(nodes, 2):
        c = C.loc[a, b]
        if pd.isna(c):
            continue
        ys = [yearly[y].loc[a, b] for y in yearly if not pd.isna(yearly[y].loc[a, b])]
        pairs.append({"a": a, "b": b, "weekly_corr": round(float(c), 3),
                      "ex_spx": None if "risk_on" in (a, b) else round(_partial(W[a], W[b], spx) or 0, 3),
                      "year_min": round(float(min(ys)), 3) if ys else None, "year_max": round(float(max(ys)), 3) if ys else None})
    pairs.sort(key=lambda p: -abs(p["weekly_corr"]))
    famous = [r for r in (pair_report(a, b) for a, b in FAMOUS) if r]
    scan, tests = lead_lag_scan(nodes)
    report = {"asof": date.today().isoformat(), "since": SINCE.date().isoformat(),
              "method": "Weekly log returns since 2015. ex_spx = partial correlation after removing the S&P 500. Lead-lag = this week's return vs next week's, Bonferroni-adjusted across all pairs, same sign required in both halves of the sample.",
              "nodes": nodes, "labels": {n: labels.get(n, n) for n in nodes},
              "matrix": [[None if pd.isna(C.loc[a, b]) else round(float(C.loc[a, b]), 2) for b in nodes] for a in nodes],
              "top_pairs": pairs[:60], "famous": famous, "lead_lag": scan[:40], "lead_lag_tests": tests}
    (KNOWLEDGE / "correlations.json").write_text(json.dumps(report))
    print(f"pairs: {len(pairs)}, lead-lag survivors: {len(scan)} of {tests} tests")
    for r in famous:
        ll = r["lead_lag"]["a_leads_b_1w"]
        print(f"{r['a']:>10} vs {r['b']:<12} weekly {r['weekly_corr']:+.2f} ex-S&P {r['weekly_corr_ex_spx']} years {r['corr_range_by_year']} flips {r['sign_flips']} | hiVIX {r['weekly_corr_high_vix']:+.2f} loVIX {r['weekly_corr_low_vix']:+.2f} | A down month -> B down {r['b_down_same_month']} same, {r['b_down_next_month']} next (base {r['b_base_down_rate']}) | leads 1w {ll['corr']:+.3f} p={ll['p']} predictive={r['predictive']}")
    print("\nlead-lag survivors:")
    for s in scan[:20]:
        print(f"  {s['a']:>14} -> {s['b']:<14} corr {s['corr']:+.3f} p_adj {s['p_adj']} halves {s['first_half']:+.3f}/{s['second_half']:+.3f}")


if __name__ == "__main__":
    main()
