import type { NextConfig } from "next";

// Headers every response gets; the Content-Security-Policy is set per request in src/middleware.ts.
const security = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const config: NextConfig = {
  // a second local dev server (for example a preview next to a running one) needs its own build folder
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: security },
      // world data and personal data are never cached by browsers or CDNs
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      // the desk page is revalidated on every load; its scripts and styles carry a content hash and never change
      { source: "/desk", headers: [{ key: "Cache-Control", value: "private, no-cache" }] },
      { source: "/desk/index.html", headers: [{ key: "Cache-Control", value: "private, no-cache" }] },
      { source: "/desk/assets/:file*", headers: [{ key: "Cache-Control", value: "private, max-age=31536000, immutable" }] },
    ];
  },
  async rewrites() {
    return [
      { source: "/desk", destination: "/desk/index.html" },
      // on Vercel /api/cas is the Python statement reader (api/cas.py); in local development it runs on its own port
      ...(process.env.NODE_ENV === "development" ? [{ source: "/api/cas", destination: "http://127.0.0.1:8797/api/cas" }] : []),
    ];
  },
};

export default config;
