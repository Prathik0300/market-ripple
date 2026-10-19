-- Market Ripple platform, step 1: people, the shared world model, and each person's own app data.
-- Every table has row-level security. Reads need a completed second factor (aal2) as well as a session.
-- The web app holds only the publishable key; world data is written by the pipeline with the service role.

create extension if not exists citext with schema extensions;

-- true when the caller's session passed two-factor sign-in
create or replace function public.mfa_ok() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
$$;

-- ---------------------------------------------------------------- people
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email extensions.citext unique not null,
  display_name text check (char_length(display_name) <= 60),
  base_currency text not null default 'USD' check (base_currency in ('USD', 'INR')),
  status text not null default 'active' check (status in ('active', 'locked', 'deleted')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy profiles_read_own on public.profiles for select to authenticated
  using (id = (select auth.uid()) and public.mfa_ok());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()) and public.mfa_ok())
  with check (id = (select auth.uid()));
-- users may change only their display name and currency; status is server-managed
revoke update on public.profiles from authenticated;
grant update (display_name, base_currency) on public.profiles to authenticated;

-- a profile row for every new account
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- shared world model
-- One document per path, in the layout the desks already read: feed/latest, signals/latest, stocks/s03,
-- dossier/AAPL, prices/latest ... Owner-only documents (owner/...) are never stored here.
create table public.world_docs (
  path text primary key check (path ~ '^[a-z_]+/[A-Za-z0-9_.:@+-]{1,120}$' and path !~ '^owner/'),
  data jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.world_docs enable row level security;
create policy world_read on public.world_docs for select to authenticated using (public.mfa_ok());
-- no insert, update or delete policy: only the service role (the pipeline) writes

-- ---------------------------------------------------------------- each person's own app data
-- progress (game), notes, research requests, saved tickers: small JSON documents per user
create table public.user_docs (
  user_id uuid not null references auth.users on delete cascade,
  key text not null check (key in ('progress', 'notes', 'requests', 'portfolio')),
  data jsonb not null check (octet_length(data::text) <= 200000),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_docs enable row level security;
create policy user_docs_own on public.user_docs for all to authenticated
  using (user_id = (select auth.uid()) and public.mfa_ok())
  with check (user_id = (select auth.uid()) and public.mfa_ok());

create or replace function public.bump_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  new.updated_at := now();
  return new;
end $$;
create trigger user_docs_version before update on public.user_docs for each row execute function public.bump_version();
create trigger world_docs_version before update on public.world_docs for each row execute function public.bump_version();

-- ---------------------------------------------------------------- security events
create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete set null,
  event text not null check (char_length(event) <= 60),
  meta jsonb,
  ts timestamptz not null default now()
);
alter table public.audit_log enable row level security;
create policy audit_read_own on public.audit_log for select to authenticated
  using (user_id = (select auth.uid()) and public.mfa_ok());

-- the only way the app records an event: always as the caller, never for someone else
create or replace function public.log_event(p_event text, p_meta jsonb default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (user_id, event, meta)
  select (select auth.uid()), left(p_event, 60), p_meta
  where (select auth.uid()) is not null
$$;
revoke all on function public.log_event(text, jsonb) from public, anon;
grant execute on function public.log_event(text, jsonb) to authenticated;

-- anonymous visitors get nothing
revoke all on public.profiles, public.world_docs, public.user_docs, public.audit_log from anon;
