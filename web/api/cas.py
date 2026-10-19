"""Statement reader: POST /api/cas turns a CAMS / KFintech (or NSDL / CDSL) consolidated account statement into the
signed-in user's mutual fund holdings.

Runs as a Vercel Python function next to the Next.js app. The PDF and its password arrive in the request body, are
read in memory with casparser and are never written anywhere: no file, no log, no database row. Only fund-level
rows leave this function (AMFI code, fund name, units, average cost), never the investor's name, PAN, email,
address, phone or folio numbers. They are stored through the database function import_funds with the user's own
sign-in token, so the database decides whose rows they are and requires two-factor sign-in.

Local development: `python api/cas.py` serves it on 127.0.0.1:8797; next dev forwards /api/cas there.
"""
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_PDF = 3 * 1024 * 1024  # Vercel caps a request body at 4.5 MB; base64 adds a third
NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"
UNITS_IN = {"PURCHASE", "PURCHASE_SIP", "SWITCH_IN", "SWITCH_IN_MERGER", "DIVIDEND_REINVEST", "GIFT_IN"}
UNITS_OUT = {"REDEMPTION", "SWITCH_OUT", "SWITCH_OUT_MERGER", "GIFT_OUT"}


class Refused(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def _supabase():
    base = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    if not base or not key:
        raise Refused(503, "Statement upload is not switched on for this site yet.")
    return base.rstrip("/"), key


def _call(method, url, key, token, body=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"apikey": key, "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"null")


def _avg_from_transactions(scheme):
    """Average cost per unit from the statement's own transactions, when it prints no cost value."""
    units = cost = 0.0
    for t in scheme.transactions:
        typ, u, amt = str(getattr(t.type, "value", t.type)), float(t.units or 0), float(t.amount or 0)
        if typ in UNITS_IN and u > 0:
            units, cost = units + u, cost + (abs(amt) if amt else u * float(t.nav or 0))
        elif typ in UNITS_OUT and units > 0:
            take = min(abs(u), units)
            cost -= cost / units * take
            units -= take
    return cost / units if units > 1e-6 else None


def _isin_codes():
    """{ISIN: AMFI code} from AMFI's daily NAV file, only for funds casparser could not name a code for."""
    req = urllib.request.Request(NAV_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode("utf-8", "replace")
    out = {}
    for line in text.splitlines():
        p = line.split(";")
        if len(p) >= 6 and p[0].strip().isdigit():
            for i in (p[1].strip(), p[2].strip()):
                if len(i) == 12:
                    out[i] = p[0].strip()
    return out


def funds_from_cas(cas):
    """[(name, isin, amfi, units, avg)] from a parsed statement (CAMS / KFintech, or a depository's)."""
    rows = []
    if hasattr(cas, "folios"):
        for f in cas.folios:
            for s in f.schemes:
                units = float(s.close)
                if units > 1e-4:
                    cost = float(s.valuation.cost) if s.valuation.cost else None
                    rows.append((s.scheme, s.isin, s.amfi, units, cost / units if cost else _avg_from_transactions(s)))
    else:
        for a in getattr(cas, "accounts", []):
            for m in a.mutual_funds:
                units = float(m.balance)
                if units > 1e-4:
                    avg = float(m.avg_cost) if m.avg_cost else (float(m.total_cost) / units if m.total_cost else None)
                    rows.append((m.name or m.isin, m.isin, m.amfi, units, avg))
    return rows


def merge(rows, isin_codes=None):
    """One row per fund (folios of the same fund added together), shaped for import_funds."""
    if isin_codes is None and any(not amfi for _, _, amfi, _, _ in rows):
        try:
            isin_codes = _isin_codes()
        except Exception:
            isin_codes = {}
    merged, skipped = {}, 0
    for name, isin, amfi, units, avg in rows:
        code = str(amfi or "") or (isin_codes or {}).get(isin or "", "")
        if not code.isdigit() or len(code) > 8:
            skipped += 1
            continue
        m = merged.setdefault(code, {"sym": f"MF_{code}", "name": str(name or "")[:120], "qty": 0.0, "cost": 0.0, "known": True})
        m["qty"] += units
        if avg:
            m["cost"] += avg * units
        else:
            m["known"] = False
    out = [{"sym": m["sym"], "name": m["name"], "qty": round(m["qty"], 4),
            "avg_cost": round(m["cost"] / m["qty"], 4) if m["known"] and m["qty"] > 0 else None} for m in merged.values()]
    return out, skipped


def handle(headers, raw):
    # same-site requests from the Connect page only
    origin, host = headers.get("origin"), headers.get("x-forwarded-host") or headers.get("host")
    if headers.get("x-ripple") != "1" or (origin and urllib.parse.urlsplit(origin).netloc != host):
        raise Refused(403, "bad origin")
    auth = headers.get("authorization") or ""
    if not auth.startswith("Bearer ") or len(auth) > 4096:
        raise Refused(401, "sign in first")
    token = auth[7:]
    base, key = _supabase()
    try:
        _call("GET", f"{base}/auth/v1/user", key, token)
    except urllib.error.HTTPError:
        raise Refused(401, "sign in first")

    try:
        body = json.loads(raw)
        pdf = base64.b64decode(body["pdf"], validate=True)
        password = str(body.get("password") or "")
    except Exception:
        raise Refused(400, "Send the statement as a PDF.")
    if not pdf.startswith(b"%PDF") or len(pdf) > MAX_PDF:
        raise Refused(400, "That is not a PDF statement under 3 MB.")
    if not password or len(password) > 64:
        raise Refused(400, "Type the statement's password.")

    import casparser
    from casparser.exceptions import CASParseError, IncorrectPasswordError
    try:
        cas = casparser.read_cas_pdf(io.BytesIO(pdf), password)
    except IncorrectPasswordError:
        raise Refused(400, "That password does not open the statement.")
    except (CASParseError, Exception):
        raise Refused(422, "This does not look like a CAMS, KFintech, NSDL or CDSL consolidated account statement.")
    finally:
        del pdf, password
    period = str(getattr(getattr(cas, "statement_period", None), "to", "") or "")[:10]
    funds, skipped = merge(funds_from_cas(cas))
    del cas
    if not funds:
        raise Refused(422, "No mutual fund holdings were found in this statement.")

    try:
        n = _call("POST", f"{base}/rest/v1/rpc/import_funds", key, token, {"p_rows": funds, "p_period": period})
    except urllib.error.HTTPError as e:
        raise Refused(403 if e.code in (400, 401, 403) else 500, "Could not save the funds. Sign in again with your authenticator and retry.")
    return {"funds": n, "period": period, "skipped": skipped, "unknown_cost": sum(1 for f in funds if f["avg_cost"] is None)}


class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            size = int(self.headers.get("content-length") or 0)
            if size <= 0 or size > MAX_PDF * 4 // 3 + 4096:
                raise Refused(413, "That is not a PDF statement under 3 MB.")
            raw = self.rfile.read(size)
            self._send(200, handle({k.lower(): v for k, v in self.headers.items()}, raw))
        except Refused as e:
            self._send(e.status, {"error": e.message})
        except Exception:
            self._send(500, {"error": "The statement could not be read."})

    def do_GET(self):
        self._send(405, {"error": "use POST"})

    def log_message(self, *args):  # never log requests: the body holds a statement and its password
        pass


if __name__ == "__main__":
    # local development only: the Supabase lines come from .env.local, as next dev reads them
    env = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.local")
    if os.path.exists(env):
        for line in open(env):
            k, _, v = line.strip().partition("=")
            if k.startswith("NEXT_PUBLIC_SUPABASE_"):
                os.environ.setdefault(k, v.strip().strip('"'))
    print("statement reader on http://127.0.0.1:8797/api/cas", file=sys.stderr)
    HTTPServer(("127.0.0.1", 8797), handler).serve_forever()
