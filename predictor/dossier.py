"""Research dossiers: everything the system knows about one asset, in one document, for the page's Research view.

For each name on today's focus list, each of the owner's holdings and anything requested with "Find more",
one dossier gathers:
  - identity, price history (1 year weekly and the last 60 daily closes) and the trend numbers;
  - what moves it: measured exposures (stocks), map links (commodities and funds), bitcoin beta (coins);
  - the knowledge graph around it: its drivers and the recent events pushing each driver;
  - the sources behind that: logged events (with links), the news collector's latest headlines that mention
    it (press wires, SEC filings and insider trades included) and facts the job found on the web;
  - analyst ratings over time, the next earnings date and today's fundamentals (Robinhood);
  - its biggest surprise days and the library episodes that touched its drivers.
Dossiers for focus names go to the shared `dossier/` collection; holdings-only and requested ones go to
`owner/` so they stay private to the owner.

    python -m predictor.dossier build                     # writes knowledge/dossiers/ and out/db/dossier_batches.json
    python -m predictor.dossier targets                   # names to search the web for today, with a query for each
    python -m predictor.dossier web out/web_facts.json    # add facts found on the web
    python -m predictor.dossier fundamentals <file>       # save get_equity_fundamentals results
    python -m predictor.dossier requests <file>           # queue Find-more requests read from the page
    python -m predictor.dossier pushed                    # after the batches are sent: remember what was pushed
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone

import numpy as np

from .config import EVENTS_FILE, KNOWLEDGE, OUT, PROXIES
from .exposures import NODE_TO_FACTOR
from .fetch import load_prices
from .portfolio import trend

DIR = KNOWLEDGE / "dossiers"
WEB_DIR = KNOWLEDGE / "web_facts"
FUND = KNOWLEDGE / "fundamentals.json"
REQ = KNOWLEDGE / "dossier_requests.json"
PUSHED = KNOWLEDGE / "dossier_pushed.json"
DB = OUT / "db"
VERSIONS = KNOWLEDGE / "db_versions.json"
BATCH_BYTES, BATCH_MAX = 850_000, 45
PUSH_EVERY_HOURS = 6
WEB_TARGETS = {"us_up": 6, "us_down": 4, "commodities": 3, "crypto": 2}  # about 15 a day, plus holdings and requests
GENERIC = {"american", "united", "general", "first", "national", "international", "global", "bank", "new", "the", "china",
           "india", "indian", "state", "royal", "western", "eastern", "southern", "northern", "pacific", "atlantic", "energy"}
FACTOR_TO_NODE = {}
for _n, _f in NODE_TO_FACTOR.items():
    FACTOR_TO_NODE.setdefault(_f, _n)


def _json(p, default=None):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return default


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="minutes").replace("+00:00", "Z")


def _clean_name(name):
    n = re.sub(r"\(.*?\)", " ", name or "")
    n = re.sub(r"[,.]", " ", n)
    n = re.sub(r"\b(Inc|Incorporated|Corp|Corporation|Company|Co|Ltd|Limited|plc|PLC|Holdings?|Group|N ?V|S ?A|AG|SE|LLC|LP|Industries|Technologies|Ltd)\b", " ", n)
    words = [w for w in n.split() if w]
    if not words:
        return name or ""
    if (len(words[0]) >= 5 or (words[0].isupper() and len(words[0]) >= 3)) and words[0].lower() not in GENERIC:
        return words[0]
    return " ".join(words[:2])


def _query_name(name, sym=""):
    """The company name as a person would search it: suffixes and share classes dropped, at most three words."""
    n = re.sub(r"\(.*?\)", " ", name or "")
    n = re.sub(r"[,.]", " ", n)
    n = re.sub(r"\b(Inc|Incorporated|Corp|Corporation|Company|Co|Ltd|Limited|plc|PLC|Holdings?|Group|N ?V|S ?A|AG|LLC|LP|Industries)\b", " ", n)
    words = n.split()[:3]
    q = " ".join(words) or sym
    return q if q.upper() != sym.upper() else sym


def _desc_name(desc):
    m = re.match(r"\s*(.{2,60}?)\s+(engages|is |operates|designs|provides|owns|manufactures|makes|produces|supplies|builds|runs|mines|turns|distributes|invests|ships)", desc or "")
    return m.group(1).strip(" ,") if m else None


def _matcher(terms):
    """A case-sensitive matcher for tickers (whole words) and a case-insensitive one for names."""
    pats = []
    for t in terms:
        if not t:
            continue
        if t.isupper() and len(t) <= 6:
            if len(t) >= 3:
                pats.append(re.compile(r"(?<![A-Za-z])" + re.escape(t) + r"(?![A-Za-z])"))
        elif len(t) >= 4:
            pats.append(re.compile(r"\b" + re.escape(t) + r"\b", re.I))
    return lambda text: any(p.search(text or "") for p in pats)


def _series(sym):
    s = load_prices(sym) if sym else None
    if s is None or s.empty:
        return None
    s = s.dropna()
    yr = s[s.index >= s.index[-1] - timedelta(days=371)]
    weekly = yr.resample("W-FRI").last().dropna()
    return {"weekly": [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in weekly.items()],
            "daily": [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in s.iloc[-60:].items()]}


def _trend(sym):
    try:
        t = trend(sym, None)
        t.pop("vs_cost", None)
        return t
    except Exception:
        return None


def _analyst_history(sym):
    out = []
    for f in sorted((KNOWLEDGE / "analyst").glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                if r["sym"] == sym:
                    out.append({k: r.get(k) for k in ("date", "buy", "hold", "sell", "balance", "target", "target_gap", "price")})
    return out[-30:]


def _web(key):
    d = _json(WEB_DIR / f"{key}.json", {}) or {}
    return d.get("facts", [])[:12], (d.get("searched") or [None])[-1]


class Context:
    """Everything shared by all dossiers, loaded once."""

    def __init__(self):
        from .events import graph, per_event_pressure, pressure
        self.graph = graph()
        self.nodes = {n[0]: {"id": n[0], "layer": n[1], "label": n[2], "inst": n[3], "desc": n[4]} for n in self.graph["nodes"]}
        self.edges = self.graph["edges"]
        self.incidents = self.graph.get("incidents", [])
        self.pressure = pressure()
        self.per_event = per_event_pressure()
        self.events = [json.loads(l) for l in EVENTS_FILE.read_text().splitlines() if l.strip()] if EVENTS_FILE.exists() else []
        self.events.sort(key=lambda e: e["ts"], reverse=True)
        news = _json(OUT / "news_candidates.json", {}) or {}
        self.headlines = news.get("items", [])
        prof = _json(KNOWLEDGE / "stock_profiles.json", {}) or {}
        self.profiles = prof.get("profiles", {})
        self.factors = {f: v["label"] for f, v in prof.get("factors", {}).items()}
        self.model = (_json(KNOWLEDGE / "model_report.json", {}) or {}).get("signals", {})
        self.calendar = (_json(KNOWLEDGE / "earnings_calendar.json", {}) or {}).get("reports", {})
        self.fund = (_json(FUND, {}) or {}).get("data", {})
        self.fund_asof = (_json(FUND, {}) or {}).get("asof")
        self.cal = {(e["s"], e["t"]): e for e in (_json(KNOWLEDGE / "edges_learned.json", {}) or {}).get("edges", [])}
        focus = sorted((KNOWLEDGE / "focus").glob("*.json"))
        self.focus = _json(focus[-1], {}) if focus else {}
        self.focus_items = {}
        for grp in ("us", "india", "commodities", "crypto"):
            for side in ("up", "down"):
                for r in (self.focus.get(grp) or {}).get(side, []):
                    self.focus_items[r["sym"]] = r
        self.portfolio = _json(KNOWLEDGE / "portfolio.json", {}) or {}
        uni = _json(KNOWLEDGE.parent / "data" / "universe" / "universe.json", {}) or {}
        rows = uni.get("stocks", uni) if isinstance(uni, dict) else uni
        self.universe_names = {r["sym"]: r["name"] for r in rows if isinstance(r, dict) and "sym" in r} if isinstance(rows, list) else {}

    def name_of(self, sym):
        p = self.profiles.get(sym, {})
        return (p.get("name") or (self.focus_items.get(sym) or {}).get("name") or self.universe_names.get(sym)
                or _desc_name((self.fund.get(sym) or {}).get("description")) or sym)

    # factor pressure from each recent event, so a stock's events can be traced through its exposures
    def event_factor_pressure(self):
        if hasattr(self, "_efp"):
            return self._efp
        rows = []
        for e, press in self.per_event:
            fp = {}
            for node, v in press.items():
                f = NODE_TO_FACTOR.get(node)
                if f:
                    fp[f] = max(-1.0, min(1.0, fp.get(f, 0) + v))
            rows.append((e, fp, press))
        self._efp = rows
        return rows


def _ev(e, c=None, via=None):
    out = {k: e.get(k) for k in ("id", "ts", "title", "summary", "url", "source", "scale", "category", "region")}
    if c is not None:
        out["c"] = round(c, 3)
    if via:
        out["via"] = via
    return out


def _episodes(ctx, nodes, n=6):
    rows = [i for i in ctx.incidents if any(m[0] in nodes for m in i.get("m", [])) or any(s in nodes for s in i.get("shock", []))]
    rows.sort(key=lambda i: i["d"], reverse=True)
    return [{"d": i["d"], "t": i["t"], "lesson": i.get("lesson", ""), "src": i.get("src", ""),
             "m": [m for m in i.get("m", []) if m[0] in nodes][:3] or i.get("m", [])[:2]} for i in rows[:n]]


def _headlines(ctx, match, n=15):
    rows = [h for h in ctx.headlines if match(h.get("title", ""))]
    rows.sort(key=lambda h: h.get("ts", ""), reverse=True)
    return [{k: h.get(k) for k in ("title", "url", "source", "ts", "topic", "feed")} for h in rows[:n]]


def stock_dossier(ctx, sym):
    p = ctx.profiles.get(sym, {})
    name = ctx.name_of(sym)
    exp = {x["f"]: x for x in p.get("exposures", [])}
    # events reaching it through its measured exposures
    contrib = []
    for e, fp, _press in ctx.event_factor_pressure():
        best, total = None, 0.0
        for f, v in fp.items():
            x = exp.get(f)
            if x:
                c = v * x["rho"] * (1 if x["cls"] == "robust" else 0.6)
                total += c
                if best is None or abs(c) > abs(best[1]):
                    best = (f, c)
        if abs(total) > 0.002:
            contrib.append((e, total, best[0] if best else None))
    contrib.sort(key=lambda t: -abs(t[1]))
    terms = [sym.split(".")[0], _clean_name(name)]
    match = _matcher(terms)
    direct = [e for e in ctx.events[:400] if match(e.get("title", "")) or match(e.get("summary", ""))][:10]
    seen = {e["id"] for e, _, _ in contrib[:20]}
    events = [_ev(e, c, via) for e, c, via in contrib[:20]] + [_ev(e, via="mentions it") for e in direct if e["id"] not in seen]
    # the graph around it: its exposures, each with the events pushing that factor hardest
    drivers = []
    for f, x in sorted(exp.items(), key=lambda t: -abs(t[1]["t"]))[:8]:
        evs = sorted(((e, fp.get(f, 0) * x["rho"]) for e, fp, _ in ctx.event_factor_pressure() if abs(fp.get(f, 0)) >= 0.01), key=lambda t: -abs(t[1]))[:2]
        node = FACTOR_TO_NODE.get(f)
        drivers.append({"id": f, "label": x["label"], "rho": x["rho"], "cls": x["cls"], "hidden": x.get("hidden", False), "t": x["t"],
                        "node": node if node in ctx.nodes else None, "push": round(sum(fp.get(f, 0) for _, fp, _ in ctx.event_factor_pressure()), 3),
                        "events": [{"id": e["id"], "title": e["title"], "url": e.get("url", ""), "ts": e["ts"], "scale": e.get("scale"), "c": round(c, 3)} for e, c in evs]})
    nodes = {d["node"] for d in drivers if d["node"]}
    web, searched = _web(sym)
    return {"key": sym, "kind": "stock", "name": name, "sector": p.get("sector"), "industry": p.get("industry"), "index": p.get("index"),
            "market": "India" if sym.endswith((".NS", ".BO")) else "US" if "." not in sym else "Global",
            "rh": "." not in sym, "price": _series(sym), "trend": _trend(sym), "beta_mkt": p.get("beta_mkt"), "beta_sector": p.get("beta_sector"),
            "exposures": p.get("exposures", []), "graph": {"drivers": drivers}, "events": events,
            "headlines": _headlines(ctx, match), "web": web, "web_searched": searched,
            "analysts": _analyst_history(sym), "earnings": ctx.calendar.get(sym), "fundamentals": ctx.fund.get(sym),
            "fundamentals_asof": ctx.fund_asof if sym in ctx.fund else None, "moves": p.get("moves", [])[:8],
            "episodes": _episodes(ctx, nodes), "focus": ctx.focus_items.get(sym)}


def node_dossier(ctx, node):
    n = ctx.nodes[node]
    sym, kind = PROXIES.get(node, (None, None))
    ins = [e for e in ctx.edges if e[1] == node]
    outs = [e for e in ctx.edges if e[0] == node]
    drivers = []
    for s, t, sign, w, lag, why, *_ in sorted(ins, key=lambda e: -e[3])[:6]:
        evs = sorted(((e, press.get(s, 0)) for e, _fp, press in ctx.event_factor_pressure() if abs(press.get(s, 0)) >= 0.01), key=lambda t2: -abs(t2[1]))[:2]
        c = ctx.cal.get((s, t), {})
        drivers.append({"id": s, "label": ctx.nodes[s]["label"], "layer": ctx.nodes[s]["layer"], "sign": sign, "w": w, "why": why, "lag": lag,
                        "verdict": c.get("verdict"), "role": "moves it", "node": s, "push": ctx.pressure.get(s, 0),
                        "events": [{"id": e["id"], "title": e["title"], "url": e.get("url", ""), "ts": e["ts"], "scale": e.get("scale"), "c": round(v, 3)} for e, v in evs]})
    for s, t, sign, w, lag, why, *_ in sorted(outs, key=lambda e: -e[3])[:4]:
        drivers.append({"id": t, "label": ctx.nodes[t]["label"], "layer": ctx.nodes[t]["layer"], "sign": sign, "w": w, "why": why, "lag": lag,
                        "verdict": ctx.cal.get((s, t), {}).get("verdict"), "role": "it moves", "node": t, "push": ctx.pressure.get(t, 0), "events": []})
    rows = sorted(((e, press.get(node, 0)) for e, _fp, press in ctx.event_factor_pressure() if abs(press.get(node, 0)) >= 0.01), key=lambda t2: -abs(t2[1]))
    direct = [e for e in ctx.events[:400] if any(x["id"] == node for x in e.get("nodes", []))]
    seen = {e["id"] for e, _ in rows[:20]}
    events = [_ev(e, v) for e, v in rows[:20]] + [_ev(e, via="logged against it") for e in direct[:10] if e["id"] not in seen]
    label = re.sub(r"\s*\(.*?\)", "", n["label"])
    item = ctx.focus_items.get(node) or {}
    match = _matcher([label] + ([item.get("etf")] if item.get("etf") else []) + ([sym] if sym and sym.isalpha() and sym.isupper() else []))
    m = ctx.model.get(node, {})
    web, searched = _web(node)
    return {"key": node, "kind": "fund" if n["layer"] == 4 else "commodity", "name": n["label"], "desc": n["desc"], "inst": n["inst"],
            "proxy": sym, "etf": item.get("etf"), "rh": bool(item.get("etf")), "price": _series(sym), "trend": _trend(sym) if sym else None,
            "model": {h: {k: m[h][k] for k in ("prob_up", "has_skill", "auc", "skill") if k in m[h]} for h in ("h5", "h20") if m.get(h)},
            "pressure": ctx.pressure.get(node, 0), "graph": {"drivers": drivers}, "events": events, "headlines": _headlines(ctx, match),
            "web": web, "web_searched": searched, "episodes": _episodes(ctx, {node} | {d["id"] for d in drivers}), "focus": item or None}


CRYPTO_NAMES = {"BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "XRP": "XRP", "ADA": "Cardano", "AVAX": "Avalanche", "DOGE": "Dogecoin",
                "LTC": "Litecoin", "LINK": "Chainlink", "BCH": "Bitcoin Cash", "XLM": "Stellar", "DOT": "Polkadot", "SHIB": "Shiba Inu", "UNI": "Uniswap"}


def crypto_dossier(ctx, code):
    from .focus import CRYPTO
    ysym = CRYPTO.get(code, f"{code}-USD")
    item = ctx.focus_items.get(code) or {}
    node = "bitcoin" if code == "BTC" else "ether" if code == "ETH" else None
    btc_in = [e for e in ctx.edges if e[1] == "bitcoin"]
    drivers = []
    if code != "BTC":
        drivers.append({"id": "bitcoin", "label": "Bitcoin", "layer": 4, "sign": 1, "w": item.get("corr_btc") or 0.7, "role": "moves it",
                        "why": "coins move with bitcoin", "node": "bitcoin", "push": ctx.pressure.get("bitcoin", 0), "events": []})
    for s, t, sign, w, lag, why, *_ in sorted(btc_in, key=lambda e: -e[3])[:6]:
        evs = sorted(((e, press.get(s, 0)) for e, _fp, press in ctx.event_factor_pressure() if abs(press.get(s, 0)) >= 0.01), key=lambda t2: -abs(t2[1]))[:2]
        drivers.append({"id": s, "label": ctx.nodes[s]["label"], "layer": ctx.nodes[s]["layer"], "sign": sign, "w": w, "why": why, "role": "moves bitcoin",
                        "node": s, "push": ctx.pressure.get(s, 0),
                        "events": [{"id": e["id"], "title": e["title"], "url": e.get("url", ""), "ts": e["ts"], "scale": e.get("scale"), "c": round(v, 3)} for e, v in evs]})
    target = node or "bitcoin"
    rows = sorted(((e, press.get(target, 0)) for e, _fp, press in ctx.event_factor_pressure() if abs(press.get(target, 0)) >= 0.01), key=lambda t2: -abs(t2[1]))
    name = CRYPTO_NAMES.get(code, code)
    match = _matcher([name, code] + (["crypto", "Crypto"] if code == "BTC" else []))
    m = ctx.model.get(node, {}) if node else {}
    web, searched = _web(code)
    return {"key": code, "kind": "crypto", "name": name, "proxy": ysym, "rh": True, "pair_id": item.get("pair_id"),
            "price": _series(ysym), "trend": _trend(ysym), "corr_btc": item.get("corr_btc"),
            "model": {h: {k: m[h][k] for k in ("prob_up", "has_skill", "auc", "skill") if k in m[h]} for h in ("h5", "h20") if m.get(h)},
            "graph": {"drivers": drivers}, "events": [_ev(e, v) for e, v in rows[:20]], "headlines": _headlines(ctx, match),
            "web": web, "web_searched": searched, "episodes": _episodes(ctx, {"bitcoin", "crypto_stocks"} | ({node} if node else set())),
            "focus": item or None}


def holdings():
    from .brokers import all_holdings
    out = []
    for h in dict((x["sym"], x) for x in all_holdings()).values():
        if h["kind"] == "fund":  # mutual funds have no dossier (no news map or filings for a fund)
            continue
        if h["kind"] == "crypto":
            out.append((h["sym"].replace("-USD", ""), "crypto"))
        else:
            out.append((h["sym"], "stock"))
    return out


def wanted(ctx):
    """(key, kind, private) for every dossier to build: focus names, holdings, then requests."""
    keys = {}
    for grp, kind in (("us", "stock"), ("india", "stock"), ("crypto", "crypto")):
        for side in ("up", "down"):
            for r in (ctx.focus.get(grp) or {}).get(side, []):
                keys[r["sym"]] = (kind, False)
    for side in ("up", "down"):
        for r in (ctx.focus.get("commodities") or {}).get(side, []):
            keys[r["sym"]] = (r["kind"], False)
    for k, kind in holdings():
        keys.setdefault(k, (kind, True))
    for r in (_json(REQ, []) or []):
        keys.setdefault(r["key"], (r.get("kind", "stock"), True))
    return keys


def build():
    ctx = Context()
    DIR.mkdir(parents=True, exist_ok=True)
    built, index, priv_index = {}, [], []
    for key, (kind, private) in wanted(ctx).items():
        try:
            if kind == "stock":
                d = stock_dossier(ctx, key)
            elif kind == "crypto":
                d = crypto_dossier(ctx, key)
            elif key in ctx.nodes:
                d = node_dossier(ctx, key)
            else:
                continue
        except Exception as ex:  # one bad asset must not stop the rest
            print(f"{key}: {ex}", file=sys.stderr)
            continue
        d["updated"] = _now()
        d["private"] = private
        (DIR / f"{key}.json").write_text(json.dumps(d, default=float))
        built[key] = d
        (priv_index if private else index).append({"key": key, "kind": d["kind"], "name": d["name"]})
    _batches(built, index, priv_index)
    return built


def _doc_name(key, private):
    return f"owner/dossier-{key}" if private else f"dossier/{key}"


def _hash(d):
    d = {k: v for k, v in d.items() if k != "updated"}
    return hashlib.sha1(json.dumps(d, sort_keys=True, default=float).encode()).hexdigest()


def _batches(built, index, priv_index):
    """Batches of changed dossiers to send: new ones, ones with new web facts or requests, and the rest every 6 hours."""
    pushed = _json(PUSHED, {}) or {}
    versions = _json(VERSIONS, {}) or {}
    req_keys = {r["key"] for r in (_json(REQ, []) or []) if r.get("status") != "done"}
    now = datetime.now(timezone.utc)
    docs = []
    for key, d in built.items():
        name = _doc_name(key, d["private"])
        h = _hash(d)
        prev = pushed.get(name) or {}
        if prev.get("hash") == h:
            continue
        age = (now - datetime.fromisoformat(prev["at"].replace("Z", "+00:00"))).total_seconds() / 3600 if prev.get("at") else 1e9
        if age < PUSH_EVERY_HOURS and key not in req_keys and prev.get("web") == d.get("web_searched"):
            continue
        docs.append((name, d, h))
    for name, items in (("dossier/index", index), ("owner/dossier-index", priv_index)):
        doc = {"updated": _now(), "items": items}
        h = _hash(doc)
        if (pushed.get(name) or {}).get("hash") != h:
            docs.append((name, doc, h))
    DB.mkdir(parents=True, exist_ok=True)
    batches, cur, size, pending = [], [], 0, {}
    for name, d, h in docs:
        coll, doc_id = name.split("/")
        p = DB / f"{name.replace('/', '__')}.json"
        body = json.dumps(d, separators=(",", ":"), default=float)
        p.write_text(body)
        w = {"op": "set", "collection": coll, "doc_id": doc_id, "file_path": str(p)}
        if versions.get(name):
            w["if_version"] = versions[name]
        if cur and (size + len(body) > BATCH_BYTES or len(cur) >= BATCH_MAX):
            batches.append(cur)
            cur, size = [], 0
        cur.append(w)
        size += len(body)
        pending[name] = {"hash": h, "web": d.get("web_searched")}
    if cur:
        batches.append(cur)
    (DB / "dossier_batches.json").write_text(json.dumps(batches, indent=1))
    (KNOWLEDGE / "dossier_pending.json").write_text(json.dumps(pending))
    print(f"{len(built)} dossiers built; {sum(len(b) for b in batches)} to send in {len(batches)} batch(es)")


def mark_pushed():
    pending = _json(KNOWLEDGE / "dossier_pending.json", {}) or {}
    pushed = _json(PUSHED, {}) or {}
    now = _now()
    for name, v in pending.items():
        pushed[name] = {**v, "at": now}
    PUSHED.write_text(json.dumps(pushed))
    (DB / "dossier_batches.json").write_text("[]")
    reqs = _json(REQ, []) or []
    for r in reqs:
        if r.get("status") != "done" and (DIR / f"{r['key']}.json").exists() and r.get("web_done"):
            r["status"] = "done"
            r["done"] = now
    REQ.write_text(json.dumps(reqs, indent=1))
    print(f"marked {len(pending)} documents as pushed")


def targets():
    """Today's web-search list: the strongest focus names, every holding, and pending Find-more requests."""
    ctx = Context()
    today = date.today().isoformat()
    out, seen = [], set()

    def add(key, kind, name, query, why):
        if key in seen:
            return
        seen.add(key)
        _, searched = _web(key)
        if searched == today:
            return
        out.append({"key": key, "kind": kind, "name": name, "query": query, "why": why})

    f = ctx.focus
    for r in (f.get("us") or {}).get("up", [])[:WEB_TARGETS["us_up"]] + (f.get("us") or {}).get("down", [])[:WEB_TARGETS["us_down"]]:
        add(r["sym"], "stock", r["name"], f"{_query_name(r['name'], r['sym'])} {r['sym']} stock news".replace(f"{r['sym']} {r['sym']}", r["sym"]), "focus list")
    comm = sorted((f.get("commodities") or {}).get("up", []) + (f.get("commodities") or {}).get("down", []), key=lambda r: -abs(r["raw"]))
    for r in comm[:WEB_TARGETS["commodities"]]:
        add(r["sym"], r["kind"], r["name"], f"{re.sub(r'[(].*?[)]', '', r['name']).strip()} price news this week", "focus list")
    coins = sorted((f.get("crypto") or {}).get("up", []) + (f.get("crypto") or {}).get("down", []), key=lambda r: -abs(r["raw"]))
    for r in coins[:WEB_TARGETS["crypto"]]:
        add(r["sym"], "crypto", r["name"], f"{r['name']} crypto news", "focus list")
    for key, kind in holdings():
        name = CRYPTO_NAMES.get(key, key) if kind == "crypto" else ctx.name_of(key)
        q = f"{name} crypto news" if kind == "crypto" else f"{_query_name(name, key)} {key} stock news".replace(f"{key} {key}", key)
        add(key, kind, name, q, "your holding")
    for r in (_json(REQ, []) or []):
        if r.get("status") != "done":
            add(r["key"], r.get("kind", "stock"), r.get("name") or r["key"], r.get("query") or f"{r.get('name') or r['key']} news", "Find more request")
    print(json.dumps(out, indent=1))
    return out


def add_web(path):
    """Merge facts found on the web: [{"key", "facts": [{"title", "url", "source", "published", "takeaway"}]}]."""
    rows = json.loads(open(path).read())
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    reqs = _json(REQ, []) or []
    n = 0
    for r in rows:
        key = str(r.get("key", "")).strip()
        if not key or not re.fullmatch(r"[A-Za-z0-9_.\-]{1,40}", key):
            continue
        p = WEB_DIR / f"{key}.json"
        cur = _json(p, {"key": key, "facts": [], "searched": []})
        urls = {x["url"] for x in cur["facts"]}
        fresh = []
        for x in r.get("facts", [])[:8]:
            url = str(x.get("url", ""))
            if not re.match(r"^https?://", url) or url in urls or not x.get("title"):
                continue
            fresh.append({"title": str(x["title"])[:220], "url": url[:600], "source": str(x.get("source", ""))[:80],
                          "published": str(x.get("published", ""))[:20], "takeaway": str(x.get("takeaway", ""))[:400], "found": today})
            urls.add(url)
        cur["facts"] = (fresh + cur["facts"])[:20]
        cur["searched"] = (cur.get("searched", []) + [today])[-30:]
        p.write_text(json.dumps(cur, indent=1))
        n += len(fresh)
        for q in reqs:
            if q["key"] == key:
                q["web_done"] = today
    REQ.write_text(json.dumps(reqs, indent=1))
    print(f"added {n} web facts for {len(rows)} names")


KEEP = ("market_cap", "pe_ratio", "pb_ratio", "dividend_yield", "high_52_weeks", "low_52_weeks", "average_volume", "description", "ceo",
        "sector", "industry", "num_employees", "year_founded", "headquarters_city", "headquarters_state", "market_date")


def add_fundamentals(path):
    raw = json.loads(open(path).read())
    rows = []
    for part in (raw if isinstance(raw, list) else [raw]):
        if isinstance(part, dict) and "data" in part:
            rows += part["data"].get("results", [])
        elif isinstance(part, dict) and "symbol" in part:
            rows.append(part)
        elif isinstance(part, dict) and "results" in part:
            rows += part["results"]
    cur = _json(FUND, {"asof": None, "data": {}}) or {"data": {}}
    for r in rows:
        if r.get("symbol"):
            cur["data"][r["symbol"]] = {k: r.get(k) for k in KEEP}
    cur["asof"] = date.today().isoformat()
    FUND.write_text(json.dumps(cur))
    print(f"saved fundamentals for {len(rows)} symbols")


def add_requests(path):
    """Merge Find-more requests copied from the page's private requests document."""
    raw = json.loads(open(path).read())
    items = raw.get("items", raw.get("data", {}).get("items", [])) if isinstance(raw, dict) else raw
    reqs = _json(REQ, []) or []
    have = {r["key"]: r for r in reqs}
    n = 0
    for it in items or []:
        key = str(it.get("key", "")).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.\-]{1,40}", key) or it.get("status") == "done":
            continue
        kind = it.get("kind") if it.get("kind") in ("stock", "crypto", "commodity", "fund") else "stock"
        if key in have and have[key].get("status") != "done":
            continue
        reqs.append({"key": key, "kind": kind, "name": str(it.get("name", key))[:80], "requested": str(it.get("at", ""))[:30], "status": "pending"})
        n += 1
    REQ.write_text(json.dumps(reqs[-200:], indent=1))
    print(f"queued {n} new requests")


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    sub.add_parser("targets")
    sub.add_parser("pushed")
    for c in ("web", "fundamentals", "requests"):
        sub.add_parser(c).add_argument("path")
    a = ap.parse_args(argv)
    if a.cmd == "build":
        build()
    elif a.cmd == "targets":
        targets()
    elif a.cmd == "pushed":
        mark_pushed()
    elif a.cmd == "web":
        add_web(a.path)
    elif a.cmd == "fundamentals":
        add_fundamentals(a.path)
    else:
        add_requests(a.path)


if __name__ == "__main__":
    main()
