-- Mutual funds from a CAMS / KFintech statement (CAS). The PDF and its password are read in memory by the
-- statement reader (web/api/cas.py) and thrown away; only fund-level rows reach the database, through
-- import_funds below, which acts on the signed-in user's own rows. There is no key to seal and nothing to sync:
-- the fund rows change only when the user uploads a newer statement.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('groww', 'coindcx', 'zerodha', 'upstox', 'binance', 'cams'));

-- the fund's name (stocks and coins leave it empty)
alter table public.holdings add column if not exists name text check (char_length(name) <= 120);

create or replace function public.import_funds(p_rows jsonb, p_period text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := (select auth.uid()); v_n int;
begin
  if v_uid is null or not public.mfa_ok() then raise exception 'two-factor sign-in required'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 300 then raise exception 'bad fund list'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
             where coalesce(r->>'sym', '') !~ '^MF_[0-9]{1,8}$'
                or jsonb_typeof(r->'qty') <> 'number' or (r->>'qty')::numeric <= 0 or (r->>'qty')::numeric > 1e9
                or (r ? 'avg_cost' and jsonb_typeof(r->'avg_cost') <> 'null'
                    and (jsonb_typeof(r->'avg_cost') <> 'number' or (r->>'avg_cost')::numeric <= 0 or (r->>'avg_cost')::numeric > 1e7))
                or char_length(coalesce(r->>'name', '')) > 120) then
    raise exception 'bad fund row';
  end if;
  v_n := jsonb_array_length(p_rows);
  insert into public.connections (user_id, provider, status, note, key_hint, last_sync_at)
    values (v_uid, 'cams', 'ok', format('%s funds from the statement to %s', v_n, left(p_period, 10)), left(p_period, 10), now())
    on conflict (user_id, provider) do update set status = 'ok', note = excluded.note, key_hint = excluded.key_hint, last_sync_at = now()
    returning id into v_id;
  delete from public.holdings where connection_id = v_id;
  insert into public.holdings (connection_id, user_id, sym, kind, qty, avg_cost, ccy, name)
    select v_id, v_uid, r->>'sym', 'fund', (r->>'qty')::numeric, nullif(r->>'avg_cost', '')::numeric, 'INR', nullif(r->>'name', '')
    from jsonb_array_elements(p_rows) r
    on conflict (connection_id, sym) do update set qty = public.holdings.qty + excluded.qty;
  insert into public.audit_log (user_id, event, meta) values (v_uid, 'funds_imported', jsonb_build_object('funds', v_n));
  return v_n;
end $$;
revoke all on function public.import_funds(jsonb, text) from public, anon;
grant execute on function public.import_funds(jsonb, text) to authenticated;
