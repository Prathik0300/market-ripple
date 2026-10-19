"use client";
import { useCallback, useEffect, useState } from "react";
import { CLIENTS, SERVERS, type McpServer } from "@/lib/mcp-catalog";

type Conn = { id: string; server: string; status: string; note: string | null; tools: string[]; last_sync_at: string | null; sync_started_at: string | null };
type Snap = { connection_id: string; tool: string; items: number | null; fetched_at: string };

const STATUS: Record<string, string> = { pending: "connected · first sync soon", ok: "connected", needs_user: "sign in again", error: "sync failed" };
// a pull holds its lock at most 5 minutes (claim_mcp_sync); an older lock is from a run that died
const syncing = (c?: Conn) => !!c?.sync_started_at && Date.now() - Date.parse(c.sync_started_at) < 5 * 60_000;

function when(ts: string | null) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  return m < 60 ? `${Math.max(m, 1)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString();
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="quiet tiny" onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Code({ text }: { text: string }) {
  return <div className="codebox"><pre><code>{text}</code></pre><Copy text={text} /></div>;
}

function Card({ s, conn, snaps, client, onChange }: { s: McpServer; conn?: Conn; snaps: Snap[]; client: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const running = busy || syncing(conn);
  const app = CLIENTS.find((c) => c.id === client) ?? CLIENTS[0];
  const refused = (conn?.tools ?? []).filter((t) => !s.read.includes(t));
  const allowed = (conn?.tools ?? []).filter((t) => s.read.includes(t));

  async function start() {
    setBusy(true); setErr("");
    const r = await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json", "x-ripple": "1" }, body: JSON.stringify({ action: "start", server: s.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) { setBusy(false); return setErr(j.error ?? "Could not start the sign-in."); }
    location.assign(j.url);
  }
  async function syncNow() {
    if (running) return;                       // a second press while a sync runs does nothing
    setBusy(true); setErr(""); setSyncMsg("");
    onChange();                                // shows "syncing" at once (the lock is visible to every tab)
    const r = await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json", "x-ripple": "1" }, body: JSON.stringify({ action: "sync", server: s.id }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) setErr(j.error ?? "Sync failed.");
    else setSyncMsg(j.running ? "A sync was already running; showing its result when it ends." : "Synced just now.");
    onChange();
  }
  async function remove() {
    setBusy(true);
    await fetch(`/api/mcp?server=${s.id}`, { method: "DELETE", headers: { "x-ripple": "1" } });
    setBusy(false);
    onChange();
  }

  return (
    <section className="pcard mcard" id={s.id}>
      <div className="prow">
        <div>
          <h2>{s.name}</h2>
          <p>{s.what}</p>
        </div>
        {conn ? <span className={`chip ${running ? "pending" : conn.status}`}>{running ? "syncing…" : STATUS[conn.status] ?? conn.status}</span>
          : <span className="chip">{s.ripple ? "not connected" : "in your AI app"}</span>}
      </div>
      {conn && <p className="small">Last sync {when(conn.last_sync_at)} · auto every 2 hours{conn.note && !running ? ` · ${conn.note}` : ""}</p>}
      <div className="row">
        {s.ripple && conn && conn.status !== "needs_user" && (
          <button type="button" disabled={running} aria-busy={running} onClick={syncNow}>{running ? "Syncing…" : "Sync now"}</button>
        )}
        {s.ripple && (conn
          ? <button type="button" className="danger" disabled={running} onClick={remove}>Disconnect</button>
          : <button type="button" disabled={busy} onClick={start}>{busy ? "Opening sign-in…" : `Connect ${s.name}`}</button>)}
        {conn && conn.status === "needs_user" && <button type="button" disabled={busy} onClick={start}>Sign in again</button>}
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      {syncMsg && !running && <p className="ok small" role="status">{syncMsg}</p>}
      <details className="more">
        <summary>More</summary>
        <div className="more-body">
          <p><b>Connector address</b></p>
          <Code text={s.url} />
          <p className="small">{s.why} {s.auth}{s.docs && <> · <a href={s.docs} target="_blank" rel="noopener noreferrer">{s.name} docs</a></>}</p>

          <h3>Use it in {app.name}</h3>
          <ol className="steps">
            {app.steps(s).map((st, i) => <li key={i}>{st.text}{st.code && <Code text={st.code} />}</li>)}
          </ol>
          {s.ripple && <p className="small">Your AI app reads it when you ask. Connect {s.name} above to keep it flowing into your desks every two hours.</p>}

          {s.ripple ? (
            <>
              <h3>What Market Ripple reads</h3>
              <p className="small">Every two hours, or when you press Sync now: {s.pulls.map((p) => p.label).join(", ") || "only what you ask for"}. Only these read tools are ever called: <code>{s.read.join(", ")}</code>.</p>
              {conn && conn.tools.length > 0 && (
                <p className="small">{s.name} offers {conn.tools.length} tools: {allowed.length} read tools allowed, {refused.length} blocked{refused.length ? <> (<code>{refused.slice(0, 12).join(", ")}{refused.length > 12 ? ", …" : ""}</code>)</> : ""}.</p>
              )}
              {snaps.length > 0 && (
                <ul className="small snaps">{snaps.map((x) => <li key={x.tool}><code>{x.tool}</code>: {x.items ?? "?"} items, {when(x.fetched_at)}</li>)}</ul>
              )}
            </>
          ) : <p className="small">{s.rippleNote}</p>}
          {s.caution && <p className="small caution">{s.caution}</p>}
        </div>
      </details>
    </section>
  );
}

export default function Connectors() {
  const [data, setData] = useState<{ connections: Conn[]; snapshots: Snap[]; ai_client: string | null; sealing: boolean } | null>(null);
  const [client, setClient] = useState("claude-desktop");
  const [flash, setFlash] = useState<{ ok?: string; err?: string }>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/mcp");
    if (r.status === 401) return location.assign("/login");
    const j = await r.json();
    setData(j);
    if (j.ai_client) setClient(j.ai_client);
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("ok") || q.get("err")) {
      setFlash({ ok: q.get("ok") ?? undefined, err: q.get("err") ?? undefined });
      history.replaceState(null, "", location.pathname + location.hash);
    }
    load();
  }, [load]);
  // while any connector is syncing, refresh every 3 seconds so its chip and "last sync" update when it ends
  const anyRunning = !!data?.connections.some((c) => syncing(c));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  async function pick(id: string) {
    setClient(id);
    await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json", "x-ripple": "1" }, body: JSON.stringify({ action: "prefs", ai_client: id }) });
  }

  return (
    <main className="connect">
      <div className="row"><a href="/desk" className="small">&larr; Back to the desks</a><a href="/connect" className="small">Brokers with API keys</a></div>
      <h1>Connectors</h1>
      <p className="lead">
        Bring in your data from services that don&rsquo;t offer an open API. Each connector uses the service&rsquo;s official
        MCP connector, so you sign in on the service&rsquo;s own page and Market Ripple never sees your password.
      </p>
      <div className="safe">
        <b>How connectors work</b>
        <ul>
          <li><b>Connect once.</b> Approve on the service&rsquo;s sign-in page. Your positions and data then sync to your desks every two hours, next to the world events that move them. Press Sync now to update straight away.</li>
          <li><b>Use them in your AI app too.</b> Pick your AI app below; each card&rsquo;s More shows the exact steps.</li>
          <li><b>Read-only by design.</b> Your sign-in is sealed on arrival, so this site and its database can&rsquo;t read it back. Market Ripple only calls read tools; order, transfer and edit tools are blocked in code. Disconnect deletes the sign-in and everything synced.</li>
        </ul>
      </div>

      <section className="pcard">
        <div className="prow"><h2>Your AI app</h2><span className="small">saved to your account</span></div>
        <div className="seg" role="radiogroup" aria-label="Your AI app">
          {CLIENTS.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={client === c.id} className={client === c.id ? "on" : ""} onClick={() => pick(c.id)}>{c.name}</button>
          ))}
        </div>
      </section>

      {flash.ok && <p className="ok" role="status">{flash.ok}</p>}
      {flash.err && <p className="err" role="alert">{flash.err}</p>}
      {data && !data.sealing && <p className="err">Connecting isn&rsquo;t available on this site yet. You can still use each connector in your AI app.</p>}
      {data === null ? <p>Loading…</p> : SERVERS.map((s) => {
        const conn = data.connections.find((c) => c.server === s.id);
        return <Card key={s.id} s={s} conn={conn} snaps={conn ? data.snapshots.filter((x) => x.connection_id === conn.id) : []} client={client} onChange={load} />;
      })}
      <p className="small">Research only: these connectors read data to show exposure to the news. Nothing here places orders or gives advice.</p>
    </main>
  );
}
