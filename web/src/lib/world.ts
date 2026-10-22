import "server-only";
import { PREFIX, withRedis } from "./redis";
import { publishWorld } from "./events";
import type { supabaseServer } from "./supabase/server";

// Read-through cache for the shared world documents (feed/latest, signals/latest, dossier/AAPL ...).
// They are the same for every signed-in user (RLS: any session that passed two-factor may read all of them), and they
// change only when the pipeline uploads, so they are safe to share across users once a caller is authenticated, and
// cheap to keep: one Redis GET instead of a database query. Callers must check the session before calling (the
// middleware enforces two-factor on every page and API route). Personal documents never come through here.
//
//   mr:w:<path>   {v, data}  the document (skipped when over MAX_BYTES)
//   mr:wv:<path>  version    small key for ETag checks without reading the document
// Both expire after TTL as a safety net; checkWorld() drops changed ones sooner and announces them on the stream.

type Supa = Awaited<ReturnType<typeof supabaseServer>>;
export type WorldEntry = { v: number; data: unknown };

const TTL = 900;
const MISSING_TTL = 120;  // a path with no document is remembered briefly, so the desks' probes do not each query
const MAX_BYTES = 4_000_000;
const CHECK_EVERY = 20;   // seconds between version checks, across all instances

const mem = new Map<string, WorldEntry & { exp: number; missing?: boolean }>();
const memV = new Map<string, number>();
function memGet(p: string) {
  const e = mem.get(p);
  if (!e || e.exp < Date.now()) return null;
  return e;
}
function memSet(p: string, e: WorldEntry, missing = false) {
  if (mem.size > 400) mem.delete(mem.keys().next().value!);   // oldest first
  mem.set(p, { ...e, missing, exp: Date.now() + (missing ? MISSING_TTL : TTL) * 1000 });
  if (!missing) memV.set(p, e.v);
}

const K = (p: string) => `${PREFIX}w:${p}`;
const KV = (p: string) => `${PREFIX}wv:${p}`;

export async function getWorldDocs(supabase: Supa, paths: string[]): Promise<Map<string, WorldEntry>> {
  const out = new Map<string, WorldEntry>();
  if (!paths.length) return out;
  const cached = await withRedis(async (r) => (await r.mGet(paths.map(K))) as (string | null)[], () => paths.map(() => null));
  const misses: string[] = [];
  paths.forEach((p, i) => {
    const hit = cached[i] ? (JSON.parse(cached[i]!) as WorldEntry & { missing?: boolean }) : memGet(p);
    if (!hit) misses.push(p);
    else if (!hit.missing) out.set(p, { v: hit.v, data: hit.data });
  });
  if (!misses.length) return out;

  const { data, error } = await supabase.from("world_docs").select("path, data, version").in("path", misses);
  if (error) throw new Error("world read failed");
  const rows = data ?? [];
  for (const row of rows) {
    const e = { v: row.version as number, data: row.data };
    out.set(row.path, e);
    memSet(row.path, e);
  }
  const absent = misses.filter((p) => !out.has(p));
  for (const p of absent) memSet(p, { v: 0, data: null }, true);
  await withRedis(async (r) => {
    const m = r.multi();
    for (const row of rows) {
      const s = JSON.stringify({ v: row.version, data: row.data });
      if (s.length <= MAX_BYTES) m.set(K(row.path), s, { EX: TTL });
      m.set(KV(row.path), String(row.version), { EX: TTL });
    }
    for (const p of absent) m.set(K(p), '{"v":0,"data":null,"missing":true}', { EX: MISSING_TTL });
    await m.exec();
  }, () => undefined);
  return out;
}

export async function getWorldDoc(supabase: Supa, path: string): Promise<WorldEntry | null> {
  return (await getWorldDocs(supabase, [path])).get(path) ?? null;
}

// The version last seen for a document, or null when not known (then the caller reads the document itself).
export function worldVersion(path: string): Promise<number | null> {
  return withRedis(async (r) => {
    const v = await r.get(KV(path));
    return v == null ? null : Number(v);
  }, () => (memGet(path) ? memV.get(path) ?? null : null));
}

// Compares every document's version with the ones last seen, drops the changed documents from the cache and announces
// them on the change stream. At most once per CHECK_EVERY seconds across all instances (a Redis lock), using the
// caller's session to read (versions only, never the documents). Called by the open event streams.
let lastLocal = 0;
export async function checkWorld(supabase: Supa): Promise<string[]> {
  const go = await withRedis(
    async (r) => (await r.set(`${PREFIX}lock:checkworld`, "1", { NX: true, EX: CHECK_EVERY })) === "OK",
    () => { if (Date.now() - lastLocal < CHECK_EVERY * 1000) return false; lastLocal = Date.now(); return true; },
  );
  if (!go) return [];
  const { data, error } = await supabase.from("world_docs").select("path, version");
  if (error || !data?.length) return [];
  const paths = data.map((d) => d.path as string);
  const seen = await withRedis(async (r) => (await r.mGet(paths.map(KV))) as (string | null)[],
    () => paths.map((p) => (memV.has(p) ? String(memV.get(p)) : null)));
  const changed = data.filter((d, i) => seen[i] != null && Number(seen[i]) !== d.version).map((d) => d.path as string);
  for (const p of changed) mem.delete(p);
  data.forEach((d) => memV.set(d.path, d.version));
  await withRedis(async (r) => {
    const m = r.multi();
    for (const p of changed) m.del(K(p));
    for (const d of data) m.set(KV(d.path), String(d.version), { EX: TTL });
    await m.exec();
  }, () => undefined);
  if (changed.length) await publishWorld(changed);
  return changed;
}
