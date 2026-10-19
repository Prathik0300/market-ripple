"""The live event log: add newly found world events, list recent ones, and compute "event pressure".

Event pressure passes each recent event through the map's links (using the weights measured by
calibrate.py where available) and decays it with age, so a three-day-old minor event counts for less than
a major one from this morning. It is a structured summary of the news, not a price forecast; once the log
has a few months of history, calibrate.py can test whether it adds anything to the model.

    python -m predictor.events add out/new_events.json     # validate, de-duplicate, append
    python -m predictor.events recent --hours 48           # titles already logged (for de-duplication)
    python -m predictor.events pressure                    # top nodes under event pressure now
    python -m predictor.events nodes                       # valid node ids and labels

Event JSON (a list of objects):
  {"title": str, "summary": str, "ts": "2026-10-14T18:00:00Z", "region": str, "category": str,
   "scale": "minor" | "notable" | "major", "url": str, "source": str,
   "nodes": [{"id": "brent", "dir": 1, "why": "short reason"}]}
"""
import argparse
import hashlib
import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone

from .config import EVENTS_FILE, GRAPH_FILE, KNOWLEDGE

SCALE = {"minor": 0.3, "notable": 0.6, "major": 1.0}
CATEGORIES = {"conflict", "energy", "metals", "agriculture", "trade-policy", "central-bank", "election", "supply-chain",
              "sanctions", "weather", "tech", "crypto", "corporate", "macro-data", "regulation", "other"}
HALF_LIFE_DAYS = 3.0
WINDOW_DAYS = 14


def _now():
    return datetime.now(timezone.utc)


def _parse_ts(s):
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def graph():
    return json.loads(GRAPH_FILE.read_text())


def load_events():
    if not EVENTS_FILE.exists():
        return []
    out = []
    for line in EVENTS_FILE.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _norm_words(t):
    return set(w for w in re.findall(r"[a-z0-9]+", t.lower()) if len(w) > 2)


def _similar(a, b):
    wa, wb = _norm_words(a), _norm_words(b)
    if not wa or not wb:
        return False
    return len(wa & wb) / min(len(wa), len(wb)) >= 0.75


def add(path):
    g = graph()
    ids = {n[0] for n in g["nodes"]}
    raw = json.loads(open(path).read())
    if isinstance(raw, dict):
        raw = raw.get("events", [])
    existing = load_events()
    seen_ids = {e["id"] for e in existing}
    recent = [e for e in existing if (_parse_ts(e.get("ts")) or _now()) > _now() - timedelta(days=5)]
    added, skipped = [], []
    for ev in raw:
        title = str(ev.get("title", "")).strip()
        url = str(ev.get("url", "")).strip()
        if not title:
            skipped.append(("no title", ev))
            continue
        nodes = []
        for n in ev.get("nodes", []):
            nid = str(n.get("id", ""))
            if nid in ids:
                nodes.append({"id": nid, "dir": 1 if float(n.get("dir", 1)) >= 0 else -1, "why": str(n.get("why", ""))[:200]})
        if not nodes:
            skipped.append(("no valid node ids", title))
            continue
        eid = hashlib.sha1((url or title).lower().encode()).hexdigest()[:12]
        if eid in seen_ids or any(_similar(title, e["title"]) for e in recent + added):
            skipped.append(("duplicate", title))
            continue
        ts = _parse_ts(ev.get("ts")) or _now()
        scale = ev.get("scale") if ev.get("scale") in SCALE else "minor"
        cat = ev.get("category") if ev.get("category") in CATEGORIES else "other"
        rec = {"id": eid, "ts": ts.isoformat().replace("+00:00", "Z"), "logged": _now().isoformat().replace("+00:00", "Z"),
               "title": title[:200], "summary": str(ev.get("summary", ""))[:600], "region": str(ev.get("region", ""))[:60],
               "category": cat, "scale": scale, "url": url[:500], "source": str(ev.get("source", ""))[:80], "nodes": nodes[:6]}
        added.append(rec)
        seen_ids.add(eid)
    if added:
        KNOWLEDGE.mkdir(exist_ok=True)
        with EVENTS_FILE.open("a") as f:
            for rec in added:
                f.write(json.dumps(rec) + "\n")
    print(json.dumps({"added": len(added), "skipped": len(skipped), "total": len(existing) + len(added),
                      "skipped_reasons": [s[0] + ": " + (s[1] if isinstance(s[1], str) else str(s[1])[:80]) for s in skipped]}, indent=1))
    return added


def recent(hours=48):
    cut = _now() - timedelta(hours=hours)
    for e in load_events():
        t = _parse_ts(e.get("ts"))
        if t and t > cut:
            print(f"{e['ts'][:16]}  [{e['scale']}] {e['title']}")


def learned_weights():
    p = KNOWLEDGE / "edges_learned.json"
    if not p.exists():
        return {}
    return {(e["s"], e["t"]): e["w"] for e in json.loads(p.read_text())["edges"]}


def propagate(seeds, g=None, weights=None):
    """seeds: list of (node, value). Returns {node: pressure} using noisy-OR path combination, as the map does."""
    g = g or graph()
    weights = weights if weights is not None else learned_weights()
    out_edges = {}
    for s, t, sign, w, *_ in g["edges"]:
        out_edges.setdefault(s, []).append((t, sign, weights.get((s, t), w)))
    pos, neg = {}, {}

    def walk(nid, val, path):
        if len(path) > 4:
            return
        for t, sign, w in out_edges.get(nid, []):
            if t in path:
                continue
            v = val * sign * w * (0.85 if len(path) > 1 else 1)
            if abs(v) < 0.03:
                continue
            if v > 0:
                pos[t] = 1 - (1 - pos.get(t, 0)) * (1 - min(v, 1))
            else:
                neg[t] = 1 - (1 - neg.get(t, 0)) * (1 - min(-v, 1))
            walk(t, v, path + [t])

    for nid, val in seeds:
        pos_or_neg = pos if val > 0 else neg
        pos_or_neg[nid] = 1 - (1 - pos_or_neg.get(nid, 0)) * (1 - min(abs(val), 1))
        walk(nid, val, [nid])
    keys = set(pos) | set(neg)
    return {k: round(pos.get(k, 0) - neg.get(k, 0), 3) for k in keys}


def pressure(window_days=WINDOW_DAYS):
    now = _now()
    seeds = []
    for e in load_events():
        t = _parse_ts(e.get("ts"))
        if not t or t < now - timedelta(days=window_days):
            continue
        age = max((now - t).total_seconds() / 86400, 0)
        mag = SCALE.get(e.get("scale"), 0.3) * math.pow(0.5, age / HALF_LIFE_DAYS)
        for n in e["nodes"]:
            seeds.append((n["id"], n["dir"] * mag))
    # combine seeds on the same node before propagating
    agg = {}
    for nid, v in seeds:
        agg[nid] = agg.get(nid, 0) + v
    # halve before propagating so one fresh major event reads as strong, not saturated
    combined = [(k, max(-1.0, min(1.0, 0.5 * v))) for k, v in agg.items() if abs(0.5 * v) >= 0.03]
    return propagate(combined) if combined else {}


def per_event_pressure(window_days=WINDOW_DAYS):
    """Pressure from each recent event on its own, so a stock's score can be traced back to the events behind it."""
    now = _now()
    g, weights = graph(), learned_weights()
    out = []
    for e in load_events():
        t = _parse_ts(e.get("ts"))
        if not t or t < now - timedelta(days=window_days):
            continue
        age = max((now - t).total_seconds() / 86400, 0)
        mag = 0.5 * SCALE.get(e.get("scale"), 0.3) * math.pow(0.5, age / HALF_LIFE_DAYS)
        seeds = [(n["id"], n["dir"] * mag) for n in e["nodes"]]
        out.append((e, propagate(seeds, g, weights)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("path")
    r = sub.add_parser("recent")
    r.add_argument("--hours", type=int, default=48)
    sub.add_parser("pressure")
    sub.add_parser("nodes")
    args = ap.parse_args(argv)
    if args.cmd == "add":
        add(args.path)
    elif args.cmd == "recent":
        recent(args.hours)
    elif args.cmd == "pressure":
        p = pressure()
        labels = {n[0]: n[2] for n in graph()["nodes"]}
        for k, v in sorted(p.items(), key=lambda kv: -abs(kv[1]))[:25]:
            print(f"{v:+.2f}  {labels.get(k, k)}")
    elif args.cmd == "nodes":
        for n in graph()["nodes"]:
            print(f"{n[0]:16s} {n[2]}")


if __name__ == "__main__":
    sys.exit(main())
