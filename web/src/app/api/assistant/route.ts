import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { limited } from "@/lib/ratelimit";
import { buildContext, runTool, TOOLS } from "@/lib/assistant/context";
import { ADVICE_REMINDER, MODEL, SYSTEM_PROMPT, asksForAdvice, cleanHistory } from "@/lib/assistant/rules";

// The per-user research assistant. Claude answers from the signed-in person's own data (read with their token, so
// row-level security keeps it to their rows) and the shared world documents. Research and explanation only: the
// system prompt forbids buy/sell/hold calls, price targets and order preparation. The API key stays on the server.
// The reply streams back as newline-delimited JSON: {t:"text",v} pieces, {t:"tool",v:name} while a tool runs, then
// {t:"done"} or {t:"error",v:message}.

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ROUNDS = 6;

function sameSite(req: NextRequest) {
  const origin = req.headers.get("origin");
  return req.headers.get("x-ripple") === "1" && (!origin || new URL(origin).host === req.nextUrl.host);
}

export async function POST(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (user.aal !== "aal2") return NextResponse.json({ error: "finish two-factor sign-in" }, { status: 403 });
  if (await limited(`ask-burst:${user.id}`, 6, 60) || await limited(`ask:${user.id}`, 60, 3600)) {
    return NextResponse.json({ error: "Too many questions for now. Try again in a few minutes." }, { status: 429 });
  }
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "The assistant is not switched on yet." }, { status: 503 });

  const raw = await req.text();
  if (raw.length > 120_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "not JSON" }, { status: 400 });
  }
  // only the chat text is taken from the request; whose data is read comes from the verified token alone
  const history = cleanHistory((body as { messages?: unknown } | null)?.messages);
  if (!history) return NextResponse.json({ error: "send the conversation, ending with your question" }, { status: 400 });

  const context = await buildContext(supabase, user.id);
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t, i) =>
    i === 0 ? { role: t.role, content: [{ type: "text", text: context }, { type: "text", text: t.content }] } : { role: t.role, content: t.content },
  );
  if (asksForAdvice(history[history.length - 1].content)) messages.push({ role: "system", content: ADVICE_REMINDER });

  const client = new Anthropic();
  const enc = new TextEncoder();
  const memo = new Map<string, unknown>();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (o: Record<string, unknown>) => ctl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const s = client.beta.messages.stream(
            {
              model: MODEL,
              max_tokens: 16000,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              cache_control: { type: "ephemeral" },
              output_config: { effort: "medium" },
              tools: TOOLS,
              messages,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            { signal: req.signal },
          );
          s.on("text", (t) => send({ t: "text", v: t }));
          const msg = await s.finalMessage();
          if (msg.stop_reason === "refusal") {
            send({ t: "text", v: "\n\nI can't help with that request. Ask me about how events and the model's signals relate to your holdings instead." });
            break;
          }
          if (msg.stop_reason === "max_tokens") {
            send({ t: "text", v: "\n\n(The answer was cut off. Ask me to continue.)" });
            break;
          }
          const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          if (msg.stop_reason !== "tool_use" || !calls.length) break;
          messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
          for (const c of calls) send({ t: "tool", v: c.name });
          const results = await Promise.all(calls.map((c) => runTool(supabase, user.id, c.name, c.input, memo)));
          messages.push({
            role: "user",
            content: calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: results[i].text, is_error: results[i].error ?? false })),
          });
          if (round === MAX_ROUNDS - 1) send({ t: "text", v: "\n\n(I stopped looking things up here. Ask a narrower question for more.)" });
        }
        send({ t: "done" });
      } catch (e) {
        if (!req.signal.aborted) {
          const msg = e instanceof Anthropic.RateLimitError ? "The assistant is busy. Try again in a minute."
            : e instanceof Anthropic.APIError ? "The assistant could not answer just now."
            : "Something went wrong.";
          console.error("assistant", e instanceof Anthropic.APIError ? `${e.status} ${e.requestID ?? ""}` : String(e));
          send({ t: "error", v: msg });
        }
      } finally {
        ctl.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "private, no-store" } });
}
