"use client";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_KEY, SUPABASE_URL } from "./env";

// Browser client for the sign-in pages only (sign-up, password, two-factor). The desks never talk to
// Supabase directly; they go through this app's /api routes.
export const supabaseBrowser = () => createBrowserClient(SUPABASE_URL, SUPABASE_KEY);
