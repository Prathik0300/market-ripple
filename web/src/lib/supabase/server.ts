import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_KEY, SUPABASE_URL } from "./env";

// A Supabase client acting as the signed-in user (their cookies, their RLS rights) for server code.
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // called from a server component: the middleware refreshes the session instead
        }
      },
    },
  });
}

// The signed-in user from their token, verified locally against the project's published signing key (ES256, cached),
// so a request does not wait on a call to Supabase. A signed-out token stays valid until it expires (an hour at most);
// the database checks the same token on every query.
export async function signedInUser(supabase: Awaited<ReturnType<typeof supabaseServer>>) {
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  return sub ? { id: sub, aal: String(data.claims.aal ?? "") } : null;
}
