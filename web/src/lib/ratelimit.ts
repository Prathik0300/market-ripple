// A small fixed-window limiter per server instance. It stops runaway clients; across many instances the
// effective limit is higher, so a shared store (for example Upstash Redis) replaces it before launch.
const hits = new Map<string, { n: number; reset: number }>();

export function limited(key: string, max: number, windowSec: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowSec * 1000 });
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > max;
}
