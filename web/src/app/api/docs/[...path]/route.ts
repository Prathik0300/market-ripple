import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { limited } from "@/lib/ratelimit";
import { getWorldDoc, worldVersion } from "@/lib/world";
import { publishOwn } from "@/lib/events";

// The desks read documents by path, as they did on claude.ai:
//   world documents  feed/latest, signals/latest, stocks/s03, dossier/AAPL ...  (shared, read-only)
//   own documents    data/users/<me or own id>/<progress|notes|requests|portfolio> (read and write)
// Everything runs as the signed-in user, so row-level security decides what comes back.
const WORLD = /^[a-z_]+\/[A-Za-z0-9_.:@+-]{1,120}$/;
const OWN_KEYS = ["progress", "notes", "requests", "portfolio"] as const;
type OwnKey = (typeof OWN_KEYS)[number];

async function resolve(parts: string[]) {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return { supabase, user: null, kind: "none" as const };
  const path = parts.join("/");
  if (parts[0] === "data" && parts[1] === "users" && parts.length === 4) {
    const self = parts[2] === "me" || parts[2] === user.id;
    const key = parts[3] as OwnKey;
    if (!self || !OWN_KEYS.includes(key)) return { supabase, user, kind: "none" as const };
    return { supabase, user, kind: "own" as const, key };
  }
  // the Portfolio desk asks for owner/portfolio: here that is the signed-in user's own report
  if (path === "owner/portfolio") return { supabase, user, kind: "report" as const };
  if (path.startsWith("owner/") || !WORLD.test(path)) return { supabase, user, kind: "none" as const };
  return { supabase, user, kind: "world" as const, path };
}

// World documents come from the shared cache (src/lib/world.ts) with an ETag, so a browser that already has the current
// version gets a 304 with no body; they may sit in the browser's own cache (no-cache: always revalidated). Personal
// documents are read fresh and never stored by the browser.
const WORLD_HEADERS = { "cache-control": "private, no-cache", vary: "cookie" };
const OWN_HEADERS = { "cache-control": "private, no-store" };
const etag = (v: number) => `W/"w${v}"`;

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const r = await resolve((await ctx.params).path);
  if (!r.user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (await limited(`read:${r.user.id}`, 600, 60)) return NextResponse.json({ error: "too many requests" }, { status: 429 });
  if (r.kind === "none") return NextResponse.json({ exists: false }, { headers: OWN_HEADERS });
  if (r.kind === "world") {
    const inm = req.headers.get("if-none-match");
    if (inm) {
      const v = await worldVersion(r.path);
      if (v != null && inm === etag(v)) return new NextResponse(null, { status: 304, headers: { ...WORLD_HEADERS, etag: etag(v) } });
    }
    let doc;
    try {
      doc = await getWorldDoc(r.supabase, r.path);
    } catch {
      return NextResponse.json({ error: "read failed" }, { status: 500 });
    }
    if (!doc) return NextResponse.json({ exists: false }, { headers: WORLD_HEADERS });
    if (inm === etag(doc.v)) return new NextResponse(null, { status: 304, headers: { ...WORLD_HEADERS, etag: etag(doc.v) } });
    return NextResponse.json({ exists: true, data: doc.data, version: doc.v }, { headers: { ...WORLD_HEADERS, etag: etag(doc.v) } });
  }
  const q = r.kind === "report"
    ? r.supabase.from("user_reports").select("data").eq("user_id", r.user.id).eq("kind", "portfolio").maybeSingle()
    : r.supabase.from("user_docs").select("data, version").eq("user_id", r.user.id).eq("key", r.key).maybeSingle();
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "read failed" }, { status: 500 });
  return NextResponse.json(data ? { exists: true, data: data.data, version: "version" in data ? data.version : 1 } : { exists: false },
    { headers: OWN_HEADERS });
}

// writes: own documents only, JSON objects up to 200 kB, from this site only
const Body = z.object({ data: z.record(z.string(), z.unknown()), merge: z.boolean().optional() });

export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  // a custom header cannot be sent cross-site without CORS approval, and the origin must be this site
  const origin = req.headers.get("origin");
  if (req.headers.get("x-ripple") !== "1" || (origin && new URL(origin).host !== req.nextUrl.host)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  const r = await resolve((await ctx.params).path);
  if (!r.user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (r.kind !== "own") return NextResponse.json({ error: "read-only" }, { status: 403 });
  if (await limited(`write:${r.user.id}`, 120, 60)) return NextResponse.json({ error: "too many requests" }, { status: 429 });
  const raw = await req.text();
  if (raw.length > 200_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let parsed;
  try {
    parsed = Body.safeParse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "not JSON" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  let data = parsed.data.data;
  if (parsed.data.merge) {
    const { data: cur } = await r.supabase.from("user_docs").select("data").eq("user_id", r.user.id).eq("key", r.key).maybeSingle();
    data = { ...((cur?.data as Record<string, unknown>) ?? {}), ...data };
  }
  const { data: row, error } = await r.supabase
    .from("user_docs")
    .upsert({ user_id: r.user.id, key: r.key, data }, { onConflict: "user_id,key" })
    .select("version")
    .single();
  if (error) return NextResponse.json({ error: "write failed" }, { status: 500 });
  // the user's other tabs and devices hear about it on /api/stream (key and version only)
  await publishOwn(r.user.id, r.key, row.version).catch(() => {});
  return NextResponse.json({ ok: true, version: row.version });
}
