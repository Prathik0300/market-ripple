"""One profile per stock: what really moves it, beyond the stock market and its own sector.

For every stock in the universe (S&P 500, Nifty 50, major global names):
  1. Weekly returns since 2012 are cleaned of the local market and the stock's sector (an orthogonalised
     sector ETF). What is left is the part of the stock's moves its sector does not explain.
  2. That remainder is tested against ~38 factors (oil, gas, metals, grains, softs, livestock, rates,
     currencies, VIX, bitcoin, freight, AI/semis, defence, geopolitical risk), each also cleaned of the
     S&P 500. An exposure is "robust" at |t| >= 4.5 and "likely" at |t| >= 3, and in both cases it must
     keep the same sign in all three thirds of the sample. Exposures a sector would not normally have
     are flagged "hidden".
  3. The stock's biggest daily surprises (moves beyond market and sector, z >= 4) are dated and matched
     to same-day factor shocks, geopolitical-risk spikes, logged episodes and events.

    python -m predictor.exposures
"""
import json
import math
import sys
from datetime import date

import numpy as np
import pandas as pd

from .config import EVENTS_FILE, GRAPH_FILE, KNOWLEDGE
from .fetch import load_prices
from .universe import EXPECTED, FACTORS, SECTOR_ETF, STYLE, load

START = pd.Timestamp("2012-01-01")
MIN_WEEKS = 156
T_ROBUST, T_LIKELY = 4.5, 3.0


def _gpr_daily():
    g = pd.read_csv(KNOWLEDGE.parent / "data" / "gpr_daily.csv", parse_dates=["date"]).set_index("date")
    return g["GPRD"].astype(float)


def daily_returns(sym, transform="price"):
    if sym == "GPR":
        g = _gpr_daily()
        return np.log(g.rolling(5).mean()).diff().dropna()
    if transform == "basket":
        parts = [daily_returns(x) for x in sym.split("+")]
        parts = [p for p in parts if p is not None]
        return pd.concat(parts, axis=1).mean(axis=1, skipna=False).dropna() if parts else None
    s = load_prices(sym)
    if s is None or len(s) < 200:
        return None
    if transform == "yield":
        r = s.diff()
    else:
        r = np.log(s).diff()
        r = r[r.abs() < 0.6]
        if transform == "inverse":
            r = -r
    return r.dropna()


def weekly(r):
    return r.resample("W-FRI").sum(min_count=1).dropna()


def _ols_resid(y, X):
    """Residuals and coefficients of y on X (with constant), rows with NaN dropped."""
    df = pd.concat([y.rename("y")] + [x.rename(f"x{i}") for i, x in enumerate(X)], axis=1).dropna()
    if len(df) < 30:
        return None, None
    A = np.column_stack([np.ones(len(df))] + [df[f"x{i}"].values for i in range(len(X))])
    coef, *_ = np.linalg.lstsq(A, df["y"].values, rcond=None)
    return pd.Series(df["y"].values - A @ coef, index=df.index), coef


def _uni(e, f):
    """Univariate regression of e on f: beta, t, correlation and the correlation in each third."""
    df = pd.concat([e.rename("e"), f.rename("f")], axis=1).dropna()
    n = len(df)
    if n < MIN_WEEKS:
        return None
    x, y = df["f"].values - df["f"].mean(), df["e"].values - df["e"].mean()
    sxx = float(x @ x)
    if sxx == 0:
        return None
    beta = float(x @ y) / sxx
    resid = y - beta * x
    se = math.sqrt(float(resid @ resid) / (n - 2) / sxx)
    rho = float(np.corrcoef(x, y)[0, 1])
    thirds = []
    for part in np.array_split(np.arange(n), 3):
        xs, ys = x[part], y[part]
        thirds.append(float(np.corrcoef(xs, ys)[0, 1]) if len(part) > 20 and xs.std() > 0 and ys.std() > 0 else 0.0)
    return {"beta": beta, "t": beta / se if se > 0 else 0.0, "rho": rho, "thirds": thirds, "n": n}


def incidents_index():
    g = json.loads(GRAPH_FILE.read_text())
    out = [(pd.Timestamp(i["d"]), i["t"], "episode") for i in g["incidents"]]
    if EVENTS_FILE.exists():
        for line in EVENTS_FILE.read_text().splitlines():
            try:
                e = json.loads(line)
                out.append((pd.Timestamp(e["ts"][:10]), e["title"], "event"))
            except (ValueError, KeyError):
                continue
    return out


# map node -> stock-profile factor, so event pressure on a map node reaches the stocks exposed to it
NODE_TO_FACTOR = {
    "brent": "oil", "jet_fuel": "diesel", "hh": "gas_us", "ttf": "gas_eu", "uranium": "uranium", "gold": "gold",
    "silver": "silver", "copper": "copper", "aluminium": "aluminium", "steel": "steel", "lithium": "lithium",
    "wheat": "wheat", "rice": "rice", "palm_oil": "soyoil", "soybeans": "soybeans", "cocoa": "cocoa", "coffee": "coffee",
    "us_yields": "rates", "usd": "dollar", "inr": "rupee", "jpy": "yen", "freight": "freight", "bitcoin": "bitcoin",
    "ai_chips": "semis", "defense": "defense", "gulf_war": "gpr", "russia_war": "gpr",
}


def stock_pressure(node_pressure, profiles, top=25):
    """Pass current event pressure on map nodes to stocks through their measured exposures.
    Score = sum over exposed factors of (pressure on that factor) x (stock's residual correlation with it),
    plus the market beta times pressure on risk appetite. A news summary, not a forecast."""
    fp = {}
    for node, v in node_pressure.items():
        f = NODE_TO_FACTOR.get(node)
        if f:
            fp[f] = max(-1.0, min(1.0, fp.get(f, 0) + v))
    risk = node_pressure.get("risk_on", 0)
    rows = []
    for sym, p in profiles.items():
        parts = []
        for x in p["exposures"]:
            if x["f"] in fp and abs(fp[x["f"]]) > 0.05:
                parts.append((x["f"], fp[x["f"]] * x["rho"] * (1 if x["cls"] == "robust" else 0.6)))
        mk = 0.25 * risk * min(max(p.get("beta_mkt") or 1, 0), 2)
        score = sum(v for _, v in parts) + mk
        if abs(score) >= 0.02 and parts:
            rows.append({"sym": sym, "name": p["name"], "sector": p["sector"], "score": round(score, 3),
                         "via": [[f, round(v, 3)] for f, v in sorted(parts, key=lambda t: -abs(t[1]))[:3]], "market_part": round(mk, 3)})
    rows.sort(key=lambda r: -r["score"])
    return {"up": rows[:top], "down": sorted(rows, key=lambda r: r["score"])[:top]}


def stock_screen(profiles, top=60):
    """Screener: stocks most exposed, up or down, to the events of the last 14 days.

    Each event is passed through the map on its own; its pressure on a factor reaches a stock through the
    stock's measured exposure (correlation beyond market and sector, scaled down for "likely" links). A
    stock's score is the sum over events, so every score can be traced to the events and factors behind
    it. It ranks exposure to current news. It is a starting list for research, not a forecast or advice."""
    from .events import per_event_pressure
    evs = per_event_pressure()
    ev_factor = []
    for e, press in evs:
        fp = {}
        for node, v in press.items():
            f = NODE_TO_FACTOR.get(node)
            if f:
                fp[f] = max(-1.0, min(1.0, fp.get(f, 0) + v))
        if fp:
            ev_factor.append((e, fp))
    rows = []
    for sym, p in profiles.items():
        exp = {x["f"]: x for x in p["exposures"]}
        if not exp:
            continue
        total, by_event, by_factor = 0.0, {}, {}
        for e, fp in ev_factor:
            c_e = 0.0
            for f, v in fp.items():
                x = exp.get(f)
                if x:
                    c = v * x["rho"] * (1 if x["cls"] == "robust" else 0.6)
                    c_e += c
                    by_factor[f] = by_factor.get(f, 0) + c
            if abs(c_e) > 0.002:
                by_event[e["id"]] = (e, c_e)
                total += c_e
        if abs(total) < 0.01:
            continue
        evl = sorted(by_event.values(), key=lambda t: -abs(t[1]))[:3]
        fl = sorted(by_factor.items(), key=lambda t: -abs(t[1]))[:3]
        rows.append({
            "sym": sym, "name": p["name"], "sector": p["sector"], "indexes": p.get("indexes", [p["index"]]), "score": round(total, 3),
            "factors": [{"f": f, "c": round(c, 3), "rho": exp[f]["rho"], "cls": exp[f]["cls"], "t": exp[f]["t"]} for f, c in fl],
            "events": [{"id": e["id"], "title": e["title"][:120], "url": e.get("url", ""), "ts": e["ts"], "c": round(c, 3)} for e, c in evl],
        })
    up = sorted([r for r in rows if r["score"] > 0], key=lambda r: -r["score"])[:top]
    down = sorted([r for r in rows if r["score"] < 0], key=lambda r: r["score"])[:top]
    # per-event factor pressure, so the page can score any stock (a portfolio holding) the same way
    events_fp = [{"id": e["id"], "title": e["title"], "url": e.get("url", ""), "ts": e["ts"],
                  "fp": {f: round(v, 4) for f, v in fp.items() if abs(v) >= 0.005}} for e, fp in sorted(ev_factor, key=lambda t: t[0]["ts"], reverse=True)[:80]]
    total_fp = {}
    for x in events_fp:
        for f, v in x["fp"].items():
            total_fp[f] = round(total_fp.get(f, 0) + v, 4)
    return {"events_used": len(ev_factor), "stocks_scored": len(rows), "up": up, "down": down,
            "events_fp": events_fp, "factor_pressure": total_fp}


def main():
    stocks = load()
    spx_d = daily_returns("^GSPC")
    spx_w = weekly(spx_d)
    markets_d = {m: daily_returns(m) for m in ("^GSPC", "^NSEI", "^STOXX50E", "^N225", "^KS11")}
    markets_w = {m: weekly(r) for m, r in markets_d.items() if r is not None}
    # style factors (size, growth vs value), cleaned of the S&P 500, used as controls for every stock
    style_w, style_d = [], []
    for long_sym, short_sym in STYLE.values():
        a, b = daily_returns(long_sym), daily_returns(short_sym)
        if a is None or b is None:
            continue
        spread = (a - b).dropna()
        style_w.append(_ols_resid(weekly(spread), [spx_w])[0])
        style_d.append(_ols_resid(spread, [spx_d])[0])
    # orthogonalised sector factors: sector ETF minus its S&P 500 component
    sec_w, sec_d = {}, {}
    for sec, etf in SECTOR_ETF.items():
        d = daily_returns(etf)
        if d is None:
            continue
        sec_w[sec], _ = _ols_resid(weekly(d), [spx_w])
        sec_d[sec], _ = _ols_resid(d, [spx_d])
    # factors, cleaned of the S&P 500
    fac_w, fac_d, fac_sd = {}, {}, {}
    for f, (sym, tr, label, group) in FACTORS.items():
        d = daily_returns(sym, tr)
        if d is None:
            print(f"factor {f}: no data", file=sys.stderr)
            continue
        w = weekly(d) if f != "gpr" else d.resample("W-FRI").sum(min_count=1).dropna()
        fac_w[f], _ = _ols_resid(w[w.index >= START], [spx_w] + [x for x in style_w if x is not None])
        fac_d[f] = d
        fac_sd[f] = d.rolling(250).std().shift(1)
    gpr_z = None
    try:
        g = _gpr_daily()
        gpr_z = (g - g.rolling(250).mean()) / g.rolling(250).std()
    except Exception:
        pass
    incs = incidents_index()

    profiles, n_tests, counts = {}, 0, {"robust": 0, "likely": 0, "hidden": 0}
    for s in stocks:
        d = daily_returns(s["sym"])
        if d is None:
            continue
        w = weekly(d)
        w = w[w.index >= START]
        if len(w) < MIN_WEEKS:
            continue
        mkt = markets_w.get(s["market"], spx_w)
        X = [mkt] + ([sec_w[s["sector"]]] if s["sector"] in sec_w else [])
        if s["market"] != "^GSPC":
            X.append(spx_w)
        X += [x for x in style_w if x is not None]
        e, coef = _ols_resid(w, X)
        if e is None or len(e) < MIN_WEEKS:
            continue
        exps = []
        for f, fw in fac_w.items():
            if fw is None:
                continue
            res = _uni(e, fw)
            n_tests += 1
            if not res:
                continue
            same = all(np.sign(t) == np.sign(res["t"]) and abs(t) > 0.03 for t in res["thirds"])
            cls = "robust" if abs(res["t"]) >= T_ROBUST and same else "likely" if abs(res["t"]) >= T_LIKELY and same else None
            if not cls:
                continue
            hidden = (f not in EXPECTED[s["sector"]]) if s["sector"] in EXPECTED else False
            counts[cls] += 1
            counts["hidden"] += int(hidden)
            exps.append({"f": f, "label": FACTORS[f][2], "group": FACTORS[f][3], "beta": round(res["beta"], 3), "t": round(res["t"], 1),
                         "rho": round(res["rho"], 3), "cls": cls, "hidden": hidden, "thirds": [round(x, 2) for x in res["thirds"]]})
        exps.sort(key=lambda x: -abs(x["t"]))
        # biggest daily surprises beyond market and sector, matched to same-day drivers
        md = markets_d.get(s["market"]) if markets_d.get(s["market"]) is not None else spx_d
        Xd = [md] + ([sec_d[s["sector"]]] if s["sector"] in sec_d else [])
        ed, _ = _ols_resid(d[d.index >= START - pd.Timedelta(days=400)], Xd)
        moves = []
        if ed is not None:
            z = (ed / ed.rolling(250).std().shift(1)).dropna()
            z = z[z.index >= START]
            big = z[z.abs() >= 4].abs().sort_values(ascending=False)
            kept = []
            for dt in big.index:
                if all(abs((dt - k).days) > 7 for k in kept):
                    kept.append(dt)
                if len(kept) >= 8:
                    break
            exposed = {x["f"]: x for x in exps}
            for dt in sorted(kept, reverse=True):
                ret = float(d.get(dt, np.nan))
                drivers = []
                for f, fd in fac_d.items():
                    if dt in fd.index and dt in fac_sd[f].index and fac_sd[f].get(dt, 0) > 0:
                        fz = float(fd[dt] / fac_sd[f][dt])
                        if abs(fz) >= 2.5:
                            agrees = f in exposed and np.sign(fz) * np.sign(exposed[f]["beta"]) == np.sign(z[dt])
                            drivers.append([f, round(float(fd[dt]) * (1 if FACTORS[f][1] == "yield" else 100), 2), round(fz, 1), bool(agrees)])
                drivers.sort(key=lambda x: (-int(x[3]), -abs(x[2])))
                near = [t for (idt, t, kind) in incs if abs((idt - dt).days) <= 3][:3]
                gz = round(float(gpr_z.get(dt, np.nan)), 1) if gpr_z is not None and dt in gpr_z.index else None
                m_ret = float(md.get(dt, np.nan)) if md is not None else np.nan
                moves.append({"d": dt.date().isoformat(), "ret": round(ret * 100, 1) if not np.isnan(ret) else None,
                              "z": round(float(z[dt]), 1), "mkt": round(m_ret * 100, 1) if not np.isnan(m_ret) else None,
                              "drivers": drivers[:4], "gpr_z": gz if gz is not None and not np.isnan(gz) else None, "events": near})
        profiles[s["sym"]] = {"name": s["name"], "sector": s["sector"], "industry": s["industry"], "index": s["index"],
                              "market": s["market"], "weeks": int(len(e)), "beta_mkt": round(float(coef[1]), 2),
                              "beta_sector": round(float(coef[2]), 2) if len(coef) > 2 and s["sector"] in sec_w else None,
                              "exposures": exps[:8], "moves": moves, "indexes": s.get("indexes", [s["index"]])}
    # reverse map: for each factor, the stocks most exposed to it
    by_factor = {}
    for sym, p in profiles.items():
        for x in p["exposures"]:
            by_factor.setdefault(x["f"], []).append({"sym": sym, "name": p["name"], "sector": p["sector"], "rho": x["rho"], "t": x["t"], "cls": x["cls"], "hidden": x["hidden"]})
    for f in by_factor:
        by_factor[f].sort(key=lambda x: -abs(x["t"]))
    hidden = sorted(({"sym": sym, "name": p["name"], "sector": p["sector"], **x} for sym, p in profiles.items() for x in p["exposures"] if x["hidden"] and x["cls"] == "robust"),
                    key=lambda x: -abs(x["t"]))
    # expected false positives if no stock had any real exposure (two-sided normal tail, times the 1-in-4 chance of a stable sign by luck)
    fp_likely = n_tests * math.erfc(T_LIKELY / math.sqrt(2)) * 0.25
    fp_robust = n_tests * math.erfc(T_ROBUST / math.sqrt(2)) * 0.25
    report = {"asof": date.today().isoformat(), "since": START.date().isoformat(), "stocks": len(profiles), "tests": n_tests,
              "counts": counts, "expected_false": {"likely": round(fp_likely, 1), "robust": round(fp_robust, 2)},
              "factors": {f: {"label": v[2], "group": v[3], "symbol": v[0]} for f, v in FACTORS.items()},
              "method": __doc__.strip().split("\n\n")[1], "profiles": profiles, "by_factor": {f: v[:25] for f, v in by_factor.items()},
              "hidden": hidden[:60]}
    (KNOWLEDGE / "stock_profiles.json").write_text(json.dumps(report))
    print(f"{len(profiles)} stocks profiled, {n_tests} tests; robust {counts['robust']}, likely {counts['likely']}, hidden {counts['hidden']}; "
          f"expected by chance: likely {fp_likely:.1f}, robust {fp_robust:.2f}")
    print("\nstrongest hidden robust exposures:")
    for h in hidden[:25]:
        print(f"  {h['sym']:12s} {h['name'][:28]:28s} {h['sector'][:22]:22s} {h['label']:28s} rho {h['rho']:+.2f} t {h['t']:+.1f}")


if __name__ == "__main__":
    main()
