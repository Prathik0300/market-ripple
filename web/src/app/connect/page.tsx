"use client";
import { useCallback, useEffect, useState } from "react";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { supabaseBrowser } from "@/lib/supabase/client";

type Conn = { provider: string; status: string; note: string | null; key_hint: string | null; last_sync_at: string | null; token_expires: string | null };

const STATUS: Record<string, string> = { pending: "waiting for first sync", ok: "connected", needs_user: "needs you", error: "sync failed" };

function when(ts: string | null) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  return m < 60 ? `${Math.max(m, 1)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString();
}

// One row per platform; it opens on click to show the steps and the key fields, so the page stays a short list.
function Head({ name, what, conn, expanded, onToggle }: { name: string; what: string; conn?: Conn; expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="phead" aria-expanded={expanded} onClick={onToggle}>
      <span className="pname">
        <b>{name}</b>
        <span>{what}</span>
      </span>
      {conn ? <span className={`chip ${conn.status}`}>{STATUS[conn.status] ?? conn.status}</span> : <span className="chip">not connected</span>}
      <svg className="caret" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

type Row = { expanded: boolean; onToggle: () => void; onChange: () => void };

function Card({ p, conn, onChange, expanded, onToggle }: { p: Provider; conn?: Conn } & Row) {
  const [open, setOpen] = useState(!conn);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    const r = await fetch("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ripple": "1" },
      body: JSON.stringify({ provider: p.id, fields: vals }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg({ err: j.error ?? "Could not save it." });
    setVals({});
    setOpen(false);
    setMsg({ ok: "Saved and sealed. Your holdings appear after the next sync (within two hours)." });
    onChange();
  }

  async function login() {
    setBusy(true);
    const r = await fetch("/api/connections/login", { method: "POST", headers: { "content-type": "application/json", "x-ripple": "1" }, body: JSON.stringify({ provider: p.id }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok || !j.url) return setMsg({ err: j.error ?? "Could not start the login." });
    location.assign(j.url); // the broker's own sign-in page; it returns here through the sync service
  }

  const loggedIn = !!conn?.token_expires && Date.parse(conn.token_expires) > Date.now();

  async function remove() {
    setBusy(true);
    await fetch(`/api/connections?provider=${p.id}`, { method: "DELETE", headers: { "x-ripple": "1" } });
    setBusy(false);
    setMsg({ ok: "Removed. Its key, holdings and transactions are deleted." });
    onChange();
  }

  return (
    <section className={`pcard${expanded ? " open" : ""}`}>
      <Head name={p.name} what={p.what} conn={conn} expanded={expanded} onToggle={onToggle} />
      {expanded && <div className="pbody">
      {conn && (
        <p className="small">
          Key ending <code>{conn.key_hint}</code> · last sync {when(conn.last_sync_at)}
          {conn.note ? ` · ${conn.note}` : ""}
        </p>
      )}
      {open ? (
        <form onSubmit={save} className="pform">
          <ol className="steps">{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {p.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                required
                value={vals[f.key] ?? ""}
                onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
              />
            </label>
          ))}
          {p.note && <p className="small">{p.note}</p>}
          <div className="prow">
            <button disabled={busy}>{busy ? "Sealing…" : conn ? "Replace key" : `Connect ${p.name}`}</button>
            {conn && <button type="button" className="quiet" onClick={() => setOpen(false)}>Cancel</button>}
          </div>
        </form>
      ) : (
        <div className="prow">
          {p.login && (
            <button type="button" disabled={busy} onClick={login}>
              {loggedIn ? `Logged in until ${new Date(conn!.token_expires!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : `Log in with ${p.name} today`}
            </button>
          )}
          <button type="button" className="quiet" onClick={() => setOpen(true)}>Replace key</button>
          <button type="button" className="danger" disabled={busy} onClick={remove}>Remove</button>
        </div>
      )}
      </div>}
      {msg.err && <p className="err" role="alert">{msg.err}</p>}
      {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
    </section>
  );
}

// Mutual funds come from a statement, not an API key: the PDF and its password are read in memory and thrown
// away (web/api/cas.py); only each fund's name, units and average cost are kept.
function FundsCard({ conn, onChange, expanded, onToggle }: { conn?: Conn } & Row) {
  const [open, setOpen] = useState(!conn);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return setMsg({ err: "That statement is over 3 MB. Request one for a shorter period." });
    setBusy(true);
    setMsg({});
    const pdf = await new Promise<string>((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",", 2)[1] ?? "");
      r.onerror = () => bad(r.error);
      r.readAsDataURL(file);
    }).catch(() => "");
    const { data: { session } } = await supabaseBrowser().auth.getSession();
    if (!session) return location.assign("/login");
    const r = await fetch("/api/cas", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ripple": "1", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ pdf, password }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    setPassword("");
    if (!r.ok) return setMsg({ err: j.error ?? "The statement could not be read." });
    setFile(null);
    setOpen(false);
    const extra = [j.skipped ? `${j.skipped} without a fund code were left out` : "", j.unknown_cost ? `${j.unknown_cost} have no cost in the statement, so their gain is unknown` : ""].filter(Boolean).join("; ");
    setMsg({ ok: `Read ${j.funds} funds from the statement to ${j.period}.${extra ? ` ${extra}.` : ""} They appear on your portfolio after the next report (within two hours).` });
    onChange();
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/connections?provider=cams", { method: "DELETE", headers: { "x-ripple": "1" } });
    setBusy(false);
    setMsg({ ok: "Removed. Your fund rows are deleted." });
    onChange();
  }

  return (
    <section className={`pcard${expanded ? " open" : ""}`}>
      <Head name="Mutual funds (CAMS)" what="Every fund you hold, from any fund house or app, from one statement." conn={conn} expanded={expanded} onToggle={onToggle} />
      {expanded && <div className="pbody">
      {conn && <p className="small">{conn.note} · uploaded {when(conn.last_sync_at)}</p>}
      {open ? (
        <form onSubmit={upload} className="pform">
          <ol className="steps">
            <li>Request a free statement at <a href="https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement" target="_blank" rel="noreferrer">camsonline.com</a>: choose <i>Detailed</i>, the period <i>Since inception</i>, and set a password.</li>
            <li>It arrives by email as a PDF within minutes. Choose it below and type that password.</li>
            <li>Upload a newer statement whenever you buy or sell; units change only then.</li>
          </ol>
          <label>
            Statement PDF
            <input type="file" accept="application/pdf,.pdf" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label>
            Statement password
            <input type="password" autoComplete="off" required maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <p className="small">The PDF and password are read once in memory and discarded. Your name, PAN, email, phone and folio numbers are never stored.</p>
          <div className="prow">
            <button disabled={busy || !file}>{busy ? "Reading…" : conn ? "Upload newer statement" : "Upload statement"}</button>
            {conn && <button type="button" className="quiet" onClick={() => setOpen(false)}>Cancel</button>}
          </div>
        </form>
      ) : (
        <div className="prow">
          <button type="button" onClick={() => setOpen(true)}>Upload newer statement</button>
          <button type="button" className="danger" disabled={busy} onClick={remove}>Remove</button>
        </div>
      )}
      </div>}
      {msg.err && <p className="err" role="alert">{msg.err}</p>}
      {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
    </section>
  );
}

export default function Connect() {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [sealing, setSealing] = useState(true);
  const [banner, setBanner] = useState<{ ok?: string; err?: string }>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => () => setOpenId((cur) => (cur === id ? null : id));
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const who = q.get("login"), res = q.get("result");
    if (who && res) {
      const name = PROVIDERS.find((x) => x.id === who)?.name ?? who;
      setOpenId(who);
      setBanner(res === "ok" ? { ok: `Logged in with ${name}; your holdings are syncing now.` } : { err: res === "expired" ? `That ${name} login took too long or was already used. Press Log in again.` : `${name} did not accept the login. Check the API key, secret and redirect URL.` });
      history.replaceState(null, "", "/connect");
    }
  }, []);
  const load = useCallback(async () => {
    const r = await fetch("/api/connections");
    if (r.status === 401) return location.assign("/login");
    const j = await r.json();
    setConns(j.connections ?? []);
    setSealing(!!j.sealing);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <main className="connect">
      <a href="/desk#portfolio" className="small">&larr; Back to your portfolio</a>
      <h1>Connect investing platforms</h1>
      <p className="lead">
        Optional. Connected accounts show your holdings, trades and gains or losses on the Portfolio desk, next to the
        world events of the days they moved. Without them you still get every news, research and graph desk.
      </p>
      <div className="safe">
        <b>How your keys are protected</b>
        <ul>
          <li>Each key is sealed on arrival with a public key; this website and its database cannot read it back.</li>
          <li>Only the cloud sync service holds the key that opens it, and it can only <i>read</i> holdings and trades: it has no way to place orders or move money. Binance keys that could trade are refused.</li>
          <li>Removing a connection deletes its key, holdings and transactions immediately.</li>
        </ul>
      </div>
      {banner.ok && <p className="ok" role="status">{banner.ok}</p>}
      {banner.err && <p className="err" role="alert">{banner.err}</p>}
      {!sealing && <p className="err">Connections are not switched on for this site yet.</p>}
      {conns === null ? <p>Loading…</p> : (
        <>
          {PROVIDERS.map((p) => <Card key={p.id} p={p} conn={conns.find((c) => c.provider === p.id)} onChange={load} expanded={openId === p.id} onToggle={toggle(p.id)} />)}
          <FundsCard conn={conns.find((c) => c.provider === "cams")} onChange={load} expanded={openId === "cams"} onToggle={toggle("cams")} />
        </>
      )}
      <p className="small">Robinhood has no API for other apps, but it has an official connector: connect it on <a href="/connectors">Connectors</a>.</p>
    </main>
  );
}
