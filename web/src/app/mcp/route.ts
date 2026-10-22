import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { SPECS } from "@/lib/assistant/context";
import { MCP_INSTRUCTIONS } from "@/lib/assistant/rules";
import { limited } from "@/lib/ratelimit";
import { CORS, metadataUrl, publicOrigin } from "@/lib/platform-mcp";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

// The platform MCP server (Streamable HTTP, stateless). A person's own AI app connects here with an OAuth access
// token from Supabase Auth, issued after they approved the app on /oauth/consent with two-factor sign-in. Every
// query runs as that person through the publishable key and their token, so row-level security (read_ok) decides
// what comes back; the tools are read-only and the token cannot write anything. No Anthropic key is involved: the
// person's own AI app does the thinking.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(req: Request, error: "invalid_request" | "invalid_token", description: string) {
  const challenge = `Bearer resource_metadata="${metadataUrl(publicOrigin(req))}"` +
    (error === "invalid_token" ? `, error="invalid_token", error_description="${description}"` : "");
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": challenge, ...CORS },
  });
}

async function handle(req: Request): Promise<Response> {
  const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return unauthorized(req, "invalid_request", "Sign in to Market Ripple to use these tools");

  const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // signature, expiry and issuer checked against the project's signing keys
  // (a malformed token makes getClaims throw rather than return an error)
  const { data, error } = await db.auth.getClaims(token).catch((e: unknown) => ({ data: null, error: e }));
  const claims = data?.claims as { sub?: string; client_id?: string } | undefined;
  // only OAuth tokens (issued to an approved AI app) are accepted here, not browser session tokens
  if (error || !claims?.sub || !claims.client_id) return unauthorized(req, "invalid_token", "Token is not valid for Market Ripple");
  // the app's session must still exist: revoking the app in Market Ripple ends it at once
  const { data: ok } = await db.rpc("read_ok");
  if (ok !== true) return unauthorized(req, "invalid_token", "Access was revoked or has expired");
  const uid = claims.sub;
  if (await limited(`mcp:${uid}`, 120, 60)) {
    return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60", ...CORS } });
  }

  const server = new McpServer({ name: "market-ripple", title: "Market Ripple", version: "1.0.0" }, { instructions: MCP_INSTRUCTIONS });
  const memo = new Map<string, unknown>();
  for (const spec of SPECS) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.shape, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      async (args: Record<string, unknown>) => {
        const r = await spec.run(db, uid, args ?? {}, memo);
        return { content: [{ type: "text" as const, text: r.text }], isError: r.error ?? false };
      },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  headers.set("cache-control", "private, no-store");
  return new Response(res.body, { status: res.status, headers });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
