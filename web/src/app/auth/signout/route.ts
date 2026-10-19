import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  if (req.headers.get("x-ripple") !== "1") return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  await supabase.rpc("log_event", { p_event: "signed_out" });
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
