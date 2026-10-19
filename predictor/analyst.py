"""Daily analyst-view snapshots (from Robinhood's read-only tools), stored so changes can be tested later.

Each snapshot row is one stock on one day. Two numbers are derived from it:
  analyst balance = (buy - sell) / (buy + hold + sell)      from -1 (all sell) to +1 (all buy)
  target gap      = average price target / current price - 1   (+0.20 = analysts' target is 20% above today)
Upgrades and downgrades show up as changes in these numbers between days. Nothing here enters the
forecasts until the January 2027 test shows it improves out-of-sample skill.

    python -m predictor.analyst add out/analyst_today.json     # validate and append today's snapshots
    python -m predictor.analyst watchlist                      # tickers the job should snapshot today
    python -m predictor.analyst changes --days 7               # biggest shifts in analyst balance

Snapshot JSON (a list): {"sym": "XOM", "price": 117.2, "buy": 14, "hold": 9, "sell": 1, "target": 128.0,
  "bull": "short bull case text", "bear": "short bear case text", "news": [{"title": "...", "url": "...", "ts": "..."}]}
"""
import argparse
import json
import sys
from datetime import date, datetime, timezone

from .config import KNOWLEDGE, OUT

DIR = KNOWLEDGE / "analyst"


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def add(path):
    rows = json.loads(open(path).read())
    if isinstance(rows, dict):
        rows = rows.get("snapshots", [])
    DIR.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    out = DIR / f"{today}.jsonl"
    have = set()
    if out.exists():
        have = {json.loads(l)["sym"] for l in out.read_text().splitlines() if l.strip()}
    kept = 0
    with out.open("a") as f:
        for r in rows:
            sym = str(r.get("sym", "")).upper().strip()
            if not sym or sym in have:
                continue
            buy, hold, sell = (_num(r.get(k)) or 0 for k in ("buy", "hold", "sell"))
            total = buy + hold + sell
            price, target = _num(r.get("price")), _num(r.get("target"))
            rec = {"sym": sym, "date": today, "ts": datetime.now(timezone.utc).isoformat(timespec="minutes"),
                   "price": price, "buy": buy, "hold": hold, "sell": sell, "target": target,
                   "balance": round((buy - sell) / total, 3) if total else None,
                   "target_gap": round(target / price - 1, 4) if price and target else None,
                   "ratings_updated": str(r.get("ratings_updated", ""))[:30], "source": str(r.get("source", "Robinhood"))[:40],
                   "bull": str(r.get("bull", ""))[:600], "bear": str(r.get("bear", ""))[:600],
                   "news": [{k: str(n.get(k, ""))[:300] for k in ("title", "url", "ts")} for n in (r.get("news") or [])[:8]]}
            f.write(json.dumps(rec) + "\n")
            have.add(sym)
            kept += 1
    print(f"saved {kept} snapshots to {out}")


def watchlist(n=20):
    """Today's watchlist: the owner's US holdings, the focus list's US names, then the screener's most exposed stocks."""
    syms = []
    from .brokers import all_holdings
    syms += [h["sym"] for h in all_holdings() if h.get("kind") == "stock" and "." not in h["sym"]]
    focus = sorted((KNOWLEDGE / "focus").glob("*.json"))
    if focus:
        f = json.loads(focus[-1].read_text())
        syms += [r["sym"] for side in ("up", "down") for r in f.get("us", {}).get(side, [])]
    p = OUT / "db" / "screen__latest.json"
    if p.exists():
        s = json.loads(p.read_text())
        for side in ("up", "down"):
            syms += [r["sym"] for r in s.get(side, [])[:n]]
    seen, out = set(), []
    for x in syms:
        if x not in seen:
            seen.add(x)
            out.append(x)
    out = out[:75]  # one get_equity_analyst_ratings call takes at most 75 symbols
    print(" ".join(out))
    return out


def changes(days=7):
    files = sorted(DIR.glob("*.jsonl"))[-days:]
    if len(files) < 2:
        print("need at least two days of snapshots")
        return
    first = {json.loads(l)["sym"]: json.loads(l) for l in files[0].read_text().splitlines() if l.strip()}
    last = {json.loads(l)["sym"]: json.loads(l) for l in files[-1].read_text().splitlines() if l.strip()}
    rows = [(s, last[s]["balance"] - first[s]["balance"]) for s in last if s in first and last[s]["balance"] is not None and first[s]["balance"] is not None]
    for s, d in sorted(rows, key=lambda t: -abs(t[1]))[:20]:
        print(f"{s:10s} analyst balance change {d:+.2f}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("path")
    sub.add_parser("watchlist")
    c = sub.add_parser("changes")
    c.add_argument("--days", type=int, default=7)
    args = ap.parse_args(argv)
    if args.cmd == "add":
        add(args.path)
    elif args.cmd == "watchlist":
        watchlist()
    else:
        changes(args.days)


if __name__ == "__main__":
    sys.exit(main())
