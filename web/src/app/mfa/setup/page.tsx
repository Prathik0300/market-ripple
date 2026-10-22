"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Two-factor is required for every account: enrol an authenticator app once, then verify it.
export default function MfaSetup() {
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: list } = await sb.auth.mfa.listFactors();
      if (list?.totp?.some((f) => f.status === "verified")) return location.replace("/mfa");
      // clear half-finished enrolments so a reload starts cleanly
      for (const f of list?.all ?? []) if (f.status === "unverified") await sb.auth.mfa.unenroll({ factorId: f.id });
      // the issuer is the name the authenticator app shows; left out, Supabase uses the Site URL's host
      const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", issuer: "Market Ripple", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
      if (error || !data) return setErr("Could not start two-factor setup. Reload to try again.");
      setFactor({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factor) return;
    setBusy(true);
    setErr("");
    const { error } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
    setBusy(false);
    if (error) return setErr("That code did not work. Check the time on your phone and try the current code.");
    location.assign("/onboarding");
  }

  return (
    <main className="auth">
      <form className="panel" onSubmit={submit}>
        <h1>Set up two-factor sign-in</h1>
        <p>Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then enter the code it shows.</p>
        {factor ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="qr" src={factor.qr} alt="QR code for your authenticator app" />
            <p className="small">Can&rsquo;t scan? Enter this key: <code className="secret">{factor.secret}</code></p>
          </>
        ) : !err && <p>Preparing your code…</p>}
        <label>6-digit code
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <button disabled={busy || !factor}>{busy ? "Checking…" : "Turn on two-factor"}</button>
        {err && <p className="err" role="alert">{err}</p>}
      </form>
    </main>
  );
}
