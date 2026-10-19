"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    const { data, error } = await supabaseBrowser().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${location.origin}/auth/confirm` },
    });
    setBusy(false);
    // email confirmation is off for now: a new account gets a session at once and goes straight to the
    // required two-factor setup, so no account can reach any data without its second factor
    if (data?.session) return location.assign("/mfa/setup");
    // one message whether or not the address already has an account, so sign-up cannot be used to find
    // out who is registered
    if (error && !/registered/i.test(error.message)) setMsg({ err: error.message });
    else setMsg({ ok: "If this email is new, check your inbox to confirm it. If you already have an account, sign in instead." });
  }

  return (
    <main className="auth">
      <form className="panel" onSubmit={submit}>
        <h1>Create your Market Ripple account</h1>
        <p>World events mapped to the markets they move. Research, not buy or sell advice.</p>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password
          <input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="small">At least 12 characters, with upper and lower case letters, a digit and a symbol.</p>
        <button disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        {msg.err && <p className="err" role="alert">{msg.err}</p>}
        {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
        <p className="small">Already have an account? <a href="/login">Sign in</a></p>
      </form>
    </main>
  );
}
