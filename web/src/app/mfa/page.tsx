"use client";
import { useEffect, useState } from "react";
import { safeNext } from "@/lib/next-path";
import { supabaseBrowser } from "@/lib/supabase/client";

// The second step of every sign-in: a 6-digit code from the authenticator app.
export default function Mfa() {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabaseBrowser().auth.mfa.listFactors().then(({ data }) => {
      const f = data?.totp?.find((x) => x.status === "verified");
      if (!f) location.replace("/mfa/setup");
      else setFactorId(f.id);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setErr("");
    const { error } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setErr("That code did not work. Codes change every 30 seconds; try the current one.");
    // a password reset proves the second factor here, then goes back to set the new password; an AI app's
    // connection request goes back to its consent page
    location.assign(safeNext(new URLSearchParams(location.search).get("next")) ?? "/");
  }

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    location.assign("/login");
  }

  return (
    <main className="auth">
      <form className="panel" onSubmit={submit}>
        <h1>Two-factor check</h1>
        <p>Enter the 6-digit code from your authenticator app.</p>
        <label>Code
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <button disabled={busy || !factorId}>{busy ? "Checking…" : "Verify"}</button>
        {err && <p className="err" role="alert">{err}</p>}
        <p className="small"><a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>Sign out</a></p>
      </form>
    </main>
  );
}
