import { headers } from "next/headers";
import { resourceUrl } from "@/lib/platform-mcp";
import Chat from "./chat";
import ConnectAi from "./connect-ai";
import s from "./assistant.module.css";

// Research help two ways. First and default: the person's own AI app (Claude, Claude Code, Codex, Cursor) connects to
// the platform MCP server with OAuth and uses their own plan. Second: the in-app chat, shown only when the platform
// has an Anthropic API key set (ANTHROPIC_API_KEY), since it runs on Market Ripple's own key.
export default async function Assistant() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const chatOn = !!process.env.ANTHROPIC_API_KEY;

  return (
    <main className={`connect ${s.page}`}>
      <a href="/desk" className="small">&larr; Back to the desks</a>
      <h1>Research assistant</h1>
      <p className="lead">Ask how today&rsquo;s world events and the Market Ripple model relate to your holdings and interests. Research, not advice.</p>
      <details className="more">
        <summary>How this works</summary>
        <div className="more-body">
          <p>Your AI app reads two things through Market Ripple: your own account data (holdings, recent trades, your portfolio
            report, your connected data sources and interests) and the shared world documents every user sees (model signals,
            the focus list, facts, the event feed and research dossiers).</p>
          <p>It signs in as you with OAuth after you approve it with two-factor, so the database&rsquo;s row-level security allows
            only your rows, and its access is read-only. Your data is not used to train the shared model.</p>
          <p>Each model signal comes with its tested skill. Most signals have not beaten a naive guess out of sample. Market
            Ripple tells connected apps not to give buy, sell or hold calls, price targets or order help.</p>
        </div>
      </details>
      <ConnectAi url={resourceUrl(`${proto}://${host}`)} />
      {chatOn && (
        <>
          <h2 className={s.sub}>Or ask here</h2>
          <Chat />
        </>
      )}
    </main>
  );
}
