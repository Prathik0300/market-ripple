import type { NextRequest } from "next/server";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { decodeCursor, encodeCursor, subscribe } from "@/lib/events";
import { checkWorld } from "@/lib/world";
import { limited } from "@/lib/ratelimit";

// Server-sent events: tells the open pages when world documents change (after a pipeline upload) and when the user's
// own documents are saved elsewhere, so pages refresh only what changed instead of polling. Names and versions only:
// the pages fetch the documents themselves through the normal, cached routes. A connection lasts up to LIFE_MS
// (serverless functions have a time limit); the browser reconnects on its own with Last-Event-ID and misses nothing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIFE_MS = process.env.VERCEL ? 55_000 : 300_000;
const PING_MS = 15_000;
const CHECK_MS = 20_000;

export async function GET(req: NextRequest) {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return new Response("sign in first", { status: 401 });
  if (await limited(`stream:${user.id}`, 60, 60)) return new Response("too many connections", { status: 429 });

  const from = decodeCursor(req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("from"));
  const enc = new TextEncoder();
  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let open = true, closed = false;
      const send = (s: string) => { if (open) try { ctrl.enqueue(enc.encode(s)); } catch { open = false; } };
      const sub = await subscribe(user.id, from, (e, c) => {
        send(`id: ${encodeCursor(c)}\nevent: ${e.type}\ndata: ${JSON.stringify(e.type === "world" ? { paths: e.paths } : { key: e.key, v: e.v })}\n\n`);
      });
      send(`retry: 2000\nid: ${encodeCursor(sub.cursor)}\nevent: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

      const check = () => { checkWorld(supabase).catch(() => {}); };
      check();
      const ping = setInterval(() => send(`: ping\n\n`), PING_MS);
      const watch = setInterval(check, CHECK_MS);
      const end = setTimeout(() => cleanup(), LIFE_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        open = false;
        clearInterval(ping); clearInterval(watch); clearTimeout(end);
        sub.close();
        try { ctrl.close(); } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() { cleanup(); },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
