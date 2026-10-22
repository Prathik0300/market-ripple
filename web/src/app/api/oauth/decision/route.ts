import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { limited } from "@/lib/ratelimit";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";

// The consent page's Approve / Deny. Approving first vouches for this authorization (vouch_oauth, which needs a
// two-factor browser session); the database refuses any approval that was not vouched, so an app can never be
// approved with only a password. Returns the AI app's redirect address with the code (or the error).

const Body = z.object({ authorization_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), decision: z.enum(["approve", "deny"]) });

function sameSite(req: NextRequest) {
  const origin = req.headers.get("origin");
  return req.headers.get("x-ripple") === "1" && (!origin || new URL(origin).host === req.nextUrl.host);
}

const httpUrl = (u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;

export async function POST(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (user.aal !== "aal2") return NextResponse.json({ error: "finish two-factor sign-in" }, { status: 403 });
  if (await limited(`oauth:${user.id}`, 20, 600)) return NextResponse.json({ error: "too many attempts; try again later" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { authorization_id: id, decision } = parsed.data;

  if (decision === "deny") {
    // Auth binds the request to the person when its details are read; for an app approved before, that read tries
    // to re-approve, which the database refuses (nothing was vouched), so the request just stays unapproved
    await supabase.auth.oauth.getAuthorizationDetails(id);
    const { data } = await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    const url = httpUrl(data?.redirect_url);
    return NextResponse.json(url ? { redirect_url: url } : { denied: true });
  }

  const { error: vouchError } = await supabase.rpc("vouch_oauth", { p_authorization_id: id });
  if (vouchError) return NextResponse.json({ error: "Could not confirm this request. Sign in again and retry." }, { status: 403 });
  // binds the request to this person; for an app they approved before, Auth approves it here and returns the redirect
  const { data: details, error: detailsError } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (detailsError || !details) return NextResponse.json({ error: "This request has expired. Start again from your AI app." }, { status: 400 });
  if (!("authorization_id" in details)) {
    const url = httpUrl((details as { redirect_url?: string }).redirect_url);
    return url ? NextResponse.json({ redirect_url: url }) : NextResponse.json({ error: "Unexpected answer from sign-in." }, { status: 502 });
  }
  if (details.user?.id && details.user.id !== user.id) return NextResponse.json({ error: "This request belongs to another account." }, { status: 403 });
  const { data, error } = await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true });
  const url = httpUrl(data?.redirect_url);
  if (error || !url) return NextResponse.json({ error: "Could not approve. Start again from your AI app." }, { status: 400 });
  return NextResponse.json({ redirect_url: url });
}
