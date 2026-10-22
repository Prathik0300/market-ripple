import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";

// The AI apps a person connected to the platform MCP server, and disconnecting one (which ends its sessions).

async function session() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  return { supabase, ok: !!user && user.aal === "aal2" };
}

export async function GET() {
  const { supabase, ok } = await session();
  if (!ok) return NextResponse.json({ error: "finish two-factor sign-in" }, { status: 403 });
  const { data, error } = await supabase.auth.oauth.listGrants();
  if (error) return NextResponse.json({ error: "read failed" }, { status: 500 });
  return NextResponse.json({ apps: (data ?? []).map((g) => ({ id: g.client.id, name: g.client.name, granted_at: g.granted_at })) });
}

export async function DELETE(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (req.headers.get("x-ripple") !== "1" || (origin && new URL(origin).host !== req.nextUrl.host)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  const { supabase, ok } = await session();
  if (!ok) return NextResponse.json({ error: "finish two-factor sign-in" }, { status: 403 });
  const id = z.string().uuid().safeParse(req.nextUrl.searchParams.get("client_id"));
  if (!id.success) return NextResponse.json({ error: "unknown app" }, { status: 400 });
  const { error } = await supabase.auth.oauth.revokeGrant({ clientId: id.data });
  if (error) return NextResponse.json({ error: "could not disconnect it" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
