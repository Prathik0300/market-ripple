import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Shell } from "./shell";
import "./globals.css";

// IBM Plex Sans for text and headings, IBM Plex Mono for figures, tickers and timestamps; served from this site
// (next/font), so the CSP needs no font host and there is no layout shift while they load.
const text = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-text", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

// Render per request so Next.js can stamp this request's CSP nonce on its inline scripts
// (a prerendered page would carry no nonce, and the strict policy would block it).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Market Ripple",
  description: "World events, mapped to the markets they move. Research, not advice.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f4f5f2" }, { media: "(prefers-color-scheme: dark)", color: "#0c1013" }],
};

// Pages with no app bar: signing in and two-factor, and the consent screen an AI app opens.
const BARE = ["/login", "/signup", "/auth", "/mfa", "/oauth", "/onboarding"];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const path = h.get("x-pathname") ?? "/";
  // the theme is chosen on the server from the cookie, so it is right on the first paint with no script
  const t = c.get("mr-theme")?.value;
  const theme = t === "light" || t === "dark" ? t : undefined;
  const bare = BARE.some((p) => path === p || path.startsWith(p + "/"));
  return (
    <html lang="en" data-theme={theme} className={`${text.variable} ${mono.variable}`}>
      <body>{bare ? children : <Shell path={path} theme={theme ?? "system"}>{children}</Shell>}</body>
    </html>
  );
}
