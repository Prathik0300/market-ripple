import "server-only";
import { SUPABASE_URL } from "@/lib/supabase/env";

// The platform MCP server's public addresses. A person adds `${origin}/mcp` to their AI app; the app finds the
// authorization server through the protected-resource metadata (RFC 9728) and signs in with Supabase Auth's
// OAuth 2.1 server (dynamic client registration + PKCE), approving on our /oauth/consent page.
export const MCP_PATH = "/mcp";
export const AUTH_ISSUER = `${SUPABASE_URL}/auth/v1`;

export const resourceUrl = (origin: string) => `${origin}${MCP_PATH}`;
export const metadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

export function protectedResource(origin: string) {
  return {
    resource: resourceUrl(origin),
    resource_name: "Market Ripple",
    authorization_servers: [AUTH_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email"],
  };
}

// The public origin behind Vercel's proxy (or the dev server)
export function publicOrigin(req: Request): string {
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

// Bearer-token endpoints carry no cookies, so any origin may call them (browser-based MCP clients and inspectors)
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
};
