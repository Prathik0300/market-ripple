"use client";
import { useEffect, useState } from "react";
import s from "./assistant.module.css";

type App = { id: string; name: string; granted_at: string };

// Connect the person's own AI app to the platform MCP server, and list or disconnect the apps already connected.
export default function ConnectAi({ url }: { url: string }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [copied, setCopied] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    const res = await fetch("/api/oauth/grants");
    const j = await res.json().catch(() => ({}));
    setApps(res.ok ? j.apps : []);
  }
  useEffect(() => {
    load();
  }, []);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setCopied("");
    }
  }

  async function disconnect(app: App) {
    setErr("");
    const res = await fetch(`/api/oauth/grants?client_id=${encodeURIComponent(app.id)}`, { method: "DELETE", headers: { "x-ripple": "1" } });
    if (!res.ok) setErr(`Could not disconnect ${app.name}.`);
    load();
  }

  const cli = `claude mcp add --transport http market-ripple ${url}`;
  return (
    <section className={`pcard ${s.connect}`}>
      <h2>Use your own Claude</h2>
      <p>Add Market Ripple to the AI app you already pay for. It signs in here (you approve it with two-factor), then answers
        with your own plan. No extra API key.</p>
      <div className="codebox"><pre>{url}</pre><button type="button" className="tiny quiet" onClick={() => copy(url, "url")}>{copied === "url" ? "Copied" : "Copy"}</button></div>
      <details className="more">
        <summary>How to add it</summary>
        <div className="more-body">
          <h3>Claude (web and desktop)</h3>
          <p>Settings, then Connectors, then add a custom connector with the address above. Claude opens a Market Ripple
            sign-in; approve it there.</p>
          <h3>Claude Code</h3>
          <div className="codebox"><pre>{cli}</pre><button type="button" className="tiny quiet" onClick={() => copy(cli, "cli")}>{copied === "cli" ? "Copied" : "Copy"}</button></div>
          <p>Then run <code>/mcp</code> in Claude Code and choose Market Ripple to sign in.</p>
          <h3>Other apps (Codex, Cursor, VS Code)</h3>
          <p>Add a remote MCP server with the address above (HTTP transport). The app finds the sign-in on its own.</p>
          <p className="small">The tools are read-only: your holdings, trades and portfolio report, your connected data, and the
            shared model&rsquo;s signals (each with its tested skill), focus list, facts, events and dossiers. They cannot trade,
            move money or change your account. Your AI app is told not to give buy or sell advice, but its answers come from
            its own model, not Market Ripple.</p>
        </div>
      </details>
      <div className={s.apps}>
        <h3>Connected apps</h3>
        {apps === null ? <p className="small">Loading…</p> : apps.length === 0 ? <p className="small">None yet.</p> : (
          <ul>
            {apps.map((a) => (
              <li key={a.id} className="prow">
                <span><b>{a.name || "Unnamed app"}</b> <span className="small">since {new Date(a.granted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></span>
                <button type="button" className="tiny danger" onClick={() => disconnect(a)}>Disconnect</button>
              </li>
            ))}
          </ul>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </section>
  );
}
