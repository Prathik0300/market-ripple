import "server-only";
import { createClient } from "redis";

// One shared Redis connection per server instance, from REDIS_URL (redis:// locally, rediss:// for Upstash or Redis
// Cloud on Vercel). Redis holds only shared, non-personal data (world documents and their versions), rate-limit
// counters and the change stream; personal documents are never cached in it. Without REDIS_URL, or while Redis is
// unreachable, every caller falls back to this instance's memory, so the app keeps working, just less shared.

type Client = ReturnType<typeof createClient>;
const g = globalThis as unknown as { __mrRedis?: Promise<Client | null>; __mrRedisDownUntil?: number };

export const PREFIX = "mr:";

export function redis(): Promise<Client | null> {
  const url = process.env.REDIS_URL;
  if (!url) return Promise.resolve(null);
  if ((g.__mrRedisDownUntil ?? 0) > Date.now()) return Promise.resolve(null);
  if (!g.__mrRedis) {
    const c = createClient({
      url,
      socket: { connectTimeout: 2000, reconnectStrategy: (n) => (n > 5 ? false : Math.min(n * 200, 1000)) },
      disableOfflineQueue: true,   // a command while disconnected fails fast instead of waiting
    });
    c.on("error", () => {});       // logged once below; the fallback handles the rest
    g.__mrRedis = c.connect().then(() => c as Client, (e) => {
      console.warn("redis: unavailable, using memory (" + (e as Error).message + ")");
      g.__mrRedis = undefined;
      g.__mrRedisDownUntil = Date.now() + 30_000;   // retry after half a minute
      return null;
    });
  }
  return g.__mrRedis;
}

// Runs fn against Redis; on any Redis error (or no Redis) returns the fallback's result instead.
export async function withRedis<T>(fn: (r: Client) => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  const r = await redis();
  if (!r?.isReady) return fallback();
  try {
    return await fn(r);
  } catch {
    return fallback();
  }
}
