import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
