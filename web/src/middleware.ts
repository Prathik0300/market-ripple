import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

// Pages anyone may open. Everything else needs a session that has passed two-factor sign-in (aal2).
const PUBLIC = ["/login", "/signup", "/auth/confirm", "/auth/reset"];
// Pages for people who are signed in but have not finished two-factor yet.
const MFA_PAGES = ["/mfa", "/mfa/setup"];

function csp(nonce: string, desk: boolean) {
  // The desks are static files with no inline script, so 'self' is enough; the sign-in pages are
  // rendered by Next.js, whose inline bootstrap scripts carry this request's nonce.
  // local development only: Next's hot reload evaluates code; production builds never get 'unsafe-eval'
  const dev = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const script = (desk ? "'self'" : `'self' 'nonce-${nonce}' 'strict-dynamic'`) + dev;
  const connect = desk ? "'self'" : `'self' ${SUPABASE_URL}`;
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));  // edge runtime: no Buffer
  const policy = csp(nonce, path.startsWith("/desk"));
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);

  let res = NextResponse.next({ request: { headers } });
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: { headers } });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const isApi = path.startsWith("/api/");
  const deny = (to: string, status: number) => {
    if (isApi) return NextResponse.json({ error: status === 401 ? "sign in first" : "finish two-factor sign-in" }, { status });
    const url = req.nextUrl.clone();
    url.pathname = to;
    url.search = "";
    return NextResponse.redirect(url);
  };
  const done = (r: NextResponse) => {
    r.headers.set("content-security-policy", policy);
    return r;
  };

  // an email link that Supabase sent to the bare Site URL (no allowed redirect): hand it to /auth/confirm
  if (path === "/" && (req.nextUrl.searchParams.has("code") || req.nextUrl.searchParams.has("token_hash"))) {
    const url = req.nextUrl.clone();
    url.pathname = "/auth/confirm";
    return done(NextResponse.redirect(url));
  }

  // getClaims() verifies the token's signature locally against the project's published key (cached), so no request
  // waits on a round trip to Supabase; it refreshes an expired session through the cookies above
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (PUBLIC.some((p) => path === p || path.startsWith(p + "/"))) {
    return done(claims && (path === "/login" || path === "/signup") ? deny("/", 302) : res);
  }
  if (!claims?.sub) return done(deny("/login", 401));

  const onMfaPage = MFA_PAGES.includes(path);
  if (claims.aal !== "aal2") {
    if (onMfaPage) return done(res);
    // two-factor is required for everyone: enrol if no factor yet, otherwise verify (only this rare path asks Supabase)
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return done(deny(aal?.nextLevel === "aal2" ? "/mfa" : "/mfa/setup", 403));
  }
  if (onMfaPage) return done(deny("/", 302));
  return done(res);
}

export const config = {
  // everything except Next's own static assets and the favicon
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
