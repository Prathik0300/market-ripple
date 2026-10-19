-- Supabase advisor findings on the first migration.

-- the sign-up trigger runs only as a trigger; nobody calls it over the API
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- log_event becomes an ordinary (invoker) function: the insert policy, not elevated rights, keeps every
-- user to their own rows
create or replace function public.log_event(p_event text, p_meta jsonb default null) returns void
language sql security invoker set search_path = '' as $$
  insert into public.audit_log (user_id, event, meta)
  select (select auth.uid()), left(p_event, 60), p_meta
  where (select auth.uid()) is not null
$$;
revoke all on function public.log_event(text, jsonb) from public, anon;
grant execute on function public.log_event(text, jsonb) to authenticated;
grant insert (user_id, event, meta) on public.audit_log to authenticated;
create policy audit_insert_own on public.audit_log for insert to authenticated
  with check (user_id = (select auth.uid()));

create index if not exists audit_log_user_id_idx on public.audit_log (user_id);
