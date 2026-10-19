import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { limited } from "@/lib/ratelimit";
import { seal, sealingReady } from "@/lib/seal";
import { providerById } from "@/lib/providers";

// List, add and remove a user's investing-platform connections. Keys are sealed here and never returned.

function sameSite(req: NextRequest) {
  const origin = req.headers.get("origin");
  return req.headers.get("x-ripple") === "1" && (!origin || new URL(origin).host === req.nextUrl.host);
}

export async function GET() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { data, error } = await supabase.from("connections").select("provider, status, note, key_hint, last_sync_at, created_at, token_expires");
  if (error) return NextResponse.json({ error: "read failed" }, { status: 500 });
  return NextResponse.json({ connections: data, sealing: sealingReady() });
}

const Add = z.object({
  provider: z.enum(["groww", "coindcx", "zerodha", "upstox", "binance"]),
  fields: z.record(z.string(), z.string().trim().min(8).max(2000)),
});

export async function POST(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (limited(`connect:${user.id}`, 10, 3600)) return NextResponse.json({ error: "too many attempts; try again later" }, { status: 429 });
  if (!sealingReady()) return NextResponse.json({ error: "connections are not switched on yet" }, { status: 503 });
  const parsed = Add.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "fill in every field" }, { status: 400 });
  const p = providerById(parsed.data.provider)!;
  const fields: Record<string, string> = {};
  for (const f of p.fields) {
    const v = parsed.data.fields[f.key];
    if (!v) return NextResponse.json({ error: `${f.label} is missing` }, { status: 400 });
    fields[f.key] = v;
  }
  const sealed = seal(fields);
  const hint = fields.api_key.slice(-4);
  const { error } = await supabase.rpc("add_connection", { p_provider: p.id, p_sealed: sealed, p_hint: hint, p_public_id: p.login ? fields.api_key : null });
  if (error) return NextResponse.json({ error: "could not save the connection" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  if (!providerById(provider) && provider !== "cams") return NextResponse.json({ error: "unknown platform" }, { status: 400 });
  const { error } = await supabase.rpc("remove_connection", { p_provider: provider });
  if (error) return NextResponse.json({ error: "could not remove it" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
