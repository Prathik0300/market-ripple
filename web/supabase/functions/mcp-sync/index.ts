// Market Ripple MCP pull: every 2 hours (pg_cron, header x-sync-secret checked against Vault, the same secret
// as the broker sync) it reads each user's MCP connections through their official MCP servers, read tools only.
// The tokens are unsealed only here, with the platform private key (secret CONNECTIONS_PRIVATE_KEY).
//
//   POST /mcp-sync/run                 the schedule
//   POST /mcp-sync/now {server}        Sync now from the Connectors page, with the user's own session token
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { runAll, runNow } from "./core.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/mcp-sync/, "");
  try {
    if (req.method === "POST" && path === "/run") {
      const { data: expected } = await db.rpc("sync_secret");
      const got = req.headers.get("x-sync-secret") ?? "";
      if (!expected || got.length !== String(expected).length || got !== expected) return new Response("forbidden", { status: 403 });
      return Response.json({ pulled: await runAll(db, Deno.env.get("CONNECTIONS_PRIVATE_KEY") ?? "") });
    }
    if (req.method === "POST" && path === "/now") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const body = await req.json().catch(() => ({}));
      const r = await runNow(db, Deno.env.get("CONNECTIONS_PRIVATE_KEY") ?? "", token, String(body?.server ?? ""));
      return Response.json(r.body, { status: r.status });
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    console.error("mcp-sync error", e instanceof Error ? e.message : e);
    return new Response("mcp sync failed", { status: 500 });
  }
});
