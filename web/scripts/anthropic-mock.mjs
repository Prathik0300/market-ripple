// A pretend Anthropic Messages API on 127.0.0.1:8798, for testing the research assistant locally without a real key.
// Start the dev server with ANTHROPIC_BASE_URL=http://127.0.0.1:8798 ANTHROPIC_API_KEY=mock-key.
// It streams answers built from what the route sent, so a test can see which data reached the model:
//   - "dossier" in the question: it first calls get_dossier(BTC), then answers from the tool result
//   - an operator reminder (advice request): it answers with a refusal
//   - otherwise: it lists the private holdings and the signals' has_skill counts it was given
// GET /__last returns the last request body, so tests can check exactly what was sent.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8798);
let last = null;

const dataBlock = (text, source) => {
  const m = new RegExp(`<data source="${source.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^"]*" trust="untrusted">(.*?)</data>`, "s").exec(text);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
};

function plan(body) {
  const msgs = body.messages ?? [];
  const first = msgs[0];
  const ctx = Array.isArray(first?.content) ? first.content.map((b) => b.text ?? "").join("\n") : String(first?.content ?? "");
  const lastMsg = msgs[msgs.length - 1];
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("\n");
  if (!system.includes("No order preparation")) return { text: "MOCK: the system prompt is missing its limits." };
  if (lastMsg?.role === "system") {
    return { text: "MOCK REFUSAL: I can't give buy or sell advice or help prepare orders. I can show what your holdings are exposed to and what the model's tested skill does and does not show." };
  }
  if (Array.isArray(lastMsg?.content) && lastMsg.content[0]?.type === "tool_result") {
    const r = lastMsg.content[0];
    const src = /<data source="([^"]+)"/.exec(String(r.content))?.[1] ?? "none";
    const doc = dataBlock(String(r.content), src);
    const sk = doc?.model?.h20?.has_skill;
    return { text: `MOCK: read ${src}${r.is_error ? " (error)" : ""}. h20 has_skill=${sk}. The model has not shown out-of-sample skill here, so its probability is not a forecast.` };
  }
  // the question is the last text block (on the first turn the context block comes before it)
  const q = typeof lastMsg?.content === "string" ? lastMsg.content : (lastMsg?.content ?? []).at(-1)?.text ?? "";
  if (/dossier/i.test(q)) return { tool: { name: "get_dossier", input: { key: "BTC" } } };
  const holdings = dataBlock(ctx, "private/holdings") ?? [];
  const signals = dataBlock(ctx, "signals/latest");
  const items = signals?.items ?? [];
  const skilled = items.filter((s) => s.h5?.has_skill || s.h20?.has_skill).length;
  return {
    text: `MOCK ANSWER for: ${q.slice(0, 80)}\n\nYour private holdings in context: ${holdings.map((h) => h.sym).join(", ") || "none"}.\n\n- Signals in context: ${items.length}\n- With tested skill at some horizon: ${skilled}`,
  };
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_mock" });
  let i = 0;
  const tick = () => {
    if (i >= events.length) return res.end();
    const e = events[i++];
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    setTimeout(tick, e.type === "content_block_delta" ? 40 : 5);
  };
  tick();
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__last") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(last));
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404);
    return res.end();
  }
  if (req.headers["x-api-key"] !== "mock-key") {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    last = { body, beta: req.headers["anthropic-beta"] ?? null };
    const p = plan(body);
    const model = body.model;
    const start = { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: raw.length >> 2, output_tokens: 1 } } };
    const evs = [start];
    if (p.tool) {
      evs.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mock1", name: p.tool.name, input: {} } });
      evs.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.tool.input) } });
      evs.push({ type: "content_block_stop", index: 0 });
      evs.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
    } else {
      evs.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (const piece of p.text.match(/[\s\S]{1,24}/g)) evs.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
      evs.push({ type: "content_block_stop", index: 0 });
      evs.push({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
    }
    evs.push({ type: "message_stop" });
    sse(res, evs);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`anthropic mock on http://127.0.0.1:${PORT}`));
