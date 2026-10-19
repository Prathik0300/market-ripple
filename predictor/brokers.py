"""Read-only holdings from Groww (Indian stocks) and CoinDCX (crypto), merged with the Robinhood holdings.

Keys live in secrets/brokers.env, which only the owner fills in (Claude is denied reading or editing it).
Neither broker offers read-only keys, so this module is the guard: it can send only the requests listed in
ALLOWED (sign in, read holdings, read balances and trades, public prices), refuses redirects, and raises
before anything else leaves the machine. It never prints or stores a key outside secrets/.

    python -m predictor.brokers sync            # every broker that has keys; writes knowledge/brokers/<broker>.json
    python -m predictor.brokers sync groww      # one broker
    python -m predictor.brokers status          # what is set up and what each one needs (never prints keys)

Groww sign-in, in the order tried (set one in secrets/brokers.env):
  GROWW_API_KEY + GROWW_API_SECRET    approval flow: approve the key once a day on groww.in/trade-api/api-keys,
                                      then the next run mints that day's token itself (recommended)
  GROWW_TOTP_KEY + GROWW_TOTP_SECRET  TOTP flow: no daily step, but anyone with this file can sign in
  GROWW_ACCESS_TOKEN                  a token pasted from the Groww app; expires at 06:00 IST every day
Tokens are cached in secrets/.groww_token.json until they expire (06:00 IST), so a sign-in costs one call a day.

CoinDCX: COINDCX_API_KEY + COINDCX_API_SECRET (bind the key to your IP address when you create it).

Output, one file per broker, read by all_holdings():
  {"synced", "holdings": [{sym, kind, qty, avg_cost, account, broker, ccy, ...}], "ignored": [...]}
  Groww stocks are SYMBOL.NS (or .BO) with INR prices and costs. CoinDCX coins are CODE-USD for the analysis,
  with the INR cost from the account's own INR trades and the INR price from CoinDCX's public ticker.
knowledge/brokers/status.json: per broker state (ok, needs_approval, needs_token, not_set_up, error), synced, note.
"""
import base64
import hashlib
import hmac
import json
import os
import socket
import stat
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from .config import KNOWLEDGE, ROOT

SECRETS = ROOT / "secrets"
ENV_FILE = SECRETS / "brokers.env"
TOKEN_CACHE = SECRETS / ".groww_token.json"
BROKER_DIR = KNOWLEDGE / "brokers"
STATUS = BROKER_DIR / "status.json"
BROKERS = ("groww", "coindcx")  # API syncs run by `sync`
SOURCES = BROKERS + ("mf",)  # plus mutual funds from a CAS statement (predictor.mutualfunds)
LABELS = {"robinhood": "Robinhood", "groww": "Groww", "coindcx": "CoinDCX", "mf": "Mutual funds"}
IST = timezone(timedelta(hours=5, minutes=30))
UA = "market-ripple/1.0 (read-only holdings sync)"

# The only requests this module can send: (method, host, path). Orders, cancels, withdrawals and every
# other path are refused before a connection is opened.
ALLOWED = {
    ("POST", "api.groww.in", "/v1/token/api/access"),          # sign in (mint the day's access token)
    ("GET", "api.groww.in", "/v1/holdings/user"),              # demat holdings
    ("POST", "api.coindcx.com", "/exchange/v1/users/balances"),     # coin balances
    ("POST", "api.coindcx.com", "/exchange/v1/orders/trade_history"),  # past fills, for average cost
    ("GET", "api.coindcx.com", "/exchange/ticker"),            # public prices
}
IPV4_ONLY = {"api.coindcx.com"}  # CoinDCX keys can be bound to one IP address


class BrokerError(Exception):
    def __init__(self, code, detail):
        super().__init__(f"HTTP {code}: {detail}")
        self.code, self.detail = code, detail


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # a redirect could lead off the allowlist, so it is an error
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)
_SECRET_VALUES = []


def _scrub(text):
    for v in _SECRET_VALUES:
        if v and len(v) >= 6:
            text = text.replace(v, "***")
    return text


def _request(method, url, headers=None, body=None, timeout=30):
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or (method, u.hostname, u.path) not in ALLOWED:
        raise PermissionError(f"blocked: {method} {u.hostname}{u.path} is not on the read-only allowlist")
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    # API keys are bound to one IP address; home IPv6 addresses rotate, so these hosts are reached over IPv4
    gai = socket.getaddrinfo
    if u.hostname in IPV4_ONLY:
        socket.getaddrinfo = lambda *a, **k: [r for r in gai(*a, **k) if r[0] == socket.AF_INET] or gai(*a, **k)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise BrokerError(e.code, _scrub(e.read()[:300].decode("utf-8", "replace"))) from None
    except urllib.error.URLError as e:
        raise BrokerError(0, _scrub(str(e.reason))) from None
    finally:
        socket.getaddrinfo = gai
    return json.loads(raw) if raw else None


# ---------------------------------------------------------------- secrets

TEMPLATE = """# Broker keys for predictor.brokers. Only you edit this file; Claude is blocked from reading it.
# Fill in one Groww option and the CoinDCX pair, then save. Leave unused lines empty.
# Keep the file private: it is chmod 600 (only your user can read it).

# Groww, option 1 (recommended): API key + secret from https://groww.in/trade-api/api-keys
# You approve the key once a day on that page; the next run then signs in by itself.
GROWW_API_KEY=
GROWW_API_SECRET=

# Groww, option 2: TOTP key + the authenticator secret shown when you create it (no daily step)
GROWW_TOTP_KEY=
GROWW_TOTP_SECRET=

# Groww, option 3: an access token pasted from the Groww app (expires 06:00 IST every day)
GROWW_ACCESS_TOKEN=

# CoinDCX: API key + secret from the API dashboard (coindcx.com > Profile > API dashboard).
# Bind it to your IP address when you create it.
COINDCX_API_KEY=
COINDCX_API_SECRET=
"""


def ensure_template():
    SECRETS.mkdir(exist_ok=True)
    os.chmod(SECRETS, 0o700)
    if not ENV_FILE.exists():
        ENV_FILE.write_text(TEMPLATE)
    os.chmod(ENV_FILE, 0o600)


def load_env():
    env = {}
    if ENV_FILE.exists():
        mode = ENV_FILE.stat().st_mode
        if mode & (stat.S_IRWXG | stat.S_IRWXO):
            os.chmod(ENV_FILE, 0o600)
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if v:
                env[k.strip()] = v
    for k in list(os.environ):
        if k.startswith(("GROWW_", "COINDCX_", "SUPABASE_")) and os.environ[k].strip():
            env[k] = os.environ[k].strip()
    _SECRET_VALUES[:] = list(env.values())
    return env


def _private_write(path, obj):
    path.write_text(json.dumps(obj))
    os.chmod(path, 0o600)


# ---------------------------------------------------------------- helpers

def _json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _next_6am_ist(now=None):
    now = (now or datetime.now(timezone.utc)).astimezone(IST)
    t = now.replace(hour=6, minute=0, second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


def usdinr():
    """Rupees per dollar, from the daily INR=X series the pipeline already keeps."""
    from .fetch import load_prices
    s = load_prices("INR=X")
    return float(s.iloc[-1]) if s is not None and len(s) else 85.0


def _has_history(sym):
    """True when Yahoo has a daily series for sym (downloads it the first time)."""
    from .fetch import fetch_symbol, load_prices
    s = load_prices(sym)
    if s is not None and len(s) >= 30:
        return True
    try:
        n, _ = fetch_symbol(sym)
        return n >= 30
    except Exception:
        return False


def totp(secret, at=None, digits=6, step=30):
    """RFC 6238 code from a base32 authenticator secret."""
    key = base64.b32decode(secret.replace(" ", "").upper() + "=" * (-len(secret.replace(" ", "")) % 8))
    msg = struct.pack(">Q", int((at or time.time()) // step))
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return str((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


# ---------------------------------------------------------------- Groww

GROWW = "https://api.groww.in"


class NeedsUser(Exception):
    """Sign-in needs something only the owner can do (approve the key, paste a new token)."""

    def __init__(self, state, note):
        super().__init__(note)
        self.state, self.note = state, note


def _reason(e):
    """Groww's own words for a refusal (an unapproved key, a lapsed plan), so the note says why."""
    try:
        d = json.loads(e.detail)
        err = d.get("error") if isinstance(d.get("error"), dict) else d
        msg = err.get("message") or err.get("displayMessage") or err.get("error_message") or d.get("message")
    except (ValueError, AttributeError, TypeError):
        msg = e.detail
    msg = " ".join(str(msg or "").split())[:140]
    return f" Groww said: “{msg}”." if msg else ""


def groww_token(env):
    cache = _json(TOKEN_CACHE, {}) or {}
    if cache.get("token") and cache.get("expires", "") > _now():
        return cache["token"]
    via, body, key = None, None, None
    ts = str(int(time.time()))
    if env.get("GROWW_API_KEY") and env.get("GROWW_API_SECRET"):
        via, key = "approval", env["GROWW_API_KEY"]
        body = {"key_type": "approval", "checksum": hashlib.sha256((env["GROWW_API_SECRET"] + ts).encode()).hexdigest(), "timestamp": ts}
    elif env.get("GROWW_TOTP_KEY") and env.get("GROWW_TOTP_SECRET"):
        via, key = "totp", env["GROWW_TOTP_KEY"]
        body = {"key_type": "totp", "totp": totp(env["GROWW_TOTP_SECRET"])}
    elif env.get("GROWW_ACCESS_TOKEN"):
        return env["GROWW_ACCESS_TOKEN"]
    else:
        raise NeedsUser("not_set_up", "No Groww keys in secrets/brokers.env yet.")
    try:
        r = _request("POST", GROWW + "/v1/token/api/access", {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json.dumps(body))
    except BrokerError as e:
        if e.code in (401, 403) or (400 <= e.code < 500 and via == "approval"):
            raise NeedsUser("needs_approval" if via == "approval" else "needs_token",
                            ("Approve today's API key on groww.in/trade-api/api-keys; the next run signs in by itself. "
                             "If it is already approved, check that your Trading API plan is still active." if via == "approval"
                             else f"Groww refused the TOTP sign-in ({e.code}). Check the TOTP key and secret, and that your Trading API plan is active.")
                            + _reason(e)) from None
        raise
    tok = (r or {}).get("token") or ((r or {}).get("payload") or {}).get("token")
    if not tok:
        raise BrokerError(200, "sign-in answered without a token")
    expires = (r.get("expiry") or "").strip()
    try:
        exp = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        exp = exp if exp.tzinfo else exp.replace(tzinfo=IST)
    except ValueError:
        exp = _next_6am_ist()
    _private_write(TOKEN_CACHE, {"token": tok, "expires": exp.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "via": via})
    return tok


def groww_holdings_raw(env):
    tok = groww_token(env)
    try:
        return _request("GET", GROWW + "/v1/holdings/user", {"Authorization": f"Bearer {tok}", "X-API-VERSION": "1.0"})
    except BrokerError as e:
        if e.code in (401, 403):
            TOKEN_CACHE.unlink(missing_ok=True)
            pasted = not (env.get("GROWW_API_KEY") or env.get("GROWW_TOTP_KEY"))
            raise NeedsUser("needs_token" if pasted else "needs_approval",
                            ("The pasted Groww token has expired (they end at 06:00 IST). Paste today's token into secrets/brokers.env."
                             if pasted else "Groww refused to show the holdings. Approve today's API key on groww.in/trade-api/api-keys, "
                             "and check that your Trading API plan is still active.") + _reason(e)) from None
        raise


def parse_groww(raw, check=_has_history):
    rows = ((raw or {}).get("payload") or {}).get("holdings") or []
    hold, ignored = [], []
    for r in rows:
        ts = str(r.get("trading_symbol") or "").strip().upper()
        qty = float(r.get("quantity") or 0)
        avg = float(r.get("average_price") or 0)
        if not ts or qty <= 0:
            continue
        sym = next((s for s in (f"{ts}.NS", f"{ts}.BO") if check(s)), None)
        if not sym:
            ignored.append(f"{ts}: {qty:g} shares, no daily price history found (bond, SME or recently listed)")
            continue
        hold.append({"sym": sym, "kind": "stock", "qty": qty, "avg_cost": round(avg, 4) if avg > 0 else None, "account": "groww",
                     "broker": "groww", "ccy": "INR", "isin": r.get("isin"), "t1_qty": float(r.get("t1_quantity") or 0) or None})
    return hold, ignored


# ---------------------------------------------------------------- CoinDCX

DCX = "https://api.coindcx.com"


def _dcx_post(env, path, payload):
    body = json.dumps({**payload, "timestamp": int(time.time() * 1000)}, separators=(",", ":"))
    sig = hmac.new(env["COINDCX_API_SECRET"].encode(), body.encode(), hashlib.sha256).hexdigest()
    return _request("POST", DCX + path, {"Content-Type": "application/json", "X-AUTH-APIKEY": env["COINDCX_API_KEY"], "X-AUTH-SIGNATURE": sig}, body)


def coindcx_raw(env):
    if not (env.get("COINDCX_API_KEY") and env.get("COINDCX_API_SECRET")):
        raise NeedsUser("not_set_up", "No CoinDCX keys in secrets/brokers.env yet.")
    try:
        balances = _dcx_post(env, "/exchange/v1/users/balances", {})
    except BrokerError as e:
        if e.code in (401, 403):
            raise NeedsUser("needs_token", f"CoinDCX refused the key ({e.code}). Check the key and secret, and that it is bound to this IP address.") from None
        raise
    trades, from_id = [], None
    for _ in range(40):  # 500 fills a page, up to 20,000 fills
        page = _dcx_post(env, "/exchange/v1/orders/trade_history", {"limit": 500, "sort": "asc", **({"from_id": from_id} if from_id else {})}) or []
        trades += page
        if len(page) < 500:
            break
        from_id = page[-1]["id"]
    ticker = _request("GET", DCX + "/exchange/ticker")
    return {"balances": balances or [], "trades": trades, "ticker": ticker or []}


def _avg_costs(trades):
    """Average INR cost per coin from INR-market fills, held in the order they happened. A sell lowers the
    quantity at the running average. Coins also traded against USDT or other coins are flagged."""
    pos, other = {}, set()
    for t in sorted(trades, key=lambda x: (x.get("timestamp") or 0, str(x.get("id")))):
        sym = str(t.get("symbol") or t.get("market") or "").upper()
        if sym.endswith("INR"):
            coin = sym[:-3]
        else:
            for q in ("USDT", "BTC", "ETH", "BNB"):
                if sym.endswith(q) and len(sym) > len(q):
                    other.add(sym[:-len(q)])
                    other.add(q)
                    break
            continue
        q, p = float(t.get("quantity") or 0), float(t.get("price") or 0)
        qty, cost = pos.get(coin, (0.0, 0.0))
        if str(t.get("side")).lower() == "buy":
            qty, cost = qty + q, cost + q * p
        elif qty > 0:
            take = min(q, qty)
            cost -= cost / qty * take
            qty -= take
        pos[coin] = (qty, cost)
    return pos, other


def parse_coindcx(raw, fx, check=_has_history, manual=None):
    """manual: costs the owner read off CoinDCX's coin pages (knowledge/brokers/coindcx_costs.json), used when the
    account has no API trade records (coins bought with the app's simple Buy, or moved in from a wallet)."""
    if manual is None:
        manual = _json(BROKER_DIR / "coindcx_costs.json", {}) or {}
    entered, as_of = manual.get("coins", {}), manual.get("as_of")
    px = {str(t.get("market", "")).upper(): float(t["last_price"]) for t in raw.get("ticker", []) if t.get("last_price") not in (None, "")}
    usdt_inr = px.get("USDTINR")
    pos, other = _avg_costs(raw.get("trades", []))
    hold, ignored, cash = [], [], 0.0
    for b in raw.get("balances", []):
        c = str(b.get("currency") or "").upper()
        qty = float(b.get("balance") or 0) + float(b.get("locked_balance") or 0)
        if qty <= 0:
            continue
        if c == "INR":
            cash = qty
            continue
        p_inr = px.get(c + "INR") or (px.get(c + "USDT") * usdt_inr if px.get(c + "USDT") and usdt_inr else None)
        if c in ("USDT", "USDC") and not p_inr:
            p_inr = usdt_inr
        if p_inr is None:
            ignored.append(f"{c}: {qty:g}, no INR or USDT price on CoinDCX")
            continue
        if qty * p_inr / fx < 1:
            ignored.append(f"{c}: {qty:g} (dust, under $1)")
            continue
        sym = f"{c}-USD"
        if not check(sym):
            ignored.append(f"{c}: {qty:g} (about ₹{qty * p_inr:,.0f}), no daily price history to analyse")
            continue
        tq, tc = pos.get(c, (0.0, 0.0))
        avg, note = None, None
        if tq > 0 and abs(tq - qty) <= 0.05 * qty and c not in other:
            avg = round(tc / tq, 6)
        elif tq > 0 and c not in other:
            note = f"INR trades explain {tq:g} of {qty:g}; the rest arrived by transfer, so the average cost is unknown"
        else:
            note = "bought outside INR markets or transferred in; average cost unknown"
        e = entered.get(c) or {}
        if avg is None and e.get("qty") and e.get("invested_inr"):
            avg = round(float(e["invested_inr"]) / float(e["qty"]), 8)
            drift = qty / float(e["qty"]) - 1
            note = f"average cost from your CoinDCX app ({as_of})" + (
                "" if abs(drift) <= 0.02 else f"; you now hold {abs(drift):.0%} {'more' if drift > 0 else 'fewer'} coins than then, so it may be out of date")
        hold.append({"sym": sym, "kind": "crypto", "qty": qty, "avg_cost": avg, "account": "coindcx", "broker": "coindcx",
                     "ccy": "INR", "px_local": round(p_inr, 6), **({"cost_note": note} if note else {})})
    return hold, ignored, cash


# ---------------------------------------------------------------- sync and merge

def _status_update(broker, **kw):
    st = _json(STATUS, {}) or {}
    prev = st.get(broker, {})
    st[broker] = {**prev, **kw, "checked": _now()}
    BROKER_DIR.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps(st, indent=1))
    return st[broker]


def sync(broker, env=None):
    env = load_env() if env is None else env
    try:
        if broker == "groww":
            hold, ignored = parse_groww(groww_holdings_raw(env))
            extra = {}
        elif broker == "coindcx":
            hold, ignored, cash = parse_coindcx(coindcx_raw(env), usdinr())
            extra = {"cash_inr": round(cash, 2)}
        else:
            raise ValueError(f"unknown broker {broker}")
    except NeedsUser as e:
        return _status_update(broker, state=e.state, note=e.note)
    except PermissionError as e:
        return _status_update(broker, state="error", note=str(e))
    except (BrokerError, ValueError, KeyError, TypeError) as e:
        return _status_update(broker, state="error", note=_scrub(str(e))[:200])
    BROKER_DIR.mkdir(parents=True, exist_ok=True)
    (BROKER_DIR / f"{broker}.json").write_text(json.dumps({"synced": _now(), "broker": broker, "holdings": hold, "ignored": ignored, **extra}, indent=1))
    return _status_update(broker, state="ok", synced=_now(), holdings=len(hold), ignored=len(ignored),
                          note=f"{len(hold)} holdings" + (f", {len(ignored)} skipped" if ignored else ""))


def all_holdings():
    """Robinhood holdings (knowledge/portfolio.json) plus each broker's last good sync and the imported mutual funds."""
    pf = _json(KNOWLEDGE / "portfolio.json", {}) or {}
    out = [{**h, "broker": h.get("broker", "robinhood"), "ccy": h.get("ccy", "USD")} for h in pf.get("holdings", [])]
    for b in SOURCES:
        d = _json(BROKER_DIR / f"{b}.json")
        if d:
            out += d.get("holdings", [])
    return out


def accounts_status():
    """Connection state per broker for the page: never keys, only state, times and counts."""
    st = _json(STATUS, {}) or {}
    out = {}
    for b in SOURCES:
        s = st.get(b) or {"state": "not_set_up", "note": "Not connected yet."}
        d = _json(BROKER_DIR / f"{b}.json") or {}
        out[b] = {"label": LABELS[b], "state": s.get("state"), "note": s.get("note"), "checked": s.get("checked"),
                  "synced": d.get("synced"), "ignored": d.get("ignored", [])[:12], **({"cash_inr": d["cash_inr"]} if "cash_inr" in d else {}),
                  **({"statement": d["statement"].get("to")} if d.get("statement") else {}), **({"warnings": d["warnings"][:5]} if d.get("warnings") else {})}
    return out


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "status"
    ensure_template()
    if cmd == "sync":
        env = load_env()
        for b in (argv[1:] or BROKERS):
            s = sync(b, env)
            print(f"{LABELS[b]:8s} {s['state']}: {s.get('note', '')}")
    elif cmd == "status":
        env = load_env()
        have = {"groww": any(env.get(k) for k in ("GROWW_API_KEY", "GROWW_TOTP_KEY", "GROWW_ACCESS_TOKEN")),
                "coindcx": bool(env.get("COINDCX_API_KEY") and env.get("COINDCX_API_SECRET")),
                "mf": bool(env.get("CAS_PASSWORD"))}
        for b, s in accounts_status().items():
            keys = ("password saved" if have[b] else "no password saved") if b == "mf" else ("keys set" if have[b] else "keys missing")
            print(f"{LABELS[b]:12s} {keys} | {s['state']}: {s.get('note') or ''} | last good sync {s.get('synced') or 'never'}")
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
