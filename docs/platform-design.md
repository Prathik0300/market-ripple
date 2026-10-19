# Market Ripple platform: design draft

A multi-user version of today's single-owner system. Everyone shares one world model (events, causal graph,
calibrated links, signals, dossiers). Each user's portfolio, progress and connections stay private to them.
Connecting brokers is optional: without it a user still gets the news, graph, research and game, just no holdings.

## 1. Pieces

| Piece | What it does | Who can reach it |
|---|---|---|
| Web app (Next.js) | Sign-up, desks, settings, connect brokers, connect an LLM | Signed-in users, their own data only |
| API (Next.js route handlers) | Reads for the app, writes for progress, notes and calls | Session cookie; per-user row checks |
| Platform MCP server | Lets a user's Claude or Codex read *their* data and the shared world model | OAuth 2.1 token per user and client, read-only scopes |
| Sync workers | Pull holdings from Groww, CoinDCX, CAS statements and others | Internal only; the only code that can decrypt broker keys |
| World pipeline (today's `predictor/`) | Events, calibration, model, dossiers, every 2 hours | Internal; writes shared tables only |
| Postgres | Everything below | Separate DB roles per piece, row-level security |
| Key service (KMS) | Wraps the per-connection data keys for broker credentials | Sync workers only |

The rule that keeps portfolios safe: **no path from an LLM, a browser or the MCP server can reach a broker
credential or a broker write endpoint.** Those live only inside the sync workers, which can call nothing but an
allowlist of read endpoints (as `predictor/brokers.py` does today).

## 2. Database schema (Postgres)

Shared world data (one copy for everyone, read-only to users):

```sql
create table instruments (
  id bigserial primary key,
  kind text not null check (kind in ('stock','crypto','fund','commodity','index','fx')),
  symbol text not null,            -- RELIANCE.NS, BTC-USD, MF_122639
  exchange text, isin text, amfi_code text, name text not null, sector text,
  unique (kind, symbol)
);
create table prices_daily (instrument_id bigint references instruments, d date, close numeric not null,
  primary key (instrument_id, d));
create table events (id text primary key, ts timestamptz not null, title text not null, summary text, url text,
  source text, region text, category text, scale text check (scale in ('minor','notable','major')));
create table event_nodes (event_id text references events, node text, dir smallint, why text, primary key (event_id, node));
create table graph_edges (src text, dst text, sign smallint, weight numeric, calibration jsonb, primary key (src, dst));
create table signals (node text, horizon smallint, asof date, prob_up numeric, has_skill boolean, auc numeric,
  primary key (node, horizon, asof));
create table dossiers (key text primary key, kind text, doc jsonb not null, updated_at timestamptz not null);
create table instrument_profiles (instrument_id bigint primary key references instruments, exposures jsonb, moves jsonb, asof date);
```

People and their private data (every table carries `user_id`, guarded by row-level security):

```sql
create table users (
  id uuid primary key,                       -- the auth provider's user id
  email citext unique not null,
  created_at timestamptz default now(),
  status text default 'active' check (status in ('active','locked','deleted')),
  base_currency text default 'USD', mfa_required boolean default true
);

-- one row per broker or data source a user links; all optional
create table connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  provider text not null check (provider in ('groww','coindcx','robinhood','cams_cas','zerodha','manual')),
  status text not null default 'pending' check (status in ('pending','ok','needs_user','error','revoked')),
  note text, last_sync_at timestamptz, created_at timestamptz default now(),
  unique (user_id, provider)
);

-- broker secrets, in their own table that only the sync role can read
create table connection_secrets (
  connection_id uuid primary key references connections on delete cascade,
  ciphertext bytea not null,                 -- AES-256-GCM of the key/secret JSON
  wrapped_dek bytea not null,                -- data key wrapped by the KMS master key
  kms_key_id text not null, fingerprint text not null,   -- last 4 of the key, for display
  created_at timestamptz default now(), rotated_at timestamptz
);

create table holdings (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  connection_id uuid references connections on delete cascade,
  instrument_id bigint not null references instruments,
  qty numeric not null, avg_cost numeric, cost_ccy text not null,
  cost_source text check (cost_source in ('broker','trades','statement','user')),
  as_of timestamptz not null,
  unique (connection_id, instrument_id)
);
create table holding_snapshots (user_id uuid, d date, value_usd numeric, by_account jsonb, primary key (user_id, d));

-- LLM clients a user connected to the platform MCP server
create table mcp_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  client_id text not null, client_name text, redirect_uris text[] not null,
  created_at timestamptz default now(), revoked_at timestamptz
);
create table mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  client_ref uuid not null references mcp_clients on delete cascade,
  user_id uuid not null references users on delete cascade,
  token_hash bytea not null unique,           -- store only a hash
  scopes text[] not null,                     -- e.g. {'world:read','portfolio:read'}
  expires_at timestamptz not null, revoked_at timestamptz, last_used_at timestamptz
);
create table mcp_calls (id bigserial primary key, user_id uuid, client_ref uuid, tool text not null,
  args_hash bytea, outcome text, ms int, ts timestamptz default now());

-- game, per user
create table progress (user_id uuid primary key references users on delete cascade, xp int default 0,
  level int default 1, streak int default 0, last_active date, badges text[] default '{}');
create table actions (id bigserial primary key, user_id uuid references users on delete cascade,
  action text not null, meta jsonb, ts timestamptz default now());
create table forecast_calls (id bigserial primary key, user_id uuid references users on delete cascade,
  instrument_id bigint references instruments, dir smallint, conf numeric, base_date date, base numeric,
  model_p numeric, status text default 'open', brier numeric, resolved_at timestamptz);
create table notes (user_id uuid references users on delete cascade, key text, body text,
  updated_at timestamptz, primary key (user_id, key));
create table research_requests (id bigserial primary key, user_id uuid references users on delete cascade,
  key text, status text default 'pending', created_at timestamptz default now());

create table audit_log (id bigserial primary key, user_id uuid, actor text, event text not null,
  ip inet, meta jsonb, ts timestamptz default now());
```

Row-level security, for every private table:

```sql
alter table holdings enable row level security;
create policy own_rows on holdings using (user_id = auth.uid());
-- connection_secrets: no policy for the app role at all, so the app can never select it;
-- only the sync_worker role (bypassing RLS by grant) reads it.
```

## 3. What a connected LLM can and cannot do

The platform MCP server exposes **read tools only**:

| Tool | Scope | Returns |
|---|---|---|
| `world_events`, `graph_path`, `signals`, `dossier` | `world:read` | Shared world model |
| `my_holdings`, `my_exposure`, `my_pressure` | `portfolio:read` | The caller's own holdings and how news presses on them |
| `my_progress`, `make_forecast_call` | `game:write` | The only write: a forecast call in the caller's own game |

There is no tool that places, previews or cancels an order, moves money, reads or changes broker keys, adds
connections, or touches another user. This is enforced in layers, so a misbehaving or prompt-injected LLM has
nothing to misuse:

1. **No dangerous tools exist.** The MCP server has no code path to brokers; it reads Postgres through a role
   with SELECT on world tables and the caller's rows only.
2. **Tokens are narrow.** OAuth 2.1 with PKCE, per user and client, short-lived access tokens (15 min) and
   rotating refresh tokens, revocable from Settings; stored as hashes.
3. **Database enforces ownership.** Every query runs as the caller (`auth.uid()`), so even a bug cannot return
   another user's rows.
4. **Broker keys are sealed.** Envelope-encrypted per connection; only sync workers can unwrap them, and the
   workers' HTTP client refuses any URL outside a per-broker read allowlist and any redirect.
5. **Tool output is data.** Headlines and dossiers are returned as quoted data with provenance, and the server
   never follows instructions inside them.
6. **Rate limits and audit.** Per token and per user (for example 60 calls a minute); every call is logged in
   `mcp_calls` and visible to the user.

## 4. Security layer for the app

- Sign-in with email plus a required second factor (TOTP or passkey); new devices confirmed by email.
- Sessions in HttpOnly, Secure, SameSite=Lax cookies; CSRF checks (origin plus token) on every write.
- Strict Content-Security-Policy with nonces, HSTS, `frame-ancestors 'none'`, no third-party scripts.
- Every input validated (zod); every route checks the session and the row owner.
- Secrets only in the host's secret store; broker keys never logged or returned to the browser (only a
  fingerprint and status); users can delete a connection, which deletes its secret at once.
- Dependency pinning, automated vulnerability scans, separate staging and production databases, backups.
- Security events (sign-in, MFA change, connection added or removed, token issued or revoked) in `audit_log`,
  with email alerts to the user for the sensitive ones.

## 5. Things to settle before launch (not engineering)

- **Broker terms.** Groww's and CoinDCX's API keys are issued for the account holder's own use; holding other
  people's keys on a platform may break those terms. Check each broker's API terms, or use their official
  partner or OAuth programs where they exist.
- **Indian regulation.** A platform that holds users' portfolios and shows them research may need registration
  (SEBI rules for research analysts, investment advisers and algo-trading vendors); crypto platforms also have
  FIU-IND obligations. Get legal advice before opening sign-ups to others.
- **Privacy law.** India's DPDP Act (and GDPR for EU users): consent, data minimisation, deletion on request,
  and a breach process.
- **Positioning.** Keep it research and education, not buy or sell advice, as the single-user version is today.

## 6. Build order

1. Auth, users, settings, shared world tables, and the desks reading them (no brokers yet).
2. Per-user game, notes, forecast calls.
3. Connections with sealed keys and the sync workers (Groww, CoinDCX, CAS upload), holdings and portfolio desk.
4. Platform MCP server with OAuth and read tools; connect Claude and Codex.
5. Hardening: rate limits, audit views, security review, load test, then deploy.
