-- What each user is into (asked once after sign-up, editable in Settings). The main page uses it to show the events,
-- model signals, focus names and facts on the user's own map nodes first. It is a preference, not connection data:
-- it never reaches the model or the shared facts store.
--
-- null = not asked yet (the main page sends the user to onboarding); an empty array = asked, picked nothing.
-- The ids match web/src/lib/interests.ts.
alter table public.profiles add column if not exists interests text[]
  check (interests is null or (
    cardinality(interests) <= 10
    and interests <@ array['crypto', 'energy', 'metals', 'tech', 'agri', 'mutual_funds', 'us_stocks', 'india_stocks', 'rates_fx', 'defense']::text[]
  ));
-- same pattern as ai_client: only this column is writable, and profiles_update_own limits it to the caller's own row
-- with a completed second factor (mfa_ok())
grant update (interests) on public.profiles to authenticated;
