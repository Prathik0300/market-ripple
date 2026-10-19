"""Portfolio report: the owner's own holdings, what moves them, what moved them, and the odds ahead.

Holdings come from knowledge/portfolio.json (refreshed from Robinhood's read-only position tools) plus the Groww
and CoinDCX syncs in knowledge/brokers/ (predictor.brokers) and the mutual funds read from a CAMS statement
(predictor.mutualfunds, priced at AMFI NAVs). Rupee holdings keep rupee prices and costs; values
are also given in dollars at the day's USD/INR rate so the accounts add up. Indian stocks are measured against
the Nifty 50 instead of the S&P 500. For each:
  1. Trend: returns over 1 week to 1 year, volatility, distance from the 200-day average, drawdown, gain vs cost.
  2. What moves it: weekly betas to the S&P 500, Nasdaq, semiconductors and bitcoin, then the same hidden-
     exposure test as predictor.exposures (moves left after market, sector and style, tested against 38
     factors; robust |t| >= 4.5, likely |t| >= 3, same sign in all three thirds).
  3. What moved it: its biggest surprise days in the last three years, each matched to same-day factor
     shocks, geopolitical-risk spikes, and logged episodes or events within 3 days. Also the biggest down days
     of the whole portfolio (current quantities held fixed) and which holdings and drivers caused them.
  4. Event pressure now: events of the last 14 days, passed through the map to factors, then to the holding
     through its measured exposures (same score as the screener).
  5. Odds: the walk-forward model from predictor.model (5 and 20 trading days; crypto counts calendar days),
     retrained yearly and scored only on unseen years, then calibrated on the holdings' own out-of-sample
     record. A probability is only meaningful where "has_skill" is true.

It describes and measures. It does not say what to buy or sell.

    python -m predictor.portfolio
"""
import json
from collections import Counter
from datetime import date

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from . import model
from .brokers import LABELS, accounts_status, all_holdings, usdinr
from .config import HORIZONS, KNOWLEDGE, PROXIES
from .exposures import NODE_TO_FACTOR, START, T_LIKELY, T_ROBUST, _gpr_daily, _ols_resid, _uni, daily_returns, incidents_index, weekly
from .fetch import load_prices
from .universe import EXPECTED, FACTORS, SECTOR_ETF, STYLE, load

PORTFOLIO = KNOWLEDGE / "portfolio.json"
REPORT = KNOWLEDGE / "portfolio_report.json"
MIN_WEEKS_HOLDING = 80  # lower than the universe's 156 so recent listings (CORZ, 2024) still get a profile
SECTORS = {"SE": "Consumer Discretionary", "CORZ": None}  # names missing from the universe or unclassified there
FACTOR_TO_NODE = {}
for _n, _f in NODE_TO_FACTOR.items():
    FACTOR_TO_NODE.setdefault(_f, _n)


def india(sym):
    """Indian stocks and Indian mutual funds (MF_<AMFI code>, from predictor.mutualfunds): rupee prices, Nifty as market."""
    return sym.endswith((".NS", ".BO")) or sym.startswith("MF_")


def _beta(y, x):
    df = pd.concat([y.rename("y"), x.rename("x")], axis=1).dropna()
    if len(df) < 52:
        return None
    b = float(np.cov(df["y"], df["x"])[0, 1] / df["x"].var())
    return {"beta": round(b, 2), "corr": round(float(df["y"].corr(df["x"])), 2), "weeks": len(df)}


def trend(sym, avg_cost):
    s = load_prices(sym)
    s = s[s.index >= s.index[-1] - pd.Timedelta(days=800)]
    last = float(s.iloc[-1])

    def back(days):
        prior = s[s.index <= s.index[-1] - pd.Timedelta(days=days)]
        return round((last / float(prior.iloc[-1]) - 1) * 100, 1) if len(prior) else None

    r = np.log(s).diff().dropna()
    per_year = 365 if sym.endswith("-USD") else 252
    yr = s[s.index >= s.index[-1] - pd.Timedelta(days=365)]
    return {"price": float(f"{last:.6g}"), "asof": s.index[-1].date().isoformat(),  # 6 significant digits: coins such as SHIB trade below $0.0001
            "ret_1w": back(7), "ret_1m": back(30), "ret_3m": back(91), "ret_1y": back(365),
            "vol_ann": round(float(r[-60:].std() * np.sqrt(per_year) * 100), 1),
            "vs_200d": round((last / float(s[-200:].mean()) - 1) * 100, 1),
            "drawdown_1y": round((last / float(yr.max()) - 1) * 100, 1),
            "vs_cost": round((last / avg_cost - 1) * 100, 1) if avg_cost else None}


class Factors:
    """Market, sector, style and factor series prepared once, the same way predictor.exposures does."""

    def __init__(self):
        self.spx_d = daily_returns("^GSPC")
        self.spx_w = weekly(self.spx_d)
        self.nifty_d = daily_returns("^NSEI")
        self.nifty_w = weekly(self.nifty_d) if self.nifty_d is not None else None
        self.ndx_w = weekly(daily_returns("^IXIC"))
        self.style_w = []
        for a, b in STYLE.values():
            ra, rb = daily_returns(a), daily_returns(b)
            if ra is not None and rb is not None:
                self.style_w.append(_ols_resid(weekly((ra - rb).dropna()), [self.spx_w])[0])
        self.sec_w, self.sec_d = {}, {}
        for sec, etf in SECTOR_ETF.items():
            d = daily_returns(etf)
            if d is not None:
                self.sec_w[sec], _ = _ols_resid(weekly(d), [self.spx_w])
                self.sec_d[sec], _ = _ols_resid(d, [self.spx_d])
        self.fac_w, self.fac_d, self.fac_sd = {}, {}, {}
        for f, (sym, tr, _label, _group) in FACTORS.items():
            d = daily_returns(sym, tr)
            if d is None:
                continue
            w = weekly(d) if f != "gpr" else d.resample("W-FRI").sum(min_count=1).dropna()
            self.fac_w[f], _ = _ols_resid(w[w.index >= START], [self.spx_w] + self.style_w)
            self.fac_d[f] = d
            self.fac_sd[f] = d.rolling(250).std().shift(1)
        g = _gpr_daily()
        self.gpr_z = (g - g.rolling(250).mean()) / g.rolling(250).std()
        self.incidents = incidents_index()


def profile(h, F, stored):
    """Betas, hidden exposures and biggest surprise days for one holding."""
    sym, crypto = h["sym"], h["kind"] == "crypto"
    ind = india(sym) and F.nifty_w is not None
    d = daily_returns(sym)
    w = weekly(d)
    w = w[w.index >= START]
    btc_w = weekly(daily_returns("BTC-USD"))
    recent = w[w.index >= w.index[-1] - pd.Timedelta(days=3 * 365)]
    betas = {"sp500": _beta(recent, F.spx_w), "nasdaq": _beta(recent, F.ndx_w),
             "semis": _beta(recent, weekly(daily_returns("SMH"))), "bitcoin": _beta(recent, btc_w)}
    if ind:
        betas["nifty"] = _beta(recent, F.nifty_w)
    sp = stored.get(sym.replace("-USD", ""))
    if sp and not crypto:
        sector = sp["sector"]
        exps, beta_mkt = sp["exposures"], sp["beta_mkt"]
    else:
        sector = SECTORS.get(sym) if crypto is False else None
        # same regressors as predictor.exposures: local market, sector, then the S&P 500 for non-US names
        X = [F.nifty_w if ind else F.spx_w] + ([F.sec_w[sector]] if sector in F.sec_w else []) + ([F.spx_w] if ind else []) + F.style_w
        e, coef = _ols_resid(w, X)
        exps, beta_mkt = [], round(float(coef[1]), 2) if coef is not None else None
        if e is not None and len(e) >= MIN_WEEKS_HOLDING:
            for f, fw in F.fac_w.items():
                if fw is None:
                    continue
                res = _uni(e, fw) if len(e) >= 156 else _uni_short(e, fw)
                if not res:
                    continue
                same = all(np.sign(t) == np.sign(res["t"]) and abs(t) > 0.03 for t in res["thirds"])
                cls = "robust" if abs(res["t"]) >= T_ROBUST and same else "likely" if abs(res["t"]) >= T_LIKELY and same else None
                if cls:
                    hidden = (f not in EXPECTED[sector]) if sector in EXPECTED else False
                    exps.append({"f": f, "label": FACTORS[f][2], "group": FACTORS[f][3], "beta": round(res["beta"], 3), "t": round(res["t"], 1),
                                 "rho": round(res["rho"], 3), "cls": cls, "hidden": hidden, "thirds": [round(x, 2) for x in res["thirds"]]})
            exps.sort(key=lambda x: -abs(x["t"]))
            exps = exps[:8]
    return {"sector": sector or ("Crypto" if crypto else "Fund" if h["kind"] == "fund" else "Unclassified"), "beta_mkt": beta_mkt, "betas_3y": betas,
            "exposures": exps, "moves": surprise_days(d, sector, exps, F, mkt_d=F.nifty_d if ind else None)}


def _uni_short(e, f):
    """_uni with a lower minimum sample, for holdings listed less than three years ago."""
    df = pd.concat([e.rename("e"), f.rename("f")], axis=1).dropna()
    n = len(df)
    if n < MIN_WEEKS_HOLDING:
        return None
    x, y = df["f"].values - df["f"].mean(), df["e"].values - df["e"].mean()
    sxx = float(x @ x)
    if sxx == 0:
        return None
    beta = float(x @ y) / sxx
    resid = y - beta * x
    se = float(np.sqrt(float(resid @ resid) / (n - 2) / sxx))
    thirds = [float(np.corrcoef(x[p], y[p])[0, 1]) if len(p) > 20 and x[p].std() > 0 and y[p].std() > 0 else 0.0 for p in np.array_split(np.arange(n), 3)]
    return {"beta": beta, "t": beta / se if se > 0 else 0.0, "rho": float(np.corrcoef(x, y)[0, 1]), "thirds": thirds, "n": n}


BROAD = {"vix", "gpr", "rates", "dollar", "bitcoin", "semis", "oil"}  # shocks that hit most assets at once


def drivers_on(dt, F, exposed, sign):
    """Same-day factor shocks (|z| >= 2.5) that the holding is measured to be exposed to, in the direction of
    its move, or broad shocks. With 38 factors about one shocks on a random day by chance, so unrelated
    coincidences (cotton on a chip-stock day) are left out."""
    out = []
    for f, fd in F.fac_d.items():
        sd = F.fac_sd[f].get(dt, np.nan)
        if dt in fd.index and sd and sd > 0:
            fz = float(fd[dt] / sd)
            if abs(fz) >= 2.5:
                agrees = f in exposed and np.sign(fz) * np.sign(exposed[f]["beta"]) == sign
                if not agrees and f not in BROAD:
                    continue
                out.append([f, round(float(fd[dt]) * (1 if FACTORS[f][1] == "yield" else 100), 2), round(fz, 1), bool(agrees)])
    out.sort(key=lambda x: (-int(x[3]), -abs(x[2])))
    return out[:4]


def surprise_days(d, sector, exps, F, years=3, n=8, mkt_d=None):
    """mkt_d: the local market's daily returns (the Nifty for Indian stocks); the S&P 500 and US sector otherwise."""
    since = d.index[-1] - pd.Timedelta(days=365 * years)
    md = F.spx_d if mkt_d is None else mkt_d
    X = [md] + ([F.sec_d[sector]] if sector in F.sec_d and mkt_d is None else [])
    e, _ = _ols_resid(d[d.index >= since - pd.Timedelta(days=400)], X)
    if e is None:
        return []
    z = (e / e.rolling(120).std().shift(1)).dropna()
    z = z[z.index >= since]
    kept = []
    for dt in z.abs().sort_values(ascending=False).index:
        if abs(z[dt]) < 3 or len(kept) >= n:
            break
        if all(abs((dt - k).days) > 5 for k in kept):
            kept.append(dt)
    exposed = {x["f"]: x for x in exps}
    moves = []
    for dt in sorted(kept, reverse=True):
        gz = F.gpr_z.get(dt, np.nan)
        moves.append({"d": dt.date().isoformat(), "ret": round(float(d[dt]) * 100, 1), "z": round(float(z[dt]), 1),
                      "mkt": round(float(md.get(dt, np.nan)) * 100, 1) if dt in md.index else None,
                      **({"mkt_name": "Nifty 50"} if mkt_d is not None else {}),
                      "drivers": drivers_on(dt, F, exposed, np.sign(z[dt])),
                      "gpr_z": None if pd.isna(gz) else round(float(gz), 1),
                      "events": [t for (idt, t, _k) in F.incidents if abs((idt - dt).days) <= 3][:3]})
    return moves


def event_pressure(h, prof):
    """Score of the last 14 days' events on this holding, traced to events and factors (screener method)."""
    from .events import per_event_pressure
    exp = {x["f"]: x for x in prof["exposures"]}
    if h["kind"] == "crypto" and "bitcoin" not in exp and prof["betas_3y"].get("bitcoin"):
        b = prof["betas_3y"]["bitcoin"]
        exp["bitcoin"] = {"rho": b["corr"], "cls": "robust", "t": None}
    total, by_event, by_factor = 0.0, [], {}
    for e, press in per_event_pressure():
        fp = {}
        for node, v in press.items():
            f = NODE_TO_FACTOR.get(node)
            if f:
                fp[f] = max(-1.0, min(1.0, fp.get(f, 0) + v))
        c_e = 0.0
        for f, v in fp.items():
            x = exp.get(f)
            if x:
                c = v * x["rho"] * (1 if x["cls"] == "robust" else 0.6)
                c_e += c
                by_factor[f] = by_factor.get(f, 0) + c
        if abs(c_e) > 0.002:
            by_event.append({"title": e["title"][:120], "url": e.get("url", ""), "ts": e["ts"], "c": round(c_e, 3)})
            total += c_e
    by_event.sort(key=lambda x: -abs(x["c"]))
    return {"score": round(total, 3), "shown": round(float(np.tanh(total)) * 100),
            "factors": [[f, round(c, 3)] for f, c in sorted(by_factor.items(), key=lambda t: -abs(t[1]))[:4]], "events": by_event[:5]}


def odds(holdings, profiles, macro):
    """Walk-forward up/down probabilities per holding, calibrated on the holdings' pooled out-of-sample record."""
    from .series import returns
    results, pooled = {}, {hz: [] for hz in HORIZONS}
    for h in holdings:
        node = "pf_" + h["sym"]
        PROXIES[node] = (h["sym"], "price")
        if returns(node) is None:  # under 300 trading days (a new listing or demerger): nothing to test the model on
            results[h["sym"]] = {"drivers": [], "note": "too little history"}
            continue
        drivers = []
        for x in profiles[h["sym"]]["exposures"][:4]:
            n = FACTOR_TO_NODE.get(x["f"])
            if n and n in PROXIES:
                drivers.append((n, 1 if x["beta"] > 0 else -1))
        if h["kind"] == "crypto" and h["sym"] != "BTC-USD":
            drivers.append(("bitcoin", 1))
        if (profiles[h["sym"]]["betas_3y"].get("semis") or {}).get("corr", 0) > 0.5:
            drivers.append(("ai_chips", 1))
        drivers = list(dict.fromkeys(drivers))
        res = model.evaluate(node, drivers, macro)
        for hz, r in res.items():
            pooled[hz].append((r.pop("_p"), r.pop("_t")))
        results[h["sym"]] = {"drivers": [d for d, _ in drivers], **{f"h{hz}": r for hz, r in res.items()}}
    for hz in HORIZONS:
        if not pooled[hz]:
            continue
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.98)
        iso.fit(np.concatenate([a for a, _ in pooled[hz]]), np.concatenate([b for _, b in pooled[hz]]))
        for r in results.values():
            x = r.get(f"h{hz}")
            if x:
                x["prob_raw"] = x["prob_up"]
                x["prob_up"] = round(float(iso.predict([x["prob_raw"]])[0]), 3)
    return results


def portfolio_moves(holdings, F, profiles, n=8):
    """The basket (current quantities held fixed) over the last year, in dollars: its path and biggest down and up
    days. The same instrument held in two accounts counts once with the summed quantity; rupee-priced series are
    converted at each day's USD/INR rate."""
    qty = {}
    for h in holdings:
        qty[h["sym"]] = qty.get(h["sym"], 0) + h["qty"]
    px = {s: load_prices(s) for s in qty}
    # holdings listed less than a year ago would shorten the whole path, so the path leaves them out and says so
    end = max(s.index[-1] for s in px.values())
    left_out = sorted(k for k, s in px.items() if s.index[0] > end - pd.Timedelta(days=366))
    path = {k: s for k, s in px.items() if k not in left_out} or px
    idx = pd.date_range(max(s.index[0] for s in path.values()), end, freq="D")
    since = idx[-1] - pd.Timedelta(days=365)
    fx = load_prices("INR=X")
    fx = fx.reindex(fx.index.union(idx)).ffill().reindex(idx) if fx is not None else None

    def usd(sym, s):
        s = s.reindex(s.index.union(idx)).ffill().reindex(idx)
        return s / fx if india(sym) and fx is not None else s

    vals = pd.DataFrame({k: usd(k, s) * qty[k] for k, s in path.items()}).dropna()
    vals = vals[vals.index >= since - pd.Timedelta(days=1)]
    tot = vals.sum(axis=1)
    r = np.log(tot).diff().dropna()
    contrib = vals.diff().div(tot.shift(1), axis=0).dropna()
    out = {"value_now": round(float(tot.iloc[-1]), 2), "ret_1y": round((float(tot.iloc[-1] / tot.iloc[0]) - 1) * 100, 1),
           "max_drawdown_1y": round(float((tot / tot.cummax() - 1).min()) * 100, 1),
           "vol_ann": round(float(r.std() * np.sqrt(365) * 100), 1), "days": [],
           **({"left_out": left_out} if left_out and path is not px else {})}
    allexp = {}
    for p in profiles.values():
        for x in p["exposures"]:
            allexp.setdefault(x["f"], x)
    for dt in list(r.nsmallest(n).index) + list(r.nlargest(n // 2).index):
        c = contrib.loc[dt].sort_values(key=abs, ascending=False)
        wk = dt - pd.Timedelta(days=(dt.weekday() - 4) % 7) if dt.weekday() >= 5 else dt  # weekend crypto moves: look at Friday's factors
        out["days"].append({"d": dt.date().isoformat(), "ret": round(float(r[dt]) * 100, 1),
                            "spx": round(float(F.spx_d.get(wk, np.nan)) * 100, 1) if wk in F.spx_d.index else None,
                            "by_holding": [[k, round(float(v) * 100, 2)] for k, v in c.head(4).items()],
                            "drivers": drivers_on(wk, F, allexp, np.sign(r[dt])),
                            "gpr_z": None if pd.isna(F.gpr_z.get(wk, np.nan)) else round(float(F.gpr_z.get(wk)), 1),
                            "events": [t for (idt, t, _k) in F.incidents if abs((idt - dt).days) <= 2][:3]})
    weekly_r = pd.DataFrame({k: weekly(np.log(s).diff().dropna()) for k, s in px.items()})
    weekly_r = weekly_r[weekly_r.index >= idx[-1] - pd.Timedelta(days=730)]
    out["corr_2y"] = weekly_r.corr().round(2).to_dict()
    weights = (vals.iloc[-1] / tot.iloc[-1]).round(4).to_dict()
    return out, weights


def write_md(report):
    b = report["basket"]
    L = [f"# Portfolio report ({report['asof']})", "",
         "Exposure and measured odds for research. Not buy or sell advice.", "",
         f"Value ${b['value_now']:,.0f}. Same quantities held for the past year: {b['ret_1y']:+.1f}%, worst drop {b['max_drawdown_1y']:.1f}%, "
         f"volatility {b['vol_ann']:.0f}% a year."
         + (f" The path leaves out {', '.join(b['left_out'])} (listed under a year ago)." if b.get("left_out") else ""), "",
         *[f"- {a['label']}: {a['count']} holdings, " + (f"₹{a['value_local']:,.0f} (${a['value_usd']:,.0f})" if a["ccy"] == "INR" else f"${a['value_usd']:,.0f}")
           for a in report.get("accounts", [])], "",
         "| Holding | Account | Weight | 1 month | 1 year | vs your cost | Bitcoin corr | What moves it (beyond market) | News pressure now | 20-day odds up | Track record |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for h in report["holdings"]:
        t, o = h["trend"], h["odds"].get("h20", {})
        ex = "; ".join(f"{x['label']} {x['rho']:+.2f}{' (hidden)' if x['hidden'] else ''}" for x in h["exposures"][:3]) or "nothing beyond market"
        rec = (f"AUC {o['auc']}, skill {o['skill']:+.3f}" + (" — beats naive" if o.get("has_skill") else " — no edge")) if o else "too little history"
        vc = f"{t['vs_cost']:+.1f}%" if t.get("vs_cost") is not None else "unknown"
        L.append(f"| {h['sym']} | {LABELS.get(h.get('broker'), h.get('account'))} | {100 * (h['weight'] or 0):.1f}% | {t['ret_1m']:+.1f}% | {t['ret_1y'] if t['ret_1y'] is not None else 'n/a'}% | {vc} | "
                 f"{(h['betas_3y']['bitcoin'] or {}).get('corr', 'n/a')} | {ex} | {h['pressure']['shown']:+d} | {o.get('prob_up', 'n/a')} | {rec} |")
    L += ["", "## Biggest portfolio days in the last year", ""]
    for d in b["days"]:
        by = ", ".join(f"{k} {v:+.1f}" for k, v in d["by_holding"][:3])
        dr = ", ".join(f"{x[0]} {x[1]:+}" for x in d["drivers"]) or "no measured factor shock"
        ev = "; ".join(d["events"]) or "none logged"
        L.append(f"- {d['d']}: portfolio {d['ret']:+.1f}% (S&P {d['spx']}%). From: {by}. Same-day shocks: {dr}. Events: {ev}.")
    L += ["", "## Each holding's biggest surprise days (last 3 years, beyond market and sector)", ""]
    for h in {x["sym"]: x for x in report["holdings"]}.values():
        L.append(f"**{h['sym']}**")
        for m in h["moves"][:5]:
            dr = ", ".join(x[0] for x in m["drivers"]) or "none measured"
            L.append(f"- {m['d']}: {m['ret']:+.1f}% ({'Nifty' if m.get('mkt_name') else 'S&P'} {m['mkt']}%). Shocks: {dr}. Events: {'; '.join(m['events']) or 'none logged'}.")
        L.append("")
    L += ["## Events of the last 14 days pressing on each holding", ""]
    for h in {x["sym"]: x for x in report["holdings"]}.values():
        if h["pressure"]["events"]:
            L.append(f"**{h['sym']}** ({h['pressure']['shown']:+d})")
            for e in h["pressure"]["events"][:3]:
                L.append(f"- {e['c']:+.2f} {e['ts'][:10]} {e['title']}")
            L.append("")
    (KNOWLEDGE / "portfolio_report.md").write_text("\n".join(L))


_SHARED = {}


def shared():
    """Market, factor and macro series, built once and reused for every portfolio in this run."""
    if not _SHARED:
        _SHARED["F"] = Factors()
        _SHARED["macro"] = model.macro_frame()
        _SHARED["stored"] = json.loads((KNOWLEDGE / "stock_profiles.json").read_text())["profiles"]
    return _SHARED["F"], _SHARED["macro"], _SHARED["stored"]


def build_report(holdings, source_head, brokers=None):
    """The full portfolio report for any list of holdings (the owner's, or a platform user's)."""
    from .fetch import fetch_symbol
    for sym in dict.fromkeys(h["sym"] for h in holdings):  # holdings outside the core and universe lists (alt coins, SE) need their own refresh
        if sym.startswith("MF_"):  # fund NAVs come from AMFI and mfapi.in (predictor.mutualfunds), not Yahoo
            continue
        try:
            fetch_symbol(sym)
        except Exception as e:
            print(f"{sym}: price refresh failed ({e}); using stored prices")
    F, macro, stored = shared()
    fx = usdinr()
    uniq = list({h["sym"]: h for h in holdings}.values())  # the analysis is per instrument, whichever account holds it
    profiles = {h["sym"]: profile(h, F, stored) for h in uniq}
    probs = odds(uniq, profiles, macro)
    basket, _ = portfolio_moves(holdings, F, profiles)
    trends = {h["sym"]: trend(h["sym"], None) for h in uniq}
    press = {h["sym"]: event_pressure(h, profiles[h["sym"]]) for h in uniq}
    count = Counter(h["sym"] for h in holdings)
    rows = []
    for h in holdings:
        t = dict(trends[h["sym"]])
        local = h.get("px_local") or t["price"]  # CoinDCX: its own INR price; otherwise the series' own currency
        t["vs_cost"] = round((local / h["avg_cost"] - 1) * 100, 1) if h.get("avg_cost") else None
        value = local * h["qty"]
        value_usd, premium = (value / fx if h.get("ccy") == "INR" else value), None
        if h.get("ccy") == "INR" and h["kind"] == "crypto" and h.get("px_local") and t["price"] > 0:
            # Indian exchanges price coins above the world price (CoinDCX's USDT has traded about 5% over the rupee rate),
            # so dollar totals use the global price, and the gap is kept for the page
            value_usd = t["price"] * h["qty"]
            premium = round((local / (t["price"] * fx) - 1) * 100, 1)
        rows.append({"key": h["sym"] if count[h["sym"]] == 1 else f"{h['sym']}@{h.get('account')}", "sym": h["sym"], "kind": h["kind"],
                     "qty": h["qty"], "avg_cost": h.get("avg_cost"), "account": h.get("account"), "broker": h.get("broker", "robinhood"),
                     "ccy": h.get("ccy", "USD"), "price_local": float(f"{local:.6g}"), "value": round(value, 2),
                     "value_usd": round(value_usd, 2), **({"local_premium": premium} if premium is not None else {}),
                     **({"cost_note": h["cost_note"]} if h.get("cost_note") else {}),
                     **{k: h[k] for k in ("name", "category", "plan", "option", "nav_date") if h.get(k)},
                     "trend": t, **profiles[h["sym"]], "pressure": press[h["sym"]], "odds": probs.get(h["sym"], {})})
    total = sum(r["value_usd"] for r in rows) or 1.0
    leaning, accounts = {}, {}
    for r in rows:
        r["weight"] = round(r["value_usd"] / total, 4)
        for x in r["exposures"]:
            leaning[x["f"]] = leaning.get(x["f"], 0) + r["weight"] * x["rho"]
        a = accounts.setdefault(r["broker"], {"broker": r["broker"], "label": LABELS.get(r["broker"], r["broker"]), "ccy": r["ccy"],
                                              "count": 0, "value_local": 0.0, "value_usd": 0.0})
        a["count"] += 1
        a["value_local"] += r["value"]
        a["value_usd"] += r["value_usd"]
    for a in accounts.values():
        a["value_local"], a["value_usd"] = round(a["value_local"], 2), round(a["value_usd"], 2)
        a["weight"] = round(a["value_usd"] / total, 4)
    basket["value_now"] = round(total, 2)  # today's prices in every account (the series end may lag a day)
    st = accounts_status() if brokers is None else brokers
    source = "; ".join([source_head] + [f"{s['label']} (read-only API, synced {s['synced'][:10]})" for b, s in st.items() if s.get("synced") and b in accounts])
    report = {"asof": date.today().isoformat(), "source": source, "method": __doc__.strip().split("\n\n")[1],
              "fx": {"usdinr": round(fx, 4)}, "accounts": list(accounts.values()), "brokers": st,
              "basket": basket, "factor_leaning": {f: round(v, 3) for f, v in sorted(leaning.items(), key=lambda t: -abs(t[1]))},
              "holdings": rows}
    return report


def main():
    pf = json.loads(PORTFOLIO.read_text())
    report = build_report(all_holdings(), pf.get("source") or "Robinhood")
    basket, accounts, rows = report["basket"], {a["broker"]: a for a in report["accounts"]}, report["holdings"]
    REPORT.write_text(json.dumps(report, indent=1, default=float))
    write_md(report)
    print(f"portfolio ${basket['value_now']:,.0f} | 1y {basket['ret_1y']:+.1f}% | max drawdown {basket['max_drawdown_1y']:.1f}% | vol {basket['vol_ann']:.0f}%"
          + "".join(f" | {a['label']} {a['count']}" for a in accounts.values()))
    for r in rows:
        t, o = r["trend"], r["odds"]
        s5, s20 = o.get("h5", {}), o.get("h20", {})
        ex = ", ".join(f"{x['f']}{'*' if x['hidden'] else ''} {x['rho']:+.2f}" for x in r["exposures"][:3]) or "-"
        vc = t["vs_cost"] if t["vs_cost"] is not None else float("nan")
        print(f"{r['key']:9s} w {100 * (r['weight'] or 0):4.1f}% | 1m {t['ret_1m']:+6.1f}% 1y {t['ret_1y'] if t['ret_1y'] is not None else float('nan'):+6.1f}% vs cost {vc:+6.1f}% | "
              f"btc corr {(r['betas_3y']['bitcoin'] or {}).get('corr')} | exp {ex} | press {r['pressure']['shown']:+d} | "
              f"20d up {s20.get('prob_up')} skill {s20.get('skill')} auc {s20.get('auc')} {'SKILL' if s20.get('has_skill') else 'no-skill'} | "
              f"5d up {s5.get('prob_up')} {'SKILL' if s5.get('has_skill') else 'no-skill'}")


if __name__ == "__main__":
    main()
