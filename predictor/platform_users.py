"""Platform users' portfolio reports: run the shared world model over each user's own holdings.

Syncing happens in the cloud (web/supabase/functions/sync), the only place users' broker keys are unsealed; it
stores each connection's holdings and trades. This job, on the owner's Mac, reads those holdings with the service
role and builds the same portfolio report the owner gets (trend, what moves each holding, odds, the biggest up and
down days with the world events and factor shocks behind them) as each user's private report, which their
Portfolio desk reads. It never sees a key; every row it writes carries that user's own id.

    python -m predictor.platform_users          # rebuild every user's report
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

from . import brokers as B
from .brokers import load_env

LABEL = {"groww": "Groww", "coindcx": "CoinDCX", "zerodha": "Zerodha", "upstox": "Upstox", "binance": "Binance", "cams": "Mutual funds"}


class Rest:
    def __init__(self, base, key):
        u = urllib.parse.urlsplit(base)
        if u.scheme != "https" and u.hostname not in ("127.0.0.1", "localhost"):
            raise SystemExit("SUPABASE_URL must be https")
        self.base, self.key = base.rstrip("/"), key

    def __call__(self, method, path, body=None, prefer=None):
        req = urllib.request.Request(self.base + "/rest/v1/" + path, method=method,
                                     data=None if body is None else json.dumps(body, default=float).encode(),
                                     headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json",
                                              **({"Prefer": prefer} if prefer else {})})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
        return json.loads(raw) if raw else None


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def main(argv=None):
    env = load_env()
    base, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        print("platform users: not set up (Supabase lines in the keys file)")
        return 0
    rest = Rest(base, key)
    # syncing is done in the cloud (web/supabase/functions/sync); this Mac never opens users' keys
    conns = rest("GET", "connections?select=id,user_id,provider,status,note,last_sync_at") or []
    status = defaultdict(dict)
    for c in conns:
        status[c["user_id"]][c["provider"]] = {"label": LABEL.get(c["provider"], c["provider"]),
                                              "state": {"ok": "ok", "needs_user": "needs_token", "pending": "not_set_up"}.get(c["status"], "error"),
                                              "note": c.get("note"), "synced": c.get("last_sync_at")}

    # one report per user, from everything their connections hold (last good sync where today's failed)
    from .export import slim_report
    from .fetch import load_prices
    from .portfolio import build_report
    rows = rest("GET", "holdings?select=user_id,connection_id,sym,kind,qty,avg_cost,ccy,price_local,name") or []
    prov = {c["id"]: c["provider"] for c in conns}
    by_user = defaultdict(list)
    for r in rows:
        p = prov.get(r["connection_id"], "groww")
        by_user[r["user_id"]].append({"sym": r["sym"], "kind": r["kind"], "qty": float(r["qty"]), "avg_cost": float(r["avg_cost"]) if r["avg_cost"] is not None else None,
                                      "account": p, "broker": p, "ccy": r["ccy"], **({"name": r["name"]} if r.get("name") else {}), **({"px_local": float(r["price_local"])} if r["price_local"] is not None and p in ("coindcx", "binance") else {})})
    # uploaded fund statements: today's AMFI NAV and the NAV history, as for the owner's own funds
    funds = {h["sym"][3:] for hold in by_user.values() for h in hold if h["sym"].startswith("MF_")}
    if funds:
        from . import mutualfunds as MF
        by_code, _ = MF.amfi_navs()
        for hold in by_user.values():
            for h in hold:
                if not h["sym"].startswith("MF_"):
                    continue
                code = h["amfi"] = h["sym"][3:]
                nav = by_code.get(code)
                if nav:
                    h.update({"px_local": nav["nav"], "nav_date": nav["date"], "name": nav["name"] or h.get("name"), "plan": nav["plan"], "option": nav["option"]})
        for code in funds:
            MF.history(code, by_code.get(code))
    built = 0
    for uid, hold in by_user.items():
        hold = [h for h in hold if (load_prices(h["sym"]) is not None if h["sym"].startswith("MF_") else B._has_history(h["sym"]))]  # skip anything with no price history
        if not hold:
            continue
        try:
            report = slim_report(build_report(hold, "Connected platforms (read-only APIs)", brokers=status.get(uid, {})), _now())
        except Exception as e:  # one user's odd holding must not stop everyone else's report
            print(f"  report for user …{uid[-4:]} failed: {e}")
            continue
        rest("POST", "user_reports?on_conflict=user_id,kind", [{"user_id": uid, "kind": "portfolio", "data": report, "updated_at": _now()}],
             prefer="resolution=merge-duplicates,return=minimal")
        built += 1
    # users who removed every connection lose their report too
    for r in rest("GET", "user_reports?select=user_id&kind=eq.portfolio") or []:
        if r["user_id"] not in by_user:
            rest("DELETE", f"user_reports?user_id=eq.{r['user_id']}&kind=eq.portfolio")
    print(f"platform users: {len(conns)} connections, {built} reports built")
    return 0


if __name__ == "__main__":
    sys.exit(main())
