import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

// The link in the confirmation email lands here: exchange it for a session, then set up two-factor.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const supabase = await supabaseServer();
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  let ok = false;
  if (code) ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash && type) ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  const to = url.clone();
  to.search = "";
  to.pathname = ok ? "/mfa/setup" : "/login";
  if (ok) await supabase.rpc("log_event", { p_event: "email_confirmed" });
  return NextResponse.redirect(to);
}
