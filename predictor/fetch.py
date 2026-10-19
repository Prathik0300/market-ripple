"""Download and refresh daily price history from Yahoo Finance's public chart endpoint, plus the daily
Geopolitical Risk index (Caldara and Iacoviello).

    python -m predictor.fetch            # refresh everything (incremental after the first run)
    python -m predictor.fetch --full     # re-download full history
"""
import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request

import pandas as pd

from .config import DATA, EXTRA, HISTORY_START, PRICES, PROXIES

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=1d"
GPR_URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls"


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def safe_name(sym):
    return sym.replace("^", "IDX_").replace("=", "_").replace("/", "_")


def price_path(sym):
    return PRICES / f"{safe_name(sym)}.csv"


def load_prices(sym):
    p = price_path(sym)
    if not p.exists():
        return None
    s = pd.read_csv(p, parse_dates=["date"]).set_index("date")["close"]
    return s[~s.index.duplicated(keep="last")].sort_index()


def fetch_symbol(sym, full=False):
    """Download daily closes (adjusted where available) and merge into data/prices/<sym>.csv."""
    old = None if full else load_prices(sym)
    p1 = HISTORY_START if old is None or old.empty else int(old.index[-1].timestamp()) - 10 * 86400
    p2 = int(time.time()) + 86400
    raw = json.loads(_get(CHART.format(sym=urllib.request.quote(sym), p1=p1, p2=p2)))
    res = raw["chart"]["result"]
    if not res:
        raise RuntimeError(f"{sym}: {raw['chart'].get('error')}")
    r = res[0]
    ts = r.get("timestamp") or []
    closes = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose") or r["indicators"]["quote"][0]["close"]
    tz = r["meta"].get("gmtoffset", 0)
    idx = pd.to_datetime([t + tz for t in ts], unit="s").normalize()
    new = pd.Series(closes, index=idx, name="close").dropna()
    new = new[new > 0] if sym not in ("^TNX",) else new
    merged = new if old is None else pd.concat([old[old.index < new.index.min()] if len(new) else old, new])
    merged = merged[~merged.index.duplicated(keep="last")].sort_index()
    out = merged.rename("close").to_frame()
    out.index.name = "date"
    out.to_csv(price_path(sym))
    return len(merged), merged.index[-1].date()


def fetch_gpr():
    """Daily Geopolitical Risk index: GPRD (overall), GPRD_ACT (acts), GPRD_THREAT (threats)."""
    raw = _get(GPR_URL, timeout=60)
    df = pd.read_excel(io.BytesIO(raw))
    cols = {c.lower(): c for c in df.columns}
    date_col = cols.get("date") or df.columns[0]
    keep = [c for c in df.columns if str(c).upper() in ("GPRD", "GPRD_ACT", "GPRD_THREAT")]
    out = df[[date_col] + keep].rename(columns={date_col: "date"})
    out["date"] = pd.to_datetime(out["date"])
    out = out.dropna(subset=keep, how="all").sort_values("date")
    out.to_csv(DATA / "gpr_daily.csv", index=False)
    return len(out), out["date"].iloc[-1].date()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--universe", action="store_true", help="also refresh every stock and factor in the stock universe")
    ap.add_argument("--missing", action="store_true", help="only download series that have no file yet")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args(argv)
    PRICES.mkdir(parents=True, exist_ok=True)
    syms = sorted({v[0] for v in list(PROXIES.values()) + list(EXTRA.values())})
    if args.universe:
        from .universe import all_symbols
        syms = sorted(set(syms) | set(all_symbols()))
    if args.only:
        syms = [s for s in syms if s in args.only]
    if args.missing:
        syms = [s for s in syms if not price_path(s).exists()]
    ok, failed = 0, []

    def one(sym):
        for attempt in range(4):
            try:
                return sym, fetch_symbol(sym, full=args.full), None
            except urllib.error.HTTPError as e:
                if e.code == 429:  # rate limited: back off and retry
                    time.sleep(5 * (attempt + 1))
                    continue
                return sym, None, e
            except Exception as e:  # keep going: one bad symbol must not stop the refresh
                if attempt < 1:
                    time.sleep(1)
                    continue
                return sym, None, e
        return sym, None, RuntimeError("rate limited")

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for sym, res, err in pool.map(one, syms):
            if err or res is None:
                failed.append(sym)
                print(f"{sym:14s} FAILED: {err}", file=sys.stderr)
            else:
                ok += 1
                print(f"{sym:14s} {res[0]:6d} rows, last {res[1]}", flush=True)
    try:
        n, last = fetch_gpr()
        print(f"GPR daily      {n:6d} rows, last {last}")
    except Exception as e:
        failed.append("GPR")
        print(f"GPR FAILED: {e}", file=sys.stderr)
    print(f"done: {ok} symbols ok, {len(failed)} failed {failed}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
