import "server-only";
import { PREFIX, withRedis } from "./redis";

// Fixed-window limiter. With Redis the window is shared by every server instance (INCR + EXPIRE on first hit);
// without it each instance counts on its own, which still stops runaway clients.
const hits = new Map<string, { n: number; reset: number }>();

function local(key: string, max: number, windowSec: number): boolean {
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

export function limited(key: string, max: number, windowSec: number): Promise<boolean> {
  return withRedis(async (r) => {
    const k = `${PREFIX}rl:${key}`;
    const [n] = (await r.multi().incr(k).expire(k, windowSec, "NX").exec()) as unknown as [number, number];
    return Number(n) > max;
  }, () => local(key, max, windowSec));
}
