import { NextResponse } from "next/server";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";

// Who is signed in, for the desks. Only an opaque id and display fields: no tokens, no email.
export async function GET() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { data: p } = await supabase.from("profiles").select("display_name, base_currency").eq("id", user.id).maybeSingle();
  return NextResponse.json({ id: user.id, name: p?.display_name ?? "", currency: p?.base_currency ?? "USD" });
}
