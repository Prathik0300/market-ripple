"""SEC EDGAR history for the US-listed map nodes: reported fundamentals and filing activity, point in time.

Two public, keyless EDGAR endpoints (they only need SEC_CONTACT, an email, in the User-Agent):
  data.sec.gov/api/xbrl/companyfacts/CIK##########.json   every XBRL figure a company reported, with its filing date
  data.sec.gov/submissions/CIK##########.json             every filing (form type and date), older pages included

Everything is keyed on the date a figure was FILED, never the period it covers, so a feature on day d only uses
what was public on day d. Cached in data/sec/ and refreshed once a week (filings change slowly).

    python -m predictor.sec_data            # refresh the cache for the US map nodes
"""
import json
import os
import sys
import time
import urllib.request
from datetime import date

import numpy as np
import pandas as pd

from .config import DATA, OUT, PROXIES

SEC_DIR = DATA / "sec"
MAX_AGE = 7 * 86400
REV = ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense")
EPS = ("EarningsPerShareDiluted", "EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted")
NI = ("NetIncomeLoss",)
PERIODIC = ("10-Q", "10-K", "10-Q/A", "10-K/A", "20-F", "40-F")


def _ua():
    c = os.environ.get("SEC_CONTACT", "").strip()
    if not c:
        raise RuntimeError("SEC_CONTACT is not set (SEC refuses requests without a contact email)")
    return {"User-Agent": f"Market Ripple personal research {c}", "Accept-Encoding": "identity"}


def _get(url, ua):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=ua), timeout=40) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1 + i)
    return None


FUNDS = {"BDRY", "CEW"}  # exchange-traded funds among the node proxies (the f_* nodes are funds too)


def us_nodes():
    """node -> ticker for map nodes whose proxy is a US-listed operating company (no exchange suffix, index, future or fund)."""
    return {n: s for n, (s, kind) in PROXIES.items()
            if kind == "price" and s.isalpha() and s.isupper() and not n.startswith("f_") and s not in FUNDS}


def cik_map(ua):
    p = OUT / "sec_company_tickers.json"
    if not p.exists() or time.time() - p.stat().st_mtime > MAX_AGE:
        with urllib.request.urlopen(urllib.request.Request("https://www.sec.gov/files/company_tickers.json", headers=ua), timeout=40) as r:
            p.write_bytes(r.read())
    return {r["ticker"]: int(r["cik_str"]) for r in json.loads(p.read_text()).values()}


def _compact_facts(cf):
    """Keep only the concepts the features use: duration facts with start, end, value, form and filing date."""
    out = {}
    for tax in ("us-gaap", "ifrs-full"):
        for concept, body in (cf.get("facts", {}).get(tax) or {}).items():
            if concept not in REV + EPS + NI and concept not in ("Revenue", "BasicEarningsLossPerShare", "ProfitLoss"):
                continue
            for unit, rows in body.get("units", {}).items():
                keep = [[r.get("start"), r["end"], r["val"], r.get("form"), r["filed"], r.get("accn")] for r in rows if r.get("start")]
                if keep:
                    out[f"{concept}|{unit}"] = keep
    return out


def refresh(force=False):
    ua = _ua()
    SEC_DIR.mkdir(parents=True, exist_ok=True)
    ciks = cik_map(ua)
    done, missing = 0, []
    for node, sym in us_nodes().items():
        cik = ciks.get(sym)
        if not cik:
            missing.append(sym)
            continue
        p = SEC_DIR / f"{sym}.json"
        if p.exists() and not force and time.time() - p.stat().st_mtime < MAX_AGE:
            continue
        cf = _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", ua) or {}
        time.sleep(0.15)
        sub = _get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", ua) or {}
        pages = [sub.get("filings", {}).get("recent", {})]
        for f in sub.get("filings", {}).get("files", []):
            time.sleep(0.15)
            pages.append(_get(f"https://data.sec.gov/submissions/{f['name']}", ua) or {})
        filings = []
        for pg in pages:
            for form, d in zip(pg.get("form", []), pg.get("filingDate", [])):
                filings.append([form, d])
        p.write_text(json.dumps({"sym": sym, "cik": cik, "name": sub.get("name"), "fetched": date.today().isoformat(),
                                 "facts": _compact_facts(cf), "filings": sorted(filings, key=lambda r: r[1])}))
        done += 1
        time.sleep(0.15)
    return done, missing


def load(sym):
    p = SEC_DIR / f"{sym}.json"
    return json.loads(p.read_text()) if p.exists() else None


def _quarters(rows):
    """Quarterly values from duration facts, each with the date it first became public.
    10-Qs carry 3-month figures; the 4th quarter is the annual figure less the three quarters before it."""
    first = {}
    for start, end, val, form, filed, _ in rows:
        k = (start, end)
        if k not in first or filed < first[k][1]:
            first[k] = (float(val), filed)
    q, annual = {}, {}
    for (start, end), (val, filed) in first.items():
        days = (pd.Timestamp(end) - pd.Timestamp(start)).days
        if 80 <= days <= 100:
            q[end] = (val, filed)
        elif 350 <= days <= 380:
            annual[(start, end)] = (val, filed)
    for (start, end), (val, filed) in annual.items():
        if end in q:
            continue
        inside = [v for e, v in q.items() if start < e < end]
        if len(inside) == 3:
            q[end] = (val - sum(v for v, _ in inside), max(filed, max(f for _, f in inside)))
    return sorted((pd.Timestamp(e), v, pd.Timestamp(f)) for e, (v, f) in q.items())


def _best(facts, names):
    """Quarters from every listed concept merged (companies switch tags, e.g. revenue tags changed with ASC 606 in
    2018). For a quarter reported under several tags, the earliest-filed figure wins; per-share and currency units
    are never mixed (the most common unit is used)."""
    units = {}
    for key in facts:
        c, u = key.split("|")
        if c in names:
            units[u] = units.get(u, 0) + len(facts[key])
    if not units:
        return []
    unit = max(units, key=units.get)
    merged = {}
    for name in names:
        rows = facts.get(f"{name}|{unit}")
        if not rows:
            continue
        for end, val, filed in _quarters(rows):
            if end not in merged or filed < merged[end][1]:
                merged[end] = (val, filed)
    return sorted((e, v, f) for e, (v, f) in merged.items())


def _ttm_series(qs, index):
    """Trailing-4-quarter sum as known on each day of index (by filing date), plus the same a year earlier."""
    if len(qs) < 8:
        return None, None
    ends = [e for e, _, _ in qs]
    vals = [v for _, v, _ in qs]
    filed = [f for _, _, f in qs]
    pts, prev = [], []
    for i in range(3, len(qs)):
        # consecutive quarters only
        if (ends[i] - ends[i - 3]).days > 300:
            continue
        known = max(filed[i - 3:i + 1])
        ttm = sum(vals[i - 3:i + 1])
        pts.append((known, ttm, ends[i]))
    if not pts:
        return None, None
    s = pd.Series({k: v for k, v, _ in sorted(pts)}).groupby(level=0).last().sort_index()
    by_end = {e: v for _, v, e in pts}
    yo = {}
    for k, v, e in pts:
        old = [vv for ee, vv in by_end.items() if 350 <= (e - ee).days <= 380]
        if old and old[0] != 0:
            yo[k] = v / abs(old[0]) - 1 if old[0] > 0 else np.nan
    s_yoy = pd.Series(yo).groupby(level=0).last().sort_index() if yo else None
    s = s.reindex(index.union(s.index)).ffill().reindex(index)
    if s_yoy is not None:
        s_yoy = s_yoy.reindex(index.union(s_yoy.index)).ffill().reindex(index)
    return s, s_yoy


def fundamentals_frame(sym, price, ret):
    """Daily point-in-time fundamentals features for one stock, on the price index.
      sec_ey       trailing-12-month diluted EPS / price (earnings yield)
      sec_rev_yoy  trailing-12-month revenue growth versus a year earlier
      sec_pead     the stock's 3-day return from the latest 10-Q/10-K filing, held until the next one (earnings drift)
      sec_age      trading-day-ish age of the latest 10-Q/10-K in calendar days, capped at 120 (earnings-season clock)"""
    d = load(sym)
    if not d:
        return None
    idx = price.index
    f = pd.DataFrame(index=idx)
    eps_ttm, _ = _ttm_series(_best(d["facts"], EPS + ("BasicEarningsLossPerShare",)), idx)
    _, rev_yoy = _ttm_series(_best(d["facts"], REV + ("Revenue",)), idx)
    if eps_ttm is not None:
        f["sec_ey"] = (eps_ttm / price).clip(-0.5, 0.5)
    if rev_yoy is not None:
        f["sec_rev_yoy"] = rev_yoy.clip(-1, 3)
    per = sorted({pd.Timestamp(dd) for form, dd in d["filings"] if form in PERIODIC})
    if per:
        last = pd.Series(per, index=per).reindex(idx.union(pd.DatetimeIndex(per))).ffill().reindex(idx)
        f["sec_age"] = (pd.Series(idx, index=idx) - last).dt.days.astype(float).clip(0, 120)
        csum = ret.reindex(idx).fillna(0).cumsum()
        pos = idx.searchsorted(pd.DatetimeIndex(per))
        pead = {}
        for p, day in zip(pos, per):
            if p + 3 < len(idx):
                pead[idx[p + 3]] = csum.iloc[p + 3] - (csum.iloc[p - 1] if p > 0 else 0)
        if pead:
            f["sec_pead"] = pd.Series(pead).reindex(idx).ffill()
    return f if len(f.columns) else None


def filings_frame(sym, index):
    """Daily filing-activity features: 8-Ks in the last 30 days and insider (Form 4) filings in the last 90, log-scaled."""
    d = load(sym)
    if not d or not d["facts"]:  # funds and trusts file too, but their filing counts say nothing about a business
        return None
    out = pd.DataFrame(index=index)
    for col, forms, win in (("sec_8k30", ("8-K", "8-K/A", "6-K"), "30D"), ("sec_f4_90", ("4", "4/A"), "90D")):
        days = pd.Series(1.0, index=pd.DatetimeIndex([pd.Timestamp(dd) for form, dd in d["filings"] if form in forms]))
        if days.empty:
            continue
        daily = days.groupby(level=0).sum()
        full = daily.reindex(pd.date_range(min(daily.index.min(), index.min()), index.max(), freq="D"), fill_value=0.0)
        out[col] = np.log1p(full.rolling(win).sum()).reindex(index).fillna(0.0)
    # EDGAR filing lists go back decades; before a company's first listed filing the counts are unknown
    first = min((pd.Timestamp(dd) for _, dd in d["filings"]), default=None)
    if first is not None:
        out.loc[out.index < first + pd.Timedelta(days=90)] = np.nan
    return out if len(out.columns) else None


if __name__ == "__main__":
    n, miss = refresh(force="--force" in sys.argv)
    print(f"sec data: {n} companies refreshed, {len(us_nodes()) - len(miss)} with a CIK; no CIK: {', '.join(miss) or 'none'}")
