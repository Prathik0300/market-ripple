# Market Ripple web app

Next.js 15 app on Vercel, Supabase for accounts and data. Step 1 of `../docs/platform-design.md`:
sign-up, required two-factor sign-in, the shared world model, and the desks with per-user game, notes and research
requests. Broker connections and the platform MCP server come in later steps.

## How it is put together

- `src/middleware.ts`: every page and API call needs a session that passed two-factor (aal2); sets a strict
  Content-Security-Policy per request (no inline scripts on the desks; nonces on Next.js pages).
- `src/app/api/docs/[...path]`: the desks' data. World documents are read-only; a user's own documents
  (`data/users/me/progress|notes|requests|portfolio`) are the only writes, size-limited, same-origin only.
  Every query runs as the signed-in user, so Postgres row-level security has the final say.
- `supabase/migrations`: tables and policies. The web app holds only the publishable key; the service role key
  stays on the owner's Mac, where `predictor.platform_sync` uploads the world documents after each 2-hourly run.
- `src/app/connectors` + `src/app/api/mcp`: MCP connectors for sources with no usable API but an official MCP
  server (Robinhood, Financial Datasets, LunarCrush; Bigdata.com in AI apps only). Per-user AI-app preference
  (`profiles.ai_client`) picks the setup steps shown. "Connect to Market Ripple" runs the MCP OAuth flow (discovery,
  dynamic client registration, PKCE), lists the server's tools once, and stores only the tokens sealed with
  `CONNECTIONS_PUBLIC_KEY` (`mcp_secrets`, no grants). `supabase/functions/mcp-sync` opens them every 2 hours,
  refreshes and re-seals them, and calls only the catalog's read tools (`supabase/functions/_shared/mcp-servers.json`,
  shared with the page) into `mcp_snapshots`. `node scripts/mcp-test-server.mjs` is a pretend broker on
  127.0.0.1:8799 for testing the whole flow. It is never listed on the page; the API accepts it only when the dev server runs with
  `MCP_TEST_SERVER=1` (`supabase/functions/_shared/mcp-test-server.json`).
- `src/app/mcp` + `src/app/oauth/consent`: the platform MCP server. A person adds `<site>/mcp` to the AI app they
  already pay for (Claude, Claude Code, Codex, Cursor), which signs in through Supabase Auth's OAuth 2.1 server
  (discovery at `/.well-known/oauth-protected-resource/mcp`, dynamic client registration, PKCE) and approves on
  `/oauth/consent` with two-factor. No Anthropic key is involved. Nine read-only tools (`src/lib/assistant/context.ts`):
  the person's portfolio and connected data, and the shared signals (with `has_skill`), feed, focus list, facts,
  events and dossiers, each result quoted as untrusted data; server instructions carry the research-only rules
  (`src/lib/assistant/rules.ts`). OAuth tokens carry `aal1`, so `supabase/migrations/20261019000500_platform_mcp.sql`
  makes the consent page vouch for each approval (`vouch_oauth`), refuses every unvouched approval with a trigger on
  `auth.oauth_authorizations` (a password alone cannot connect an app, and Auth's silent re-approval of a known app
  needs a click on the page), and adds `read_ok()` to the SELECT policies of the tables the tools read; writes and
  RPCs keep `mfa_ok()`, so an app's token can read but never change anything. Connected apps are listed and
  disconnected on `/assistant` (`/api/oauth/grants`).
- `src/app/assistant` + `src/app/api/assistant`: the in-app chat, shown only when `ANTHROPIC_API_KEY` is set (it runs
  on the platform's key). Claude (`claude-opus-5-5`, server-side refusal fallback on) with the same rules and tools,
  starting from the person's data and the shared documents. Rate-limited per user; needs two-factor.
- Tests: `node --test tests/` (offline rules); `node scripts/platform-mcp-test.mjs` (two throwaway users on the local
  Supabase, dev server on :3000: OAuth sign-in end to end, each app sees only its user's data, the token cannot
  write, password-only and direct-to-Auth approvals are refused, disconnecting ends access);
  `node scripts/assistant-rls-test.mjs --route` (cross-user reads, two-factor gate and the chat route against
  `node scripts/anthropic-mock.mjs`; start the dev server with `ANTHROPIC_BASE_URL=http://127.0.0.1:8798
  ANTHROPIC_API_KEY=mock-key`); with a real key `node scripts/assistant-refusal-eval.mjs` (advice and
  prompt-injection cases graded by Claude).
- `public/desk`: the desks, generated from `../map/index.html` by `npm run desk` (the claude.ai page stays the
  single source; `desk-src/runtime.js` answers its `claude.use(...)` calls from this app's API).

## Run locally

```bash
npx supabase start          # Postgres, Auth and a test mail inbox in Docker
npm run dev                 # http://localhost:3000
```

`.env.local` needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (from `npx supabase status`).
Confirmation emails land in the local inbox at http://127.0.0.1:54324.

## Deploy

1. Create a Supabase project, then apply the schema: `npx supabase link --project-ref <ref>` and `npx supabase db push`.
2. In Supabase > Authentication: turn on TOTP multi-factor, turn **off** "Confirm email" for now (sign-up goes
   straight to the required two-factor setup; turn it back on once a fast email sender such as Resend is set up as
   custom SMTP), minimum password length 12 with all character types, set the Site URL to the Vercel address and
   add `<site>/auth/confirm` as a redirect URL.
3. Create the Vercel project with root directory `web/`, and set `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. `ANTHROPIC_API_KEY` is optional (server-only,
   never `NEXT_PUBLIC_`): without it the in-app chat is hidden and people use their own AI app through `/mcp`.
   For the platform MCP server: apply the migrations first (the approval trigger must exist), then in Supabase >
   Authentication > OAuth Server turn the server on with authorization path `/oauth/consent` and dynamic client
   registration allowed, and switch JWT signing to an asymmetric key if it is still HS256.
4. On the Mac, add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the keys file; the next 2-hourly run
   uploads the world data (or run `.venv/bin/python -m predictor.platform_sync --all`).
