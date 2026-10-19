import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "./mcp-catalog";

// The MCP authorization flow (OAuth 2.1): find the server's sign-in server from its protected-resource
// metadata, register Market Ripple as a public client, send the user there with PKCE, and swap the code for
// tokens. Only catalog servers are ever contacted, and every discovered endpoint must be https (loopback only
// in development), so a server's metadata cannot point this code at an internal address.

const UA = "MarketRipple/1.0 (research only)";
const dev = process.env.NODE_ENV === "development";

function safeUrl(raw: unknown): URL {
  if (typeof raw !== "string") throw new Error("missing endpoint");
  const u = new URL(raw);
  const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol === "https:" && !loop) return u;
  if (dev && loop) return u;
  throw new Error(`refusing endpoint ${u.origin}`);
}

async function getJson(url: string) {
  const r = await fetch(safeUrl(url), { headers: { accept: "application/json", "user-agent": UA }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

function wellKnown(base: string, name: string) {
  const u = new URL(base);
  const path = u.pathname.replace(/\/$/, "");
  return [`${u.origin}/.well-known/${name}${path}`, `${u.origin}/.well-known/${name}`];
}

export type AuthMeta = {
  authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string;
  code_challenge_methods_supported?: string[]; resource: string; scopes?: string[];
};

export async function discover(s: McpServer): Promise<AuthMeta> {
  // 1. the server says where its metadata is in WWW-Authenticate; fall back to the well-known paths
  let prmUrl: string | undefined;
  const probe = await fetch(safeUrl(s.url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "market-ripple", version: "1" } } }),
  }).catch(() => null);
  const m = probe?.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/);
  if (m) prmUrl = m[1];
  let prm = prmUrl ? await getJson(prmUrl) : null;
  for (const u of prm ? [] : wellKnown(s.url, "oauth-protected-resource")) if (!prm) prm = await getJson(u);
  const asBase: string = prm?.authorization_servers?.[0] ?? new URL(s.url).origin;
  // 2. the sign-in server's own metadata
  let as = null;
  for (const u of [...wellKnown(asBase, "oauth-authorization-server"), ...wellKnown(asBase, "openid-configuration")]) {
    if (!as) as = await getJson(u);
  }
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error("the server publishes no sign-in details");
  safeUrl(as.authorization_endpoint); safeUrl(as.token_endpoint);
  if (as.registration_endpoint) safeUrl(as.registration_endpoint);
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes("S256")) throw new Error("the server does not support PKCE");
  return { ...as, resource: prm?.resource ?? s.url, scopes: prm?.scopes_supported };
}

export async function register(meta: AuthMeta, redirectUri: string) {
  if (!meta.registration_endpoint) throw new Error("the server does not let new apps register");
  const r = await fetch(safeUrl(meta.registration_endpoint), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
    body: JSON.stringify({
      client_name: "Market Ripple (read-only research)", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.client_id) throw new Error(`registration refused (${r.status})`);
  return { client_id: String(j.client_id), client_secret: j.client_secret ? String(j.client_secret) : undefined };
}

const b64u = (b: Buffer) => b.toString("base64url");
export function pkce() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()), state: b64u(randomBytes(16)) };
}

export async function exchange(p: { token_endpoint: string; code: string; verifier: string; redirect_uri: string; client_id: string; client_secret?: string; resource: string }) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirect_uri, client_id: p.client_id, code_verifier: p.verifier, resource: p.resource });
  if (p.client_secret) body.set("client_secret", p.client_secret);
  const r = await fetch(safeUrl(p.token_endpoint), {
    method: "POST", redirect: "error", body, signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": UA },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new Error(`sign-in was not accepted (${r.status}${j?.error ? ": " + String(j.error).slice(0, 60) : ""})`);
  return { access_token: String(j.access_token), refresh_token: j.refresh_token ? String(j.refresh_token) : undefined,
           expires_at: j.expires_in ? Math.floor(Date.now() / 1000) + Number(j.expires_in) : undefined };
}

// One JSON-RPC call over MCP Streamable HTTP; the reply may be plain JSON or a server-sent event stream.
async function rpc(url: string, token: string, session: string | null, id: number | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "user-agent": UA, "mcp-protocol-version": "2025-06-18" };
  if (session) headers["mcp-session-id"] = session;
  const r = await fetch(safeUrl(url), { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(20_000),
    body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }) });
  if (!r.ok && r.status !== 202) throw new Error(`${method} failed (${r.status})`);
  const sid = r.headers.get("mcp-session-id") ?? session;
  if (id === null) return { sid, result: null };
  const text = await r.text();
  let msg = null;
  if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const d = JSON.parse(line.slice(5));
      if (d.id === id) { msg = d; break; }
    }
  } else msg = JSON.parse(text);
  if (!msg || msg.error) throw new Error(`${method}: ${msg?.error?.message ?? "no reply"}`);
  return { sid, result: msg.result };
}

// The server's tool names, read once right after sign-in so the page can show what is allowed and what is
// refused. The token is used here and then only sealed; it is never stored in the clear.
export async function listTools(url: string, token: string): Promise<string[]> {
  const init = await rpc(url, token, null, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "market-ripple", version: "1" } });
  await rpc(url, token, init.sid, null, "notifications/initialized");
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { result } = await rpc(url, token, init.sid, 2 + page, "tools/list", cursor ? { cursor } : {});
    for (const t of result?.tools ?? []) if (typeof t?.name === "string") names.push(t.name.slice(0, 80));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return names.slice(0, 300);
}
