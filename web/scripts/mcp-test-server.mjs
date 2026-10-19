// A pretend broker MCP server on 127.0.0.1:8799, for checking the MCP connect flow end to end without a real
// account: OAuth 2.1 discovery, dynamic client registration, PKCE sign-in (an approve button), token refresh,
// and three tools over Streamable HTTP. Two read tools; place_order is there to prove Market Ripple refuses it.
// Development only; it holds everything in memory and fake data only.
//
//   node web/scripts/mcp-test-server.mjs
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`, RESOURCE = `${BASE}/mcp`;
const clients = new Map(), codes = new Map(), access = new Map(), refresh = new Map();
const rand = () => randomBytes(24).toString("base64url");
const calls = [];

const TOOLS = [
  { name: "get_positions", description: "Pretend positions", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_quote", description: "Pretend quote", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, annotations: { readOnlyHint: true } },
  { name: "place_order", description: "Pretend order (Market Ripple must never call this)", inputSchema: { type: "object", properties: {} } },
];
const POSITIONS = [
  { symbol: "AAPL", quantity: 12, average_cost: 181.2 },
  { symbol: "NVDA", quantity: 5, average_cost: 122.4 },
  { symbol: "BTC", quantity: 0.04, average_cost: 61000 },
];

function send(res, status, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(status, { "content-type": isStr ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });

function issue(client_id) {
  const at = rand(), rt = rand();
  access.set(at, { client_id, exp: Date.now() + 15 * 60_000 });
  refresh.set(rt, { client_id });
  return { access_token: at, token_type: "Bearer", expires_in: 900, refresh_token: rt };
}

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  if (p === "/.well-known/oauth-protected-resource/mcp" || p === "/.well-known/oauth-protected-resource")
    return send(res, 200, { resource: RESOURCE, authorization_servers: [BASE], scopes_supported: ["read"], bearer_methods_supported: ["header"] });
  if (p === "/.well-known/oauth-authorization-server")
    return send(res, 200, { issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (p === "/register" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (!Array.isArray(b.redirect_uris) || !b.redirect_uris.length) return send(res, 400, { error: "invalid_redirect_uri" });
    const client_id = "test-" + rand().slice(0, 10);
    clients.set(client_id, { redirect_uris: b.redirect_uris, name: b.client_name });
    return send(res, 201, { client_id, redirect_uris: b.redirect_uris, token_endpoint_auth_method: "none" });
  }
  if (p === "/authorize") {
    const q = url.searchParams, c = clients.get(q.get("client_id") ?? "");
    if (!c || !c.redirect_uris.includes(q.get("redirect_uri"))) return send(res, 400, "<p>Unknown client or redirect URI.</p>");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return send(res, 400, "<p>PKCE (S256) is required.</p>");
    const approve = new URL(`${BASE}/approve`); approve.search = q.toString();
    return send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width"><title>Test broker sign-in</title>
      <body style="font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px"><h1>Test broker</h1>
      <p><b>${String(c.name).replace(/[<>&]/g, "")}</b> wants to read your pretend positions.</p>
      <p><a id="approve" href="${approve}" style="display:inline-block;padding:10px 16px;background:#2453d1;color:#fff;border-radius:8px;text-decoration:none">Approve</a>
      <a id="deny" href="${q.get("redirect_uri")}?error=access_denied&state=${encodeURIComponent(q.get("state") ?? "")}" style="margin-left:12px">Deny</a></p></body>`);
  }
  if (p === "/approve") {
    const q = url.searchParams, code = rand();
    codes.set(code, { client_id: q.get("client_id"), redirect_uri: q.get("redirect_uri"), challenge: q.get("code_challenge"), exp: Date.now() + 60_000 });
    const back = new URL(q.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", q.get("state") ?? "");
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (p === "/token" && req.method === "POST") {
    const b = new URLSearchParams(await readBody(req));
    if (b.get("grant_type") === "authorization_code") {
      const c = codes.get(b.get("code") ?? ""); codes.delete(b.get("code") ?? "");
      if (!c || c.exp < Date.now() || c.client_id !== b.get("client_id") || c.redirect_uri !== b.get("redirect_uri")) return send(res, 400, { error: "invalid_grant" });
      const ch = createHash("sha256").update(b.get("code_verifier") ?? "").digest("base64url");
      if (ch !== c.challenge) return send(res, 400, { error: "invalid_grant", error_description: "PKCE check failed" });
      return send(res, 200, issue(c.client_id));
    }
    if (b.get("grant_type") === "refresh_token") {
      const r = refresh.get(b.get("refresh_token") ?? "");
      if (!r || r.client_id !== b.get("client_id")) return send(res, 400, { error: "invalid_grant" });
      refresh.delete(b.get("refresh_token"));       // rotate
      return send(res, 200, issue(r.client_id));
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }
  if (p === "/calls") return send(res, 200, calls.slice(-50));    // what clients called, for checking
  if (p === "/mcp" && req.method === "POST") {
    const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const a = access.get(tok);
    if (!a || a.exp < Date.now())
      return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` });
    const m = JSON.parse(await readBody(req));
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    const ok = (result) => send(res, 200, { jsonrpc: "2.0", id: m.id, result }, { "mcp-session-id": "test-session" });
    if (m.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-broker", version: "1" } });
    if (m.method === "tools/list") return ok({ tools: TOOLS });
    if (m.method === "tools/call") {
      // MCP_TEST_DELAY_MS slows tool calls, to watch a sync in progress
      await new Promise((r) => setTimeout(r, Number(process.env.MCP_TEST_DELAY_MS ?? 0)));
      calls.push({ tool: m.params?.name, ts: new Date().toISOString() });
      if (m.params?.name === "get_positions") return ok({ content: [{ type: "text", text: JSON.stringify({ positions: POSITIONS }) }], structuredContent: { positions: POSITIONS } });
      if (m.params?.name === "get_quote") return ok({ content: [{ type: "text", text: JSON.stringify({ symbol: m.params?.arguments?.symbol, price: 100 }) }] });
      if (m.params?.name === "place_order") return ok({ content: [{ type: "text", text: "PRETEND ORDER PLACED - a client called a write tool" }] });
      return send(res, 200, { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } });
    }
    return send(res, 200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`test MCP server on ${RESOURCE}`));
