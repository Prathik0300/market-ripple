// Only the public URL and the publishable key reach the web app. The service role key never does:
// world data is written by the pipeline, and every request here runs as the signed-in user under RLS.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  // fail loudly at build or boot rather than serving a half-configured app
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set");
}
