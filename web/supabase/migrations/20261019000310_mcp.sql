-- MCP connectors: data sources with no usable API that a user signs in to through their official MCP server.
--
-- The web app runs the OAuth sign-in (PKCE), then seals the tokens with the platform public key, exactly like
-- broker keys: neither the web app nor any signed-in role can read them back. The 2-hourly pipeline (service
-- role, holds the private key) opens them, refreshes them, calls only an allowlist of read tools, and stores
-- what it read as the user's private snapshots.

-- which AI app the user uses, so the Connectors page shows the steps for that app
alter table public.profiles add column if not exists ai_client text
  check (ai_client in ('claude-desktop', 'claude-code', 'cursor', 'vscode', 'codex'));
grant update (ai_client) on public.profiles to authenticated;

create table public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  server text not null check (server ~ '^[a-z0-9-]{2,32}$'),
  status text not null default 'pending' check (status in ('pending', 'ok', 'needs_user', 'error')),
  note text check (char_length(note) <= 300),
  tools jsonb not null default '[]',            -- the server's tool names at sign-in, for display
  last_sync_at timestamptz,
  sync_started_at timestamptz,                  -- set while a pull runs (Sync now or the schedule); a lock against double runs
  created_at timestamptz not null default now(),
  unique (user_id, server)
);
alter table public.mcp_connections enable row level security;
create policy mcp_connections_read_own on public.mcp_connections for select to authenticated
  using (user_id = (select auth.uid()) and public.mfa_ok());

create table public.mcp_secrets (
  connection_id uuid primary key references public.mcp_connections on delete cascade,
  sealed text not null check (char_length(sealed) <= 16000),
  updated_at timestamptz not null default now(),
  constraint mcp_sealed_envelope check (sealed ~ '^\{"v":1,"k":"[A-Za-z0-9+/=]{255}[A-Za-z0-9+/=]*","iv":"[A-Za-z0-9+/=]{16}","ct":"[A-Za-z0-9+/=]+","tag":"[A-Za-z0-9+/=]{24}"\}$')
);
alter table public.mcp_secrets enable row level security;
-- no policies and no grants: only the service role (the pipeline) reads or rewrites tokens
revoke all on public.mcp_secrets from anon, authenticated;

-- what the pipeline read from each connection, newest pull per tool
create table public.mcp_snapshots (
  connection_id uuid not null references public.mcp_connections on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  tool text not null,
  items int,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (connection_id, tool)
);
alter table public.mcp_snapshots enable row level security;
create policy mcp_snapshots_read_own on public.mcp_snapshots for select to authenticated
  using (user_id = (select auth.uid()) and public.mfa_ok());

revoke insert, update, delete on public.mcp_connections, public.mcp_snapshots from authenticated;
revoke all on public.mcp_connections, public.mcp_snapshots from anon;

create or replace function public.add_mcp_connection(p_server text, p_sealed text, p_tools jsonb, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  if jsonb_typeof(p_tools) <> 'array' or jsonb_array_length(p_tools) > 300 then raise exception 'bad tool list'; end if;
  insert into public.mcp_connections (user_id, server, status, note, tools)
    values ((select auth.uid()), p_server, 'pending', left(p_note, 300), p_tools)
    on conflict (user_id, server) do update set status = 'pending', note = left(excluded.note, 300), tools = excluded.tools
    returning id into v_id;
  insert into public.mcp_secrets (connection_id, sealed) values (v_id, p_sealed)
    on conflict (connection_id) do update set sealed = excluded.sealed, updated_at = now();
  insert into public.audit_log (user_id, event, meta) values ((select auth.uid()), 'mcp_connected', jsonb_build_object('server', p_server));
  return v_id;
end $$;

create or replace function public.remove_mcp_connection(p_server text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  -- deletes the sealed tokens and every snapshot with it
  delete from public.mcp_connections where user_id = (select auth.uid()) and server = p_server;
  insert into public.audit_log (user_id, event, meta) values ((select auth.uid()), 'mcp_removed', jsonb_build_object('server', p_server));
end $$;
revoke all on function public.add_mcp_connection(text, text, jsonb, text), public.remove_mcp_connection(text) from public, anon;
grant execute on function public.add_mcp_connection(text, text, jsonb, text), public.remove_mcp_connection(text) to authenticated;

-- Sync now: claim the connection for one pull. Returns false when a pull is already running (started under 5 minutes
-- ago), so pressing the button twice, or pressing it during the scheduled run, never starts a second pull.
create or replace function public.claim_mcp_sync(p_server text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  update public.mcp_connections set sync_started_at = now()
    where user_id = (select auth.uid()) and server = p_server
      and (sync_started_at is null or sync_started_at < now() - interval '5 minutes');
  return found;
end $$;
-- give the claim back when the pull could not even start (the sync function was unreachable)
create or replace function public.release_mcp_sync(p_server text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  update public.mcp_connections set sync_started_at = null where user_id = (select auth.uid()) and server = p_server;
end $$;
revoke all on function public.claim_mcp_sync(text), public.release_mcp_sync(text) from public, anon;
grant execute on function public.claim_mcp_sync(text), public.release_mcp_sync(text) to authenticated;

-- Schedule: the mcp-sync function runs every 2 hours next to the broker sync, with the same Vault secret, e.g.
--   select cron.schedule('mcp-sync', '15 */2 * * *', $$ select net.http_post(
--     url := '<SUPABASE_URL>/functions/v1/mcp-sync/run',
--     headers := jsonb_build_object('x-sync-secret', public.sync_secret())) $$);
-- It is added together with the broker sync's own schedule, so both read the project URL the same way.
