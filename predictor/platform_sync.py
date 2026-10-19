"""Upload the shared world documents (out/db/*.json, written by predictor.export) to the platform's Supabase
database, so every signed-in user's desks read the same world model. Owner-only documents (owner/...) are never
uploaded: personal data reaches the platform only through each user's own connections.

Needs two lines in the private keys file (predictor.brokers.ENV_FILE), which only the owner edits:
    SUPABASE_URL=https://<project>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=<service role key from the Supabase dashboard>
The service role key stays on this Mac; the web app has only the publishable key.

    python -m predictor.platform_sync          # upload documents that changed since the last upload
    python -m predictor.platform_sync --all    # upload everything
"""
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from .brokers import _json, _scrub, load_env
from .config import KNOWLEDGE, OUT

DB_OUT = OUT / "db"
PUSHED = KNOWLEDGE / "platform_pushed.json"
BATCH_BYTES = 4_000_000


def _docs():
    for f in sorted(DB_OUT.glob("*__*.json")):
        coll, doc = f.stem.split("__", 1)
        if coll == "owner" or f.name.endswith("_batches.json"):
            continue
        yield f"{coll}/{doc}", f


def _post(base, key, rows):
    u = urllib.parse.urlsplit(base)
    if u.scheme != "https" and u.hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("SUPABASE_URL must be https")
    req = urllib.request.Request(base.rstrip("/") + "/rest/v1/world_docs?on_conflict=path", method="POST",
                                 data=json.dumps(rows).encode(),
                                 headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    env = load_env()
    base, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        print("platform: not set up (add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the keys file)")
        return 0
    record = _json(PUSHED, {}) or {}  # per database, so a local test never hides documents from the real upload
    pushed = {} if "--all" in argv else dict(record.get(base, {}))
    todo = []
    for path, f in _docs():
        raw = f.read_bytes()
        h = hashlib.sha256(raw).hexdigest()[:20]
        if pushed.get(path) != h:
            todo.append((path, f, raw, h))
    sent, batch, size = 0, [], 0
    try:
        for i, (path, f, raw, h) in enumerate(todo):
            batch.append((path, raw, h))
            size += len(raw)
            if size >= BATCH_BYTES or i == len(todo) - 1:
                _post(base, key, [{"path": p, "data": json.loads(r)} for p, r, _ in batch])
                for p, _, hh in batch:
                    pushed[p] = hh
                sent += len(batch)
                batch, size = [], 0
    except urllib.error.HTTPError as e:
        print(f"platform: upload failed (HTTP {e.code}: {_scrub(e.read()[:200].decode('utf-8', 'replace'))}); {sent} sent")
        return 1
    except urllib.error.URLError as e:
        print(f"platform: upload failed ({_scrub(str(e.reason))}); {sent} sent")
        return 1
    finally:
        record[base] = pushed
        PUSHED.write_text(json.dumps(record, indent=1, sort_keys=True))
    print(f"platform: {sent} documents uploaded, {len(pushed) - sent} unchanged")
    return _events(base, key, record)


EVENTS = KNOWLEDGE / "events.jsonl"
EVENT_FIELDS = ("id", "ts", "title", "summary", "url", "source", "region", "category", "scale", "nodes")


def _events(base, key, record):
    """The world-event log (for matching users' trades and big days to what happened), when it changed."""
    if not EVENTS.exists():
        return 0
    raw = EVENTS.read_bytes()
    h = hashlib.sha256(raw).hexdigest()[:20]
    mark = base + "#events"
    if record.get(mark) == h:
        return 0
    rows = [{k: e.get(k) for k in EVENT_FIELDS} for e in (json.loads(l) for l in raw.decode().splitlines() if l.strip()) if e.get("id") and e.get("ts")]
    try:
        for i in range(0, len(rows), 500):
            req = urllib.request.Request(base.rstrip("/") + "/rest/v1/events?on_conflict=id", method="POST", data=json.dumps(rows[i:i + 500]).encode(),
                                         headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                                  "Prefer": "resolution=merge-duplicates,return=minimal"})
            urllib.request.urlopen(req, timeout=120).close()
    except urllib.error.HTTPError as e:
        print(f"platform: event upload failed (HTTP {e.code})")
        return 1
    record[mark] = h
    PUSHED.write_text(json.dumps(record, indent=1, sort_keys=True))
    print(f"platform: {len(rows)} events uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
