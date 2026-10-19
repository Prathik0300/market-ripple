"""Turn stored prices into return series for each map node."""
import numpy as np
import pandas as pd

from .config import EXTRA, PROXIES
from .fetch import load_prices

_cache = {}


def returns(node):
    """Daily returns for a node on its own trading calendar (log returns; yield changes in points)."""
    if node in _cache:
        return _cache[node]
    spec = PROXIES.get(node) or EXTRA.get(node)
    if not spec:
        return None
    sym, kind = spec
    s = load_prices(sym)
    if s is None or len(s) < 300:
        return None
    if kind == "yield":
        r = s.diff()
    else:
        r = np.log(s).diff()
        r = r[r.abs() < 0.5]  # drop data glitches and contract-roll artefacts
        if kind == "inverse":
            r = -r
    r = r.dropna()
    _cache[node] = r
    return r


def level(node):
    spec = PROXIES.get(node) or EXTRA.get(node)
    return load_prices(spec[0]) if spec else None


def forward_sum(r, dates, h, after=False):
    """For each date, the sum of r over the h trading days starting at the first r-date on or after it
    (after=True: strictly after it, so the shock day's own reaction is excluded)."""
    idx = r.index
    vals = r.values
    csum = np.concatenate([[0.0], np.cumsum(vals)])
    pos = idx.searchsorted(pd.DatetimeIndex(dates), side="right" if after else "left")
    out = np.full(len(pos), np.nan)
    ok = pos + h <= len(vals)
    out[ok] = csum[pos[ok] + h] - csum[pos[ok]]
    return out


def shock_days(r, z=2.0, window=60, gap=5):
    """Days when a series moved more than z rolling standard deviations, thinned so shocks are at least gap days apart."""
    sd = r.rolling(window).std().shift(1)
    zs = (r / sd).dropna()
    big = zs[zs.abs() > z]
    kept, last = [], None
    for d, v in big.items():
        if last is None or (d - last).days > gap * 7 / 5:
            kept.append((d, np.sign(v), v))
            last = d
    return kept
