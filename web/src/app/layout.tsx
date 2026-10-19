import type { Metadata } from "next";
import { Libre_Franklin, Newsreader } from "next/font/google";
import "./globals.css";

// The broadsheet type pair, served from this site (next/font), so the CSP needs no font host:
// Newsreader for headlines, Libre Franklin (the newspaper sans) for text, labels and figures.
const display = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-display", display: "swap" });
const text = Libre_Franklin({ subsets: ["latin"], variable: "--font-text", display: "swap" });

// Render per request so Next.js can stamp this request's CSP nonce on its inline scripts
// (a prerendered page would carry no nonce, and the strict policy would block it).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Market Ripple",
  description: "World events, mapped to the markets they move. Research, not advice.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable}`}>
      <body>{children}</body>
    </html>
  );
}
