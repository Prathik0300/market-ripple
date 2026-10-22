import "server-only";
import { PREFIX, redis, withRedis } from "./redis";

// The change stream behind /api/stream. Two kinds of event:
//   world  {paths}       shared documents changed (found by checkWorld after a pipeline upload)
//   own    {key, v}      one of a user's own documents was saved (so their other tabs and devices refresh)
// With Redis they are Redis Streams (mr:events, mr:u:<user id>), trimmed to the last ~500 entries, so every server
// instance sees every event and a reconnecting browser can replay what it missed (Last-Event-ID). One poller per
// instance reads all the streams its open connections need in a single XREAD and fans out in memory, so Redis load does
// not grow with the number of open tabs. Without Redis the same thing runs inside this instance only.

export type StreamEvent = { id: string; type: "world" | "own"; paths?: string[]; key?: string; v?: number };
type Listener = (e: StreamEvent) => void;

const WORLD = `${PREFIX}events`;
const userStream = (uid: string) => `${PREFIX}u:${uid}`;
const POLL_MS = 1500;
const KEEP = 500;

// ------------------------------------------------------------------ publish
export async function publishWorld(paths: string[]) {
  await publish(WORLD, { type: "world", paths: JSON.stringify(paths.slice(0, 200)) });
}
export async function publishOwn(uid: string, key: string, v: number) {
  await publish(userStream(uid), { type: "own", key, v: String(v) });
}
async function publish(stream: string, fields: Record<string, string>) {
  await withRedis(async (r) => {
    await r.xAdd(stream, "*", fields, { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: KEEP } });
    if (stream !== WORLD) await r.expire(stream, 86_400);
  }, () => memPublish(stream, fields));
}

function parse(id: string, f: Record<string, string>): StreamEvent {
  return f.type === "world"
    ? { id, type: "world", paths: safeJson(f.paths) }
    : { id, type: "own", key: f.key, v: Number(f.v) };
}
const safeJson = (s?: string) => { try { return JSON.parse(s ?? "[]"); } catch { return []; } };

// ------------------------------------------------------------------ memory fallback
const memLog = new Map<string, { id: string; f: Record<string, string> }[]>();
let memSeq = 0;
function memPublish(stream: string, f: Record<string, string>) {
  const id = `${Date.now()}-${memSeq++}`;
  const log = memLog.get(stream) ?? [];
  log.push({ id, f });
  if (log.length > KEEP) log.shift();
  memLog.set(stream, log);
  for (const l of listeners.get(stream) ?? []) l(parse(id, f));
}
const after = (a: string, b: string) => {   // stream ids "ms-seq": is a later than b?
  const [am, as] = a.split("-").map(Number), [bm, bs] = b.split("-").map(Number);
  return am > bm || (am === bm && as > bs);
};

// ------------------------------------------------------------------ subscribe
const listeners = new Map<string, Set<Listener>>();
const cursors = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function latestId(stream: string) {
  return withRedis(async (r) => {
    const last = await r.xRevRange(stream, "+", "-", { COUNT: 1 });
    return last?.[0]?.id ?? "0-0";
  }, () => memLog.get(stream)?.at(-1)?.id ?? "0-0");
}

async function poll() {
  if (polling || !listeners.size) return;
  polling = true;
  try {
    const r = await redis();
    if (!r?.isReady) return;   // memory mode delivers on publish
    const streams = [...listeners.keys()].filter((s) => cursors.has(s)).map((key) => ({ key, id: cursors.get(key)! }));
    if (!streams.length) return;
    const res = (await r.xRead(streams, { COUNT: 100 })) as { name: string; messages: { id: string; message: Record<string, string> }[] }[] | null;
    for (const s of res ?? []) {
      for (const m of s.messages) {
        cursors.set(s.name, m.id);
        const e = parse(m.id, m.message);
        for (const l of listeners.get(s.name) ?? []) l(e);
      }
    }
  } catch {
    // Redis hiccup: the next tick tries again
  } finally {
    polling = false;
  }
}

async function attach(stream: string, l: Listener) {
  if (!listeners.has(stream)) {
    listeners.set(stream, new Set());
    cursors.set(stream, await latestId(stream));
  }
  listeners.get(stream)!.add(l);
  timer ??= setInterval(poll, POLL_MS);
}
function detach(stream: string, l: Listener) {
  const set = listeners.get(stream);
  set?.delete(l);
  if (set && !set.size) { listeners.delete(stream); cursors.delete(stream); }
  if (!listeners.size && timer) { clearInterval(timer); timer = null; }
}

// Events after the given ids (from a reconnecting browser), oldest first.
async function replay(stream: string, from: string): Promise<StreamEvent[]> {
  if (!from || from === "0-0") return [];
  return withRedis(async (r) => {
    const rows = await r.xRange(stream, "(" + from, "+", { COUNT: 100 });
    return (rows ?? []).map((m) => parse(m.id, m.message as Record<string, string>));
  }, () => (memLog.get(stream) ?? []).filter((m) => after(m.id, from)).map((m) => parse(m.id, m.f)));
}

// The ids the browser sends back are "<world id>~<own id>".
export type Cursor = { world: string; own: string };
export const encodeCursor = (c: Cursor) => `${c.world}~${c.own}`;
export function decodeCursor(s: string | null): Cursor | null {
  const m = s?.match(/^(\d+-\d+)~(\d+-\d+)$/);
  return m ? { world: m[1], own: m[2] } : null;
}

export async function subscribe(uid: string, from: Cursor | null, onEvent: (e: StreamEvent, c: Cursor) => void) {
  const own = userStream(uid);
  const cur: Cursor = { world: await latestId(WORLD), own: await latestId(own) };
  const missed = from ? [...(await replay(WORLD, from.world)), ...(await replay(own, from.own))] : [];
  const emit = (e: StreamEvent) => {
    // replayed events are older than the starting cursor: deliver them without moving it back
    if (e.type === "world") { if (after(e.id, cur.world)) cur.world = e.id; } else if (after(e.id, cur.own)) cur.own = e.id;
    onEvent(e, { ...cur });
  };
  const lw: Listener = emit, lo: Listener = emit;
  await attach(WORLD, lw);
  await attach(own, lo);
  for (const e of missed) emit(e);
  return { cursor: { ...cur }, close: () => { detach(WORLD, lw); detach(own, lo); } };
}
