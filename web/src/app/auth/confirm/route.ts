import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

// Every email link lands here (sign-up confirmation, password reset). Supabase has already checked the link by the
// time it sends the browser here:
//   ?code=...                 PKCE link: swap the code for a session. That needs the verifier cookie from the browser
//                             that asked for the email, so on another device the swap fails; the email is confirmed
//                             all the same, and the person is told to sign in.
//   ?token_hash=...&type=...  link from an email template that uses {{ .TokenHash }}: works on any device.
//   ?error_code=...           Supabase could not accept the link (expired or already used).
// `next` picks where to go afterwards, from a fixed list only.
const NEXT = ["/mfa/setup", "/auth/reset"] as const;

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const p = url.searchParams;
  const next = NEXT.find((n) => n === p.get("next")) ?? "/mfa/setup";
  const recovery = next === "/auth/reset" || p.get("type") === "recovery";
  const go = (path: string, notice?: string) => {
    const to = url.clone();
    to.pathname = path;
    to.search = notice ? `?notice=${notice}` : "";
    return NextResponse.redirect(to);
  };

  if (p.get("error_code") || p.get("error")) return go(recovery ? "/auth/reset" : "/login", "expired");

  const supabase = await supabaseServer();
  const code = p.get("code");
  const tokenHash = p.get("token_hash");
  const type = p.get("type") as EmailOtpType | null;
  let ok = false;
  if (code) ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash && type) ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  else return go("/login", "expired");

  if (ok) {
    await supabase.rpc("log_event", { p_event: recovery ? "password_reset_link" : "email_confirmed" });
    return go(recovery ? "/auth/reset" : next);
  }
  // a code that Supabase accepted but this browser cannot swap: opened on a different device or browser
  if (code) return go(recovery ? "/auth/reset" : "/login", recovery ? "other-browser" : "confirmed");
  return go(recovery ? "/auth/reset" : "/login", "expired");
}
