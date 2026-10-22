import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { limited } from "@/lib/ratelimit";
import { INTEREST_IDS, cleanInterests } from "@/lib/interests";

// The signed-in user's areas of interest (profiles.interests). null means not asked yet.
export async function GET() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { data, error } = await supabase.from("profiles").select("interests").eq("id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "read failed" }, { status: 500 });
  return NextResponse.json({ interests: data?.interests == null ? null : cleanInterests(data.interests) });
}

const Body = z.object({ interests: z.array(z.enum(INTEREST_IDS)).max(INTEREST_IDS.length) });

export async function PUT(req: NextRequest) {
  // a custom header cannot be sent cross-site without CORS approval, and the origin must be the host the browser asked
  const origin = req.headers.get("origin");
  const host = req.headers.get("host") ?? req.nextUrl.host;
  if (req.headers.get("x-ripple") !== "1" || (origin && new URL(origin).host !== host)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (await limited(`interests:${user.id}`, 30, 60)) return NextResponse.json({ error: "too many requests" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const interests = cleanInterests(parsed.data.interests);
  const { error } = await supabase.from("profiles").update({ interests }).eq("id", user.id);
  if (error) return NextResponse.json({ error: "could not save" }, { status: 500 });
  return NextResponse.json({ ok: true, interests });
}
