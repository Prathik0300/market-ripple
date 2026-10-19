-- Step 3: investing-platform connections, sealed broker keys, holdings, transactions, per-user reports,
-- and the event history the reports explain moves with.
--
-- Broker keys arrive already encrypted by the web server with a public key (RSA-OAEP + AES-256-GCM).
-- Only the sync worker holds the private key, so neither the web app nor the database can read them.
-- No signed-in role can select connection_secrets at all; users add and remove keys only through the two
-- functions below, which act on their own rows.

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  provider text not null check (provider in ('groww', 'coindcx')),
  status text not null default 'pending' check (status in ('pending', 'ok', 'needs_user', 'error')),
  note text check (char_length(note) <= 300),
  key_hint text check (char_length(key_hint) <= 12),     -- last 4 characters of the API key, for display
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);
alter table public.connections enable row level security;
create policy connections_read_own on public.connections for select to authenticated
  using (user_id = (select auth.uid()) and public.mfa_ok());

create table public.connection_secrets (
  connection_id uuid primary key references public.connections on delete cascade,
  sealed text not null check (char_length(sealed) <= 8000),
  created_at timestamptz not null default now()
);
alter table public.connection_secrets enable row level security;
-- deliberately no policies and no grants: only the service role (the sync worker) can read this table
revoke all on public.connection_secrets from anon, authenticated;

create or replace function public.add_connection(p_provider text, p_sealed text, p_hint text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  insert into public.connections (user_id, provider, status, note, key_hint)
    values ((select auth.uid()), p_provider, 'pending', 'Waiting for the first sync', left(p_hint, 12))
    on conflict (user_id, provider) do update set status = 'pending', note = 'Waiting for the first sync', key_hint = excluded.key_hint
    returning id into v_id;
  insert into public.connection_secrets (connection_id, sealed) values (v_id, p_sealed)
    on conflict (connection_id) do update set sealed = excluded.sealed, created_at = now();
  insert into public.audit_log (user_id, event, meta) values ((select auth.uid()), 'connection_added', jsonb_build_object('provider', p_provider));
  return v_id;
end $$;

create or replace function public.remove_connection(p_provider text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  -- removing the connection deletes its sealed key, holdings and transactions with it
  delete from public.connections where user_id = (select auth.uid()) and provider = p_provider;
  insert into public.audit_log (user_id, event, meta) values ((select auth.uid()), 'connection_removed', jsonb_build_object('provider', p_provider));
end $$;
revoke all on function public.add_connection(text, text, text), public.remove_connection(text) from public, anon;
grant execute on function public.add_connection(text, text, text), public.remove_connection(text) to authenticated;

-- what each connection holds, as of its last sync
create table public.holdings (
  connection_id uuid not null references public.connections on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  sym text not null,                      -- RELIANCE.NS, BTC-USD
  kind text not null check (kind in ('stock', 'crypto', 'fund')),
  qty numeric not null,
  avg_cost numeric,
  ccy text not null default 'INR',
  price_local numeric,
  as_of timestamptz not null default now(),
  primary key (connection_id, sym)
);
-- orders and trades, newest first in the app
create table public.transactions (
  connection_id uuid not null references public.connections on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  ext_id text not null,                   -- the broker's trade id
  ts timestamptz not null,
  sym text not null,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null,
  price numeric,
  fee numeric,
  ccy text not null default 'INR',
  primary key (connection_id, ext_id)
);
create index transactions_user_ts on public.transactions (user_id, ts desc);
create index holdings_user on public.holdings (user_id);

-- per-user analysis written by the pipeline (the portfolio report the Portfolio desk shows)
create table public.user_reports (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('portfolio')),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

alter table public.holdings enable row level security;
alter table public.transactions enable row level security;
alter table public.user_reports enable row level security;
create policy holdings_read_own on public.holdings for select to authenticated using (user_id = (select auth.uid()) and public.mfa_ok());
create policy transactions_read_own on public.transactions for select to authenticated using (user_id = (select auth.uid()) and public.mfa_ok());
create policy reports_read_own on public.user_reports for select to authenticated using (user_id = (select auth.uid()) and public.mfa_ok());
-- users never write these; the pipeline does
revoke insert, update, delete on public.connections, public.holdings, public.transactions, public.user_reports from authenticated;

-- the world-event history (shared), so moves can be matched to what happened that day
create table public.events (
  id text primary key,
  ts timestamptz not null,
  title text not null,
  summary text,
  url text,
  source text,
  region text,
  category text,
  scale text,
  nodes jsonb
);
create index events_ts on public.events (ts);
alter table public.events enable row level security;
create policy events_read on public.events for select to authenticated using (public.mfa_ok());

revoke all on public.connections, public.holdings, public.transactions, public.user_reports, public.events from anon;
