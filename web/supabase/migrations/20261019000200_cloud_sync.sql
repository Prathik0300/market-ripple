-- Cloud sync worker (supabase/functions/sync): more platforms, the daily-login handshake for Zerodha and Upstox,
-- and the 2-hourly schedule.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('groww', 'coindcx', 'zerodha', 'upstox', 'binance'));
-- the platform's public app id (Kite api_key, Upstox client id): it appears in login links anyway, so it is not secret
alter table public.connections add column if not exists public_id text check (char_length(public_id) <= 80);
-- one-time state for a daily broker login, valid 10 minutes
alter table public.connections add column if not exists oauth_state text;
alter table public.connections add column if not exists oauth_expires timestamptz;
alter table public.connections add column if not exists token_expires timestamptz;

-- add_connection gains the public id
drop function if exists public.add_connection(text, text, text);
create or replace function public.add_connection(p_provider text, p_sealed text, p_hint text, p_public_id text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  insert into public.connections (user_id, provider, status, note, key_hint, public_id)
    values ((select auth.uid()), p_provider, 'pending', 'Waiting for the first sync', left(p_hint, 12), p_public_id)
    on conflict (user_id, provider) do update set status = 'pending', note = 'Waiting for the first sync',
      key_hint = excluded.key_hint, public_id = excluded.public_id, token_expires = null
    returning id into v_id;
  insert into public.connection_secrets (connection_id, sealed) values (v_id, p_sealed)
    on conflict (connection_id) do update set sealed = excluded.sealed, created_at = now();
  insert into public.audit_log (user_id, event, meta) values ((select auth.uid()), 'connection_added', jsonb_build_object('provider', p_provider));
  return v_id;
end $$;

-- start a daily broker login: a fresh random state the callback must present within 10 minutes
create or replace function public.start_broker_login(p_provider text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_state text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if (select auth.uid()) is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  update public.connections set oauth_state = v_state, oauth_expires = now() + interval '10 minutes'
    where user_id = (select auth.uid()) and provider = p_provider and provider in ('zerodha', 'upstox');
  if not found then raise exception 'connect this platform first'; end if;
  return v_state;
end $$;
revoke all on function public.add_connection(text, text, text, text), public.start_broker_login(text) from public, anon;
grant execute on function public.add_connection(text, text, text, text), public.start_broker_login(text) to authenticated;

-- the schedule: every 2 hours the database calls the sync function with a secret only it and the function know.
-- The secret is generated inside Postgres and kept in Vault; the function reads it through sync_secret(),
-- which only the service role may call.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'sync_secret', 'shared by pg_cron and the sync function')
  where not exists (select 1 from vault.secrets where name = 'sync_secret');

create or replace function public.sync_secret() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret'
$$;
revoke all on function public.sync_secret() from public, anon, authenticated;
grant execute on function public.sync_secret() to service_role;
