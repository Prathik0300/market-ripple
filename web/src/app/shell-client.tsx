"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export type Theme = "system" | "light" | "dark";

// ------------------------------------------------------------------ theme: System / Light / Dark
// Stored in the "mr-theme" cookie (read by the layout on the server and by the desk's head script), applied at once on
// <html> with a short cross-fade where the browser supports view transitions.
const ICONS: Record<Theme, React.ReactNode> = {
  system: <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  light: <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  dark: <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>,
};

export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  function pick(t: Theme) {
    document.cookie = t === "system" ? "mr-theme=; path=/; max-age=0; samesite=lax" : `mr-theme=${t}; path=/; max-age=31536000; samesite=lax`;
    const go = () => {
      if (t === "system") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", t);
      setTheme(t);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(go);
    else go();
  }
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {(["system", "light", "dark"] as const).map((t) => (
        <button key={t} type="button" role="radio" aria-checked={theme === t} aria-label={`${t[0].toUpperCase() + t.slice(1)} theme`}
          title={t[0].toUpperCase() + t.slice(1)} onClick={() => pick(t)}>{ICONS[t]}</button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ live updates
// One EventSource per tab on /api/stream. When the pipeline uploads new world documents, the main page re-renders on
// the server (router.refresh keeps scroll and state; the documents come from the Redis cache) and a short note says so.
// A hidden tab lets the connection go after a minute and picks up where it left off when shown again.
type Live = "connecting" | "live" | "paused" | "offline";
const LIVE_TEXT: Record<Live, string> = { live: "Live", connecting: "Connecting", paused: "Paused", offline: "Offline" };
const REFRESHES = new Set(["/"]);   // pages built from world documents

export function LiveStatus() {
  const [state, setState] = useState<Live>("connecting");
  const [note, setNote] = useState("");
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    let es: EventSource | null = null, cursor = "", failures = 0, hideTimer: ReturnType<typeof setTimeout> | undefined, noteTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (es) return;
      es = new EventSource("/api/stream" + (cursor ? `?from=${encodeURIComponent(cursor)}` : ""));
      es.addEventListener("ready", (e) => { failures = 0; cursor = (e as MessageEvent).lastEventId || cursor; setState("live"); });
      es.addEventListener("world", (e) => {
        cursor = (e as MessageEvent).lastEventId || cursor;
        if (!REFRESHES.has(pathRef.current)) return;
        router.refresh();
        setNote("New data from the latest run");
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => setNote(""), 2600);
      });
      es.addEventListener("own", (e) => { cursor = (e as MessageEvent).lastEventId || cursor; });
      es.onerror = () => {
        failures += 1;
        if (es?.readyState === EventSource.CLOSED) { es = null; setTimeout(connect, Math.min(30_000, 1000 * failures)); }
        setState(failures >= 3 ? "offline" : "connecting");
      };
    };
    const disconnect = () => { es?.close(); es = null; };
    const onVis = () => {
      if (document.hidden) hideTimer = setTimeout(() => { disconnect(); setState("paused"); }, 60_000);
      else { clearTimeout(hideTimer); connect(); }
    };
    connect();
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); clearTimeout(hideTimer); clearTimeout(noteTimer); disconnect(); };
  }, [router]);

  return (
    <>
      <span className="live" data-state={state} role="status" title={`Updates: ${LIVE_TEXT[state]}`}>{LIVE_TEXT[state]}</span>
      <div className={"toast" + (note ? " on" : "")} role="status" aria-live="polite">{note}</div>
    </>
  );
}

// ------------------------------------------------------------------ sign out
export function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="quiet" disabled={busy} onClick={() => {
      setBusy(true);
      try { caches.delete("mr-world-v1"); } catch {}
      fetch("/auth/signout", { method: "POST", headers: { "x-ripple": "1" }, credentials: "same-origin" })
        .finally(() => location.assign("/login"));
    }}>Sign out</button>
  );
}
