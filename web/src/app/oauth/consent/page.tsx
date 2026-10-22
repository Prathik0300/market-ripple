import { supabaseServer } from "@/lib/supabase/server";
import Decision from "./decision";

// An AI app (Claude, Claude Code, Codex, Cursor ...) asks to connect to the person's Market Ripple account through
// the platform MCP server. Supabase Auth sends them here with an authorization_id; the middleware has already made
// sure they are signed in with two-factor. Nothing is approved until they click.
type Req = { client_name: string | null; client_uri: string | null; redirect_uri: string; scope: string | null; consented_before: boolean };

const host = (u: string | null) => {
  try {
    return u ? new URL(u).host : null;
  } catch {
    return null;
  }
};

export default async function Consent({ searchParams }: { searchParams: Promise<{ authorization_id?: string }> }) {
  const id = (await searchParams).authorization_id ?? "";
  let req: Req | null = null;
  if (/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    const supabase = await supabaseServer();
    const { data } = await supabase.rpc("oauth_request", { p_authorization_id: id });
    req = ((data ?? []) as Req[])[0] ?? null;
  }

  if (!req) {
    return (
      <main className="auth">
        <div className="panel">
          <h1>This connection request has expired</h1>
          <p>Start again from your AI app: remove Market Ripple there and add it once more.</p>
          <a href="/assistant">Back to Market Ripple</a>
        </div>
      </main>
    );
  }

  const name = (req.client_name || "An AI app").slice(0, 80);
  const back = host(req.redirect_uri);
  return (
    <main className="auth">
      <div className="panel">
        <h1>Connect {name} to Market Ripple?</h1>
        <p>{name} will be able to read, as you:</p>
        <ul className="steps">
          <li>your holdings, recent trades and portfolio report</li>
          <li>data from the sources you connected, and your interests</li>
          <li>the shared world model: signals with their tested skill, the focus list, facts, events and dossiers</li>
        </ul>
        <div className="safe">
          <b>Read-only.</b>
          <ul>
            <li>It cannot trade, move money, change your account or see your broker keys.</li>
            <li>Your AI app&rsquo;s own plan does the thinking; Market Ripple sends no Claude API key.</li>
            <li>You can disconnect it any time from the research assistant page.</li>
          </ul>
        </div>
        <p className="small">After you choose, you go back to <b>{back ?? req.redirect_uri}</b>.
          {req.consented_before ? " You connected this app before." : ""} Only approve a request you started yourself.</p>
        <Decision id={id} />
      </div>
    </main>
  );
}
