"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Password reset, two steps on one page:
//   no session      ask for a reset link (always the same answer, so it never reveals who has an account)
//   from the link   /auth/confirm signed the person in; an account with two-factor proves its code first (/mfa),
//                   then sets a new password here
const NOTICES: Record<string, string> = {
  expired: "That reset link has expired or was already used. Ask for a new one below.",
  "other-browser": "Open the reset link in the same browser you asked for it from, or ask for a new one here.",
};

export default function Reset() {
  const [mode, setMode] = useState<"loading" | "ask" | "set">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const n = new URLSearchParams(location.search).get("notice");
      const sb = supabaseBrowser();
      const { data } = await sb.auth.getSession();
      if (!data.session || (n && NOTICES[n])) {
        if (n && NOTICES[n]) setMsg({ err: NOTICES[n] });
        return setMode("ask");
      }
      const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel !== "aal2" && aal?.nextLevel === "aal2") return location.replace("/mfa?next=/auth/reset");
      setMode("set");
    })();
  }, []);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    await supabaseBrowser().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/auth/confirm?next=/auth/reset` });
    setBusy(false);
    setMsg({ ok: "If an account uses this email, a reset link is on its way. Open it in this browser." });
  }

  async function set(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    const sb = supabaseBrowser();
    const { error } = await sb.auth.updateUser({ password });
    if (error) {
      setBusy(false);
      return setMsg({ err: /weak|least|character/i.test(error.message) ? error.message : "Could not change the password. Ask for a new reset link and try again." });
    }
    await sb.auth.signOut();
    location.assign("/login?notice=reset");
  }

  if (mode === "loading") return <main className="auth"><div className="panel"><p>Loading…</p></div></main>;
  return (
    <main className="auth">
      {mode === "ask" ? (
        <form className="panel" onSubmit={ask}>
          <h1>Reset your password</h1>
          <p>Enter your account email and we&rsquo;ll send a link to choose a new password.</p>
          <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
          {msg.err && <p className="err" role="alert">{msg.err}</p>}
          {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
          <p className="small"><a href="/login">Back to sign in</a></p>
        </form>
      ) : (
        <form className="panel" onSubmit={set}>
          <h1>Choose a new password</h1>
          <label>New password
            <input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <p className="small">At least 12 characters, with upper and lower case letters, a digit and a symbol.</p>
          <button disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
          {msg.err && <p className="err" role="alert">{msg.err}</p>}
        </form>
      )}
    </main>
  );
}
