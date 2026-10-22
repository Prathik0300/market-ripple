// Throwaway test users on the local Supabase (Docker) for the platform's security tests: real password + TOTP
// sessions kept in cookie jars like the web app's, and one private row in each private table. The local service key
// is used only to create and delete these fixtures. Refuses to run against anything but a local Supabase.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
export const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
export const KEY = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(URL_)) throw new Error("refusing to run against a non-local Supabase: " + URL_);
export const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
export const admin = createClient(URL_, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
export const APP = process.env.APP_URL ?? "http://localhost:3000";

const tally = { passes: 0, failures: 0 };
export const check = (ok, what) => {
  if (ok) tally.passes++;
  else tally.failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
};

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret
export function totp(secret) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", key).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

// A user client that keeps its session in a cookie jar, the way the web app's server client does
export function cookieClient() {
  const jar = new Map();
  const client = createServerClient(URL_, KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  return { client, cookie: () => [...jar].map(([n, v]) => `${n}=${v}`).join("; ") };
}

export async function makeUser(tag) {
  const email = `assistant-test-${tag}-${randomBytes(4).toString("hex")}@ripple.test`;
  const password = "At-" + randomBytes(12).toString("hex") + "-Aa9!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  const sym = `ZZ${tag.toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;
  const marker = `secret-${tag}-${randomBytes(6).toString("hex")}`;
  const { data: conn, error: e1 } = await admin.from("connections").insert({ user_id: id, provider: "cams", status: "ok", note: marker }).select("id").single();
  if (e1) throw e1;
  const { data: mcp, error: e2 } = await admin.from("mcp_connections").insert({ user_id: id, server: "test-server", status: "ok" }).select("id").single();
  if (e2) throw e2;
  const ins = await Promise.all([
    admin.from("holdings").insert({ connection_id: conn.id, user_id: id, sym, kind: "stock", qty: 7, ccy: "USD", name: marker }),
    admin.from("transactions").insert({ connection_id: conn.id, user_id: id, ext_id: marker, ts: new Date().toISOString(), sym, side: "buy", qty: 7, ccy: "USD" }),
    admin.from("user_reports").insert({ user_id: id, kind: "portfolio", data: { marker, holdings: [{ sym, name: marker }] } }),
    admin.from("mcp_snapshots").insert({ connection_id: mcp.id, user_id: id, tool: "get_positions", items: 1, data: { marker, sym } }),
  ]);
  for (const r of ins) if (r.error) throw r.error;
  const interest = tag === "a" ? "crypto" : "energy";
  const pr = await admin.from("profiles").update({ interests: [interest] }).eq("id", id);
  if (pr.error) throw pr.error;

  // password sign-in (aal1), then enrol and verify a TOTP factor (aal2), as the sign-in pages do
  const aal2 = cookieClient();
  const s1 = await aal2.client.auth.signInWithPassword({ email, password });
  if (s1.error) throw s1.error;
  const en = await aal2.client.auth.mfa.enroll({ factorType: "totp", friendlyName: "test" });
  if (en.error) throw en.error;
  const v = await aal2.client.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: totp(en.data.totp.secret) });
  if (v.error) throw v.error;
  const aal1 = cookieClient();
  const s2 = await aal1.client.auth.signInWithPassword({ email, password });
  if (s2.error) throw s2.error;
  return { id, email, password, sym, marker, aal2, aal1, interest, tag: tag.toUpperCase() };
}

// deletes the users (their rows cascade) and prints the tally; sets the exit code
export async function finish(users) {
  for (const u of users) await admin.auth.admin.deleteUser(u.id);
  console.log(`\n${tally.passes} passed, ${tally.failures} failed${users.length ? `; deleted ${users.length} test users` : ""}`);
  process.exitCode = tally.failures ? 1 : 0;
}

