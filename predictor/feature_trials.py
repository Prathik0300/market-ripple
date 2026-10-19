"""Trials for new model inputs: a feature family enters the forecasts only if it beats the model without it out of sample.

For each family and each target it covers, the model is run twice on IDENTICAL rows (the days where the new
features are known): once without them (base) and once with them. Both use the same walk-forward test as
predictor.model (retrained before each year, scored only on that unseen year). A family is kept when, pooled over
its targets, it raises the Brier skill at both horizons AND a block bootstrap over (target, year) blocks says it
was better in at least 80% of resamples at both horizons. One verdict per family (not per target), so the test
does not cherry-pick the targets where noise happened to help.

Sources that have no history yet cannot be tested this way; they are listed with how much history they have and
when a test becomes possible. Nothing from users' own holdings, trades or connected accounts is used here.

    python -m predictor.feature_trials          # run every trial, write knowledge/feature_trials.json
"""
import json
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd

from .config import GRAPH_FILE, HORIZONS, KNOWLEDGE
from .series import level, returns

TRIALS_FILE = KNOWLEDGE / "feature_trials.json"
MIN_GAIN = 0.0
MIN_PROB = 0.8
BOOT = 2000


def _sec_fund(node):
    from .sec_data import fundamentals_frame, us_nodes
    sym = us_nodes().get(node)
    return fundamentals_frame(sym, level(node), returns(node)) if sym else None


def _sec_filings(node):
    from .sec_data import filings_frame, us_nodes
    sym = us_nodes().get(node)
    return filings_frame(sym, level(node).index) if sym else None


FAMILIES = {
    "sec_fundamentals": {"build": _sec_fund, "source": "SEC EDGAR XBRL company facts (data.sec.gov)",
                         "what": "earnings yield, revenue growth, post-filing drift, days since the last 10-Q/10-K"},
    "sec_filings": {"build": _sec_filings, "source": "SEC EDGAR submissions (data.sec.gov)",
                    "what": "8-K count in 30 days, insider Form 4 count in 90 days"},
}


def kept_extra(node):
    """The added features the live model uses for a node: only families whose last trial verdict is "keep"."""
    if not TRIALS_FILE.exists():
        return None, []
    kept = [f for f, r in json.loads(TRIALS_FILE.read_text()).get("families", {}).items() if r.get("verdict") == "keep"]
    frames, used = [], []
    for fam in kept:
        if fam not in FAMILIES:
            continue
        try:
            f = FAMILIES[fam]["build"](node)
        except Exception:
            f = None
        if f is not None and len(f.dropna()):
            frames.append(f)
            used.append(fam)
    return (pd.concat(frames, axis=1) if frames else None), used


def _boot(blocks, rng):
    """Share of block-bootstrap resamples where the new model's mean Brier is lower than the base model's."""
    if len(blocks) < 5:
        return 0.0
    d = np.array([b[0] for b in blocks])      # sum over the block of (brier_base - brier_new)
    n = np.array([b[1] for b in blocks])
    idx = rng.integers(0, len(blocks), size=(BOOT, len(blocks)))
    return float(np.mean(d[idx].sum(1) / n[idx].sum(1) > 0))


def run_family(fam, drivers_of, macro):
    from .model import MIN_TRAIN, scores, target_frame, walk_forward
    rng = np.random.default_rng(7)
    per, pooled = [], {h: {"base": [], "new": [], "blocks": []} for h in HORIZONS}
    from .config import PROXIES
    for node in PROXIES:
        try:
            extra = FAMILIES[fam]["build"](node)
        except Exception as e:
            per.append({"node": node, "error": str(e)[:120]})
            continue
        if extra is None or not len(extra.dropna()):
            continue
        X, labels = target_frame(node, drivers_of.get(node, []), macro)
        Xn = X.join(extra.reindex(X.index, method="ffill"))
        row = {"node": node, "features": list(extra.columns)}
        for h in HORIZONS:
            dfn = Xn.join(labels[h].rename("y")).dropna()
            dfb = dfn[list(X.columns) + ["y"]]          # identical rows, without the new columns
            if len(dfn) < MIN_TRAIN + 250:
                continue
            rb, rn = walk_forward(dfb, h), walk_forward(dfn, h)
            if rb is None or rn is None:
                continue
            sb, sn = scores(*rb[:3]), scores(*rn[:3])
            row[f"h{h}"] = {"n": int(len(rb[1])), "skill_base": sb["skill"], "skill_new": sn["skill"],
                            "auc_base": sb["auc"], "auc_new": sn["auc"], "gain": round(sn["skill"] - sb["skill"], 4)}
            pooled[h]["base"].append(rb)
            pooled[h]["new"].append(rn)
            # (target, year) blocks for the bootstrap
            pb, pt, pn, yy = rb[0], rb[1], rn[0], rb[3]
            for y in np.unique(yy):
                m = yy == y
                pooled[h]["blocks"].append((float(np.sum((pb[m] - pt[m]) ** 2 - (pn[m] - pt[m]) ** 2)), int(m.sum())))
        if any(f"h{h}" in row for h in HORIZONS):
            per.append(row)
    summary = {}
    for h in HORIZONS:
        if not pooled[h]["base"]:
            continue
        cat = lambda rs: [np.concatenate([r[i] for r in rs]) for i in range(3)]
        sb, sn = scores(*cat(pooled[h]["base"])), scores(*cat(pooled[h]["new"]))
        gains = [r[f"h{h}"]["gain"] for r in per if f"h{h}" in r]
        summary[f"h{h}"] = {"targets": len(gains), "oos_n": int(sum(len(r[1]) for r in pooled[h]["base"])),
                            "skill_base": sb["skill"], "skill_new": sn["skill"], "auc_base": sb["auc"], "auc_new": sn["auc"],
                            "gain": round(sn["skill"] - sb["skill"], 4), "targets_helped": int(sum(g > 0 for g in gains)),
                            "median_gain": round(float(np.median(gains)), 4),
                            "p_better": round(_boot(pooled[h]["blocks"], rng), 3)}
    ok = bool(summary) and all(summary.get(f"h{h}", {}).get("gain", -1) > MIN_GAIN and summary[f"h{h}"]["p_better"] >= MIN_PROB for h in HORIZONS)
    return {"source": FAMILIES[fam]["source"], "what": FAMILIES[fam]["what"], "verdict": "keep" if ok else "drop",
            "rule": f"keep only if pooled Brier skill rises at both horizons and block bootstrap P(better) >= {MIN_PROB}",
            "summary": summary, "targets": per}


def main():
    from .model import macro_frame
    g = json.loads(GRAPH_FILE.read_text())
    learned = {}
    lp = KNOWLEDGE / "edges_learned.json"
    if lp.exists():
        learned = {(e["s"], e["t"]): e for e in json.loads(lp.read_text())["edges"]}
    from .config import PROXIES
    drivers_of = {}
    for s, t, sign, w, *_ in g["edges"]:
        if s in PROXIES and t in PROXIES and learned.get((s, t), {}).get("verdict") in ("confirmed", "supported"):
            drivers_of.setdefault(t, []).append((s, sign))
    macro = macro_frame()
    fams = {}
    for fam in FAMILIES:
        r = run_family(fam, drivers_of, macro)
        fams[fam] = r
        for h, s in r["summary"].items():
            print(f"{fam:17s} {h}: skill {s['skill_base']:+.4f} -> {s['skill_new']:+.4f} (gain {s['gain']:+.4f}), "
                  f"AUC {s['auc_base']:.3f} -> {s['auc_new']:.3f}, helped {s['targets_helped']}/{s['targets']}, P(better) {s['p_better']:.2f}")
        print(f"{fam:17s} verdict: {r['verdict']}")
    from .sources import untestable
    out = {"asof": date.today().isoformat(), "run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "method": "Same walk-forward test as the model, base and new on identical rows; one verdict per family.",
           "families": fams, "waiting_for_history": untestable()}
    TRIALS_FILE.write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
