// The MCP pull, shared by the cloud function (index.ts) and a local test run under Node. Only fetch and
// WebCrypto, so it runs in Deno and Node alike.
//
// For every MCP connection: open the sealed tokens, refresh them when they are about to expire (re-sealing the
// new ones), then call only the catalog's pull tools, each of which must also be on the catalog's read list
// and on the server's own tool list. Anything else is refused before a request is made. What comes back is
// stored as the user's private snapshot; tool output is data and nothing in it is acted on.
import servers from "../_shared/mcp-servers.json" with { type: "json" };
import testServer from "../_shared/mcp-test-server.json" with { type: "json" };

type Server = { id: string; name: string; url: string; ripple: boolean; read: string[]; pulls: { tool: string; args?: Record<string, unknown>; label: string }[] };
type Conn = { id: string; user_id: string; server: string; status: string };
// deno-lint-ignore no-explicit-any
type Db = any;

const SERVERS = servers as Server[];
const UA = "MarketRipple/1.0 (research only)";
const MAX_SNAPSHOT = 200_000;

// ------------------------------------------------------------------ sealing (matches web/src/lib/seal.ts)
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ub64 = (a: Uint8Array) => { let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); };

export async function keyPair(pemText: string) {
  const pem = pemText.replace(/-----[^-]+-----|\s/g, "");
  if (!pem) throw new Error("CONNECTIONS_PRIVATE_KEY is not set");
  const priv = await crypto.subtle.importKey("pkcs8", b64(pem), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  return { priv, pub };
}
type Keys = Awaited<ReturnType<typeof keyPair>>;

async function unseal(keys: Keys, sealed: string): Promise<Record<string, string>> {
  const s = JSON.parse(sealed);
  if (s.v !== 1) throw new Error("unknown sealed format");
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keys.priv, b64(s.k));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const ct = new Uint8Array([...b64(s.ct), ...b64(s.tag)]);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(s.iv) }, aes, ct)));
}
async function seal(keys: Keys, fields: Record<string, string>) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(fields))));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, keys.pub, raw));
  return JSON.stringify({ v: 1, k: ub64(wrapped), iv: ub64(iv), ct: ub64(out.slice(0, -16)), tag: ub64(out.slice(-16)) });
}

// ------------------------------------------------------------------ requests
class NeedsUser extends Error {}

function safeUrl(raw: string, allowLoopback: boolean) {
  const u = new URL(raw);
  const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if ((u.protocol === "https:" && !loop) || (allowLoopback && loop)) return u;
  throw new Error(`refusing endpoint ${u.origin}`);
}

async function refresh(f: Record<string, string>, loop: boolean) {
  if (!f.refresh_token) throw new NeedsUser("The sign-in has expired; sign in again.");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: f.refresh_token, client_id: f.client_id, resource: f.resource });
  if (f.client_secret) body.set("client_secret", f.client_secret);
  const r = await fetch(safeUrl(f.token_endpoint, loop), { method: "POST", body, redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": UA } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new NeedsUser("The server did not renew the sign-in; sign in again.");
  return { ...f, access_token: String(j.access_token), refresh_token: j.refresh_token ? String(j.refresh_token) : f.refresh_token,
           expires_at: j.expires_in ? String(Math.floor(Date.now() / 1000) + Number(j.expires_in)) : "" };
}

class Mcp {
  sid: string | null = null;
  n = 0;
  url: URL;
  token: string;
  constructor(url: URL, token: string) { this.url = url; this.token = token; }
  async call(method: string, params?: unknown, notify = false) {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`, "user-agent": UA, "mcp-protocol-version": "2025-06-18" };
    if (this.sid) headers["mcp-session-id"] = this.sid;
    const id = ++this.n;
    const r = await fetch(this.url, { method: "POST", headers, redirect: "error",
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }) });
    if (r.status === 401) throw new NeedsUser("The server no longer accepts the sign-in; sign in again.");
    if (!r.ok && r.status !== 202) throw new Error(`${method} failed (${r.status})`);
    this.sid = r.headers.get("mcp-session-id") ?? this.sid;
    if (notify) return null;
    const text = await r.text();
    let msg = null;
    if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) if (line.startsWith("data:")) { const d = JSON.parse(line.slice(5)); if (d.id === id) { msg = d; break; } }
    } else msg = JSON.parse(text);
    if (!msg || msg.error) throw new Error(`${method}: ${String(msg?.error?.message ?? "no reply").slice(0, 120)}`);
    return msg.result;
  }
}

// the length of the first list in a tool's result, for the "N items" line
function countItems(v: unknown, depth = 0): number | null {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object" && depth < 3) for (const x of Object.values(v)) { const n = countItems(x, depth + 1); if (n !== null) return n; }
  return null;
}
function parseResult(res: { structuredContent?: unknown; content?: { type: string; text?: string }[] }) {
  if (res?.structuredContent) return res.structuredContent;
  const text = (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  try { return JSON.parse(text); } catch { return { text: text.slice(0, MAX_SNAPSHOT) }; }
}

// ------------------------------------------------------------------ one connection, then all
async function pullOne(db: Db, keys: Keys, c: Conn, sealed: string, loop: boolean) {
  // the pretend broker counts only in a local test run (loopback allowed); deployed, it is unknown
  const s = [...SERVERS, ...(loop ? (testServer as Server[]) : [])].find((x) => x.id === c.server && x.ripple);
  if (!s) return { status: "error", note: "This source is no longer in the catalog." };
  let f = await unseal(keys, sealed);
  if (!f.expires_at || Number(f.expires_at) < Date.now() / 1000 + 120) {
    f = await refresh(f, loop);
    await db.from("mcp_secrets").update({ sealed: await seal(keys, f), updated_at: new Date().toISOString() }).eq("connection_id", c.id);
  }
  const mcp = new Mcp(safeUrl(s.url, loop), f.access_token);
  await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "market-ripple", version: "1" } });
  await mcp.call("notifications/initialized", undefined, true);
  const offered = new Set<string>(((await mcp.call("tools/list", {}))?.tools ?? []).map((t: { name: string }) => t.name));
  const got: string[] = [], missing: string[] = [];
  for (const p of s.pulls) {
    // the allowlist: a pull runs only if it is a catalog read tool AND the server offers it
    if (!s.read.includes(p.tool)) throw new Error(`catalog error: ${p.tool} is not a read tool`);
    if (!offered.has(p.tool)) { missing.push(p.tool); continue; }
    const data = parseResult(await mcp.call("tools/call", { name: p.tool, arguments: p.args ?? {} }));
    let json = JSON.stringify(data);
    if (json.length > MAX_SNAPSHOT) json = JSON.stringify({ truncated: true, text: json.slice(0, MAX_SNAPSHOT) });
    await db.from("mcp_snapshots").upsert({ connection_id: c.id, user_id: c.user_id, tool: p.tool, items: countItems(data), data: JSON.parse(json), fetched_at: new Date().toISOString() });
    got.push(p.label);
  }
  return { status: "ok", note: `Read ${got.join(", ") || "nothing"}${missing.length ? `; not offered: ${missing.join(", ")}` : ""}.` };
}

const STALE_MS = 5 * 60_000;   // a lock older than this is from a run that died; matches claim_mcp_sync()

type RunOpts = { allowLoopback?: boolean; servers?: string[]; userId?: string; preclaimed?: boolean };

export async function runAll(db: Db, privatePem: string, opts: RunOpts = {}) {
  const keys = await keyPair(privatePem);
  const loop = !!opts.allowLoopback;
  let q = db.from("mcp_connections").select("id, user_id, server, status");
  if (opts.servers) q = q.in("server", opts.servers);
  if (opts.userId) q = q.eq("user_id", opts.userId);
  const { data: conns } = await q;
  const ids = ((conns ?? []) as Conn[]).map((c) => c.id);
  const { data: secrets } = ids.length ? await db.from("mcp_secrets").select("connection_id, sealed").in("connection_id", ids) : { data: [] };
  const sealed = new Map((secrets ?? []).map((r: { connection_id: string; sealed: string }) => [r.connection_id, r.sealed]));
  const out: { server: string; status: string }[] = [];
  for (const c of (conns ?? []) as Conn[]) {
    if (!opts.preclaimed) {
      // the scheduled run takes the same lock as Sync now, and skips a connection whose pull is already running
      const stale = new Date(Date.now() - STALE_MS).toISOString();
      const { data: got } = await db.from("mcp_connections").update({ sync_started_at: new Date().toISOString() })
        .eq("id", c.id).or(`sync_started_at.is.null,sync_started_at.lt.${stale}`).select("id");
      if (!got?.length) { out.push({ server: c.server, status: "running" }); continue; }
    }
    let res: { status: string; note: string };
    try {
      if (!sealed.has(c.id)) throw new NeedsUser("No sign-in stored; sign in again.");
      res = await pullOne(db, keys, c, sealed.get(c.id) as string, loop);
    } catch (e) {
      // never echo token material: only our own messages reach the user
      res = e instanceof NeedsUser ? { status: "needs_user", note: e.message } : { status: "error", note: `Pull failed: ${(e as Error).message}`.slice(0, 300) };
    }
    await db.from("mcp_connections").update({ status: res.status, note: res.note, sync_started_at: null,
      ...(res.status === "ok" ? { last_sync_at: new Date().toISOString() } : {}) }).eq("id", c.id);
    out.push({ server: c.server, status: res.status });
  }
  return out;
}

// Sync now: one user's one connection, right away. The caller is the user's own session token (checked here,
// two-factor required); the web app has already claimed the lock with claim_mcp_sync().
export async function runNow(db: Db, privatePem: string, userToken: string, server: string, opts: { allowLoopback?: boolean } = {}) {
  const { data, error } = await db.auth.getUser(userToken);
  if (error || !data?.user) return { status: 401, body: { error: "sign in first" } };
  const claims = JSON.parse(atob(userToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (claims.aal !== "aal2") return { status: 403, body: { error: "finish two-factor sign-in" } };
  if (!/^[a-z0-9-]{2,32}$/.test(server)) return { status: 400, body: { error: "unknown source" } };
  const pulled = await runAll(db, privatePem, { ...opts, servers: [server], userId: data.user.id, preclaimed: true });
  return { status: 200, body: { pulled } };
}
