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
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
4. On the Mac, add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the keys file; the next 2-hourly run
   uploads the world data (or run `.venv/bin/python -m predictor.platform_sync --all`).
