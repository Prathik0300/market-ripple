"""Experiment: do cross-asset correlations make the forecasts better?

Variant A (baseline): the model in model.py (own trend, macro, GPR, map drivers).
Variant B (all correlations): A plus the 5-day and 20-day returns of EVERY other asset (about 140 extra
inputs), so the model can use any correlation or lead-lag it finds, copper -> bitcoin included.
Both are retrained yearly and scored only on unseen years (2014-2026). Same targets, same test weeks.

    python -m predictor.experiment_xasset
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

from .config import GRAPH_FILE, KNOWLEDGE, PROXIES
from .model import TEST_YEARS, MIN_TRAIN, macro_frame, target_frame
from .series import returns

warnings.filterwarnings("ignore")
H = 20


def cross_frame():
    cols = {}
    for n in PROXIES:
        r = returns(n)
        if r is None:
            continue
        c = r.cumsum()
        cols[f"x5_{n}"] = c.diff(5)
        cols[f"x20_{n}"] = c.diff(20)
    return pd.DataFrame(cols).sort_index().ffill(limit=3)


def walk(df, C=0.05):
    preds, truth, clim = [], [], []
    for yr in TEST_YEARS:
        test = df[df.index.year == yr]
        train = df[df.index < pd.Timestamp(f"{yr}-01-01") - pd.Timedelta(days=int(H * 1.5) + 2)]
        if len(test) < 20 or len(train) < MIN_TRAIN:
            continue
        ytr = (train["y"] > 0).astype(int)
        if ytr.nunique() < 2:
            continue
        m = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=800))
        m.fit(train.drop(columns="y").fillna(0), ytr)
        preds.append(m.predict_proba(test.drop(columns="y").fillna(0))[:, 1])
        truth.append((test["y"] > 0).astype(int).values)
        clim.append(np.full(len(test), ytr.mean()))
    if not preds:
        return None
    p, t, c = np.concatenate(preds), np.concatenate(truth), np.concatenate(clim)
    b, bc = np.mean((p - t) ** 2), np.mean((c - t) ** 2)
    try:
        auc = roc_auc_score(t, p)
    except ValueError:
        auc = 0.5
    return {"skill": round(float(1 - b / bc), 4), "auc": round(float(auc), 3), "n": int(len(t))}


def main():
    g = json.loads(GRAPH_FILE.read_text())
    learned = {(e["s"], e["t"]): e for e in json.loads((KNOWLEDGE / "edges_learned.json").read_text())["edges"]}
    drivers_of = {}
    for s, t, sign, *_ in g["edges"]:
        if s in PROXIES and t in PROXIES and learned.get((s, t), {}).get("verdict") in ("confirmed", "supported"):
            drivers_of.setdefault(t, []).append((s, sign))
    macro = macro_frame()
    X2 = cross_frame()
    rows = []
    for node in PROXIES:
        X, labels = target_frame(node, drivers_of.get(node, []), macro)
        base = X.join(labels[H].rename("y")).dropna()
        if len(base) < MIN_TRAIN + 250:
            continue
        extra = X2.drop(columns=[c for c in X2.columns if c.endswith("_" + node)]).reindex(base.index, method="ffill")
        full = base.join(extra)
        a, b = walk(base), walk(full, C=0.003)
        if a and b:
            rows.append({"node": node, "base_skill": a["skill"], "base_auc": a["auc"], "x_skill": b["skill"], "x_auc": b["auc"], "n": a["n"]})
            print(f"{node:15s} base skill {a['skill']:+.3f} auc {a['auc']:.3f} | +all correlations skill {b['skill']:+.3f} auc {b['auc']:.3f}")
    df = pd.DataFrame(rows)
    summary = {
        "targets": len(df), "horizon_days": H,
        "median_base_skill": round(float(df.base_skill.median()), 4), "median_x_skill": round(float(df.x_skill.median()), 4),
        "median_base_auc": round(float(df.base_auc.median()), 3), "median_x_auc": round(float(df.x_auc.median()), 3),
        "x_better": int((df.x_skill > df.base_skill).sum()), "x_beats_naive": int((df.x_skill > 0.005).sum()),
        "base_beats_naive": int((df.base_skill > 0.005).sum()),
    }
    out = {"asof": date.today().isoformat(), "summary": summary, "rows": rows,
           "method": "Walk-forward yearly retraining, 2014-2026 test years, 20-day horizon. Variant B adds 5- and 20-day returns of every other asset."}
    (KNOWLEDGE / "experiment_xasset.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
