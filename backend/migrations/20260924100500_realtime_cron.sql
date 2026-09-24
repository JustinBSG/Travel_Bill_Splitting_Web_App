-- =============================================================================
-- Realtime publication + scheduled jobs (requirement §7, §5.K)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Realtime: live trip pages. Clients filter by trip_id / user_id; Realtime
-- applies each table's SELECT policy per subscriber. Soft delete arrives as
-- an UPDATE (expenses has replica identity FULL, so the old row is included).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['expenses', 'expense_participants', 'settlements', 'trip_members',
                           'trips', 'trip_days', 'notifications'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- pg_cron + pg_net. Created when available (always on Supabase); skipped by
-- environments without them so the rest of the schema still applies.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end;
$$;

-- Jobs (times are UTC):
--   fetch-fx-rates        16:10 UTC = 00:10 Asia/Hong_Kong, right after the HK
--                         date rolls over. The Edge Function stores rates under
--                         today's HK date and backfills yesterday if missing.
--   fetch-fx-rates-retry  22:10 UTC = 06:10 HKT. No vendor call when today's
--                         rates are already stored, so it only matters if the
--                         first run failed ("one fetch per day is enough").
--   purge-join-attempts   drop rate-limit rows older than 2 days.
-- The fetch jobs POST /functions/v1/fetch_fx_rates with header x-cron-secret,
-- using Vault secrets `project_url` and `cron_secret` (see backend/README.md).
do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not installed: scheduled jobs were not created';
    return;
  end if;
  perform cron.schedule('fetch-fx-rates', '10 16 * * *',
    $cmd$select private.call_edge_function('fetch_fx_rates', '{}'::jsonb, 'cron_secret', 'x-cron-secret')$cmd$);
  perform cron.schedule('fetch-fx-rates-retry', '10 22 * * *',
    $cmd$select private.call_edge_function('fetch_fx_rates', '{}'::jsonb, 'cron_secret', 'x-cron-secret')$cmd$);
  perform cron.schedule('purge-join-attempts', '30 19 * * *',
    $cmd$delete from private.join_attempts where created_at < now() - interval '2 days'$cmd$);
end;
$$;

-- Pick up the new tables / functions in PostgREST's schema cache.
notify pgrst, 'reload schema';
