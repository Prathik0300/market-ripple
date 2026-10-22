import Link from "next/link";
import { LiveStatus, SignOut, ThemeSwitch, type Theme } from "./shell-client";

// The app bar on every signed-in page. Links go through next/link, so moving between pages swaps only the content
// (prefetched, no full reload); the desks are a separate static app, so that one link is a plain page load.
const NAV: { href: string; label: string; plain?: boolean }[] = [
  { href: "/", label: "Home" },
  { href: "/desk", label: "Desks", plain: true },
  { href: "/activity", label: "Activity" },
  { href: "/connect", label: "Connect" },
  { href: "/settings", label: "Settings" },
];

export function Logo({ size = 22 }: { size?: number }) {
  // three rings: an event at the centre (saffron) rippling out through the map (lagoon) to the markets (cobalt)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="var(--teal)" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.6" fill="var(--gold-fill)" />
    </svg>
  );
}

export function Shell({ path, theme, children }: { path: string; theme: Theme; children: React.ReactNode }) {
  const current = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  return (
    <>
      <header className="appbar">
        <div className="appbar-in">
          <Link href="/" className="brand"><Logo />Market Ripple</Link>
          <nav className="appnav" aria-label="Main">
            {NAV.map((n) => n.plain
              ? <a key={n.href} href={n.href}>{n.label}</a>
              : <Link key={n.href} href={n.href} aria-current={current(n.href) ? "page" : undefined}>{n.label}</Link>)}
          </nav>
          <div className="appbar-tools">
            <LiveStatus />
            <ThemeSwitch initial={theme} />
            <SignOut />
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
