"""Probability model: for each tradable node, the chance it is higher in 5 and 20 trading days.

Inputs per target: its own trend and volatility, the S&P 500, US 10-year yield, dollar, VIX, the daily
Geopolitical Risk index, and the recent moves of the drivers that point to it in the map (signed by the
link direction). A regularised logistic regression is retrained each year on data before that year and
scored on that year only (walk-forward), with a gap of h days so no future information leaks in.

The report says how often the model beat a naive forecast (the target's own historical up-rate). Where it
did not, the latest probability is shown but flagged as having no demonstrated skill.

    python -m predictor.model
"""
import json
import warnings
from datetime import date

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .config import GRAPH_FILE, HORIZONS, KNOWLEDGE, PROXIES
from .fetch import load_prices
from .series import level, returns

warnings.filterwarnings("ignore")
TEST_YEARS = list(range(2014, 2027))
MIN_TRAIN = 750


def gpr_frame():
    p = KNOWLEDGE.parent / "data" / "gpr_daily.csv"
    g = pd.read_csv(p, parse_dates=["date"]).set_index("date")
    col = "GPRD" if "GPRD" in g.columns else g.columns[0]
    s = g[col].astype(float)
    return pd.DataFrame({"gpr_z": (s - s.rolling(250).mean()) / s.rolling(250).std(), "gpr_chg20": np.log(s.rolling(5).mean()).diff(20)})


def macro_frame():
    spx = level("risk_on")
    tnx = level("us_yields")
    dxy = level("usd")
    vix = load_prices("^VIX")
    f = pd.DataFrame({
        "spx20": np.log(spx).diff(20),
        "spx_dd": np.log(spx / spx.rolling(250).max()),
        "tnx20": tnx.diff(20),
        "dxy20": np.log(dxy).diff(20),
        "vix": np.log(vix),
    })
    return f.join(gpr_frame(), how="left").ffill()


def target_frame(node, drivers, macro):
    px = level(node)
    r = returns(node)
    lp = np.log(px) if PROXIES[node][1] != "yield" else px
    f = pd.DataFrame(index=r.index)
    f["mom5"] = lp.diff(5)
    f["mom20"] = lp.diff(20)
    f["mom60"] = lp.diff(60)
    f["mom250"] = lp.diff(250)
    f["vol20"] = r.rolling(20).std()
    f["dist200"] = lp - lp.rolling(200).mean()
    for d, sign in drivers:
        dr = returns(d)
        if dr is None:
            continue
        f[f"drv_{d}"] = sign * dr.rolling(20).sum().reindex(f.index, method="ffill")
    f = f.join(macro.reindex(f.index, method="ffill"))
    labels = {}
    csum = r.cumsum()
    for h in HORIZONS:
        fwd = csum.shift(-h) - csum  # return over the next h trading days, from tomorrow on
        labels[h] = fwd
    return f, labels


def walk_forward(df, h):
    """Walk-forward test on one target's rows (features + "y"): retrain before each test year, with a gap of
    h trading days so no label overlaps the test year. Returns pooled (probabilities, outcomes, naive rates, test years)."""
    preds, truth, clim, years = [], [], [], []
    for yr in TEST_YEARS:
        test = df[df.index.year == yr]
        train = df[df.index < pd.Timestamp(f"{yr}-01-01") - pd.Timedelta(days=int(h * 1.5) + 2)]
        if len(test) < 20 or len(train) < MIN_TRAIN:
            continue
        ytr = (train["y"] > 0).astype(int)
        if ytr.nunique() < 2:
            continue
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=500))
        m.fit(train.drop(columns="y"), ytr)
        preds.append(m.predict_proba(test.drop(columns="y"))[:, 1])
        truth.append((test["y"] > 0).astype(int).values)
        clim.append(np.full(len(test), ytr.mean()))
        years.append(np.full(len(test), yr))
    if not preds:
        return None
    return np.concatenate(preds), np.concatenate(truth), np.concatenate(clim), np.concatenate(years)


def scores(p, t, c):
    brier, brier_c = float(np.mean((p - t) ** 2)), float(np.mean((c - t) ** 2))
    try:
        auc = float(roc_auc_score(t, p))
    except ValueError:
        auc = 0.5
    bss = 1 - brier / brier_c if brier_c > 0 else 0.0
    return {"auc": round(auc, 3), "brier": round(brier, 4), "brier_naive": round(brier_c, 4), "skill": round(bss, 4),
            "acc": round(float(np.mean((p > 0.5) == t)), 3), "acc_naive": round(float(np.mean((c > 0.5) == t)), 3),
            "up_rate": round(float(t.mean()), 3), "has_skill": bool(bss > 0.005 and auc > 0.53)}


def evaluate(node, drivers, macro, extra=None):
    """extra: an optional DataFrame of added features (on any daily index); rows where it is missing are dropped,
    so a target with an added feature family is trained and tested only where that family is known."""
    X, labels = target_frame(node, drivers, macro)
    if extra is not None:
        X = X.join(extra.reindex(X.index, method="ffill"))
    out = {}
    for h in HORIZONS:
        df = X.join(labels[h].rename("y")).dropna()
        if len(df) < MIN_TRAIN + 250:
            continue
        res = walk_forward(df, h)
        if res is None:
            continue
        p, t, c, _ = res
        # latest forecast: train on everything with a known outcome
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=500))
        m.fit(df.drop(columns="y"), (df["y"] > 0).astype(int))
        latest_x = X.dropna().iloc[[-1]]
        prob = float(m.predict_proba(latest_x)[:, 1][0])
        out[h] = {"prob_up": round(prob, 3), "asof": latest_x.index[-1].date().isoformat(), "oos_n": int(len(t)),
                  **scores(p, t, c), "_p": p, "_t": t}
    return out


def calibration_table(pairs, bins=10):
    p = np.concatenate([a for a, _ in pairs])
    t = np.concatenate([b for _, b in pairs])
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum() >= 200:
            rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": int(m.sum()), "predicted": round(float(p[m].mean()), 3), "actual": round(float(t[m].mean()), 3)})
    return rows


def main():
    g = json.loads(GRAPH_FILE.read_text())
    learned_path = KNOWLEDGE / "edges_learned.json"
    learned = {}
    if learned_path.exists():
        for e in json.loads(learned_path.read_text())["edges"]:
            learned[(e["s"], e["t"])] = e
    labels = {n[0]: n[2] for n in g["nodes"]}
    drivers_of = {}
    for s, t, sign, w, *_ in g["edges"]:
        v = learned.get((s, t), {}).get("verdict")
        if s in PROXIES and t in PROXIES and v in ("confirmed", "supported"):
            drivers_of.setdefault(t, []).append((s, sign))
    macro = macro_frame()
    from .feature_trials import kept_extra
    signals, pooled = {}, {h: [] for h in HORIZONS}
    for node in PROXIES:
        try:
            extra, fams = kept_extra(node)
            res = evaluate(node, drivers_of.get(node, []), macro, extra)
        except Exception as e:
            print(f"{node}: failed {e}")
            continue
        if not res:
            continue
        sig = {"label": labels.get(node, node), "symbol": PROXIES[node][0], **({"extra_features": fams} if fams else {})}
        for h, r in res.items():
            pooled[h].append((r.pop("_p"), r.pop("_t")))
            sig[f"h{h}"] = r
        signals[node] = sig
        s5, s20 = sig.get("h5", {}), sig.get("h20", {})
        print(f"{node:15s} 5d p={s5.get('prob_up')} skill={s5.get('skill')} auc={s5.get('auc')} | 20d p={s20.get('prob_up')} skill={s20.get('skill')} auc={s20.get('auc')}")
    # Raw logistic probabilities were overconfident out of sample (a stated 84% rose about 60% of the time).
    # Map them through an isotonic curve fitted on the pooled out-of-sample predictions, so the reported
    # probability matches how often that level actually came true in the 2014-2026 test years.
    from sklearn.isotonic import IsotonicRegression
    for h in HORIZONS:
        if not pooled[h]:
            continue
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.98)
        iso.fit(np.concatenate([a for a, _ in pooled[h]]), np.concatenate([b for _, b in pooled[h]]))
        for s in signals.values():
            r = s.get(f"h{h}")
            if r:
                r["prob_raw"] = r["prob_up"]
                r["prob_up"] = round(float(iso.predict([r["prob_raw"]])[0]), 3)
    summary = {}
    for h in HORIZONS:
        skills = [s[f"h{h}"]["skill"] for s in signals.values() if f"h{h}" in s]
        aucs = [s[f"h{h}"]["auc"] for s in signals.values() if f"h{h}" in s]
        summary[f"h{h}"] = {
            "targets": len(skills), "with_skill": int(sum(s[f"h{h}"]["has_skill"] for s in signals.values() if f"h{h}" in s)),
            "median_skill": round(float(np.median(skills)), 4), "median_auc": round(float(np.median(aucs)), 3),
            "calibration": calibration_table(pooled[h]),
        }
    report = {"asof": date.today().isoformat(), "test_years": f"{TEST_YEARS[0]}-{TEST_YEARS[-1]}",
              "method": "Walk-forward logistic regression, retrained yearly, scored only on unseen years. Skill = 1 - Brier / Brier of the naive up-rate forecast (above 0 beats naive).",
              "summary": summary, "signals": signals}
    (KNOWLEDGE / "model_report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
