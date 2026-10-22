import { CORS, protectedResource, publicOrigin } from "@/lib/platform-mcp";

// RFC 9728 protected-resource metadata for the platform MCP server. AI apps read it (at the bare path or with the
// resource path appended, /mcp) to find the authorization server: Supabase Auth's OAuth 2.1 server.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return new Response(JSON.stringify(protectedResource(publicOrigin(req))), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300", ...CORS },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
