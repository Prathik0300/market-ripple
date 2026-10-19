"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// what an email link (via /auth/confirm) or the reset page says when it sends someone here
const NOTICES: Record<string, { ok?: string; err?: string }> = {
  confirmed: { ok: "Your email is confirmed. Sign in to continue." },
  expired: { err: "That email link has expired or was already used. Sign in, or ask for a new link below." },
  reset: { ok: "Your password is changed. Sign in with the new one." },
};

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const n = new URLSearchParams(location.search).get("notice");
    // Supabase reports a bad link in the URL fragment when it cannot hand the link to /auth/confirm
    const h = new URLSearchParams(location.hash.slice(1));
    if (n && NOTICES[n]) setMsg(NOTICES[n]);
    else if (h.get("error_code") || h.get("error")) setMsg(NOTICES.expired);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    setUnconfirmed(false);
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error && /confirm/i.test(error.message)) {
      setUnconfirmed(true);
      return setMsg({ err: "Confirm your email first: check your inbox, or send the link again." });
    }
    // one message for any other failure: never reveal whether the email exists
    if (error) return setMsg({ err: "That email and password did not match." });
    location.assign("/mfa");
  }

  async function resend() {
    setBusy(true);
    await supabaseBrowser().auth.resend({ type: "signup", email, options: { emailRedirectTo: `${location.origin}/auth/confirm` } });
    setBusy(false);
    setUnconfirmed(false);
    setMsg({ ok: "If that address is waiting for confirmation, a new link is on its way." });
  }

  return (
    <main className="auth">
      <form className="panel" onSubmit={submit}>
        <h1>Sign in to Market Ripple</h1>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
        {msg.err && <p className="err" role="alert">{msg.err}</p>}
        {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
        {unconfirmed && <button type="button" className="quiet" disabled={busy || !email} onClick={resend}>Send the confirmation link again</button>}
        <p className="small"><a href="/auth/reset">Forgot your password?</a></p>
        <p className="small">New here? <a href="/signup">Create an account</a></p>
      </form>
    </main>
  );
}
