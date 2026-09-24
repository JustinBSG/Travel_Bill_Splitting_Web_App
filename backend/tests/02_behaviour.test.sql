-- pgTAP · behaviour on the real database. Run with the Supabase CLI:
--     node backend/scripts/supabase.mjs test db            (local stack)
--     node backend/scripts/supabase.mjs test db --linked   (deployed project)
-- Creates throwaway users and a trip inside ONE transaction and rolls it all
-- back at the end, so it is safe on a deployed project (queued pg_net calls
-- are rolled back too). Acts as a signed-in user the way PostgREST does:
-- role authenticated + request.jwt.claims.
begin;
select plan(40);

-- --------------------------------------------------------------------- helpers
create temp table t (k text primary key, v text);
grant all on t to authenticated;

-- auth.uid() reads request.jwt.claim.sub before request.jwt.claims, and
-- join_trip_as / regenerate_invite_as set both, so the helpers set both too.
create function pg_temp.login(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- back to the database owner (what Edge Functions reach via service_role RPCs)
create function pg_temp.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.id(key text) returns uuid language sql as $$
  select v::uuid from pg_temp.t where k = key
$$;

create function pg_temp.day(d date) returns jsonb language sql as $$
  select jsonb_build_object('date', d, 'location_name', 'Seoul', 'country_code', 'KR', 'latitude', 37.5665,
                            'longitude', 126.978, 'timezone', 'Asia/Seoul', 'currency', 'KRW')
$$;

-- save_expense body (HKD, so no FX data is needed); `extra` overrides fields
create function pg_temp.expense(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', null, 'trip_id', (select v from pg_temp.t where k = 'trip'), 'title', 'pgTAP expense',
    'category', 'Food & Drink', 'amount', 1000, 'currency', 'HKD',
    'paid_by', (select v from pg_temp.t where k = 'm_bob'), 'split_method', 'equal',
    'occurred_at', to_char(current_date + 30, 'YYYY-MM-DD') || 'T19:00:00+09:00',
    'timezone', 'Asia/Seoul', 'participants', '[]'::jsonb) || extra
$$;

create function pg_temp.members(variadic keys text[]) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('member_id', v)) from pg_temp.t where k = any (keys)
$$;

create function pg_temp.settlement() returns jsonb language sql as $$
  select jsonb_build_object(
    'trip_id', (select v from pg_temp.t where k = 'trip'),
    'from_member', (select v from pg_temp.t where k = 'm_bob'),
    'to_member', (select v from pg_temp.t where k = 'm_alice'),
    'debt_currency', 'HKD', 'debt_amount', 3334, 'paid_currency', 'HKD', 'paid_amount', 3334,
    'idempotency_key', 'pgtap-settle-0001')
$$;

-- ---------------------------------------------------------------------- users
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'pgtap-alice@example.test', '{"display_name": "Alice"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'pgtap-bob@example.test', '{"display_name": "Bob"}'),
  ('eeeeeeee-0000-4000-8000-000000000003', 'pgtap-eve@example.test', '{"display_name": "Eve"}');

select is((select display_name from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'Alice', 'signup trigger created a profile with the display name');

-- ---------------------------------------------------------------- create_trip
select pg_temp.login('aaaaaaaa-0000-4000-8000-000000000001');
insert into t select 'trip', public.create_trip(jsonb_build_object(
  'name', 'pgTAP trip', 'start_date', current_date + 30, 'end_date', current_date + 31,
  'days', jsonb_build_array(pg_temp.day(current_date + 30), pg_temp.day(current_date + 31)))) ->> 'id';
insert into t select 'm_alice', id::text from public.trip_members where trip_id = pg_temp.id('trip');
insert into t select 'code', invite_code from public.trip_invites where trip_id = pg_temp.id('trip');

select is((select count(*)::int from public.trip_days where trip_id = pg_temp.id('trip')), 2,
  'create_trip stored one trip day per date');
select is((select role from public.trip_members where id = pg_temp.id('m_alice')), 'owner',
  'the creator is the owner');

select pg_temp.login('eeeeeeee-0000-4000-8000-000000000003');
select is_empty($$ select 1 from public.trips where id = pg_temp.id('trip') $$,
  'a non-member cannot see the trip');

-- ------------------------------------------------------------ join + invites
select pg_temp.logout();
select is(public.join_trip_as(p_user_id => 'bbbbbbbb-0000-4000-8000-000000000002',
                              p_code => (select v from t where k = 'code')) ->> 'ok',
  'true', 'join_trip_as lets Bob join with the code');
insert into t select 'm_bob', id::text from public.trip_members
where trip_id = pg_temp.id('trip') and user_id = 'bbbbbbbb-0000-4000-8000-000000000002';

select pg_temp.login('bbbbbbbb-0000-4000-8000-000000000002');
select is_empty($$ select 1 from public.trip_invites $$, 'members cannot read invite secrets');
select throws_like($$ select public.get_trip_invite(pg_temp.id('trip')) $$,
  '%"code" : "forbidden"%', 'get_trip_invite is admin-only');
select ok((select to_jsonb(tr)::text from public.trips tr where tr.id = pg_temp.id('trip'))
          not like '%' || (select v from t where k = 'code') || '%',
  'the trip row a member reads carries no invite code');

select lives_ok($$ insert into public.trip_members (trip_id, display_name) values (pg_temp.id('trip'), 'Grandma') $$,
  'a member can add a placeholder');
insert into t select 'm_ph', id::text from public.trip_members
where trip_id = pg_temp.id('trip') and display_name = 'Grandma';
select throws_ok($$ insert into public.trip_members (trip_id, display_name, role) values (pg_temp.id('trip'), 'Boss', 'admin') $$,
  '42501', null, 'placeholders cannot be created as admins');

-- ------------------------------------------------------------------- expenses
insert into t select 'e_aa', public.save_expense(pg_temp.expense(jsonb_build_object(
  'title', 'Dinner', 'amount', 10000, 'participants', pg_temp.members('m_alice', 'm_bob', 'm_ph')))) ->> 'id';

select is((select sum(share_amount)::int from public.expense_participants where expense_id = pg_temp.id('e_aa')),
  10000, 'AA shares add up to the amount');
select results_eq(
  $$ select share_amount from public.expense_participants where expense_id = pg_temp.id('e_aa') order by member_id $$,
  $$ values (3334), (3333), (3333) $$,
  'the AA remainder goes to the lowest trip_members.id');
select is((select local_date from public.expenses where id = pg_temp.id('e_aa')), current_date + 30,
  'local_date comes from occurred_at in the expense time zone');

select throws_like($$ select public.save_expense(pg_temp.expense(jsonb_build_object(
    'split_method', 'exact', 'amount', 12000, 'participants', jsonb_build_array(
      jsonb_build_object('member_id', pg_temp.id('m_bob'), 'share_amount', 8000),
      jsonb_build_object('member_id', pg_temp.id('m_alice'), 'share_amount', 3000))))) $$,
  '%"code" : "share_sum_mismatch"%', 'AB shares that do not add up are rejected');
select lives_ok($$ select public.save_expense(pg_temp.expense(jsonb_build_object(
    'split_method', 'exact', 'amount', 12000, 'participants', jsonb_build_array(
      jsonb_build_object('member_id', pg_temp.id('m_bob'), 'share_amount', 8000),
      jsonb_build_object('member_id', pg_temp.id('m_alice'), 'share_amount', '4000'))))) $$,
  'AB shares that add up are saved');

insert into t select 'e_personal', public.save_expense(pg_temp.expense('{"title": "Souvenir"}')) ->> 'id';
select is((select count(*)::int from public.expense_participants where expense_id = pg_temp.id('e_personal')),
  0, 'a personal expense has no participants');

select throws_like($$ select public.save_expense(pg_temp.expense('{"amount": 12.5}')) $$,
  '%"code" : "validation_error"%', 'fractional amounts are rejected');
select throws_like($$ select public.save_expense(pg_temp.expense(jsonb_build_object(
    'id', pg_temp.id('e_aa'), 'expected_updated_at', '2000-01-01T00:00:00Z',
    'participants', pg_temp.members('m_bob')))) $$,
  '%"code" : "conflict_updated_at"%', 'a stale expected_updated_at is a 409 conflict');
select throws_ok($$ update public.expenses set title = 'hack' where id = pg_temp.id('e_aa') $$,
  '42501', null, 'expenses cannot be updated directly');

-- ---------------------------------------------------------------- settlements
insert into t select 's1', public.record_settlement(pg_temp.settlement()) ->> 'id';
select is(public.record_settlement(pg_temp.settlement()) ->> 'idempotent_replay', 'true',
  'repeating an idempotency_key is a replay');
select is((select count(*)::int from public.settlements where trip_id = pg_temp.id('trip')), 1,
  'the replay did not record a second payment');
select throws_ok($$ insert into public.settlements (trip_id, from_member, to_member, debt_currency, debt_amount,
                     paid_currency, paid_amount, paid_at, idempotency_key)
                   values (pg_temp.id('trip'), pg_temp.id('m_bob'), pg_temp.id('m_alice'), 'HKD', 3334,
                     'HKD', 3334, now(), 'pgtap-settle-0001') $$,
  '23505', null, 'a direct POST with the same key hits the unique constraint');

-- ----------------------------------------------------------------------- lock
select pg_temp.login('aaaaaaaa-0000-4000-8000-000000000001');
select lives_ok($$ select public.lock_trip(pg_temp.id('trip')) $$, 'an admin can lock the trip');
select pg_temp.login('bbbbbbbb-0000-4000-8000-000000000002');
select throws_like($$ select public.save_expense(pg_temp.expense('{}')) $$,
  '%"code" : "trip_locked"%', 'a locked trip rejects new expenses');
select throws_ok($$ insert into public.trip_members (trip_id, display_name) values (pg_temp.id('trip'), 'Late') $$,
  '42501', null, 'a locked trip rejects new placeholders');
select pg_temp.login('aaaaaaaa-0000-4000-8000-000000000001');
select lives_ok($$ select public.unlock_trip(pg_temp.id('trip')) $$, 'an admin can unlock the trip');

-- ------------------------------------------------------ soft delete + the log
select pg_temp.login('bbbbbbbb-0000-4000-8000-000000000002');
select lives_ok($$ select public.soft_delete_expense(pg_temp.id('e_personal'),
                    (select updated_at from public.expenses where id = pg_temp.id('e_personal'))) $$,
  'a member can soft-delete an expense');
select isnt((select deleted_at from public.expenses where id = pg_temp.id('e_personal')), null,
  'soft delete sets deleted_at');

select pg_temp.logout();
select throws_like($$ delete from public.expenses where id = pg_temp.id('e_aa') $$,
  '%"code" : "forbidden"%', 'expenses cannot be hard-deleted, even by the owner role');
select throws_like($$ update public.activity_log set action = 'x' $$,
  '%"code" : "forbidden"%', 'activity_log rows cannot be changed');
select set_has(
  $$ select entity_type || ':' || action from public.activity_log where trip_id = pg_temp.id('trip') $$,
  $$ select unnest(array['trip:create', 'trip_member:join', 'trip_member:create', 'expense:create',
                         'settlement:create', 'trip:lock', 'trip:unlock', 'expense:delete']) $$,
  'activity_log has an entry for each change');

-- --------------------------------------------------------------------- photos
select lives_ok($$ insert into storage.objects (bucket_id, name)
                   values ('trip-photos', pg_temp.id('trip') || '/' || pg_temp.id('e_aa') || '/pgtap.jpg') $$,
  'fixture: a photo object in the trip folder');
select pg_temp.login('bbbbbbbb-0000-4000-8000-000000000002');
select is((select count(*)::int from storage.objects
           where bucket_id = 'trip-photos' and name like pg_temp.id('trip') || '/%'),
  1, 'a member can see the trip photos (needed to sign URLs)');
select pg_temp.login('eeeeeeee-0000-4000-8000-000000000003');
select is((select count(*)::int from storage.objects
           where bucket_id = 'trip-photos' and name like pg_temp.id('trip') || '/%'),
  0, 'a non-member cannot see them');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                   values ('trip-photos', pg_temp.id('trip') || '/x/' || gen_random_uuid() || '.jpg') $$,
  '42501', null, 'a non-member cannot upload into the trip folder');

-- -------------------------------------------------------- invite regeneration
select pg_temp.logout();
select ok(public.regenerate_invite_as('aaaaaaaa-0000-4000-8000-000000000001', pg_temp.id('trip')) ->> 'invite_code'
          is distinct from (select v from t where k = 'code'),
  'regenerate_invite issues a new code');
select is(public.join_trip_as(p_user_id => 'eeeeeeee-0000-4000-8000-000000000003',
                              p_code => (select v from t where k = 'code'), p_preview => true) ->> 'status',
  '404', 'the old code stops working immediately');

-- ------------------------------------------------------------------ delete
select pg_temp.login('bbbbbbbb-0000-4000-8000-000000000002');
select throws_like($$ select public.delete_trip(pg_temp.id('trip')) $$,
  '%"code" : "forbidden"%', 'only the owner can delete the trip');
select pg_temp.login('aaaaaaaa-0000-4000-8000-000000000001');
select lives_ok($$ select public.delete_trip(pg_temp.id('trip')) $$, 'the owner can delete the trip');
select pg_temp.logout();
select is((select count(*)::int from public.expenses where trip_id = pg_temp.id('trip')), 0,
  'deleting the trip removed its expenses');

select * from finish();
rollback;
