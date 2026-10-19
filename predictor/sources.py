"""Every data source Market Ripple takes in, where it goes (model features, the shared facts store, or neither and
why), and the facts store itself.

The facts store (knowledge/facts.jsonl, one JSON object per line) holds shared, non-personal facts only. Each fact
records where it came from and when:
    {"id", "kind", "subject", "text", "value"?, "source", "url"?, "observed", "collected", "via"}
  observed   when the fact happened or was published (UTC ISO), as the source states it
  collected  when Market Ripple first stored it
  via        the pipeline step that brought it in (e.g. "predictor.analyst", "mcp:lunarcrush/Cryptocurrencies")
Facts are appended and never rewritten; a fact seen again keeps its first "collected" time.

Privacy: per-user and owner holdings, trades, positions and statements never become facts or model inputs. Facts
about a single company are kept only when that company is in a shared list (map proxies, the screener universe,
the shared dossier index, the earnings calendar), so the facts never reveal which names someone holds.

    python -m predictor.sources facts       # add new facts from every shared source; write out/db/facts__latest.json
    python -m predictor.sources coverage    # print and save which source feeds what (knowledge/source_coverage.json)
"""
import hashlib
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone

from .config import DATA, EXTRA, KNOWLEDGE, OUT, PROXIES

FACTS = KNOWLEDGE / "facts.jsonl"
COVERAGE = KNOWLEDGE / "source_coverage.json"
SHARED_MCP_DIR = DATA / "shared_mcp"
LATEST_DAYS = 7
LATEST_MAX = 2500

# Market data a user's MCP connection returns that is the same for everyone (no account content). Only these tools'
# snapshots are read from the platform, and only numbers and short names are kept from them.
SHARED_MCP_TOOLS = {"financialdatasets": ("get_interest_rates",), "lunarcrush": ("Cryptocurrencies", "Stocks")}
MCP_KEEP_TEXT = ("symbol", "name", "bank", "ticker", "date", "topic")

# ------------------------------------------------------------------ the inventory

REGISTRY = [
    # broker APIs (cloud sync function web/supabase/functions/sync, and the owner's own on this Mac)
    {"id": "groww", "group": "broker API", "data": "holdings, trades (per user)", "personal": True, "model": "no", "facts": "no",
     "why": "Personal account data. Stays in that user's own report; never pooled. Groww's market-data calls need a user's own key, which only the cloud sync can open, and the same Indian prices already come from Yahoo (data/prices)."},
    {"id": "zerodha", "group": "broker API", "data": "holdings, trades (per user)", "personal": True, "model": "no", "facts": "no",
     "why": "Personal account data. Kite market data needs a user's own session; NSE prices already come from Yahoo."},
    {"id": "upstox", "group": "broker API", "data": "holdings, trades (per user)", "personal": True, "model": "no", "facts": "no",
     "why": "Personal account data. Upstox market data needs a user's own token; NSE prices already come from Yahoo."},
    {"id": "coindcx", "group": "broker API", "data": "holdings, trades (per user)", "personal": True, "model": "no", "facts": "no",
     "why": "Personal account data. CoinDCX public tickers duplicate the crypto prices already in the model (BTC-USD, ETH-USD)."},
    {"id": "binance", "group": "broker API", "data": "holdings, trades (per user)", "personal": True, "model": "no", "facts": "no",
     "why": "Personal account data. Binance's public futures data (funding rates) would be a real crypto feature, but fapi.binance.com answers HTTP 451 (restricted location) from this Mac."},
    {"id": "cams", "group": "statement upload", "data": "mutual fund statement (per user, web/api/cas.py; owner: predictor.mutualfunds)", "personal": True, "model": "no", "facts": "no",
     "why": "Personal statements (PAN, holdings). AMFI NAVs are public, but the funds fetched are the ones held, so NAV facts would reveal holdings; funds are not model targets."},
    # MCP connectors (web/src/lib/mcp-catalog.ts; pulls by supabase/functions/mcp-sync into mcp_snapshots)
    {"id": "robinhood", "group": "MCP connector", "data": "portfolio and positions (per user)", "personal": True, "model": "no", "facts": "no",
     "why": "The platform pulls only account tools (portfolio, positions). Personal; never pooled."},
    {"id": "robinhood-owner-research", "group": "MCP (owner's job session)", "data": "analyst ratings, fundamentals snapshot, earnings calendar", "personal": False,
     "model": "waiting for history (analyst snapshots since 2026-10-16; fundamentals history comes from SEC instead, see sec_fundamentals)",
     "facts": "yes: analyst_view, fundamentals, earnings_date", "why": ""},
    {"id": "financialdatasets", "group": "MCP connector", "data": "central bank rates (get_interest_rates)", "personal": False,
     "model": "waiting for history (collected daily into data/shared_mcp/ once a user connects; US rates already enter via the 10-year yield)",
     "facts": "yes: interest_rate (from any connected user's pull, numbers only)", "why": ""},
    {"id": "lunarcrush", "group": "MCP connector", "data": "crypto and stock social rankings", "personal": False,
     "model": "waiting for history (collected daily into data/shared_mcp/ once a user connects)",
     "facts": "yes: social_rank (from any connected user's pull, numbers only)", "why": ""},
    {"id": "bigdata", "group": "MCP connector", "data": "news and filings search", "personal": False, "model": "no", "facts": "no",
     "why": "Catalog lists it for users' own AI apps only: its server does not let Market Ripple register as a client, so nothing is pulled."},
    # collectors on this Mac
    {"id": "prices", "group": "collector", "data": "Yahoo daily closes (predictor.fetch)", "personal": False, "model": "yes (all targets)", "facts": "no", "why": "Prices are model inputs and on the map, not facts."},
    {"id": "gpr", "group": "collector", "data": "Geopolitical Risk index (data/gpr_daily.csv)", "personal": False, "model": "yes (all targets)", "facts": "no", "why": "A daily index, used as a feature."},
    {"id": "events", "group": "collector", "data": "reviewed world events (knowledge/events.jsonl)", "personal": False,
     "model": "waiting for history (log starts 2026-10-01)", "facts": "yes: event", "why": ""},
    {"id": "primary-sources", "group": "collector", "data": "SEC 8-K/6-K/Form 4, NSE/BSE filings, Federal Register, Fed/BLS/OFAC, RBI/DGFT, NOAA/NWS (predictor.news)", "personal": False,
     "model": "filing activity tested as sec_filings (EDGAR history); exchange and agency feeds have no history",
     "facts": "yes: filing, official, weather", "why": ""},
    {"id": "prediction-markets", "group": "collector", "data": "Polymarket and Kalshi odds moves", "personal": False,
     "model": "waiting for history (48 h of snapshots kept)", "facts": "yes: market_odds (crowd odds, not facts about the world)", "why": ""},
    {"id": "headlines", "group": "collector", "data": "Google News topic feeds, publishers, wires", "personal": False, "model": "no", "facts": "no",
     "why": "Unreviewed headlines; the job reviews them and logs the real ones as events, which are facts."},
    {"id": "web-facts", "group": "collector", "data": "dossier web searches (predictor.dossier web)", "personal": False, "model": "no",
     "facts": "yes: web_fact (shared dossier names only)", "why": "Text takeaways with no history to test."},
    {"id": "sec-edgar", "group": "public API", "data": "XBRL company facts and filing lists (predictor.sec_data)", "personal": False,
     "model": "trial: sec_fundamentals, sec_filings (see knowledge/feature_trials.json)", "facts": "yes: reported_quarter", "why": ""},
]


# ------------------------------------------------------------------ helpers

def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _iso(x):
    if not x:
        return None
    s = str(x)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s + "T00:00:00Z"
    return s


def _fid(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def _read_json(p, default=None):
    try:
        return json.loads(p.read_text())
    except Exception:
        return default


def shared_symbols():
    """Company and crypto symbols that are in a shared list, so a fact about them reveals nothing about anyone's holdings."""
    syms = {s for s, _ in list(PROXIES.values()) + list(EXTRA.values())}
    uni = _read_json(DATA / "universe" / "universe.json", {}) or {}
    syms |= {s["sym"] for s in uni.get("stocks", [])}
    idx = _read_json(OUT / "db" / "dossier__index.json", {}) or {}
    syms |= {i["key"] for i in idx.get("items", [])}
    cal = _read_json(KNOWLEDGE / "earnings_calendar.json", {}) or {}
    syms |= set(cal.get("reports", {}))
    return syms


def _fact(kind, subject, text, source, observed, via, url=None, value=None, key=None):
    f = {"id": _fid(kind, subject, key if key is not None else (observed, text)), "kind": kind, "subject": subject,
         "text": re.sub(r"\s+", " ", str(text)).strip()[:400], "source": source, "observed": _iso(observed), "via": via}
    if url:
        f["url"] = url
    if value is not None:
        f["value"] = value
    return f


# ------------------------------------------------------------------ fact collectors (all shared sources)

def from_events():
    for line in (KNOWLEDGE / "events.jsonl").read_text().splitlines() if (KNOWLEDGE / "events.jsonl").exists() else []:
        if not line.strip():
            continue
        e = json.loads(line)
        nodes = [n.get("id") for n in e.get("nodes", []) if isinstance(n, dict)]
        yield _fact("event", ",".join(nodes) or e.get("region", ""), f"{e.get('title', '')}. {e.get('summary', '')}",
                    e.get("source", ""), e.get("ts"), "knowledge/events.jsonl (job step 4)", e.get("url"),
                    {"scale": e.get("scale"), "category": e.get("category"), "region": e.get("region")}, key=e.get("id"))


def from_analyst(shared):
    d = KNOWLEDGE / "analyst"
    for p in sorted(d.glob("*.jsonl")) if d.exists() else []:
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("sym") not in shared:
                continue
            n = (r.get("buy") or 0) + (r.get("hold") or 0) + (r.get("sell") or 0)
            txt = f"{r['sym']}: {int(r.get('buy') or 0)} buy, {int(r.get('hold') or 0)} hold, {int(r.get('sell') or 0)} sell ratings ({int(n)} analysts)"
            if r.get("target"):
                txt += f"; mean target {r['target']:.2f} vs price {r.get('price')}"
            yield _fact("analyst_view", r["sym"], txt, r.get("source", "Robinhood"), r.get("ts") or r.get("date"),
                        "predictor.analyst (job step 4b)", None,
                        {k: r.get(k) for k in ("buy", "hold", "sell", "target", "price", "balance", "target_gap", "ratings_updated")},
                        key=r.get("date"))


def from_fundamentals(shared):
    d = _read_json(KNOWLEDGE / "fundamentals.json", {}) or {}
    for sym, r in (d.get("data") or {}).items():
        if sym not in shared or not isinstance(r, dict):
            continue
        val = {k: r.get(k) for k in ("market_cap", "pe_ratio", "pb_ratio", "dividend_yield", "high_52_weeks", "low_52_weeks")}
        txt = f"{sym}: market cap {val['market_cap']}, P/E {val['pe_ratio']}, P/B {val['pb_ratio']}, dividend yield {val['dividend_yield']}%"
        when = r.get("market_date") or d.get("asof")
        yield _fact("fundamentals", sym, txt, "Robinhood get_equity_fundamentals", when, "predictor.dossier fundamentals (job step 4b)",
                    None, val, key=when)


def from_earnings(shared):
    d = _read_json(KNOWLEDGE / "earnings_calendar.json", {}) or {}
    for sym, r in (d.get("reports") or {}).items():
        if sym not in shared:
            continue
        txt = f"{sym} reports earnings on {r.get('date')} ({r.get('timing') or 'time n/a'}); EPS estimate {r.get('eps_est')}"
        yield _fact("earnings_date", sym, txt, d.get("source", "Robinhood get_earnings_calendar"), d.get("fetched"),
                    "predictor.focus earnings (job step 4b)", None, r, key=(r.get("date"), r.get("eps_est")))


def from_web_facts(shared):
    d = KNOWLEDGE / "web_facts"
    for p in sorted(d.glob("*.json")) if d.exists() else []:
        w = _read_json(p, {}) or {}
        key = w.get("key")
        if key not in shared:
            continue
        for f in w.get("facts", []):
            yield _fact("web_fact", key, f.get("takeaway") or f.get("title", ""), f.get("source", ""), f.get("published") or f.get("found"),
                        "predictor.dossier web (job step 4f)", f.get("url"), key=f.get("url"))


PRIMARY = {"sec-filings": "filing", "india-filings": "filing", "fed-register": "official", "us-official": "official",
           "india-official": "official", "weather": "weather", "prediction-markets": "market_odds"}


def from_primary(shared):
    d = _read_json(OUT / "news_candidates.json", {}) or {}
    for it in d.get("items", []):
        kind = PRIMARY.get(it.get("topic"))
        if not kind:
            continue
        subject = it["topic"]
        if kind == "filing":
            tok = (it.get("title") or "").split(" ", 1)[0]
            sym = tok + ".NS" if it["topic"] == "india-filings" and "(NSE)" in it.get("title", "") else \
                tok + ".BO" if it["topic"] == "india-filings" else tok
            alt = tok + ".NS"
            if sym not in shared and alt not in shared:
                continue  # watched only because someone holds it
            subject = sym if sym in shared else alt
        yield _fact(kind, subject, it.get("title", ""), it.get("source", ""), it.get("ts"), f"predictor.news ({it['topic']})",
                    it.get("url"), key=it.get("url"))


def from_sec():
    from . import sec_data as S
    for node, sym in S.us_nodes().items():
        d = S.load(sym)
        if not d or not d["facts"]:
            continue
        rev, eps = S._best(d["facts"], S.REV + ("Revenue",)), S._best(d["facts"], S.EPS)
        if not rev and not eps:
            continue
        last = (rev or eps)[-1]
        end, filed = last[0], last[2]
        r = next((v for e, v, _ in rev if e == end), None)
        e = next((v for ee, v, _ in eps if ee == end), None)
        txt = f"{sym} quarter ended {end.date()}: revenue {r:,.0f}" if r is not None else f"{sym} quarter ended {end.date()}:"
        if e is not None:
            txt += f", diluted EPS {e:.2f}"
        txt += f" (filed {filed.date()})"
        url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={d['cik']:010d}&type=10-Q"
        yield _fact("reported_quarter", sym, txt, "SEC EDGAR XBRL", filed.date().isoformat(), "predictor.sec_data", url,
                    {"period_end": end.date().isoformat(), "revenue": r, "eps_diluted": e}, key=end.date().isoformat())


def _mcp_rows(data):
    """Numbers and short names from an MCP tool result. Free text is dropped, so nothing in a tool result can
    become an instruction or carry account content."""
    rows = data
    if isinstance(rows, dict):
        for k in ("data", "results", "items", "rates", "interest_rates", "content"):
            if isinstance(rows.get(k), list):
                rows = rows[k]
                break
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows[:100]:
        if not isinstance(r, dict):
            continue
        keep = {k: r[k] for k in r if isinstance(r[k], (int, float)) and not isinstance(r[k], bool)}
        keep = dict(list(keep.items())[:12])
        for k in MCP_KEEP_TEXT:
            if isinstance(r.get(k), str):
                keep[k] = r[k][:60]
        if keep:
            out.append(keep)
    return out


def from_platform_mcp():
    """Shared-market-data tool pulls from users' MCP connections (newest snapshot per tool across users). The user
    is never recorded; only the allowlisted tools are read. Also appends each day's rows to data/shared_mcp/ so the
    series builds a history the feature trials can test later."""
    from .brokers import load_env
    env = load_env()
    base, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        return [], "platform not set up"
    from .platform_users import Rest
    rest = Rest(base, key)
    facts, notes = [], []
    import urllib.error
    for server, tools in SHARED_MCP_TOOLS.items():
        try:
            conns = rest("GET", f"mcp_connections?select=id&server=eq.{server}&status=eq.ok") or []
        except urllib.error.HTTPError as e:
            return [], f"mcp tables not available (HTTP {e.code})"
        ids = [c["id"] for c in conns]
        if not ids:
            notes.append(f"{server}: no connected users")
            continue
        for tool in tools:
            snaps = rest("GET", f"mcp_snapshots?select=data,fetched_at&tool=eq.{tool}&connection_id=in.({','.join(ids)})&order=fetched_at.desc&limit=1") or []
            if not snaps:
                continue
            rows, when = _mcp_rows(snaps[0]["data"]), snaps[0]["fetched_at"]
            SHARED_MCP_DIR.mkdir(parents=True, exist_ok=True)
            hist = SHARED_MCP_DIR / f"{server}_{tool}.jsonl"
            day = when[:10]
            have = {json.loads(l)["day"] for l in hist.read_text().splitlines() if l.strip()} if hist.exists() else set()
            if day not in have:
                with hist.open("a") as fh:
                    fh.write(json.dumps({"day": day, "fetched": when, "rows": rows}) + "\n")
            kind = "interest_rate" if server == "financialdatasets" else "social_rank"
            for r in rows[:50]:
                subj = r.get("symbol") or r.get("bank") or r.get("name") or r.get("ticker") or "?"
                txt = f"{subj}: " + ", ".join(f"{k} {v}" for k, v in r.items() if k not in ("symbol", "bank", "name", "ticker"))[:300]
                facts.append(_fact(kind, subj, txt, {"financialdatasets": "Financial Datasets", "lunarcrush": "LunarCrush"}[server],
                                   when, f"mcp:{server}/{tool}", None, r, key=day))
    return facts, "; ".join(notes) or "ok"


# ------------------------------------------------------------------ store

def collect():
    shared = shared_symbols()
    have = {}
    if FACTS.exists():
        for line in FACTS.read_text().splitlines():
            if line.strip():
                f = json.loads(line)
                have[f["id"]] = f
    now = _now()
    added, by_kind, errors = [], {}, []
    gens = [("events", from_events), ("analyst", lambda: from_analyst(shared)), ("fundamentals", lambda: from_fundamentals(shared)),
            ("earnings", lambda: from_earnings(shared)), ("web facts", lambda: from_web_facts(shared)),
            ("primary sources", lambda: from_primary(shared)), ("sec", from_sec)]
    for name, g in gens:
        try:
            for f in g():
                if f["id"] in have:
                    continue
                f["collected"] = now
                have[f["id"]] = f
                added.append(f)
                by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1
        except Exception as e:
            errors.append(f"{name}: {str(e)[:120]}")
    try:
        mcp, note = from_platform_mcp()
    except Exception as e:
        mcp, note = [], f"error {str(e)[:120]}"
    for f in mcp:
        if f["id"] not in have:
            f["collected"] = now
            have[f["id"]] = f
            added.append(f)
            by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1
    if added:
        with FACTS.open("a") as fh:
            for f in added:
                fh.write(json.dumps(f, ensure_ascii=False) + "\n")
    # newest facts as a shared world document (platform_sync uploads out/db/<collection>__<doc>.json)
    cut = (datetime.now(timezone.utc) - timedelta(days=LATEST_DAYS)).isoformat()
    recent = [f for f in have.values() if (f.get("observed") or f.get("collected") or "") >= cut[:19] or f.get("collected", "") >= cut[:19]]
    recent.sort(key=lambda f: f.get("observed") or "", reverse=True)
    (OUT / "db").mkdir(parents=True, exist_ok=True)
    (OUT / "db" / "facts__latest.json").write_text(json.dumps(
        {"updated": now, "days": LATEST_DAYS, "count": len(recent[:LATEST_MAX]), "total": len(have),
         "note": "Shared facts with their source and times. observed = when it happened or was published; collected = when Market Ripple stored it.",
         "facts": recent[:LATEST_MAX]}, ensure_ascii=False))
    return {"added": len(added), "by_kind": by_kind, "total": len(have), "mcp": note, "errors": errors}


def untestable():
    """Shared sources that cannot enter the walk-forward test yet, with how much history exists."""
    out = []

    def span(name, days, first, note):
        need = 4 * 365  # 750 training days + a test year, in calendar days
        out.append({"source": name, "history_days": days, "first": first, "testable_from": (date.fromisoformat(first) + timedelta(days=need)).isoformat() if first else None,
                    "note": note})

    ev = [json.loads(l)["ts"][:10] for l in (KNOWLEDGE / "events.jsonl").read_text().splitlines() if l.strip()] if (KNOWLEDGE / "events.jsonl").exists() else []
    if ev:
        span("events", (date.fromisoformat(max(ev)) - date.fromisoformat(min(ev))).days + 1, min(ev), "event-pressure features per node; logged since the job started")
    an = sorted(p.stem for p in (KNOWLEDGE / "analyst").glob("*.jsonl")) if (KNOWLEDGE / "analyst").exists() else []
    if an:
        span("analyst ratings", len(an), an[0], "predictor.analyst plans a simpler event study in January 2027")
    pm = _read_json(OUT / "prediction_markets.json", {}) or {}
    span("prediction markets", 2, None, "only 48 h of snapshots are kept")
    for p in sorted(SHARED_MCP_DIR.glob("*.jsonl")) if SHARED_MCP_DIR.exists() else []:
        days = [json.loads(l)["day"] for l in p.read_text().splitlines() if l.strip()]
        if days:
            span(f"mcp {p.stem}", len(days), min(days), "shared market data from users' MCP connections")
    for s in ("financialdatasets", "lunarcrush"):
        if not (SHARED_MCP_DIR / f"{s}_{SHARED_MCP_TOOLS[s][0]}.jsonl").exists():
            span(f"mcp {s}", 0, None, "no user has connected it yet")
    return out


def coverage():
    trials = _read_json(KNOWLEDGE / "feature_trials.json", {}) or {}
    fams = {k: v.get("verdict") for k, v in (trials.get("families") or {}).items()}
    counts = {}
    if FACTS.exists():
        for line in FACTS.read_text().splitlines():
            if line.strip():
                k = json.loads(line)["via"]
                counts[k] = counts.get(k, 0) + 1
    rows = []
    for r in REGISTRY:
        r = dict(r)
        if r["id"] == "sec-edgar" and fams:
            r["model"] = "trial: " + ", ".join(f"{k} {v}" for k, v in fams.items())
        rows.append(r)
    doc = {"asof": _now(), "sources": rows, "trial_verdicts": fams, "facts_by_pipeline": counts, "waiting_for_history": untestable()}
    COVERAGE.write_text(json.dumps(doc, indent=1))
    for r in rows:
        print(f"{r['id']:26s} model: {r['model'][:70]:70s} facts: {r['facts'][:40]}")
    return doc


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "facts"
    if cmd == "facts":
        r = collect()
        kinds = ", ".join(f"{k} {v}" for k, v in sorted(r["by_kind"].items())) or "none new"
        print(f"facts: {r['added']} added ({kinds}); {r['total']} stored; platform MCP: {r['mcp']}"
              + (f"; errors: {'; '.join(r['errors'])}" if r["errors"] else ""))
    elif cmd == "coverage":
        coverage()
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
