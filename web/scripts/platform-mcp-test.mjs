// End-to-end test of the platform MCP server and its OAuth sign-in. Local Supabase in Docker only, with the OAuth
// server on (supabase/config.toml) and the dev server on :3000 (Auth sends consent to the Site URL).
//
//   node scripts/platform-mcp-test.mjs
//
// For two throwaway users it acts as an AI app would: registers itself (dynamic client registration), starts the
// authorization with PKCE, has the user approve on /oauth/consent, swaps the code for tokens, then calls /mcp.
// Checks: each user's app sees only that user's data; the token reads but cannot write; approving with only a
// password (straight against Auth, skipping our two-factor consent page) is refused, including Auth's automatic
// re-approval; browser session tokens and missing tokens are turned away; refresh works; disconnecting ends access.
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { APP, KEY, URL_, check, finish, makeUser } from "./test-users.mjs";

const REDIRECT = "http://127.0.0.1:9/callback";
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));

async function register(name) {
  const res = await fetch(`${URL_}/auth/v1/oauth/clients/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  return (await res.json()).client_id;
}

async function authorize(clientId) {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: randomBytes(8).toString("hex"), scope: "openid email",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${APP}/mcp`,
  });
  const res = await fetch(`${URL_}/auth/v1/oauth/authorize?${q}`, { redirect: "manual" });
  const loc = new URL(res.headers.get("location"));
  return { verifier, consentUrl: loc, id: loc.searchParams.get("authorization_id") };
}

async function decide(cookie, id, decision) {
  const res = await fetch(`${APP}/api/oauth/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-ripple": "1", cookie }, body: JSON.stringify({ authorization_id: id, decision }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function token(params) {
  const res = await fetch(`${URL_}/auth/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  return res.json();
}

let rpcId = 0;
async function mcp(accessToken, method, params) {
  const res = await fetch(`${APP}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, www: res.headers.get("www-authenticate") };
}
const call = async (t, name, args = {}) => {
  const r = await mcp(t, "tools/call", { name, arguments: args });
  return { ...r, out: r.json?.result?.content?.map((c) => c.text).join("\n") ?? "" };
};

// a full, legitimate connection: register, authorize, approve on our consent page, exchange the code
async function connect(user, name) {
  const clientId = await register(name);
  const { verifier, consentUrl, id } = await authorize(clientId);
  const page = await fetch(consentUrl, { headers: { cookie: user.aal2.cookie() }, redirect: "manual" });
  const html = await page.text();
  const d = await decide(user.aal2.cookie(), id, "approve");
  const code = d.body.redirect_url ? new URL(d.body.redirect_url).searchParams.get("code") : null;
  const tok = code ? await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) : {};
  return { clientId, consentUrl, page, html, decision: d, tok };
}

async function flow(me, other) {
  const c = await connect(me, `Test app ${me.tag}`);
  check(c.consentUrl.origin + c.consentUrl.pathname === `${APP}/oauth/consent`, `${me.tag}: Auth sends the person to our consent page`);
  check(c.page.status === 200 && c.html.includes(`Test app ${me.tag}`) && c.html.includes("Read-only"), `${me.tag}: consent page names the app and says it is read-only`);
  check(c.decision.status === 200 && !!c.tok.access_token, `${me.tag}: approving on the consent page yields tokens`);
  const t = c.tok.access_token;
  const cl = claimsOf(t);
  check(cl.sub === me.id && cl.client_id === c.clientId, `${me.tag}: token is for this person and this app (aal=${cl.aal})`);

  const init = await mcp(t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check(init.status === 200 && init.json?.result?.serverInfo?.name === "market-ripple" && /buy, sell, hold/.test(init.json?.result?.instructions ?? ""), `${me.tag}: initialize returns the server with its research-only instructions`);
  const list = await mcp(t, "tools/list", {});
  const tools = list.json?.result?.tools ?? [];
  check(tools.length === 9 && tools.every((x) => x.annotations?.readOnlyHint === true), `${me.tag}: tools/list has 9 read-only tools`);
  const mine = await call(t, "get_my_portfolio");
  check(mine.out.includes(me.sym) && mine.out.includes(me.marker), `${me.tag}: get_my_portfolio returns ${me.tag}'s own data`);
  check(!mine.out.includes(other.sym) && !mine.out.includes(other.marker), `${me.tag}: get_my_portfolio has nothing of ${other.tag}'s`);
  check(/trust="untrusted"/.test(mine.out), `${me.tag}: tool results are quoted as untrusted data`);
  const snap = await call(t, "get_my_connected_data", { tool: "get_positions" });
  check(snap.out.includes(me.marker) && !snap.out.includes(other.marker), `${me.tag}: connected data is ${me.tag}'s own`);
  const sig = await call(t, "get_signals", { keys: [] });
  check(/has_skill/.test(sig.out) && /"items":\[\{/.test(sig.out), `${me.tag}: shared signals readable, with has_skill`);
  const dos = await call(t, "get_dossier", { key: "BTC" });
  check(dos.out.includes("dossier/BTC") && !dos.out.includes('"private"'), `${me.tag}: shared dossier readable, owner-only field stripped`);
  const ev = await call(t, "search_events", { query: "Hormuz", days: 365 });
  check(ev.status === 200 && !ev.json?.result?.isError, `${me.tag}: event search works`);
  const bad = await call(t, "get_dossier", { key: "../../etc" });
  check(bad.json?.result?.isError === true || !!bad.json?.error, `${me.tag}: invalid tool input is rejected`);

  // the same token straight against the database: reads its own rows only, writes nothing
  const db = createClient(URL_, KEY, { global: { headers: { Authorization: `Bearer ${t}` } }, auth: { persistSession: false } });
  const h = await db.from("holdings").select("user_id, sym");
  check(!h.error && h.data.length === 1 && h.data[0].user_id === me.id, `${me.tag}: token reads only ${me.tag}'s holdings via the database`);
  const h2 = await db.from("holdings").select("sym").eq("user_id", other.id);
  check(!h2.error && h2.data.length === 0, `${me.tag}: token asking for ${other.tag}'s rows gets none`);
  const w1 = await db.from("user_docs").insert({ user_id: me.id, key: "notes", data: { x: 1 } });
  check(!!w1.error, `${me.tag}: token cannot write notes`);
  const w2 = await db.from("profiles").update({ display_name: "hacked" }).eq("id", me.id).select("id");
  check(!!w2.error || (w2.data ?? []).length === 0, `${me.tag}: token cannot change the profile`);
  const w3 = await db.rpc("remove_connection", { p_provider: "cams" });
  check(!!w3.error, `${me.tag}: token cannot remove a broker connection`);
  const w4 = await db.rpc("vouch_oauth", { p_authorization_id: "abcdefgh12" });
  check(!!w4.error, `${me.tag}: token cannot vouch for other approvals`);
  const notes = await db.from("user_docs").select("key");
  check(!notes.error && notes.data.length === 0, `${me.tag}: token cannot read private notes (not part of the MCP tools)`);

  // refresh keeps working while the app is connected
  const r = await token({ grant_type: "refresh_token", refresh_token: c.tok.refresh_token, client_id: c.clientId });
  const after = r.access_token ? await call(r.access_token, "get_my_portfolio") : { out: "" };
  check(after.out.includes(me.sym), `${me.tag}: refreshed token works`);
  return { ...c, token: r.access_token ?? t };
}

async function attacks(a, aConn) {
  // missing and wrong tokens
  const none = await mcp(null, "tools/list", {});
  check(none.status === 401 && /resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp"/.test(none.www ?? ""), "no token -> 401 pointing to the protected-resource metadata");
  const meta = await (await fetch(`${APP}/.well-known/oauth-protected-resource/mcp`)).json();
  check(meta.resource === `${APP}/mcp` && meta.authorization_servers?.[0] === `${URL_}/auth/v1`, "protected-resource metadata names /mcp and the Auth server");
  const session = (await a.aal2.client.auth.getSession()).data.session.access_token;
  check((await mcp(session, "tools/list", {})).status === 401, "a browser session token (not an AI app's) -> 401");
  check((await mcp("abc.def.ghi", "tools/list", {})).status === 401, "a forged token -> 401");

  // password only: approve straight against Auth, skipping the two-factor consent page
  const evil = await register("Password-only app");
  const req1 = await authorize(evil);
  await a.aal1.client.auth.oauth.getAuthorizationDetails(req1.id);
  const ap = await a.aal1.client.auth.oauth.approveAuthorization(req1.id, { skipBrowserRedirect: true });
  check(!!ap.error && !ap.data?.redirect_url, "approving with only a password (aal1) straight against Auth is refused");
  // an app consented before: Auth would re-approve on the details call; without our vouch it is refused
  const req2 = await authorize(aConn.clientId);
  const det = await a.aal1.client.auth.oauth.getAuthorizationDetails(req2.id);
  check(!!det.error || !("redirect_url" in (det.data ?? {})), "Auth's automatic re-approval of a known app is refused without the consent page");
  // even a two-factor session must go through the page: calling Auth directly is refused too
  const req3 = await authorize(evil);
  await a.aal2.client.auth.oauth.getAuthorizationDetails(req3.id);
  const ap2 = await a.aal2.client.auth.oauth.approveAuthorization(req3.id, { skipBrowserRedirect: true });
  check(!!ap2.error, "approving straight against Auth (not via the consent page) is refused even with two-factor");
  // the consent page itself asks for two-factor
  const req4 = await authorize(evil);
  const p1 = await fetch(req4.consentUrl, { headers: { cookie: a.aal1.cookie() }, redirect: "manual" });
  check(p1.status === 307 && (p1.headers.get("location") ?? "").includes("/mfa?next=%2Foauth%2Fconsent%3Fauthorization_id%3D"), "consent page with only a password -> two-factor first, then back");
  const p2 = await fetch(req4.consentUrl, { redirect: "manual" });
  check(p2.status === 307 && (p2.headers.get("location") ?? "").includes("/login?next="), "consent page signed out -> sign in first, then back");
  const d1 = await decide(a.aal1.cookie(), req4.id, "approve");
  check(d1.status === 403, "decision API with only a password -> 403");
  const d2 = await fetch(`${APP}/api/oauth/decision`, { method: "POST", headers: { "content-type": "application/json", "x-ripple": "1", cookie: a.aal2.cookie(), origin: "https://evil.example" }, body: JSON.stringify({ authorization_id: req4.id, decision: "approve" }) });
  check(d2.status === 403, "decision API from another site -> 403");
  // deny works and gives the app an error, not a code
  const dn = await decide(a.aal2.cookie(), req4.id, "deny");
  check(dn.status === 200 && /error=access_denied/.test(dn.body.redirect_url ?? "") && !/code=/.test(dn.body.redirect_url ?? ""), "deny sends the app back with access_denied");
  // denying an app approved before: no code either way
  const req5 = await authorize(aConn.clientId);
  const dn2 = await decide(a.aal2.cookie(), req5.id, "deny");
  check(dn2.status === 200 && !/code=/.test(dn2.body.redirect_url ?? "") && (dn2.body.denied === true || /error=access_denied/.test(dn2.body.redirect_url ?? "")), "denying an app approved before gives it no code");
}

async function revoke(a, aConn) {
  const before = await fetch(`${APP}/api/oauth/grants`, { headers: { cookie: a.aal2.cookie() } }).then((r) => r.json());
  check(before.apps?.some((x) => x.id === aConn.clientId), "connected apps list shows the app");
  const del = await fetch(`${APP}/api/oauth/grants?client_id=${aConn.clientId}`, { method: "DELETE", headers: { cookie: a.aal2.cookie(), "x-ripple": "1" } });
  check(del.status === 200, "disconnect succeeds");
  const after = await mcp(aConn.token, "tools/list", {});
  check(after.status === 401, "after disconnecting, the app's token is refused at once");
  const r = await token({ grant_type: "refresh_token", refresh_token: aConn.tok.refresh_token, client_id: aConn.clientId });
  check(!r.access_token, "after disconnecting, the app cannot refresh");
}

async function accountEndpoints(t) {
  // what an AI app's token can do against Auth itself (outside Market Ripple's code): reported, not asserted
  const u = await fetch(`${URL_}/auth/v1/user`, { method: "PUT", headers: { apikey: KEY, authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ data: { probe: 1 } }) });
  const p = await fetch(`${URL_}/auth/v1/user`, { method: "PUT", headers: { apikey: KEY, authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ password: "Zz-" + randomBytes(10).toString("hex") + "-Aa9!" }) });
  const f = await fetch(`${URL_}/auth/v1/factors`, { headers: { apikey: KEY, authorization: `Bearer ${t}` } });
  console.log(`INFO  Auth API with an AI app token: update metadata ${u.status}, change password ${p.status} ${(await p.text()).slice(0, 120)}, list factors ${f.status}`);
  check(p.status >= 400, "an AI app's token cannot change the password");
}

const users = [];
try {
  const a = await makeUser("a"); users.push(a);
  const b = await makeUser("b"); users.push(b);
  const aConn = await flow(a, b);
  const bConn = await flow(b, a);
  await attacks(a, aConn);
  await accountEndpoints(bConn.token);
  await revoke(a, aConn);
} finally {
  await finish(users);
}
