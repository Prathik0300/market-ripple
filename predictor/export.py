"""Build the documents the Market Ripple Map reads from its database, as JSON files under out/db/.

    python -m predictor.export            # writes out/db/*.json and out/db/writes.json

writes.json lists {collection, doc_id, file_path} for every document to send. Send them with one
ArtifactData "batch" call; pin each existing document with the version recorded in
knowledge/db_versions.json, then save the versions the batch returns:

    python -m predictor.export --record '{"feed/latest": 3, "signals/latest": 5}'
"""
import argparse
import json
from datetime import datetime, timezone

from .config import KNOWLEDGE, OUT
from .events import graph, load_events, pressure

DB_OUT = OUT / "db"
VERSIONS = KNOWLEDGE / "db_versions.json"
FEED_SIZE = 80


def _write(name, doc):
    DB_OUT.mkdir(parents=True, exist_ok=True)
    p = DB_OUT / f"{name.replace('/', '__')}.json"
    p.write_text(json.dumps(doc, separators=(",", ":")))
    coll, doc_id = name.split("/")
    return {"collection": coll, "doc_id": doc_id, "file_path": str(p)}


def build(days_touched=None):
    now = datetime.now(timezone.utc).isoformat(timespec="minutes").replace("+00:00", "Z")
    events = load_events()
    events.sort(key=lambda e: e["ts"], reverse=True)
    writes = []

    def slim(e):
        return {k: e[k] for k in ("id", "ts", "title", "summary", "region", "category", "scale", "url", "source", "nodes") if k in e}

    writes.append(_write("feed/latest", {"updated": now, "total": len(events), "events": [slim(e) for e in events[:FEED_SIZE]]}))

    # one document per day keeps the store far below its 25,000-document cap
    by_day = {}
    for e in events:
        by_day.setdefault(e["ts"][:10], []).append(slim(e))
    days = sorted(by_day)[-3:] if days_touched is None else [d for d in days_touched if d in by_day]
    for d in days:
        writes.append(_write(f"days/{d}", {"date": d, "events": by_day[d]}))

    labels = {n[0]: n[2] for n in graph()["nodes"]}
    model_p = KNOWLEDGE / "model_report.json"
    sig = {"updated": now, "pressure": pressure()}
    if model_p.exists():
        m = json.loads(model_p.read_text())
        items = {}
        for node, s in m["signals"].items():
            row = {"label": s["label"], "symbol": s["symbol"]}
            for h in ("h5", "h20"):
                r = s.get(h)
                if r:
                    row[h] = {k: r[k] for k in ("prob_up", "skill", "auc", "has_skill", "asof", "acc", "acc_naive") if k in r}
            items[node] = row
        sig.update({"model_asof": m["asof"], "test_years": m["test_years"], "method": m["method"],
                    "summary": m["summary"], "items": items})
    sig_slot = len(writes)
    writes.append(None)  # signals/latest is written below, once stock pressure is added

    cal_p = KNOWLEDGE / "edges_learned.json"
    if cal_p.exists():
        c = json.loads(cal_p.read_text())
        keep = ("s", "t", "sign", "prior", "w", "verdict", "predictive", "n", "hit5", "base5", "lift5", "p5", "resp5",
                "phit5", "pbase5", "plift5", "pp5", "hit20", "base20", "lift20", "plift20", "corr")
        writes.append(_write("calibration/links", {"asof": c["asof"], "method": c["method"], "counts": c["counts"],
                                                   "predictive_counts": c.get("predictive_counts", {}),
                                                   "edges": [{k: e[k] for k in keep if k in e} for e in c["edges"]],
                                                   "candidates": c.get("candidates", [])[:20]}))
    cor_p = KNOWLEDGE / "correlations.json"
    if cor_p.exists():
        c = json.loads(cor_p.read_text())
        cor = {k: c[k] for k in ("asof", "since", "method", "nodes", "matrix", "famous", "lead_lag", "lead_lag_tests") if k in c}
        # strongest pairs that are not the same exposure in two wrappers (a fund and what it holds)
        from .calibrate import same_family
        cor["top_pairs"] = [p for p in c.get("top_pairs", []) if not same_family(p["a"], p["b"])][:30]
        xp = KNOWLEDGE / "experiment_xasset.json"
        if xp.exists():
            cor["experiment"] = json.loads(xp.read_text())["summary"]
        writes.append(_write("correlations/latest", cor))
    prof_p = KNOWLEDGE / "stock_profiles.json"
    if prof_p.exists():
        from .exposures import stock_screen
        prof = json.loads(prof_p.read_text())
        scr = stock_screen(prof["profiles"])
        scr.update({"updated": now, "profiles_asof": prof["asof"], "factors": {f: v["label"] for f, v in prof["factors"].items()}})
        writes.append(_write("screen/latest", scr))
    writes.append(_write("prices/latest", {"updated": now, "days": PRICE_DAYS, "series": recent_closes()}))
    focus = sorted((KNOWLEDGE / "focus").glob("*.json"))
    if focus:
        # the day's research list (no holdings in it: the page marks the owner's holdings from owner/portfolio)
        writes.append(_write("focus/latest", json.loads(focus[-1].read_text())))
    pf = owner_portfolio(now)
    if pf:
        # owner/ is readable only by the artifact's owner (db rule), so holdings never reach shared viewers
        writes.append(_write("owner/portfolio", pf))
    status = {"updated": now, "events_total": len(events), "events_24h": sum(1 for e in events if e["ts"] >= _hours_ago(24)),
              "top_pressure": sorted(({"id": k, "label": labels.get(k, k), "v": v} for k, v in sig["pressure"].items()), key=lambda x: -abs(x["v"]))[:12]}
    writes[sig_slot] = _write("signals/latest", sig)
    writes.append(_write("status/run", status))
    versions = json.loads(VERSIONS.read_text()) if VERSIONS.exists() else {}
    for w in writes:
        v = versions.get(f"{w['collection']}/{w['doc_id']}")
        if v:
            w["if_version"] = v
        w["op"] = "set"
    (DB_OUT / "writes.json").write_text(json.dumps(writes, indent=1))
    print(json.dumps(writes, indent=1))
    build_profiles(versions)


PRICE_DAYS = 40


def _closes(sym, n=PRICE_DAYS):
    from .fetch import load_prices
    s = load_prices(sym)
    if s is None or s.empty:
        return None
    s = s.dropna().iloc[-n:]
    return [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in s.items()]


def recent_closes():
    """Last 40 daily closes of every map asset, so the page can score forecasts people make on it."""
    from .config import PROXIES
    out = {}
    for node, (sym, kind) in PROXIES.items():
        if node.startswith("pf_"):
            continue
        c = _closes(sym)
        if c:
            out[node] = {"sym": sym, "kind": kind, "c": c}
    return out


def owner_portfolio(now):
    """The owner's holdings report (predictor.portfolio), slimmed for the page, with recent closes per holding."""
    p = KNOWLEDGE / "portfolio_report.json"
    if not p.exists():
        return None
    return slim_report(json.loads(p.read_text()), now)


def slim_report(r, now):
    """The portfolio report as the Portfolio desk reads it (also used for platform users' reports)."""
    from .focus import _analysts
    an = _analysts()
    cal = (json.loads((KNOWLEDGE / "earnings_calendar.json").read_text()) if (KNOWLEDGE / "earnings_calendar.json").exists() else {}).get("reports", {})
    hold = []
    for h in r["holdings"]:
        o = h.get("odds") or {}
        hold.append({"key": h.get("key", h["sym"]), "sym": h["sym"], "kind": h["kind"], "qty": h["qty"], "avg_cost": h["avg_cost"], "weight": h.get("weight"),
                     "broker": h.get("broker", "robinhood"), "account": h.get("account"), "ccy": h.get("ccy", "USD"),
                     "price_local": h.get("price_local"), "value": h.get("value"), "value_usd": h.get("value_usd", h.get("value")),
                     **({"cost_note": h["cost_note"]} if h.get("cost_note") else {}),
                     **{k: h[k] for k in ("name", "category", "plan", "option", "nav_date", "local_premium") if h.get(k) is not None},
                     "sector": h.get("sector"), "trend": h["trend"], "betas": h.get("betas_3y"),
                     "exposures": [{k: x[k] for k in ("f", "label", "rho", "t", "cls", "hidden") if k in x} for x in h.get("exposures", [])[:5]],
                     "moves": h.get("moves", [])[:6], "pressure": h.get("pressure"),
                     "odds": {hz: {k: o[hz][k] for k in ("prob_up", "skill", "auc", "has_skill", "asof") if k in o[hz]} for hz in ("h5", "h20") if o.get(hz)},
                     "analysts": an.get(h["sym"]), "earnings": cal.get(h["sym"]), "c": _closes(h["sym"])})
    b = r["basket"]
    return {"updated": now, "asof": r["asof"], "source": r.get("source"), "fx": r.get("fx"), "accounts": r.get("accounts", []),
            "brokers": r.get("brokers", {}),
            "basket": {k: b[k] for k in ("value_now", "ret_1y", "max_drawdown_1y", "vol_ann", "days", "left_out") if k in b},
            "leaning": r.get("factor_leaning", {}), "holdings": hold}


SHARDS = 24
BATCH_BYTES = 850_000


def shard_of(sym):
    return sum(ord(c) for c in sym) % SHARDS


def build_profiles(versions):
    """Stock profiles change weekly at most, so they go in their own batches, only when newer than the last push.
    Writes out/db/profile_batches.json: a list of batches, each under the 1 MiB batch limit."""
    prof_p = KNOWLEDGE / "stock_profiles.json"
    target = DB_OUT / "profile_batches.json"
    if not prof_p.exists():
        return
    prof = json.loads(prof_p.read_text())
    if versions.get("_profiles_asof") == prof["asof"]:
        target.write_text("[]")
        print("stock profiles already pushed for", prof["asof"])
        return
    docs = []
    shards = {}
    index = {}
    for sym, p in prof["profiles"].items():
        k = shard_of(sym)
        shards.setdefault(k, {})[sym] = p
        index[sym] = [p["name"], p["sector"], p["index"], k]
    docs.append(_write("stocks/index", {"asof": prof["asof"], "count": len(index), "stocks": index}))
    docs.append(_write("stocks/factors", {"asof": prof["asof"], "since": prof["since"], "tests": prof["tests"], "counts": prof["counts"],
                                          "expected_false": prof["expected_false"], "factors": prof["factors"], "method": prof["method"],
                                          "by_factor": prof["by_factor"], "hidden": prof["hidden"]}))
    for k in sorted(shards):
        docs.append(_write(f"stocks/s{k:02d}", {"asof": prof["asof"], "profiles": shards[k]}))
    batches, cur, size = [], [], 0
    for d in docs:
        b = (DB_OUT / d["file_path"].split("/")[-1]).stat().st_size
        if cur and (size + b > BATCH_BYTES or len(cur) >= 50):
            batches.append(cur)
            cur, size = [], 0
        d["op"] = "set"
        v = versions.get(f"{d['collection']}/{d['doc_id']}")
        if v:
            d["if_version"] = v
        cur.append(d)
        size += b
    if cur:
        batches.append(cur)
    target.write_text(json.dumps(batches, indent=1))
    print(f"stock profiles: {len(docs)} documents in {len(batches)} batches -> {target}")


def _hours_ago(h):
    from datetime import timedelta
    return (datetime.now(timezone.utc) - timedelta(hours=h)).isoformat(timespec="minutes").replace("+00:00", "Z")


def record(js):
    versions = json.loads(VERSIONS.read_text()) if VERSIONS.exists() else {}
    versions.update({k: (v if k.startswith("_") else int(v)) for k, v in json.loads(js).items()})
    VERSIONS.write_text(json.dumps(versions, indent=1, sort_keys=True))
    print(f"recorded {len(versions)} document versions")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--days", nargs="*")
    ap.add_argument("--profiles-pushed", action="store_true", help="mark the current stock profiles as sent")
    args = ap.parse_args(argv)
    if args.profiles_pushed:
        asof = json.loads((KNOWLEDGE / "stock_profiles.json").read_text())["asof"]
        record(json.dumps({"_profiles_asof": asof}))
        (DB_OUT / "profile_batches.json").write_text("[]")
    elif args.record:
        record(args.record)
    else:
        build(args.days)


if __name__ == "__main__":
    main()
