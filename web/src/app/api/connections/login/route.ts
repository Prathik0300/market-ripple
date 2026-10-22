import { NextResponse, type NextRequest } from "next/server";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { limited } from "@/lib/ratelimit";
import { loginRedirect } from "@/lib/providers";

// Start a daily broker login: a one-time state (10 minutes) is stored against the user's own connection, and the
// broker sends the user back to the sync function, which exchanges the code at once.
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (req.headers.get("x-ripple") !== "1" || (origin && new URL(origin).host !== req.nextUrl.host)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (await limited(`login:${user.id}`, 20, 3600)) return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  const provider = (await req.json().catch(() => ({})))?.provider;
  if (provider !== "zerodha" && provider !== "upstox") return NextResponse.json({ error: "this platform has no daily login" }, { status: 400 });
  const { data: conn } = await supabase.from("connections").select("public_id").eq("provider", provider).maybeSingle();
  if (!conn?.public_id) return NextResponse.json({ error: "connect this platform first" }, { status: 400 });
  const { data: state, error } = await supabase.rpc("start_broker_login", { p_provider: provider });
  if (error || !state) return NextResponse.json({ error: "could not start the login" }, { status: 500 });
  const url = provider === "zerodha"
    ? `https://kite.zerodha.com/connect/login?${new URLSearchParams({ v: "3", api_key: conn.public_id, redirect_params: `state=${state}` })}`
    : `https://api.upstox.com/v2/login/authorization/dialog?${new URLSearchParams({ response_type: "code", client_id: conn.public_id, redirect_uri: loginRedirect("upstox"), state })}`;
  return NextResponse.json({ url });
}
