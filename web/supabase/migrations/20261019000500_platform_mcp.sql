-- Platform MCP server: a user's own AI app (Claude, Claude Code, Codex, Cursor ...) signs in to Market Ripple through
-- Supabase Auth's OAuth 2.1 server and reads that user's data and the shared world model through /mcp.
--
-- OAuth access tokens always carry aal1, so the two-factor rule (mfa_ok) would block them, and simply trusting them
-- would let anyone with only a password approve an app straight against the Auth API and skip two-factor. So:
--   1. the consent page (two-factor session required) vouches for each authorization it approves (vouch_oauth),
--   2. a trigger on auth.oauth_authorizations refuses every approval that was not vouched, including the automatic
--      re-approval Auth does when the user consented before, and
--   3. a separate read gate (read_ok) admits OAuth sessions on the tables the MCP tools read. Every write, RPC and
--      the user's notes keep mfa_ok, so an AI app's token can read but never change anything.
-- Apply this before turning on the OAuth server in the dashboard, so no approval can happen without the trigger.

create table public.mcp_vouches (
  authorization_id text primary key check (char_length(authorization_id) between 8 and 128),
  user_id uuid not null references auth.users on delete cascade,
  vouched_at timestamptz not null default now()
);
alter table public.mcp_vouches enable row level security;
-- no policies: only the two functions below touch it
revoke all on public.mcp_vouches from anon, authenticated;

-- called by the consent page right before it approves; needs a two-factor browser session (not an OAuth token)
create or replace function public.vouch_oauth(p_authorization_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not public.mfa_ok() or (select auth.jwt() ->> 'client_id') is not null then
    raise exception 'two-factor sign-in required';
  end if;
  insert into public.mcp_vouches (authorization_id, user_id) values (p_authorization_id, v_uid)
  on conflict (authorization_id) do update set vouched_at = now() where public.mcp_vouches.user_id = v_uid;
  delete from public.mcp_vouches where vouched_at < now() - interval '1 day';
end $$;
revoke all on function public.vouch_oauth(text) from public, anon;
grant execute on function public.vouch_oauth(text) to authenticated;

-- what the consent page shows: which app is asking and where it will send the person back. It reads Auth's own
-- tables so the page never calls the Auth details endpoint before the person clicks (that endpoint re-approves an
-- app consented to before, which would let a crafted link connect an app without a click).
create or replace function public.oauth_request(p_authorization_id text)
returns table (client_name text, client_uri text, redirect_uri text, scope text, consented_before boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not public.mfa_ok() or (select auth.jwt() ->> 'client_id') is not null then
    raise exception 'two-factor sign-in required';
  end if;
  return query
    select c.client_name, c.client_uri, a.redirect_uri, a.scope,
           exists (select 1 from auth.oauth_consents k where k.user_id = v_uid and k.client_id = a.client_id and k.revoked_at is null)
    from auth.oauth_authorizations a join auth.oauth_clients c on c.id = a.client_id
    where a.authorization_id = p_authorization_id and a.status::text = 'pending' and a.expires_at > now()
      and (a.user_id is null or a.user_id = v_uid) and c.deleted_at is null;
end $$;
revoke all on function public.oauth_request(text) from public, anon;
grant execute on function public.oauth_request(text) to authenticated;

create or replace function public.oauth_approval_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status::text = 'approved' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not exists (
      select 1 from public.mcp_vouches v
      where v.authorization_id = new.authorization_id and v.user_id = new.user_id
        and v.vouched_at > now() - interval '15 minutes'
    ) then
      raise exception 'Market Ripple: approve AI apps from the consent page with two-factor sign-in';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.oauth_approval_guard() from public, anon, authenticated;

create trigger oauth_approval_guard before insert or update on auth.oauth_authorizations
  for each row execute function public.oauth_approval_guard();

-- true for a two-factor browser session, or for a live OAuth session of an approved (hence vouched) AI app.
-- Revoking the app in Market Ripple ends its sessions, and with them this check, at once.
create or replace function public.read_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.mfa_ok() or exists (
    select 1 from auth.sessions s
    where (select auth.jwt() ->> 'client_id') is not null
      and s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = (select auth.uid())
      and s.oauth_client_id = nullif(auth.jwt() ->> 'client_id', '')::uuid
  )
$$;
revoke all on function public.read_ok() from public, anon;
grant execute on function public.read_ok() to authenticated;

-- the tables the MCP tools read switch their SELECT policies to read_ok; nothing else changes
drop policy world_read on public.world_docs;
create policy world_read on public.world_docs for select to authenticated using ((select public.read_ok()));
drop policy events_read on public.events;
create policy events_read on public.events for select to authenticated using ((select public.read_ok()));
drop policy holdings_read_own on public.holdings;
create policy holdings_read_own on public.holdings for select to authenticated
  using (user_id = (select auth.uid()) and (select public.read_ok()));
drop policy transactions_read_own on public.transactions;
create policy transactions_read_own on public.transactions for select to authenticated
  using (user_id = (select auth.uid()) and (select public.read_ok()));
drop policy reports_read_own on public.user_reports;
create policy reports_read_own on public.user_reports for select to authenticated
  using (user_id = (select auth.uid()) and (select public.read_ok()));
-- mcp_snapshots comes from 20261019000310_mcp, which a project may not have yet; that migration's own policy
-- (mfa_ok) then applies, so an AI app simply sees no connected-data snapshots until this is re-run
do $$
begin
  if to_regclass('public.mcp_snapshots') is not null then
    drop policy if exists mcp_snapshots_read_own on public.mcp_snapshots;
    create policy mcp_snapshots_read_own on public.mcp_snapshots for select to authenticated
      using (user_id = (select auth.uid()) and (select public.read_ok()));
  end if;
end $$;
drop policy profiles_read_own on public.profiles;
create policy profiles_read_own on public.profiles for select to authenticated
  using (id = (select auth.uid()) and (select public.read_ok()));
