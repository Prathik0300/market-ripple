"""Daily focus list: where this week's news pushes hardest, by asset class, as a starting list for research.

Each asset is ranked by the same event exposure as the screener: the events of the last 14 days are traced
through the map to the factors they move, then to the asset through its measured exposure (stocks), its own
map node (commodities and funds), or bitcoin's pressure times the coin's correlation with bitcoin (crypto).
Beside each name sits the other evidence a researcher would check, kept separate rather than blended into
one verdict: whether the walk-forward model has a tested edge on it, the analyst consensus (Robinhood, US
stocks), the price trend, and any earnings report within 14 days. "Lines up" counts how many of those point
the same way as the news. Only the model has been tested on unseen years, and it shows little edge for most
assets, so lining up is a reason to look closer, not a forecast.

The list is saved per day, and later runs check how each day's list actually moved (1 and 5 trading days on),
so the page can show whether following the news direction has worked.

    python -m predictor.focus                         # writes knowledge/focus/<date>.json and out/focus_watchlist.json
    python -m predictor.focus earnings <file>         # save a get_earnings_calendar result
    python -m predictor.focus watchlist-created '{"list_id": "..."}'   # note that today's Robinhood list exists
"""
import json
import math
from datetime import date, datetime, timezone

import numpy as np

from .config import KNOWLEDGE, OUT, PROXIES
from .exposures import NODE_TO_FACTOR, daily_returns, stock_screen, weekly
from .fetch import fetch_symbol, load_prices
from .portfolio import trend

FOCUS_DIR = KNOWLEDGE / "focus"
PER_SIDE = 12
# US-listed funds that hold or track a commodity node, for the Robinhood watchlist (futures cannot be added there)
COMMODITY_ETF = {"brent": "USO", "hh": "UNG", "gold": "GLD", "silver": "SLV", "copper": "CPER", "steel": "SLX",
                 "wheat": "WEAT", "soybeans": "SOYB"}
CRYPTO = {"BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD", "XRP": "XRP-USD", "ADA": "ADA-USD", "AVAX": "AVAX-USD",
          "DOGE": "DOGE-USD", "LTC": "LTC-USD", "LINK": "LINK-USD", "BCH": "BCH-USD", "XLM": "XLM-USD", "DOT": "DOT-USD",
          "SHIB": "SHIB-USD", "UNI": "UNI7083-USD"}
WATCH = {"us_up": 6, "us_down": 4, "etf_up": 3, "etf_down": 2, "crypto": 2}


def _json(p, default=None):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return default


def _market(sym):
    if sym.endswith((".NS", ".BO")):
        return "India"
    if "." in sym or sym.startswith("^") or sym[:1].isdigit():
        return "Global"
    return "US"


def _trend(sym):
    try:
        t = trend(sym, None)
    except Exception:
        return None
    t.pop("vs_cost", None)
    return t


def _analysts():
    files = sorted((KNOWLEDGE / "analyst").glob("*.jsonl"))
    out = {}
    for f in files[-2:]:  # latest file wins; the one before gives the change
        for line in f.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                prev = out.get(r["sym"])
                out[r["sym"]] = {"buy": r["buy"], "hold": r["hold"], "sell": r["sell"], "balance": r["balance"],
                                 "target_gap": r["target_gap"], "date": r["date"],
                                 "balance_prev": prev["balance"] if prev and prev["date"] != r["date"] else None}
    return out


def _lines_up(direction, model=None, analyst=None, tr=None):
    """Which independent signals point the same way as the news. None = no data for that signal."""
    def m():
        if not model or not model.get("has_skill"):
            return None
        return (model["prob_up"] >= 0.5) == (direction > 0)

    def a():
        if not analyst or analyst.get("balance") is None:
            return None
        b = analyst["balance"]
        return True if (direction > 0 and b >= 0.5) or (direction < 0 and b <= 0.2) else False

    def t():
        if not tr or tr.get("ret_1m") is None or tr.get("vs_200d") is None:
            return None
        up = tr["ret_1m"] > 0 and tr["vs_200d"] > 0
        down = tr["ret_1m"] < 0 and tr["vs_200d"] < 0
        return True if (direction > 0 and up) or (direction < 0 and down) else False

    return {"model": m(), "analysts": a(), "trend": t()}


def stocks(profiles, analysts, cal):
    scr = stock_screen(profiles, top=500)
    out = {"US": {"up": [], "down": []}, "India": {"up": [], "down": []}}
    # screener scores add up over many events, so show them against the strongest push of the day (= 100)
    top = max([abs(scr[s][0]["score"]) for s in ("up", "down") if scr[s]] or [1])
    for side in ("up", "down"):
        for r in scr[side]:
            mk = _market(r["sym"])
            if mk not in out or len(out[mk][side]) >= PER_SIDE:
                continue
            p = profiles.get(r["sym"], {})
            tr = _trend(r["sym"])
            an = analysts.get(r["sym"]) if mk == "US" else None
            d = 1 if r["score"] > 0 else -1
            out[mk][side].append({
                "sym": r["sym"], "name": r["name"], "sector": r["sector"], "kind": "stock", "market": mk,
                "score": round(100 * r["score"] / top), "raw": r["score"], "dir": d,
                "factors": [{"f": f["f"], "rho": f["rho"], "cls": f["cls"]} for f in r["factors"]],
                "events": [{k: e[k] for k in ("title", "url", "ts", "c")} for e in r["events"][:2]],
                "hidden": any(x.get("hidden") for x in p.get("exposures", []) if x["f"] in {f["f"] for f in r["factors"]}),
                "trend": tr, "analysts": an, "earnings": cal.get(r["sym"]), "lines_up": _lines_up(d, None, an, tr),
                "rh": mk == "US"})
    return out, scr


def _node_events(per_event, node, n=2):
    rows = [(e, press.get(node, 0)) for e, press in per_event]
    rows = [r for r in rows if abs(r[1]) >= 0.01]
    rows.sort(key=lambda r: -abs(r[1]))
    return [{"title": e["title"], "url": e.get("url", ""), "ts": e["ts"], "c": round(v, 3)} for e, v in rows[:n]]


def commodities(pressure, per_event, model, labels):
    rows = []
    g = json.loads((KNOWLEDGE / "graph.json").read_text())
    layer = {n[0]: n[1] for n in g["nodes"]}
    for node, (sym, kind) in PROXIES.items():
        if layer.get(node) not in (2, 4) or node in ("bitcoin", "ether") or node.startswith("pf_"):
            continue
        v = pressure.get(node, 0)
        if abs(v) < 0.02:
            continue
        m = (model.get(node) or {})
        h20 = m.get("h20")
        etf = sym if layer[node] == 4 else COMMODITY_ETF.get(node)
        d = 1 if v > 0 else -1
        tr = _trend(sym)
        rows.append({"sym": node, "name": labels.get(node, node), "kind": "fund" if layer[node] == 4 else "commodity",
                     "proxy": sym, "etf": etf, "score": round(v * 100), "raw": v, "dir": d,
                     "events": _node_events(per_event, node), "trend": tr,
                     "model": {k: h20[k] for k in ("prob_up", "has_skill", "auc", "skill") if k in h20} if h20 else None,
                     "lines_up": _lines_up(d, h20, None, tr), "rh": bool(etf)})
    up = sorted([r for r in rows if r["dir"] > 0], key=lambda r: -r["raw"])[:PER_SIDE]
    down = sorted([r for r in rows if r["dir"] < 0], key=lambda r: r["raw"])[:PER_SIDE]
    return {"up": up, "down": down}


def crypto(pressure, per_event, model, pairs):
    btc_w = weekly(daily_returns("BTC-USD"))
    btc_p = pressure.get("bitcoin", 0)
    rows = []
    for code, ysym in CRYPTO.items():
        try:
            fetch_symbol(ysym)
        except Exception:
            pass
        r = daily_returns(ysym)
        if r is None:
            continue
        w = weekly(r)
        w = w[w.index >= w.index[-1] - np.timedelta64(3 * 365, "D")]
        both = w.to_frame("c").join(btc_w.rename("b"), how="inner").dropna()
        corr = float(both["c"].corr(both["b"])) if len(both) > 52 else None
        if code == "BTC":
            v, corr, node = btc_p, 1.0, "bitcoin"
        elif code == "ETH" and "ether" in pressure:
            v, node = pressure["ether"], "ether"
        else:
            v, node = btc_p * (corr or 0), None
        m = model.get(node, {}) if node else {}
        h20 = m.get("h20")
        d = 1 if v > 0 else -1
        tr = _trend(ysym)
        rows.append({"sym": code, "name": (pairs.get(code) or {}).get("name", code), "kind": "crypto", "proxy": ysym,
                     "pair_id": (pairs.get(code) or {}).get("id"), "score": round(v * 100), "raw": v, "dir": d,
                     "corr_btc": round(corr, 2) if corr is not None else None,
                     "events": _node_events(per_event, node or "bitcoin"), "trend": tr,
                     "model": {k: h20[k] for k in ("prob_up", "has_skill", "auc", "skill") if k in h20} if h20 else None,
                     "lines_up": _lines_up(d, h20, None, tr), "rh": bool((pairs.get(code) or {}).get("id"))})
    rows.sort(key=lambda r: -abs(r["raw"]))
    return {"up": [r for r in rows if r["dir"] > 0], "down": [r for r in rows if r["dir"] < 0]}


def _price_at(sym, day, k):
    """Close on the first trading day on or after `day`, and the close k trading days after that."""
    s = load_prices(sym)
    if s is None:
        return None, None
    s = s.dropna()
    i = s.index.searchsorted(np.datetime64(day))
    if i >= len(s) or i + k >= len(s):
        return (float(s.iloc[i]) if i < len(s) else None), None
    return float(s.iloc[i]), float(s.iloc[i + k])


def track_record(today):
    """How earlier focus lists moved: did names the news pushed up rise, and names it pushed down fall?"""
    stats = {h: {"up_n": 0, "up_hit": 0, "down_n": 0, "down_hit": 0, "rose": 0, "n": 0} for h in (1, 5)}
    lists = 0
    for f in sorted(FOCUS_DIR.glob("*.json")):
        day = f.stem
        if day >= today:
            continue
        doc = _json(f, {})
        lists += 1
        for grp in _groups(doc):
            for r in grp:
                sym = r.get("proxy") or r["sym"]
                if r["kind"] == "stock":
                    sym = r["sym"]
                for h in (1, 5):
                    p0, p1 = _price_at(sym, doc.get("asof_day", day), h)
                    if p0 is None or p1 is None:
                        continue
                    rose = p1 > p0
                    st = stats[h]
                    st["n"] += 1
                    st["rose"] += int(rose)
                    if r["dir"] > 0:
                        st["up_n"] += 1
                        st["up_hit"] += int(rose)
                    else:
                        st["down_n"] += 1
                        st["down_hit"] += int(not rose)
    out = {"lists": lists}
    for h, st in stats.items():
        out[f"d{h}"] = {"items": st["n"], "tailwind_rose": round(st["up_hit"] / st["up_n"], 3) if st["up_n"] else None,
                        "headwind_fell": round(st["down_hit"] / st["down_n"], 3) if st["down_n"] else None,
                        "base_rose": round(st["rose"] / st["n"], 3) if st["n"] else None, "tailwinds": st["up_n"], "headwinds": st["down_n"]}
    return out


def _groups(doc):
    for key in ("us", "india", "commodities", "crypto"):
        g = doc.get(key) or {}
        yield g.get("up", [])
        yield g.get("down", [])


def watchlist(doc, day):
    syms, seen = [], set()

    def add(s):
        if s and s not in seen:
            seen.add(s)
            syms.append(s)

    for r in doc["us"]["up"][:WATCH["us_up"]]:
        add(r["sym"])
    for r in doc["us"]["down"][:WATCH["us_down"]]:
        add(r["sym"])
    for r in [x for x in doc["commodities"]["up"] if x.get("etf")][:WATCH["etf_up"]]:
        add(r["etf"])
    for r in [x for x in doc["commodities"]["down"] if x.get("etf")][:WATCH["etf_down"]]:
        add(r["etf"])
    coins = sorted(doc["crypto"]["up"] + doc["crypto"]["down"], key=lambda r: -abs(r["raw"]))
    pairs = [{"code": r["sym"], "id": r["pair_id"]} for r in coins if r.get("pair_id")][:WATCH["crypto"]]
    d = date.fromisoformat(day)
    return {"date": day, "name": f"Ripple focus {d.day} {d.strftime('%b %Y')}",
            "description": "Most exposed to this week's news, both directions. A research list from Market Ripple, not advice.",
            "symbols": syms, "crypto": pairs}


def build():
    today = date.today().isoformat()
    prof = _json(KNOWLEDGE / "stock_profiles.json", {})
    profiles = prof.get("profiles", {})
    model = (_json(KNOWLEDGE / "model_report.json", {}) or {}).get("signals", {})
    cal = (_json(KNOWLEDGE / "earnings_calendar.json", {}) or {}).get("reports", {})
    pairs = _json(KNOWLEDGE / "crypto_pairs.json", {}) or {}
    analysts = _analysts()
    from .events import graph, per_event_pressure, pressure
    labels = {n[0]: n[2] for n in graph()["nodes"]}
    pr = pressure()
    per_event = per_event_pressure()
    st, scr = stocks(profiles, analysts, cal)
    doc = {"date": today, "updated": datetime.now(timezone.utc).isoformat(timespec="minutes").replace("+00:00", "Z"),
           "asof_day": today, "events_used": scr["events_used"], "method": __doc__.strip().split("\n\n")[1],
           "factors": {f: v["label"] for f, v in prof.get("factors", {}).items()},
           "us": st["US"], "india": st["India"], "commodities": commodities(pr, per_event, model, labels),
           "crypto": crypto(pr, per_event, model, pairs)}
    wl = watchlist(doc, today)
    made = [json.loads(l) for l in (KNOWLEDGE / "watchlists.jsonl").read_text().splitlines() if l.strip()] if (KNOWLEDGE / "watchlists.jsonl").exists() else []
    doc["watchlist"] = {**{k: wl[k] for k in ("name", "date")}, "count": len(wl["symbols"]) + len(wl["crypto"]),
                        "symbols": wl["symbols"] + [c["code"] for c in wl["crypto"]],
                        "created": next((m.get("created") for m in made if m.get("date") == today), None)}
    doc["track"] = track_record(today)
    FOCUS_DIR.mkdir(parents=True, exist_ok=True)
    (FOCUS_DIR / f"{today}.json").write_text(json.dumps(doc, default=float))
    OUT.mkdir(exist_ok=True)
    (OUT / "focus_watchlist.json").write_text(json.dumps(wl, indent=1))
    return doc, wl


def save_earnings(path):
    """Save a get_earnings_calendar result (the tool's JSON, or its saved output file) as knowledge/earnings_calendar.json."""
    raw = json.loads(open(path).read())
    res = raw.get("data", raw).get("results", []) if isinstance(raw, dict) else raw
    reports = {}
    for r in res:
        rep, eps = r.get("report") or {}, r.get("eps") or {}
        if r.get("symbol") and rep.get("date") and eps.get("actual") is None:
            reports.setdefault(r["symbol"], {"date": rep["date"], "timing": rep.get("timing"), "verified": rep.get("verified"),
                                             "eps_est": eps.get("estimate")})
    (KNOWLEDGE / "earnings_calendar.json").write_text(json.dumps({"fetched": date.today().isoformat(),
        "source": "Robinhood get_earnings_calendar (high_market_cap)", "reports": reports}))
    print(f"saved {len(reports)} upcoming reports")


def record_watchlist(js):
    """Note that today's Robinhood watchlist was created: '{"list_id": "...", "symbols": [...], "crypto": [...]}'."""
    info = json.loads(js)
    wl = json.loads((OUT / "focus_watchlist.json").read_text())
    row = {"date": wl["date"], "name": wl["name"], "list_id": info.get("list_id"), "symbols": info.get("symbols", wl["symbols"]),
           "crypto": info.get("crypto", [c["code"] for c in wl["crypto"]]),
           "created": datetime.now(timezone.utc).isoformat(timespec="minutes").replace("+00:00", "Z")}
    with (KNOWLEDGE / "watchlists.jsonl").open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"recorded {row['name']}")


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    e = sub.add_parser("earnings")
    e.add_argument("path")
    w = sub.add_parser("watchlist-created")
    w.add_argument("json")
    args = ap.parse_args(argv)
    if args.cmd == "earnings":
        return save_earnings(args.path)
    if args.cmd == "watchlist-created":
        return record_watchlist(args.json)
    doc, wl = build()
    for key, title in (("us", "US stocks"), ("india", "India stocks"), ("commodities", "Commodities and funds"), ("crypto", "Crypto")):
        g = doc[key]
        print(f"\n## {title}")
        for side in ("up", "down"):
            for r in g[side][:6]:
                lu = r["lines_up"]
                agree = sum(1 for v in lu.values() if v)
                known = sum(1 for v in lu.values() if v is not None)
                ev = r["events"][0]["title"][:70] if r["events"] else ""
                print(f"  {'+' if side == 'up' else '-'} {r['sym']:12s} {r['score']:+4d}  lines up {agree}/{known}  {ev}")
    print(f"\nwatchlist: {wl['name']}: {', '.join(wl['symbols'])} + crypto {', '.join(c['code'] for c in wl['crypto'])}")
    t = doc["track"]
    print(f"track record: {t['lists']} earlier lists; 1 day {t['d1']}; 5 days {t['d5']}")


if __name__ == "__main__":
    main()
