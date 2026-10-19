"use client";
import { useState } from "react";
import { INTERESTS } from "@/lib/interests";

// The multi-select used by onboarding and Settings. Saves through /api/interests, then goes to `next`.
export default function InterestsPicker({ initial, next, action }: { initial: string[]; next?: string; action: string }) {
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  const toggle = (id: string) => {
    const s = new Set(picked);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setPicked(s);
    setMsg({});
  };

  async function save(ids: string[]) {
    setBusy(true);
    setMsg({});
    const r = await fetch("/api/interests", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-ripple": "1" },
      body: JSON.stringify({ interests: ids }),
    }).catch(() => null);
    setBusy(false);
    if (r?.status === 401) return location.assign("/login");
    if (!r?.ok) return setMsg({ err: "Could not save. Try again." });
    if (next) return location.assign(next);
    setMsg({ ok: "Saved. The main page now leads with these areas." });
  }

  return (
    <div className="pform">
      <div className="ipick" role="group" aria-label="Areas you follow">
        {INTERESTS.map((i) => (
          <button key={i.id} type="button" className={picked.has(i.id) ? "on" : ""} aria-pressed={picked.has(i.id)} onClick={() => toggle(i.id)}>
            <b>{i.label}</b>
            <span>{i.blurb}</span>
          </button>
        ))}
      </div>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => save(INTERESTS.filter((i) => picked.has(i.id)).map((i) => i.id))}>
          {busy ? "Saving…" : action}
        </button>
        {next && <button type="button" className="quiet" disabled={busy} onClick={() => save([])}>Skip for now</button>}
      </div>
      {msg.err && <p className="err" role="alert">{msg.err}</p>}
      {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
    </div>
  );
}
