import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { limited } from "@/lib/ratelimit";
import { sealingReady } from "@/lib/seal";
import { CLIENT_IDS } from "@/lib/mcp-catalog";
import { serverById } from "@/lib/mcp-servers";
import { discover, pkce, register } from "@/lib/mcp-oauth";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

// MCP connectors: list a user's connections and snapshots, save their AI-app preference, start a sign-in,
// and remove a connection. Tokens are sealed in the callback and never returned.

const PENDING = "mcp_oauth";

function sameSite(req: NextRequest) {
  const origin = req.headers.get("origin");
  return req.headers.get("x-ripple") === "1" && (!origin || new URL(origin).host === req.nextUrl.host);
}

export async function GET() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const [conns, snaps, prof] = await Promise.all([
    supabase.from("mcp_connections").select("id, server, status, note, tools, last_sync_at, sync_started_at, created_at"),
    supabase.from("mcp_snapshots").select("connection_id, tool, items, fetched_at"),
    supabase.from("profiles").select("ai_client").eq("id", user.id).maybeSingle(),
  ]);
  if (conns.error || snaps.error) return NextResponse.json({ error: "read failed" }, { status: 500 });
  return NextResponse.json({ connections: conns.data, snapshots: snaps.data, ai_client: prof.data?.ai_client ?? null, sealing: sealingReady() });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prefs"), ai_client: z.enum(CLIENT_IDS) }),
  z.object({ action: z.literal("start"), server: z.string().max(32) }),
  z.object({ action: z.literal("sync"), server: z.string().max(32) }),
]);

// the cloud pull (supabase/functions/mcp-sync); MCP_SYNC_URL points elsewhere only for local testing
const SYNC_URL = process.env.MCP_SYNC_URL ?? `${SUPABASE_URL}/functions/v1/mcp-sync`;

export async function POST(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  if (parsed.data.action === "prefs") {
    const { error } = await supabase.from("profiles").update({ ai_client: parsed.data.ai_client }).eq("id", user.id);
    if (error) return NextResponse.json({ error: "could not save" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "sync") {
    const server = parsed.data.server;
    if (!serverById(server)) return NextResponse.json({ error: "unknown source" }, { status: 400 });
    if (await limited(`mcpsync:${user.id}`, 30, 3600)) return NextResponse.json({ error: "too many syncs; try again later" }, { status: 429 });
    // the lock: false means a pull for this connection is already running, so nothing new starts
    const { data: claimed, error } = await supabase.rpc("claim_mcp_sync", { p_server: server });
    if (error) return NextResponse.json({ error: "could not start the sync" }, { status: 500 });
    if (!claimed) return NextResponse.json({ running: true });
    const { data: { session } } = await supabase.auth.getSession();
    try {
      const r = await fetch(`${SYNC_URL}/now`, {
        method: "POST", signal: AbortSignal.timeout(55_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${session?.access_token ?? ""}`, apikey: SUPABASE_KEY },
        body: JSON.stringify({ server }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `sync service answered ${r.status}`);
      return NextResponse.json({ ok: true, status: j.pulled?.[0]?.status ?? "ok" });
    } catch (e) {
      // if the pull never started, give the lock back so the next press works; a slow pull keeps it and clears it itself
      if (!(e instanceof Error && e.name === "TimeoutError")) await supabase.rpc("release_mcp_sync", { p_server: server });
      return NextResponse.json({ error: `Sync could not run: ${(e as Error).message}`.slice(0, 200) }, { status: 502 });
    }
  }

  if (await limited(`mcp:${user.id}`, 10, 3600)) return NextResponse.json({ error: "too many attempts; try again later" }, { status: 429 });
  if (!sealingReady()) return NextResponse.json({ error: "connections are not switched on yet" }, { status: 503 });
  const s = serverById(parsed.data.server);
  if (!s || !s.ripple) return NextResponse.json({ error: "this source cannot connect to Market Ripple" }, { status: 400 });
  const redirect_uri = `${req.nextUrl.origin}/api/mcp/callback`;
  try {
    const meta = await discover(s);
    const client = await register(meta, redirect_uri);
    const p = pkce();
    const auth = new URL(meta.authorization_endpoint);
    const scope = s.scope ?? meta.scopes?.join(" ");
    auth.search = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri, state: p.state,
      code_challenge: p.challenge, code_challenge_method: "S256", resource: meta.resource, ...(scope ? { scope } : {}),
    }).toString();
    const res = NextResponse.json({ url: auth.toString() });
    // only this browser, only the callback, for ten minutes
    res.cookies.set(PENDING, JSON.stringify({ server: s.id, state: p.state, verifier: p.verifier, redirect_uri, token_endpoint: meta.token_endpoint, resource: meta.resource, ...client, uid: user.id }), {
      httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/api/mcp/callback", maxAge: 600,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: `Could not start the ${s.name} sign-in: ${(e as Error).message}` }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const server = req.nextUrl.searchParams.get("server") ?? "";
  if (!serverById(server)) return NextResponse.json({ error: "unknown source" }, { status: 400 });
  const { error } = await supabase.rpc("remove_mcp_connection", { p_server: server });
  if (error) return NextResponse.json({ error: "could not remove it" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
