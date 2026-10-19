"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    setBusy(false);
    // one message for any failure: never reveal whether the email exists
    if (error) return setErr(/confirm/i.test(error.message) ? "Confirm your email first: check your inbox." : "That email and password did not match.");
    location.assign("/mfa");
  }

  return (
    <main className="auth">
      <form className="panel" onSubmit={submit}>
        <h1>Sign in to Market Ripple</h1>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
        {err && <p className="err" role="alert">{err}</p>}
        <p className="small">New here? <a href="/signup">Create an account</a></p>
      </form>
    </main>
  );
}
