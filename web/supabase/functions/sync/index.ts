// Market Ripple cloud sync worker.
//
// The only place users' broker keys are ever unsealed. It holds the platform private key (secret
// CONNECTIONS_PRIVATE_KEY), reads holdings and trades through an allowlist of read-only endpoints, and writes them
// under each connection's own user. It cannot place orders or move money: no such endpoint is on the list.
//
//   POST /sync/run                     every 2 hours from pg_cron (header x-sync-secret, checked against Vault)
//   GET  /sync/oauth/zerodha|upstox    the broker's redirect after a user's daily login: exchanges the one-time code
//                                      at once, seals the day's token, syncs, and sends the user back to /connect
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";
const FN_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync`;

// ------------------------------------------------------------------ allowlist: read and sign-in only
const ALLOWED: [string, string, string][] = [
  ["POST", "api.groww.in", "/v1/token/api/access"], ["GET", "api.groww.in", "/v1/holdings/user"],
  ["POST", "api.coindcx.com", "/exchange/v1/users/balances"], ["POST", "api.coindcx.com", "/exchange/v1/orders/trade_history"],
  ["GET", "api.coindcx.com", "/exchange/ticker"],
  ["POST", "api.kite.trade", "/session/token"], ["GET", "api.kite.trade", "/portfolio/holdings"], ["GET", "api.kite.trade", "/trades"],
  ["POST", "api.upstox.com", "/v2/login/authorization/token"], ["GET", "api.upstox.com", "/v2/portfolio/long-term-holdings"],
  ["GET", "api.upstox.com", "/v2/order/trades/get-trades-for-day"],
  ["GET", "api.binance.com", "/sapi/v1/account/apiRestrictions"], ["GET", "api.binance.com", "/api/v3/account"],
  ["GET", "api.binance.com", "/api/v3/ticker/price"],
];
class Refused extends Error {}
class NeedsUser extends Error {}
async function call(method: string, url: string, init: RequestInit = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED.some(([m, h, p]) => m === method && h === u.hostname && p === u.pathname)) {
    throw new Refused(`blocked: ${method} ${u.hostname}${u.pathname} is not a read endpoint`);
  }
  const r = await fetch(u, { ...init, method, redirect: "error" });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}

// ------------------------------------------------------------------ sealing (matches web/src/lib/seal.ts)
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ub64 = (a: Uint8Array) => btoa(String.fromCharCode(...a));
let keys: { priv: CryptoKey; pub: CryptoKey } | null = null;
async function keyPair() {
  if (keys) return keys;
  const pem = (Deno.env.get("CONNECTIONS_PRIVATE_KEY") ?? "").replace(/-----[^-]+-----|\s/g, "");
  if (!pem) throw new Error("CONNECTIONS_PRIVATE_KEY is not set");
  const priv = await crypto.subtle.importKey("pkcs8", b64(pem), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  keys = { priv, pub };
  return keys;
}
async function unseal(sealed: string): Promise<Record<string, string>> {
  const s = JSON.parse(sealed);
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, (await keyPair()).priv, b64(s.k));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const ct = new Uint8Array([...b64(s.ct), ...b64(s.tag)]);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(s.iv) }, aes, ct)));
}
async function seal(fields: Record<string, string>) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(fields))));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, (await keyPair()).pub, raw));
  return JSON.stringify({ v: 1, k: ub64(wrapped), iv: ub64(iv), ct: ub64(out.slice(0, -16)), tag: ub64(out.slice(-16)) });
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

// ------------------------------------------------------------------ platforms
type Holding = { sym: string; kind: "stock" | "crypto"; qty: number; avg_cost: number | null; ccy: string; price_local: number | null };
type Trade = { ext_id: string; ts: string; sym: string; side: "buy" | "sell"; qty: number; price: number | null; fee: number | null; ccy: string };
type Result = { holdings: Holding[]; trades: Trade[]; note: string };
const nse = (sym: string, exch?: string) => `${sym.toUpperCase()}${exch === "BSE" ? ".BO" : ".NS"}`;

async function groww(f: Record<string, string>): Promise<Result> {
  const ts = String(Math.floor(Date.now() / 1000));
  const t = await call("POST", "https://api.groww.in/v1/token/api/access", {
    headers: { Authorization: `Bearer ${f.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key_type: "approval", checksum: await sha256(f.api_secret + ts), timestamp: ts }),
  });
  const token = t.body?.token ?? t.body?.payload?.token;
  if (!token) throw new NeedsUser("Approve today's API key on groww.in/trade-api/api-keys; the next sync signs in by itself.");
  const h = await call("GET", "https://api.groww.in/v1/holdings/user", { headers: { Authorization: `Bearer ${token}`, "X-API-VERSION": "1.0", Accept: "application/json" } });
  if (h.status !== 200) throw new Error(`Groww holdings answered ${h.status}`);
  const rows = h.body?.payload?.holdings ?? [];
  const holdings = rows.filter((r: any) => Number(r.quantity) > 0).map((r: any) => ({
    sym: nse(r.trading_symbol), kind: "stock" as const, qty: Number(r.quantity), avg_cost: Number(r.average_price) || null, ccy: "INR", price_local: null }));
  return { holdings, trades: [], note: `${holdings.length} holdings` };
}

async function coindcx(f: Record<string, string>): Promise<Result> {
  const post = async (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ ...payload, timestamp: Date.now() });
    const r = await call("POST", `https://api.coindcx.com${path}`, {
      headers: { "Content-Type": "application/json", "X-AUTH-APIKEY": f.api_key, "X-AUTH-SIGNATURE": await hmac(f.api_secret, body) }, body });
    if (r.status === 401 || r.status === 403) throw new NeedsUser("CoinDCX refused the key. Check it, and do not bind it to one IP address: the cloud sync's address changes.");
    return r.body;
  };
  const balances = (await post("/exchange/v1/users/balances", {})) ?? [];
  const trades: any[] = [];
  let from_id: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = (await post("/exchange/v1/orders/trade_history", { limit: 500, sort: "asc", ...(from_id ? { from_id } : {}) })) ?? [];
    trades.push(...page);
    if (page.length < 500) break;
    from_id = page[page.length - 1].id;
  }
  const px: Record<string, number> = {};
  for (const t of (await call("GET", "https://api.coindcx.com/exchange/ticker")).body ?? []) px[String(t.market).toUpperCase()] = Number(t.last_price);
  const pos: Record<string, [number, number]> = {};
  for (const t of trades.filter((t) => String(t.symbol).toUpperCase().endsWith("INR")).sort((a, b) => a.timestamp - b.timestamp)) {
    const c = String(t.symbol).toUpperCase().slice(0, -3), q = Number(t.quantity), p = Number(t.price);
    const [qty, cost] = pos[c] ?? [0, 0];
    pos[c] = t.side === "buy" ? [qty + q, cost + q * p] : qty > 0 ? [qty - Math.min(q, qty), cost - (cost / qty) * Math.min(q, qty)] : [qty, cost];
  }
  const holdings: Holding[] = [];
  for (const b of balances) {
    const c = String(b.currency).toUpperCase(), qty = Number(b.balance) + Number(b.locked_balance);
    if (c === "INR" || !(qty > 0)) continue;
    const p = px[c + "INR"] ?? (px[c + "USDT"] && px.USDTINR ? px[c + "USDT"] * px.USDTINR : null);
    if (!p || qty * p < 100) continue; // dust under about a dollar
    const [tq, tc] = pos[c] ?? [0, 0];
    holdings.push({ sym: `${c}-USD`, kind: "crypto", qty, avg_cost: tq > 0 && Math.abs(tq - qty) <= 0.05 * qty ? tc / tq : null, ccy: "INR", price_local: p });
  }
  const tx: Trade[] = trades.map((t) => ({ ext_id: String(t.id), ts: new Date(Number(t.timestamp)).toISOString(), sym: String(t.symbol).toUpperCase(),
    side: t.side === "buy" ? "buy" : "sell", qty: Number(t.quantity), price: Number(t.price) || null, fee: Number(t.fee_amount) || null,
    ccy: String(t.symbol).toUpperCase().endsWith("INR") ? "INR" : "USDT" }));
  return { holdings, trades: tx, note: `${holdings.length} coins, ${tx.length} trades` };
}

function needToken(f: Record<string, string>, expires: string | null, name: string) {
  if (!f.access_token || !expires || Date.parse(expires) < Date.now()) throw new NeedsUser(`Log in with ${name} today on the Connect page; the session ends every morning.`);
}

async function zerodha(f: Record<string, string>, expires: string | null): Promise<Result> {
  needToken(f, expires, "Zerodha");
  const headers = { "X-Kite-Version": "3", Authorization: `token ${f.api_key}:${f.access_token}` };
  const h = await call("GET", "https://api.kite.trade/portfolio/holdings", { headers });
  if (h.status === 403) throw new NeedsUser("Zerodha ended the session. Log in with Zerodha again on the Connect page.");
  const holdings = (h.body?.data ?? []).map((r: any) => ({ sym: nse(r.tradingsymbol, r.exchange), kind: "stock" as const,
    qty: Number(r.quantity) + Number(r.t1_quantity ?? 0), avg_cost: Number(r.average_price) || null, ccy: "INR", price_local: Number(r.last_price) || null }))
    .filter((x: Holding) => x.qty > 0);
  const t = await call("GET", "https://api.kite.trade/trades", { headers });
  const trades = (t.body?.data ?? []).map((r: any) => ({ ext_id: String(r.trade_id), ts: new Date(r.fill_timestamp ?? r.exchange_timestamp).toISOString(),
    sym: r.tradingsymbol, side: r.transaction_type === "BUY" ? "buy" : "sell", qty: Number(r.quantity), price: Number(r.average_price) || null, fee: null, ccy: "INR" }));
  return { holdings, trades, note: `${holdings.length} holdings, ${trades.length} trades today` };
}

async function upstox(f: Record<string, string>, expires: string | null): Promise<Result> {
  needToken(f, expires, "Upstox");
  const headers = { Authorization: `Bearer ${f.access_token}`, Accept: "application/json" };
  const h = await call("GET", "https://api.upstox.com/v2/portfolio/long-term-holdings", { headers });
  if (h.status === 401) throw new NeedsUser("Upstox ended the session. Log in with Upstox again on the Connect page.");
  const holdings = (h.body?.data ?? []).map((r: any) => ({ sym: nse(r.trading_symbol ?? r.tradingsymbol, r.exchange), kind: "stock" as const,
    qty: Number(r.quantity) + Number(r.t1_quantity ?? 0), avg_cost: Number(r.average_price) || null, ccy: "INR", price_local: Number(r.last_price) || null }))
    .filter((x: Holding) => x.qty > 0);
  const t = await call("GET", "https://api.upstox.com/v2/order/trades/get-trades-for-day", { headers });
  const trades = (t.body?.data ?? []).map((r: any) => ({ ext_id: String(r.trade_id), ts: new Date(r.exchange_timestamp ?? r.order_timestamp ?? Date.now()).toISOString(),
    sym: r.trading_symbol ?? r.tradingsymbol, side: r.transaction_type === "BUY" ? "buy" : "sell", qty: Number(r.quantity), price: Number(r.average_price) || null, fee: null, ccy: "INR" }));
  return { holdings, trades, note: `${holdings.length} holdings, ${trades.length} trades today` };
}

async function binance(f: Record<string, string>): Promise<Result> {
  const signed = async (path: string, extra = "") => {
    const q = `${extra}${extra ? "&" : ""}timestamp=${Date.now()}&recvWindow=10000`;
    return call("GET", `https://api.binance.com${path}?${q}&signature=${await hmac(f.api_secret, q)}`, { headers: { "X-MBX-APIKEY": f.api_key } });
  };
  const rest = await signed("/sapi/v1/account/apiRestrictions");
  if (rest.status === 451) throw new Error("Binance refuses this server's location; the sync must run from India (x-region ap-south-1).");
  if (rest.status !== 200) throw new NeedsUser(`Binance refused the key (${rest.status}). Check the key and secret.`);
  const r = rest.body ?? {};
  if (r.enableWithdrawals || r.enableSpotAndMarginTrading || r.enableMargin || r.enableFutures || r.enableInternalTransfer || r.permitsUniversalTransfer) {
    throw new NeedsUser("This Binance key can trade or move funds. Create a new key with only \"Enable Reading\" ticked, and connect that instead.");
  }
  const acct = await signed("/api/v3/account", "omitZeroBalances=true");
  if (acct.status !== 200) throw new Error(`Binance account answered ${acct.status}`);
  const px: Record<string, number> = {};
  for (const t of (await call("GET", "https://api.binance.com/api/v3/ticker/price")).body ?? []) px[t.symbol] = Number(t.price);
  const stable = new Set(["USDT", "USDC", "FDUSD", "BUSD", "DAI", "TUSD"]);
  const holdings: Holding[] = [];
  for (const b of acct.body?.balances ?? []) {
    const a = String(b.asset).toUpperCase().replace(/^LD/, ""), qty = Number(b.free) + Number(b.locked);
    const p = stable.has(a) ? 1 : px[a + "USDT"] ?? null;
    if (!p || qty * p < 1) continue;
    const prev = holdings.find((h) => h.sym === `${a}-USD`);
    if (prev) prev.qty += qty; else holdings.push({ sym: `${a}-USD`, kind: "crypto", qty, avg_cost: null, ccy: "USD", price_local: p });
  }
  return { holdings, trades: [], note: `${holdings.length} coins (read-only key confirmed)` };
}

const SYNC: Record<string, (f: Record<string, string>, expires: string | null) => Promise<Result>> = { groww, coindcx, zerodha, upstox, binance };

// ------------------------------------------------------------------ one connection
async function syncOne(c: any, sealed: string | undefined) {
  let status = "ok", note = "";
  try {
    if (!sealed) throw new Error("No stored key; add it again on the Connect page.");
    const r = await SYNC[c.provider](await unseal(sealed), c.token_expires);
    note = r.note;
    await db.from("holdings").delete().eq("connection_id", c.id);
    if (r.holdings.length) await db.from("holdings").insert(r.holdings.map((h) => ({ ...h, connection_id: c.id, user_id: c.user_id })));
    if (r.trades.length) await db.from("transactions").upsert(r.trades.map((t) => ({ ...t, connection_id: c.id, user_id: c.user_id })), { onConflict: "connection_id,ext_id" });
  } catch (e) {
    status = e instanceof NeedsUser ? "needs_user" : "error";
    note = e instanceof Error ? e.message : String(e);
  }
  await db.from("connections").update({ status, note: note.slice(0, 300), ...(status === "ok" ? { last_sync_at: new Date().toISOString() } : {}) }).eq("id", c.id);
  return { provider: c.provider, status };
}

async function runAll() {
  // fund statements (provider cams) are uploaded, not synced
  const { data: conns } = await db.from("connections").select("id, user_id, provider, token_expires").neq("provider", "cams");
  const { data: secrets } = await db.from("connection_secrets").select("connection_id, sealed");
  const sealed = new Map((secrets ?? []).map((s) => [s.connection_id, s.sealed]));
  const out = [];
  for (const c of conns ?? []) out.push(await syncOne(c, sealed.get(c.id)));
  return out;
}

// ------------------------------------------------------------------ daily broker login
async function oauth(provider: "zerodha" | "upstox", params: URLSearchParams) {
  const back = (msg: string) => Response.redirect(`${APP_URL}/connect?${new URLSearchParams({ login: provider, result: msg })}`, 303);
  const state = params.get("state") ?? "";
  if (!/^[0-9a-f]{48}$/.test(state)) return back("expired");
  const { data: c } = await db.from("connections").select("id, user_id, provider, oauth_expires").eq("oauth_state", state).eq("provider", provider).maybeSingle();
  if (!c || !c.oauth_expires || Date.parse(c.oauth_expires) < Date.now()) return back("expired");
  await db.from("connections").update({ oauth_state: null, oauth_expires: null }).eq("id", c.id); // one use only
  const { data: s } = await db.from("connection_secrets").select("sealed").eq("connection_id", c.id).maybeSingle();
  if (!s) return back("failed");
  const f = await unseal(s.sealed);
  let token: string | undefined;
  if (provider === "zerodha") {
    const rt = params.get("request_token") ?? "";
    const r = await call("POST", "https://api.kite.trade/session/token", {
      headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: f.api_key, request_token: rt, checksum: await sha256(f.api_key + rt + f.api_secret) }) });
    token = r.body?.data?.access_token;
  } else {
    const r = await call("POST", "https://api.upstox.com/v2/login/authorization/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ code: params.get("code") ?? "", client_id: f.api_key, client_secret: f.api_secret,
        redirect_uri: `${FN_URL}/oauth/upstox`, grant_type: "authorization_code" }) });
    token = r.body?.access_token;
  }
  if (!token) return back("failed");
  // both brokers end sessions early next morning (India time); expire at the next 06:00 IST to be safe
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (ist.getUTCHours() >= 6 ? 1 : 0), 0, 30);
  await db.from("connection_secrets").update({ sealed: await seal({ ...f, access_token: token }) }).eq("connection_id", c.id);
  await db.from("connections").update({ token_expires: new Date(next).toISOString() }).eq("id", c.id);
  await syncOne({ ...c, token_expires: new Date(next).toISOString() }, await seal({ ...f, access_token: token }));
  return back("ok");
}

// ------------------------------------------------------------------ routes
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/sync/, "");
  try {
    if (req.method === "POST" && path === "/run") {
      const { data: expected } = await db.rpc("sync_secret");
      const got = req.headers.get("x-sync-secret") ?? "";
      if (!expected || got.length !== String(expected).length || got !== expected) return new Response("forbidden", { status: 403 });
      return Response.json({ synced: await runAll() });
    }
    if (req.method === "GET" && (path === "/oauth/zerodha" || path === "/oauth/upstox")) {
      return await oauth(path.endsWith("zerodha") ? "zerodha" : "upstox", url.searchParams);
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    // never echo key material: only the error class reaches the caller
    console.error("sync error", e instanceof Error ? e.message : e);
    return new Response("sync failed", { status: 500 });
  }
});
