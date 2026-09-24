-- pgTAP · platform checks. Run with the Supabase CLI (see backend/DEPLOY.md):
--     node backend/scripts/supabase.mjs test db            (local stack)
--     node backend/scripts/supabase.mjs test db --linked   (deployed project)
-- Read-only checks that the migrations produced the right grants, RLS,
-- storage, realtime and cron setup on the real platform. Rolled back.
begin;
select plan(27);

-- ---------------------------------------------------------------- RLS / grants
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'RLS is enabled on every table in public');

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') $$,
  'anon has no privileges on any public table');

select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon cannot use schema private');

select ok(not has_table_privilege('authenticated', 'public.trips', 'INSERT, DELETE'),
  'trips: no direct INSERT / DELETE (create_trip / delete_trip only)');

select ok(has_column_privilege('authenticated', 'public.trips', 'name', 'UPDATE')
          and has_column_privilege('authenticated', 'public.trips', 'joining_enabled', 'UPDATE'),
  'trips: name and joining_enabled can be PATCHed by admins');

select ok(not has_column_privilege('authenticated', 'public.trips', 'is_locked', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.trips', 'start_date', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.trips', 'base_currency', 'UPDATE'),
  'trips: is_locked, dates and base_currency cannot be PATCHed');

select ok(not has_table_privilege('authenticated', 'public.expenses', 'INSERT, UPDATE, DELETE'),
  'expenses: writes only through the expense RPCs');

select ok(not has_table_privilege('authenticated', 'public.expense_participants', 'INSERT, UPDATE, DELETE'),
  'expense_participants: writes only through save_expense');

select ok(not has_table_privilege('authenticated', 'public.activity_log', 'INSERT, UPDATE, DELETE'),
  'activity_log: no client writes');

select ok(not has_table_privilege('authenticated', 'public.settlements', 'UPDATE, DELETE'),
  'settlements: no UPDATE / DELETE');

select ok(not has_table_privilege('authenticated', 'public.notifications', 'INSERT, DELETE')
          and has_column_privilege('authenticated', 'public.notifications', 'read_at', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.notifications', 'payload', 'UPDATE'),
  'notifications: the client may only set read_at');

select ok(not has_table_privilege('authenticated', 'public.profiles', 'INSERT, DELETE')
          and not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE'),
  'profiles: only display_name / language are writable');

-- ------------------------------------------------------------------- functions
select ok((select bool_and(has_function_privilege('authenticated', f, 'EXECUTE'))
           from unnest(array[
             'public.create_trip(jsonb)', 'public.update_trip(jsonb)', 'public.lock_trip(uuid)',
             'public.unlock_trip(uuid)', 'public.delete_trip(uuid)', 'public.get_trip_invite(uuid)',
             'public.set_member_role(uuid,text)', 'public.remove_member(uuid)',
             'public.save_expense(jsonb)', 'public.soft_delete_expense(uuid,timestamp with time zone)',
             'public.restore_expense(uuid)', 'public.record_settlement(jsonb)']) f),
  'authenticated can call the client RPCs');

select ok((select bool_and(not has_function_privilege(r, f, 'EXECUTE'))
           from unnest(array['anon', 'authenticated']) r,
                unnest(array[
                  'public.join_trip_as(uuid,text,text,uuid,boolean,text,integer,integer,integer)',
                  'public.regenerate_invite_as(uuid,uuid)',
                  'public.upsert_fx_rates(date,text,jsonb,text)']) f),
  'the Edge-Function-only RPCs are not callable by clients');

select ok((select bool_and(not has_function_privilege('anon', f, 'EXECUTE'))
           from unnest(array['public.create_trip(jsonb)', 'public.save_expense(jsonb)',
                             'public.record_settlement(jsonb)', 'public.get_trip_invite(uuid)']) f),
  'anon cannot call the RPCs');

select ok(has_function_privilege('service_role',
            'public.join_trip_as(uuid,text,text,uuid,boolean,text,integer,integer,integer)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.upsert_fx_rates(date,text,jsonb,text)', 'EXECUTE'),
  'service_role can call the Edge Function RPCs');

-- -------------------------------------------------------------------- triggers
select has_trigger('auth', 'users', 'profiles_on_signup', 'signup creates a profile');
select has_trigger('public', 'expenses', 'expenses_prevent_hard_delete', 'expenses cannot be hard-deleted');
select has_trigger('public', 'activity_log', 'activity_log_append_only', 'activity_log is append-only');
select has_trigger('public', 'notifications', 'notifications_send_push', 'new notifications call send_push');

-- --------------------------------------------------------------------- storage
select results_eq(
  $$ select public, file_size_limit from storage.buckets where id = 'trip-photos' $$,
  $$ values (false, 5242880::bigint) $$,
  'trip-photos bucket is private with a 5 MB limit');

select set_eq(
  $$ select policyname::text from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and policyname like 'trip-photos:%' $$,
  array['trip-photos: members read', 'trip-photos: members upload while unlocked',
        'trip-photos: members delete while unlocked'],
  'trip-photos storage policies exist');

-- -------------------------------------------------------------------- realtime
select set_has(
  $$ select tablename::text from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' $$,
  $$ select unnest(array['expenses', 'expense_participants', 'settlements', 'trip_members',
                         'trips', 'trip_days', 'notifications']) $$,
  'the realtime publication covers the live tables');

select is((select relreplident::text from pg_class where oid = 'public.expenses'::regclass), 'f',
  'expenses has replica identity FULL (soft delete carries the old row)');

-- ------------------------------------------------------------------------ cron
select case
  when to_regnamespace('cron') is null then skip('pg_cron is not installed here', 1)
  else set_has($$ select jobname::text from cron.job $$,
               $$ select unnest(array['fetch-fx-rates', 'fetch-fx-rates-retry', 'purge-join-attempts']) $$,
               'pg_cron jobs are scheduled')
end;

-- -------------------------------------------------------------- reference data
select results_eq(
  $$ select code, decimals from public.currencies
     where code in ('HKD', 'JPY', 'KRW', 'TWD', 'USD', 'VND') order by code $$,
  $$ values ('HKD'::text, 2), ('JPY', 0), ('KRW', 0), ('TWD', 0), ('USD', 2), ('VND', 0) $$,
  'currency decimals match the required seed');

select is((select count(*)::int from public.currencies
           where code in ('HKD', 'JPY', 'KRW', 'TWD', 'CNY', 'USD', 'EUR', 'GBP', 'SGD', 'THB', 'VND', 'MYR', 'AUD')),
  13, 'all 13 required currencies are seeded');

select * from finish();
rollback;
