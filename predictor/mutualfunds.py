"""Mutual funds from a CAMS / KFintech Consolidated Account Statement (CAS), valued every day at AMFI NAVs.

Groww's trading API has no mutual funds, so they come from the official CAS PDF the owner requests (free; it covers
every fund house and platform) and saves into inbox/cas/. casparser reads it on this Mac, with the PDF password the
owner keeps as CAS_PASSWORD in the private keys file (predictor.brokers.ENV_FILE) or types in when importing by hand.
Only fund-level rows are kept: never the investor's name, PAN, email, address or phone, and folio numbers only as
their last four characters. Depository statements (NSDL / CDSL CAS) work too; only their mutual fund rows are used,
since Groww's API already supplies the shares.

    python -m predictor.mutualfunds sync            # import a newer statement if one is waiting, then refresh NAVs (the job runs this)
    python -m predictor.mutualfunds import [pdf]    # import a statement now (the newest in inbox/cas/ if none is named)
    python -m predictor.mutualfunds status

Prices: today's NAV from AMFI's daily file of every Indian fund; history from mfapi.in, saved as
data/prices/MF_<AMFI code>.csv, so the portfolio analysis treats each fund like any other series.
Output: knowledge/brokers/mf.json, which predictor.brokers.all_holdings() adds as the "Mutual funds" account.
Units change only when a newer statement is imported: SIP instalments after its date appear with the next one.
"""
import getpass
import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import pandas as pd

from .brokers import BROKER_DIR, _json, _now, _status_update, load_env
from .config import DATA, PRICES, ROOT

INBOX = ROOT / "inbox" / "cas"
MF_FILE = BROKER_DIR / "mf.json"
IMPORTED = BROKER_DIR / "mf_imported.json"
NAV_FILE = DATA / "amfi_nav.txt"
NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"
HISTORY_URL = "https://api.mfapi.in/mf/{code}"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
NAV_MAX_AGE_H = 6
# units in, units out, by casparser transaction type (taxes and stamp duty do not change units)
UNITS_IN = {"PURCHASE", "PURCHASE_SIP", "SWITCH_IN", "SWITCH_IN_MERGER", "DIVIDEND_REINVEST", "GIFT_IN"}
UNITS_OUT = {"REDEMPTION", "SWITCH_OUT", "SWITCH_OUT_MERGER", "GIFT_OUT"}


def _get(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- AMFI NAVs

def amfi_navs(force=False):
    """{AMFI code: {...}} and {ISIN: code} from AMFI's daily file, downloaded at most every NAV_MAX_AGE_H hours."""
    fresh = NAV_FILE.exists() and time.time() - NAV_FILE.stat().st_mtime < NAV_MAX_AGE_H * 3600
    if force or not fresh:
        try:
            raw = _get(NAV_URL, timeout=90)
            if raw.count(b";") > 1000:  # a moved-page notice or an error page is not a NAV file
                NAV_FILE.write_bytes(raw)
        except Exception as e:
            print(f"AMFI NAV download failed ({e}); using the saved file", file=sys.stderr)
    if not NAV_FILE.exists():
        return {}, {}
    by_code, by_isin = {}, {}
    for line in NAV_FILE.read_text(errors="replace").splitlines():
        p = [x.strip() for x in line.split(";")]
        if len(p) < 6 or not p[0].isdigit():
            continue
        # current layout: code;ISIN growth/payout;ISIN reinvest;name;plan;option;NAV;date (older files had no plan/option)
        code, isin1, isin2 = p[0], p[1], p[2]
        if len(p) >= 8:
            name, plan, option, nav, day = p[3], p[4], p[5], p[6], p[7]
        else:
            name, plan, option, nav, day = p[3], "", "", p[4], p[5]
        try:
            nav = float(nav)
        except ValueError:
            continue
        try:
            d = datetime.strptime(day, "%d-%b-%Y").date().isoformat()
        except ValueError:
            d = None
        by_code[code] = {"name": name, "plan": plan, "option": option, "nav": nav, "date": d}
        for i in (isin1, isin2):
            if i and i != "-":
                by_isin[i] = code
    return by_code, by_isin


def history(code, nav_today=None):
    """Daily NAV history for one fund in data/prices/MF_<code>.csv, refreshed from mfapi.in when it is older than
    the latest AMFI NAV. A failed download keeps the saved history and only adds today's NAV."""
    path = PRICES / f"MF_{code}.csv"
    old = pd.read_csv(path).set_index("date")["close"] if path.exists() else pd.Series(dtype=float, name="close")
    if len(old) and (nav_today is None or not nav_today.get("date") or old.index[-1] >= nav_today["date"]):
        return path
    rows = {}
    try:
        d = json.loads(_get(HISTORY_URL.format(code=code)))
        rows = {datetime.strptime(x["date"], "%d-%m-%Y").date().isoformat(): float(x["nav"]) for x in d.get("data", []) if float(x["nav"]) > 0}
    except Exception as e:
        print(f"MF_{code}: NAV history download failed ({e}); keeping the saved history", file=sys.stderr)
    s = pd.concat([old, pd.Series(rows, dtype=float)]) if rows else old.copy()
    s = s[~s.index.duplicated(keep="last")]
    if nav_today and nav_today.get("date") and nav_today["date"] not in s.index:
        s.loc[nav_today["date"]] = nav_today["nav"]
    if s.empty:
        return None
    out = s.sort_index().rename("close").to_frame()
    out.index.name = "date"
    PRICES.mkdir(parents=True, exist_ok=True)
    out.to_csv(path)
    return path


# ---------------------------------------------------------------- statements

def _avg_cost_from_transactions(scheme):
    """Average cost per unit from the statement's own transactions, when the statement prints no cost value."""
    units = cost = 0.0
    for t in scheme.transactions:
        typ, u, amt = str(getattr(t.type, "value", t.type)), float(t.units or 0), float(t.amount or 0)
        if typ in UNITS_IN and u > 0:  # a row without an amount (some switches and mergers) is costed at its NAV
            units, cost = units + u, cost + (abs(amt) if amt else u * float(t.nav or 0))
        elif typ in UNITS_OUT and units > 0:
            take = min(abs(u), units)
            cost -= cost / units * take
            units -= take
    return cost / units if units > 1e-6 else None


def _tail(folio):
    """The last four digits of a folio number, so funds can be told apart without storing the number."""
    digits = "".join(c for c in str(folio or "") if c.isdigit())
    return digits[-4:]


def holdings_from_cas(cas, by_isin):
    """Fund rows from a parsed statement (CASData from CAMS / KFintech, or NSDLCASData from a depository)."""
    rows = []
    if hasattr(cas, "folios"):
        for f in cas.folios:
            for s in f.schemes:
                units = float(s.close)
                if units <= 1e-4:
                    continue
                v = s.valuation
                cost = float(v.cost) if v.cost else None
                avg = cost / units if cost else _avg_cost_from_transactions(s)
                rows.append({"name": s.scheme, "isin": s.isin, "amfi": s.amfi, "category": s.type, "units": units, "avg": avg,
                             "folio_tail": _tail(f.folio), "cas_date": str(v.date), "cas_nav": float(v.nav)})
    else:
        for a in getattr(cas, "accounts", []):
            for m in a.mutual_funds:
                units = float(m.balance)
                if units <= 1e-4:
                    continue
                avg = float(m.avg_cost) if m.avg_cost else (float(m.total_cost) / units if m.total_cost else None)
                rows.append({"name": m.name or m.isin, "isin": m.isin, "amfi": m.amfi, "category": m.type, "units": units, "avg": avg,
                             "folio_tail": _tail(m.folio), "cas_date": str(cas.statement_period.to), "cas_nav": float(m.nav)})
    merged, ignored = {}, []
    for r in rows:
        code = str(r["amfi"] or "") or by_isin.get(r["isin"] or "")
        if not code:
            ignored.append(f"{r['name'][:60]}: no AMFI code for its ISIN, so no daily NAV")
            continue
        m = merged.setdefault(code, {"sym": f"MF_{code}", "kind": "fund", "qty": 0.0, "cost": 0.0, "known": True, "account": "mutual_funds",
                                     "broker": "mf", "ccy": "INR", "name": r["name"], "isin": r["isin"], "amfi": code,
                                     "category": (r["category"] or "").upper() or None, "folios": [], "cas_date": r["cas_date"], "cas_nav": r["cas_nav"]})
        m["qty"] += r["units"]
        if r["avg"]:
            m["cost"] += r["avg"] * r["units"]
        else:
            m["known"] = False
        if r["folio_tail"]:
            m["folios"].append("…" + r["folio_tail"])
    out = []
    for m in merged.values():
        m["avg_cost"] = round(m.pop("cost") / m["qty"], 4) if m.pop("known") and m["qty"] > 0 else None
        if m["avg_cost"] is None:
            m["cost_note"] = "the statement gives no cost for this fund, so gain or loss is unknown"
        m["qty"] = round(m["qty"], 4)
        out.append(m)
    return out, ignored


def _password(env, interactive):
    if env.get("CAS_PASSWORD"):
        return env["CAS_PASSWORD"]
    if interactive and sys.stdin.isatty():
        return getpass.getpass("CAS PDF password: ") or None
    return None


def _fingerprint(pdf):
    return hashlib.sha256(pdf.read_bytes()).hexdigest()[:24]


def import_pdf(pdf, interactive=False, password=None):
    """password: given directly by the owner for this one import (never stored); otherwise CAS_PASSWORD or a prompt."""
    import casparser
    from casparser.exceptions import CASParseError, IncorrectPasswordError
    pw = password or _password(load_env(), interactive)
    if not pw:
        return _status_update("mf", state="needs_password", note=f"A statement is waiting ({pdf.name}). Add CAS_PASSWORD to the keys file, "
                              "or run `python -m predictor.mutualfunds import` and type the PDF password.")
    try:
        cas = casparser.read_cas_pdf(str(pdf), pw)
    except IncorrectPasswordError:
        return _status_update("mf", state="needs_password", note=f"The password did not open {pdf.name}. Check CAS_PASSWORD (it is the one you chose when requesting the statement).")
    except (CASParseError, ValueError) as e:
        return _status_update("mf", state="error", note=f"Could not read {pdf.name}: {str(e)[:160]}. A re-saved or printed copy will not parse; use the PDF as emailed.")
    by_code, by_isin = amfi_navs()
    hold, ignored = holdings_from_cas(cas, by_isin)
    warn = list(getattr(cas, "parse_warnings", []) or [])[:5]
    period = cas.statement_period.to
    BROKER_DIR.mkdir(parents=True, exist_ok=True)
    MF_FILE.write_text(json.dumps({"synced": _now(), "broker": "mf", "statement": {"to": str(period), "file": pdf.name,
                                   "type": str(getattr(cas, "cas_type", "") or getattr(cas, "file_type", ""))},
                                   "holdings": hold, "ignored": ignored, "warnings": warn}, indent=1))
    seen = _json(IMPORTED, {}) or {}
    seen[_fingerprint(pdf)] = {"file": pdf.name, "to": str(period), "imported": _now()}
    IMPORTED.write_text(json.dumps(seen, indent=1))
    refresh(by_code)
    return _status_update("mf", state="ok", synced=_now(), statement=str(period), holdings=len(hold), ignored=len(ignored),
                          note=f"{len(hold)} funds from the statement to {period}" + (f", {len(ignored)} skipped" if ignored else "")
                          + (f"; casparser flagged {len(warn)} rows to double-check" if warn else ""))


def refresh(by_code=None):
    """Today's NAV for every held fund, plus its history file; marks funds whose NAV could not be found."""
    d = _json(MF_FILE)
    if not d:
        return 0
    if by_code is None:
        by_code, _ = amfi_navs()
    n = 0
    for h in d["holdings"]:
        nav = by_code.get(h["amfi"])
        if nav:
            h.update({"px_local": nav["nav"], "nav_date": nav["date"], "name": nav["name"] or h["name"], "plan": nav["plan"], "option": nav["option"]})
            n += 1
        else:
            h.setdefault("px_local", h.get("cas_nav"))
            h["nav_date"] = h.get("nav_date") or h.get("cas_date")
        history(h["amfi"], nav)
    d["navs"] = {"updated": _now(), "matched": n}
    MF_FILE.write_text(json.dumps(d, indent=1))
    return n


def waiting():
    """The newest statement in inbox/cas/ that has not been imported yet."""
    if not INBOX.exists():
        return None
    seen = _json(IMPORTED, {}) or {}
    pdfs = sorted((p for p in INBOX.iterdir() if p.suffix.lower() == ".pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
    return next((p for p in pdfs if _fingerprint(p) not in seen), None)


def _private_inbox():
    INBOX.mkdir(parents=True, exist_ok=True)
    for d in (INBOX.parent, INBOX):  # statements hold the owner's PAN and contact details
        os.chmod(d, 0o700)


def sync(interactive=False):
    _private_inbox()
    pdf = waiting()
    if pdf:
        return import_pdf(pdf, interactive)
    if MF_FILE.exists():
        n = refresh()
        d = _json(MF_FILE, {})
        return _status_update("mf", state="ok", note=f"{len(d.get('holdings', []))} funds from the statement to {d.get('statement', {}).get('to')}; "
                              f"NAVs for {n} updated")
    return _status_update("mf", state="not_set_up", note="No mutual fund statement yet: save a CAMS CAS PDF into inbox/cas/.")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "status"
    if cmd == "sync":
        s = sync()
    elif cmd == "import":
        _private_inbox()
        if len(argv) > 1:
            pdf = Path(argv[1]).expanduser().resolve()
        else:
            pdf = waiting() or max(INBOX.glob("*.pdf"), key=lambda p: p.stat().st_mtime, default=None)
        if not pdf or not pdf.exists():
            print("No statement found: save the CAS PDF into inbox/cas/ or name it on the command line.")
            return 1
        s = import_pdf(pdf, interactive=True)
    elif cmd == "status":
        s = (_json(BROKER_DIR / "status.json", {}) or {}).get("mf") or {"state": "not_set_up", "note": "No statement imported yet."}
    else:
        print(__doc__)
        return 1
    print(f"Mutual funds {s['state']}: {s.get('note', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
