"use client";
import { useState } from "react";

// Approve or deny. The decision API answers with the AI app's redirect address; going there with location.assign
// (not a form redirect) keeps the page's strict form-action policy intact.
export default function Decision({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/oauth/decision", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ripple": "1" },
      body: JSON.stringify({ authorization_id: id, decision }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && typeof j.redirect_url === "string") return location.assign(j.redirect_url);
    if (res.ok && j.denied) return setDone(true);
    setBusy(false);
    setErr(j.error ?? "That did not work. Start again from your AI app.");
  }

  if (done) return <p className="ok" role="status">Denied. Nothing was shared; you can close this page.</p>;
  return (
    <>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="prow">
        <button type="button" className="quiet" disabled={busy} onClick={() => decide("deny")}>Deny</button>
        <button type="button" disabled={busy} onClick={() => decide("approve")}>{busy ? "Connecting…" : "Approve"}</button>
      </div>
    </>
  );
}
