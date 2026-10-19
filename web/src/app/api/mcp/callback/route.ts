import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { seal } from "@/lib/seal";
import { serverById } from "@/lib/mcp-servers";
import { exchange, listTools } from "@/lib/mcp-oauth";

// The sign-in server sends the user back here with a code. Swap it for tokens (PKCE), read the tool list once,
// seal the tokens for the pipeline and store only the sealed envelope.

const PENDING = "mcp_oauth";

function back(req: NextRequest, server: string, msg: string, ok: boolean) {
  const u = new URL("/connectors", req.nextUrl.origin);
  u.searchParams.set(ok ? "ok" : "err", msg.slice(0, 200));
  u.hash = server;
  const res = NextResponse.redirect(u, 303);
  res.cookies.set(PENDING, "", { path: "/api/mcp/callback", maxAge: 0 });
  return res;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function GET(req: NextRequest) {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  let p;
  try { p = JSON.parse(req.cookies.get(PENDING)?.value ?? ""); } catch { return back(req, "", "The sign-in expired; start it again.", false); }
  const s = serverById(p?.server ?? "");
  const q = req.nextUrl.searchParams;
  if (!s || p.uid !== user.id || !same(String(q.get("state") ?? ""), String(p.state))) return back(req, "", "The sign-in did not match; start it again.", false);
  if (q.get("error")) return back(req, s.id, `${s.name} said: ${q.get("error_description") ?? q.get("error")}`, false);
  const code = q.get("code");
  if (!code) return back(req, s.id, "No sign-in code came back.", false);

  try {
    const tok = await exchange({ token_endpoint: p.token_endpoint, code, verifier: p.verifier, redirect_uri: p.redirect_uri, client_id: p.client_id, client_secret: p.client_secret, resource: p.resource });
    const tools = await listTools(s.url, tok.access_token).catch(() => [] as string[]);
    const allowed = tools.filter((t) => s.read.includes(t));
    const sealed = seal({
      access_token: tok.access_token, refresh_token: tok.refresh_token ?? "", expires_at: String(tok.expires_at ?? ""),
      client_id: p.client_id, client_secret: p.client_secret ?? "", token_endpoint: p.token_endpoint, resource: p.resource,
    });
    const note = tools.length
      ? `Signed in. ${allowed.length} of ${tools.length} tools are read tools Market Ripple may call; ${tools.length - allowed.length} refused. First pull within two hours.`
      : "Signed in. First pull within two hours.";
    const { error } = await supabase.rpc("add_mcp_connection", { p_server: s.id, p_sealed: sealed, p_tools: tools, p_note: note });
    if (error) return back(req, s.id, "Could not save the connection.", false);
    return back(req, s.id, `${s.name} connected and sealed.`, true);
  } catch (e) {
    return back(req, s.id, (e as Error).message, false);
  }
}
