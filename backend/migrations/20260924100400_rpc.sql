-- =============================================================================
-- RPC REST: /rest/v1/rpc/{fn}  (requirement §5)
--
-- All RPCs are SECURITY DEFINER and authorize explicitly (membership, admin,
-- owner, lock). They are called with POST (PostgREST RPCs accept GET/POST
-- only; get_trip_invite also works as GET ?trip_id=...). Errors use the §8
-- codes via private.api_error.
--
--   authenticated   create_trip, update_trip, lock_trip, unlock_trip,
--                   delete_trip, get_trip_invite, set_member_role,
--                   remove_member, save_expense, soft_delete_expense,
--                   restore_expense, record_settlement
--   service_role    join_trip_as, regenerate_invite_as (behind the Edge
--                   Functions join_trip / regenerate_invite), upsert_fx_rates
--                   (behind fetch_fx_rates)
--
-- jsonb RPCs (create_trip, update_trip, save_expense, record_settlement) take
-- a single unnamed jsonb parameter, so the request body is passed as-is.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Small helpers
-- -----------------------------------------------------------------------------
create or replace function private.require_user() returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v uuid := auth.uid();
begin
  if v is null then
    perform private.api_error('unauthenticated', 'Sign in first', 401);
  end if;
  return v;
end;
$$;

create or replace function private.try_numeric(s text) returns numeric
language plpgsql immutable
set search_path = ''
as $$
begin
  if s is null or btrim(s) !~ '^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' then
    return null;
  end if;
  return btrim(s)::numeric;
exception when others then
  return null;
end;
$$;

-- Positive decimal (JSON number or numeric string) for FX rates.
create or replace function private.j_rate(p jsonb, k text) returns numeric
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'number' then
    n := v::text::numeric;
  elsif jsonb_typeof(v) = 'string' then
    n := private.try_numeric(v #>> '{}');
  end if;
  if n is null or n <= 0 or n > 1000000000 then
    perform private.api_error('validation_error', k || ' must be a positive decimal number', 422);
  end if;
  return n;
end;
$$;

-- 43-char base64url, 256 bits.
create or replace function private.new_invite_token() returns text
language sql volatile
set search_path = ''
as $$
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), E'+/=\n', '-_');
$$;

-- 6 chars from the 32-letter alphabet without 0 O 1 I (256 % 32 = 0: unbiased).
create or replace function private.new_invite_code() returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  b        bytea;
  v_code   text;
begin
  loop
    b := extensions.gen_random_bytes(6);
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.trip_invites ti where ti.invite_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Trip + days (+ members) as returned by the trip RPCs. Invite only on request.
create or replace function private.trip_json(tid uuid, with_invite boolean default false) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select to_jsonb(t)
    || jsonb_build_object(
         'trip_days', coalesce((select jsonb_agg(to_jsonb(d) order by d.date)
                                from public.trip_days d where d.trip_id = t.id), '[]'::jsonb),
         'trip_members', coalesce((select jsonb_agg(to_jsonb(m) order by m.joined_at, m.id)
                                   from public.trip_members m where m.trip_id = t.id), '[]'::jsonb))
    || case when with_invite then coalesce((
         select jsonb_build_object('invite', jsonb_build_object(
                  'invite_token', i.invite_token,
                  'invite_code', i.invite_code,
                  'join_path', '/join/' || i.invite_token))
         from public.trip_invites i where i.trip_id = t.id), '{}'::jsonb)
       else '{}'::jsonb end
  from public.trips t
  where t.id = tid;
$$;

-- Trip settings + days, for the consolidated create/update log entries.
create or replace function private.trip_state(tid uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select private.trip_snapshot(t) || jsonb_build_object(
    'days', coalesce((select jsonb_agg(to_jsonb(d) - 'trip_id' order by d.date)
                      from public.trip_days d where d.trip_id = t.id), '[]'::jsonb))
  from public.trips t
  where t.id = tid;
$$;

-- Validates a days[] array against [p_start, p_end] and returns trip_days rows.
create or replace function private.parse_trip_days(
  p_trip_id uuid, p_days jsonb, p_start date, p_end date
) returns setof public.trip_days
language plpgsql
set search_path = ''
as $$
declare
  v_el   jsonb;
  v_row  public.trip_days;
  v_seen date[] := '{}';
begin
  if p_days is null or jsonb_typeof(p_days) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_days) <> 'array' then
    perform private.api_error('validation_error', 'days must be an array', 422);
  end if;
  for v_el in select value from jsonb_array_elements(p_days) loop
    if jsonb_typeof(v_el) <> 'object' then
      perform private.api_error('validation_error', 'each entry of days must be an object', 422);
    end if;
    v_row.trip_id := p_trip_id;
    v_row.date := private.j_date(v_el, 'date', true);
    if v_row.date < p_start or v_row.date > p_end then
      perform private.api_error('validation_error', 'day ' || v_row.date || ' is outside start_date..end_date', 422);
    end if;
    if v_row.date = any (v_seen) then
      perform private.api_error('validation_error', 'day ' || v_row.date || ' appears twice', 422);
    end if;
    v_seen := v_seen || v_row.date;
    v_row.location_name := private.j_text(v_el, 'location_name', true, 200);
    v_row.country_code  := upper(private.j_text(v_el, 'country_code', true, 2));
    if v_row.country_code !~ '^[A-Z]{2}$' then
      perform private.api_error('validation_error', 'country_code must be ISO 3166-1 alpha-2', 422);
    end if;
    v_row.latitude  := private.j_float(v_el, 'latitude', -90, 90);
    v_row.longitude := private.j_float(v_el, 'longitude', -180, 180);
    if v_row.latitude is null or v_row.longitude is null then
      perform private.api_error('validation_error', 'day ' || v_row.date || ' needs latitude and longitude', 422);
    end if;
    v_row.timezone := private.j_text(v_el, 'timezone', true, 64);
    if not private.is_valid_timezone(v_row.timezone) then
      perform private.api_error('validation_error', 'timezone must be an IANA name such as Asia/Tokyo', 422);
    end if;
    v_row.currency := upper(private.j_text(v_el, 'currency', true, 3));
    if not exists (select 1 from public.currencies c where c.code = v_row.currency) then
      perform private.api_error('validation_error', 'Unknown currency ' || v_row.currency, 422);
    end if;
    return next v_row;
  end loop;
end;
$$;

create or replace function private.assert_days_cover_range(p_trip_id uuid, p_start date, p_end date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_missing text;
begin
  select string_agg(d::date::text, ', ' order by d)
    into v_missing
  from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
  where not exists (select 1 from public.trip_days td where td.trip_id = p_trip_id and td.date = d::date);
  if v_missing is not null then
    perform private.api_error('validation_error', 'Every trip date needs a location. Missing: ' || v_missing, 422);
  end if;
end;
$$;

-- Notification payload for expense events.
create or replace function private.expense_notice(e public.expenses) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'expense_id', e.id, 'title', e.title, 'amount', e.amount, 'currency', e.currency,
    'amount_display', private.format_minor(e.amount, e.currency), 'local_date', e.local_date);
$$;

-- =============================================================================
-- 5.D Trips
-- =============================================================================

-- POST /rest/v1/rpc/create_trip
--   { name, start_date, end_date, days: [{ date, location_name, country_code,
--     latitude, longitude, timezone, currency }, ...one per date] }
-- Trip + days + owner member + invite in one transaction. Returns the trip
-- with trip_days, trip_members and invite { invite_token, invite_code, join_path }.
create or replace function public.create_trip(jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  p              jsonb := coalesce($1, '{}'::jsonb);
  v_uid          uuid := private.require_user();
  v_profile_name text;
  v_name         text;
  v_start        date;
  v_end          date;
  v_trip_id      uuid := gen_random_uuid();
begin
  select btrim(pr.display_name) into v_profile_name from public.profiles pr where pr.id = v_uid;
  if coalesce(v_profile_name, '') = '' then
    perform private.api_error('validation_error', 'Set your display name before creating a trip', 422);
  end if;

  v_name  := private.j_text(p, 'name', true, 100);
  v_start := private.j_date(p, 'start_date', true);
  v_end   := private.j_date(p, 'end_date', true);
  if v_end < v_start then
    perform private.api_error('validation_error', 'end_date must be on or after start_date', 422);
  end if;
  if v_end - v_start >= 366 then
    perform private.api_error('validation_error', 'A trip can be at most 366 days long', 422);
  end if;
  if jsonb_typeof(p -> 'days') is distinct from 'array' then
    perform private.api_error('validation_error', 'days is required: one location per trip date', 422);
  end if;

  perform set_config('tbs.rpc_logging', 'on', true);

  insert into public.trips (id, name, start_date, end_date, created_by)
  values (v_trip_id, v_name, v_start, v_end, v_uid);

  insert into public.trip_days
  select * from private.parse_trip_days(v_trip_id, p -> 'days', v_start, v_end);
  perform private.assert_days_cover_range(v_trip_id, v_start, v_end);

  insert into public.trip_members (trip_id, user_id, display_name, role)
  values (v_trip_id, v_uid, v_profile_name, 'owner');

  insert into public.trip_invites (trip_id, invite_token, invite_code)
  values (v_trip_id, private.new_invite_token(), private.new_invite_code());

  perform private.write_log(v_trip_id, 'create', 'trip', v_trip_id, null, private.trip_state(v_trip_id));
  perform set_config('tbs.rpc_logging', 'off', true);

  return private.trip_json(v_trip_id, true);
end;
$$;

-- POST /rest/v1/rpc/update_trip   (admin, unlocked)
--   { trip_id, name?, start_date?, end_date?, days?: [...] }
-- trip_days is made to match the new inclusive range: out-of-range days are
-- deleted, given days are upserted, and every date must end up with a
-- location. Expenses are never touched (they keep currency, timezone,
-- occurred_at, local_date and their locked FX; the UI re-buckets by date).
create or replace function public.update_trip(jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  p         jsonb := coalesce($1, '{}'::jsonb);
  v_trip_id uuid;
  v_trip    public.trips;
  v_name    text;
  v_start   date;
  v_end     date;
  v_before  jsonb;
  v_after   jsonb;
begin
  perform private.require_user();
  v_trip_id := private.j_uuid(p, 'trip_id', true);

  select t.* into v_trip from public.trips t where t.id = v_trip_id for update;
  if not found or not private.is_trip_admin(v_trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can edit the trip', 403);
  end if;
  if v_trip.is_locked then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;

  v_name  := case when p ? 'name' then private.j_text(p, 'name', true, 100) else v_trip.name end;
  v_start := case when p ? 'start_date' then private.j_date(p, 'start_date', true) else v_trip.start_date end;
  v_end   := case when p ? 'end_date' then private.j_date(p, 'end_date', true) else v_trip.end_date end;
  if v_end < v_start then
    perform private.api_error('validation_error', 'end_date must be on or after start_date', 422);
  end if;
  if v_end - v_start >= 366 then
    perform private.api_error('validation_error', 'A trip can be at most 366 days long', 422);
  end if;

  v_before := private.trip_state(v_trip_id);
  perform set_config('tbs.rpc_logging', 'on', true);

  update public.trips t
     set name = v_name, start_date = v_start, end_date = v_end
   where t.id = v_trip_id
     and (t.name, t.start_date, t.end_date) is distinct from (v_name, v_start, v_end);

  delete from public.trip_days d
   where d.trip_id = v_trip_id and (d.date < v_start or d.date > v_end);

  insert into public.trip_days as d
  select * from private.parse_trip_days(v_trip_id, p -> 'days', v_start, v_end)
  on conflict (trip_id, date) do update
     set location_name = excluded.location_name,
         country_code  = excluded.country_code,
         latitude      = excluded.latitude,
         longitude     = excluded.longitude,
         timezone      = excluded.timezone,
         currency      = excluded.currency
   where (d.location_name, d.country_code, d.latitude, d.longitude, d.timezone, d.currency)
         is distinct from
         (excluded.location_name, excluded.country_code, excluded.latitude, excluded.longitude,
          excluded.timezone, excluded.currency);

  perform private.assert_days_cover_range(v_trip_id, v_start, v_end);

  v_after := private.trip_state(v_trip_id);
  if v_after is distinct from v_before then
    perform private.write_log(v_trip_id, 'update', 'trip', v_trip_id, v_before, v_after);
  end if;
  perform set_config('tbs.rpc_logging', 'off', true);

  return private.trip_json(v_trip_id, false);
end;
$$;

-- POST /rest/v1/rpc/lock_trip { trip_id }   (admin) — trigger logs + notifies
create or replace function public.lock_trip(trip_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_trip_id uuid := lock_trip.trip_id;
begin
  perform private.require_user();
  if not private.is_trip_admin(v_trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can lock the trip', 403);
  end if;
  update public.trips t set is_locked = true where t.id = v_trip_id and not t.is_locked;
  return private.trip_json(v_trip_id, false);
end;
$$;

-- POST /rest/v1/rpc/unlock_trip { trip_id }   (admin) — the one write a locked trip allows
create or replace function public.unlock_trip(trip_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_trip_id uuid := unlock_trip.trip_id;
begin
  perform private.require_user();
  if not private.is_trip_admin(v_trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can unlock the trip', 403);
  end if;
  update public.trips t set is_locked = false where t.id = v_trip_id and t.is_locked;
  return private.trip_json(v_trip_id, false);
end;
$$;

-- POST /rest/v1/rpc/delete_trip { trip_id }   (owner; unlock first)
-- Cascades days, members, invites, expenses, participants, settlements, logs
-- and notifications; queues deletion of every trip-photos/{trip_id}/ object.
create or replace function public.delete_trip(trip_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_trip_id uuid := delete_trip.trip_id;
  v_trip    public.trips;
  v_photos  text[];
  v_queued  integer;
begin
  perform private.require_user();
  select t.* into v_trip from public.trips t where t.id = v_trip_id for update;
  if not found or not private.is_trip_owner(v_trip_id) then
    perform private.api_error('forbidden', 'Only the trip owner can delete the trip', 403);
  end if;
  if v_trip.is_locked then
    perform private.api_error('trip_locked', 'Unlock the trip before deleting it', 423);
  end if;

  v_photos := private.trip_photo_names(v_trip_id);

  perform set_config('tbs.deleting_trip', v_trip_id::text, true);
  delete from public.trips t where t.id = v_trip_id;
  perform set_config('tbs.deleting_trip', '', true);

  v_queued := private.queue_photo_deletes(v_photos);
  return jsonb_build_object('trip_id', v_trip_id, 'deleted', true,
                            'photos', cardinality(v_photos), 'photos_queued_for_deletion', v_queued);
end;
$$;

-- POST|GET /rest/v1/rpc/get_trip_invite { trip_id }   (admin; others 403)
create or replace function public.get_trip_invite(trip_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_trip_id uuid := get_trip_invite.trip_id;
  v_result  jsonb;
begin
  perform private.require_user();
  if not private.is_trip_admin(v_trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can see the invite link and code', 403);
  end if;
  select jsonb_build_object('invite_token', i.invite_token, 'invite_code', i.invite_code,
                            'join_path', '/join/' || i.invite_token)
    into v_result
  from public.trip_invites i where i.trip_id = v_trip_id;
  if v_result is null then
    perform private.api_error('not_found', 'This trip has no invite', 404);
  end if;
  return v_result;
end;
$$;

-- =============================================================================
-- 5.E Members
-- =============================================================================

-- POST /rest/v1/rpc/set_member_role { member_id, role: 'admin' | 'member' }   (admin)
create or replace function public.set_member_role(member_id uuid, role text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member public.trip_members;
  v_role   text := lower(btrim(coalesce(set_member_role.role, '')));
begin
  perform private.require_user();
  select m.* into v_member from public.trip_members m where m.id = set_member_role.member_id for update;
  if not found or not private.is_trip_admin(v_member.trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can change roles', 403);
  end if;
  if private.trip_is_locked(v_member.trip_id) then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;
  if v_role not in ('admin', 'member') then
    perform private.api_error('validation_error',
      'role must be admin or member (ownership transfer is not supported)', 422);
  end if;
  if v_member.role = 'owner' then
    perform private.api_error('forbidden', 'The owner''s role cannot be changed', 403);
  end if;
  if v_member.removed_at is not null then
    perform private.api_error('validation_error', 'This member has left the trip', 422);
  end if;
  if v_member.user_id is null and v_role = 'admin' then
    perform private.api_error('validation_error', 'A placeholder cannot be an admin', 422);
  end if;

  if v_member.role <> v_role then
    update public.trip_members m set role = v_role where m.id = v_member.id returning m.* into v_member;
  end if;
  return to_jsonb(v_member);
end;
$$;

-- POST /rest/v1/rpc/remove_member { member_id }   (admin)
-- Soft removal: removed_at = now(). Expenses, shares and settlements stay.
create or replace function public.remove_member(member_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member public.trip_members;
begin
  perform private.require_user();
  select m.* into v_member from public.trip_members m where m.id = remove_member.member_id for update;
  if not found or not private.is_trip_admin(v_member.trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can remove members', 403);
  end if;
  if private.trip_is_locked(v_member.trip_id) then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;
  if v_member.role = 'owner' then
    perform private.api_error('forbidden', 'The trip owner cannot be removed', 403);
  end if;

  if v_member.removed_at is null then
    update public.trip_members m set removed_at = now() where m.id = v_member.id returning m.* into v_member;
  end if;
  return to_jsonb(v_member);
end;
$$;

-- =============================================================================
-- 5.G Expenses — one transaction each
-- =============================================================================

-- POST /rest/v1/rpc/save_expense
--   { id: null|uuid, trip_id, title, category, amount, currency, paid_by,
--     split_method: 'equal'|'exact', occurred_at, timezone, end_date,
--     location_text, latitude, longitude, photo_path, note,
--     currency_manually_set, expected_updated_at,
--     participants: [{ member_id, share_amount }] }
-- Returns the expense with expense_participants [{ member_id, share_amount }].
create or replace function public.save_expense(jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  p            jsonb := coalesce($1, '{}'::jsonb);
  v_uid        uuid := private.require_user();
  v_today      date := (now() at time zone 'Asia/Hong_Kong')::date;
  v_id         uuid;
  v_trip_id    uuid;
  v_trip       public.trips;
  v_old        public.expenses;
  v_new        public.expenses;
  v_payer      public.trip_members;
  v_expected   timestamptz;
  v_before     jsonb;
  v_after      jsonb;
  v_decimals   integer;
  v_hkd        numeric;
  v_parts      jsonb;
  v_el         jsonb;
  v_mid        uuid;
  v_ids        uuid[] := '{}';
  v_shares     integer[] := '{}';
  v_old_ids    uuid[] := '{}';
  v_sum        bigint;
  v_n          integer;
  v_q          integer;
  v_r          integer;
begin
  v_id      := private.j_uuid(p, 'id');
  v_trip_id := private.j_uuid(p, 'trip_id', true);

  -- 1. current member, trip not locked (FOR SHARE: serialises with lock_trip)
  select t.* into v_trip from public.trips t where t.id = v_trip_id for share;
  if not found or not private.is_trip_member(v_trip_id) then
    perform private.api_error('forbidden', 'You are not a member of this trip', 403);
  end if;
  if v_trip.is_locked then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;

  -- 3. update: optimistic lock on updated_at (lost-update protection)
  if v_id is not null then
    select e.* into v_old from public.expenses e where e.id = v_id and e.trip_id = v_trip_id for update;
    if not found then
      perform private.api_error('not_found', 'Expense not found', 404);
    end if;
    v_expected := private.j_timestamptz(p, 'expected_updated_at', true);
    v_before := private.expense_json(v_old);
    if v_old.deleted_at is not null or v_old.updated_at <> v_expected then
      perform private.api_error('conflict_updated_at',
        case when v_old.deleted_at is not null then 'This expense was deleted by someone else'
             else 'This expense was changed by someone else' end,
        409, v_before::text);
    end if;
    select coalesce(array_agg(ep.member_id), '{}') into v_old_ids
    from public.expense_participants ep where ep.expense_id = v_id;
  end if;

  -- fields
  v_new.id       := coalesce(v_id, gen_random_uuid());
  v_new.trip_id  := v_trip_id;
  v_new.title    := private.j_text(p, 'title', true, 200);
  v_new.category := private.j_text(p, 'category', true);
  if v_new.category not in ('Food & Drink', 'Transport', 'Accommodation', 'Activities & Tickets',
                            'Shopping', 'Groceries', 'Loan', 'Other') then
    perform private.api_error('validation_error', 'Unknown category ' || v_new.category, 422);
  end if;
  v_new.amount   := private.j_minor(p, 'amount', true, 1);
  v_new.currency := upper(private.j_text(p, 'currency', true, 3));
  select c.decimals into v_decimals from public.currencies c where c.code = v_new.currency;
  if not found then
    perform private.api_error('validation_error', 'Unknown currency ' || v_new.currency, 422);
  end if;
  v_new.split_method := coalesce(private.j_text(p, 'split_method'), 'equal');
  if v_new.split_method not in ('equal', 'exact') then
    perform private.api_error('validation_error', 'split_method must be equal or exact', 422);
  end if;
  v_new.occurred_at := private.j_timestamptz(p, 'occurred_at', true);
  v_new.timezone    := private.j_text(p, 'timezone', true, 64);
  if not private.is_valid_timezone(v_new.timezone) then
    perform private.api_error('validation_error', 'timezone must be an IANA name such as Asia/Tokyo', 422);
  end if;
  -- 4. page assignment comes from the stored instant + zone, never a phone clock
  v_new.local_date := (v_new.occurred_at at time zone v_new.timezone)::date;
  v_new.end_date   := private.j_date(p, 'end_date');
  if v_new.end_date = v_new.local_date then
    v_new.end_date := null;  -- a one-day "range" is an ordinary expense
  elsif v_new.end_date < v_new.local_date then
    perform private.api_error('validation_error', 'end_date must be on or after the expense date', 422);
  elsif v_new.end_date - v_new.local_date >= 366 then
    perform private.api_error('validation_error', 'A multi-day expense can cover at most 366 days', 422);
  end if;
  v_new.location_text := private.j_text(p, 'location_text', false, 300);
  v_new.latitude      := private.j_float(p, 'latitude', -90, 90);
  v_new.longitude     := private.j_float(p, 'longitude', -180, 180);
  if (v_new.latitude is null) <> (v_new.longitude is null) then
    perform private.api_error('validation_error', 'latitude and longitude must be sent together', 422);
  end if;
  v_new.photo_path := private.j_text(p, 'photo_path', false, 300);
  if v_new.photo_path is not null
     and (private.path_trip_id(v_new.photo_path) is distinct from v_trip_id
          or not private.photo_path_ok(v_new.photo_path)) then
    perform private.api_error('validation_error',
      'photo_path must be a trip-photos object of this trip: {trip_id}/{expense_id}/{uuid}.jpg', 422);
  end if;
  v_new.note := private.j_text(p, 'note', false, 2000);
  v_new.currency_manually_set := private.j_bool(p, 'currency_manually_set', false);

  -- 2. paid_by belongs to the trip; a removed member only if already the payer
  v_new.paid_by := private.j_uuid(p, 'paid_by', true);
  select m.* into v_payer from public.trip_members m where m.id = v_new.paid_by and m.trip_id = v_trip_id;
  if not found then
    perform private.api_error('validation_error', 'paid_by must be a member of this trip', 422);
  end if;
  if v_payer.removed_at is not null and v_old.paid_by is distinct from v_new.paid_by then
    perform private.api_error('validation_error', v_payer.display_name || ' has left the trip', 422);
  end if;

  -- 6. participants ("To"); a removed member may stay but never be newly added
  v_parts := p -> 'participants';
  if v_parts is null or jsonb_typeof(v_parts) <> 'array' then
    perform private.api_error('validation_error',
      'participants is required (an empty array makes a personal expense)', 422);
  end if;
  for v_el in select value from jsonb_array_elements(v_parts) loop
    if jsonb_typeof(v_el) <> 'object' then
      perform private.api_error('validation_error', 'each participant must be an object', 422);
    end if;
    v_mid := private.j_uuid(v_el, 'member_id', true);
    if v_mid = any (v_ids) then
      perform private.api_error('validation_error', 'participant ' || v_mid || ' is listed twice', 422);
    end if;
    perform 1 from public.trip_members m
     where m.id = v_mid and m.trip_id = v_trip_id and (m.removed_at is null or v_mid = any (v_old_ids));
    if not found then
      perform private.api_error('validation_error', 'participant ' || v_mid || ' is not a current member of this trip', 422);
    end if;
    v_ids := v_ids || v_mid;
    if v_new.split_method = 'exact' then
      v_shares := v_shares || private.j_minor(v_el, 'share_amount', true, 0);
    end if;
  end loop;

  v_n := cardinality(v_ids);
  if v_n > 0 and v_new.split_method = 'equal' then
    -- AA: server computes; remainder units to members in ascending trip_members.id order
    select array_agg(x order by x) into v_ids from unnest(v_ids) as x;
    v_q := v_new.amount / v_n;
    v_r := v_new.amount % v_n;
    v_shares := '{}';
    for i in 1..v_n loop
      v_shares := v_shares || (v_q + case when i <= v_r then 1 else 0 end);
    end loop;
  elsif v_n > 0 then
    -- AB: typed shares must add up exactly
    select sum(s) into v_sum from unnest(v_shares) as s;
    if v_sum <> v_new.amount then
      perform private.api_error('share_sum_mismatch',
        format('Shares add up to %s but the amount is %s', v_sum, v_new.amount), 422);
    end if;
  end if;

  -- 5. lock FX: past date -> that date's rate (nearest earlier stored day if the
  -- exact day is missing; earliest stored rate if the date predates the
  -- history); today / future -> latest rate. Only on create or when amount,
  -- currency or local_date changed.
  if v_id is null or (v_old.amount, v_old.currency, v_old.local_date)
                     is distinct from (v_new.amount, v_new.currency, v_new.local_date) then
    if v_new.currency = 'HKD' then
      v_new.fx_rate_to_hkd := 1;
      v_new.fx_rate_date   := least(v_new.local_date, v_today);
    else
      select r.rate, r.rate_date into v_new.fx_rate_to_hkd, v_new.fx_rate_date
      from public.fx_rates r
      where r.base_currency = v_new.currency and r.quote_currency = 'HKD'
        and (v_new.local_date >= v_today or r.rate_date <= v_new.local_date)
      order by r.rate_date desc
      limit 1;
      if v_new.fx_rate_to_hkd is null and v_new.local_date < v_today then
        select r.rate, r.rate_date into v_new.fx_rate_to_hkd, v_new.fx_rate_date
        from public.fx_rates r
        where r.base_currency = v_new.currency and r.quote_currency = 'HKD'
        order by r.rate_date asc
        limit 1;
      end if;
      if v_new.fx_rate_to_hkd is null then
        perform private.api_error('fx_rate_missing', 'No exchange rate to HKD is available for ' || v_new.currency, 422);
      end if;
    end if;
    -- exact numeric: amount * 10^-decimals * rate * 100, rounded to HKD cents
    v_hkd := round(v_new.amount::numeric * v_new.fx_rate_to_hkd * 100 / (10::numeric ^ v_decimals));
    if v_hkd > 2147483647 then
      perform private.api_error('validation_error', 'amount is too large', 422);
    end if;
    v_new.amount_hkd := v_hkd::integer;
  else
    v_new.fx_rate_to_hkd := v_old.fx_rate_to_hkd;
    v_new.fx_rate_date   := v_old.fx_rate_date;
    v_new.amount_hkd     := v_old.amount_hkd;
  end if;

  -- write the row (8. updated_at is touched by trigger on update)
  if v_id is null then
    insert into public.expenses (
      id, trip_id, title, category, amount, currency, paid_by, occurred_at, timezone, local_date,
      end_date, location_text, latitude, longitude, photo_path, note, fx_rate_to_hkd, fx_rate_date,
      amount_hkd, currency_manually_set, split_method, created_by)
    values (
      v_new.id, v_new.trip_id, v_new.title, v_new.category, v_new.amount, v_new.currency, v_new.paid_by,
      v_new.occurred_at, v_new.timezone, v_new.local_date, v_new.end_date, v_new.location_text,
      v_new.latitude, v_new.longitude, v_new.photo_path, v_new.note, v_new.fx_rate_to_hkd,
      v_new.fx_rate_date, v_new.amount_hkd, v_new.currency_manually_set, v_new.split_method, v_uid)
    returning * into v_new;
  else
    update public.expenses e
       set title = v_new.title, category = v_new.category, amount = v_new.amount,
           currency = v_new.currency, paid_by = v_new.paid_by, occurred_at = v_new.occurred_at,
           timezone = v_new.timezone, local_date = v_new.local_date, end_date = v_new.end_date,
           location_text = v_new.location_text, latitude = v_new.latitude, longitude = v_new.longitude,
           photo_path = v_new.photo_path, note = v_new.note, fx_rate_to_hkd = v_new.fx_rate_to_hkd,
           fx_rate_date = v_new.fx_rate_date, amount_hkd = v_new.amount_hkd,
           currency_manually_set = v_new.currency_manually_set, split_method = v_new.split_method
     where e.id = v_id
    returning e.* into v_new;
  end if;

  -- 6/7. replace the participant set (equal <-> exact switches land here too)
  delete from public.expense_participants ep
   where ep.expense_id = v_new.id and not (ep.member_id = any (v_ids));
  insert into public.expense_participants as ep (expense_id, member_id, share_amount)
  select v_new.id, x.member_id, x.share_amount
  from unnest(v_ids, v_shares) as x (member_id, share_amount)
  on conflict (expense_id, member_id) do update
     set share_amount = excluded.share_amount
   where ep.share_amount is distinct from excluded.share_amount;

  -- 9/10. activity log + notifications (payer and To, old and new, not the actor)
  v_after := private.expense_json(v_new);
  if v_id is null then
    perform private.write_log(v_trip_id, 'create', 'expense', v_new.id, null, v_after);
    perform private.notify(v_trip_id, 'expense_added',
                           private.member_user_ids(v_ids || v_new.paid_by), private.expense_notice(v_new));
  elsif (v_before - 'updated_at') is distinct from (v_after - 'updated_at') then
    perform private.write_log(v_trip_id, 'update', 'expense', v_new.id, v_before, v_after);
    perform private.notify(v_trip_id, 'expense_updated',
                           private.member_user_ids(v_ids || v_old_ids || v_new.paid_by || v_old.paid_by),
                           private.expense_notice(v_new));
  end if;

  return v_after;
end;
$$;

-- POST /rest/v1/rpc/soft_delete_expense { expense_id, expected_updated_at }
create or replace function public.soft_delete_expense(expense_id uuid, expected_updated_at timestamptz)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old     public.expenses;
  v_new     public.expenses;
  v_old_ids uuid[];
begin
  perform private.require_user();
  select e.* into v_old from public.expenses e where e.id = soft_delete_expense.expense_id for update;
  if not found then
    perform private.api_error('not_found', 'Expense not found', 404);
  end if;
  if not private.is_trip_member(v_old.trip_id) then
    perform private.api_error('forbidden', 'You are not a member of this trip', 403);
  end if;
  if private.trip_is_locked(v_old.trip_id) then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;
  if soft_delete_expense.expected_updated_at is null then
    perform private.api_error('validation_error', 'expected_updated_at is required', 422);
  end if;
  if v_old.deleted_at is not null or v_old.updated_at <> soft_delete_expense.expected_updated_at then
    perform private.api_error('conflict_updated_at',
      case when v_old.deleted_at is not null then 'This expense was already deleted'
           else 'This expense was changed by someone else' end,
      409, private.expense_json(v_old)::text);
  end if;

  update public.expenses e set deleted_at = clock_timestamp() where e.id = v_old.id returning e.* into v_new;

  select coalesce(array_agg(ep.member_id), '{}') into v_old_ids
  from public.expense_participants ep where ep.expense_id = v_old.id;
  perform private.write_log(v_old.trip_id, 'delete', 'expense', v_old.id,
                            private.expense_json(v_old), private.expense_json(v_new));
  perform private.notify(v_old.trip_id, 'expense_deleted',
                         private.member_user_ids(v_old_ids || v_old.paid_by), private.expense_notice(v_new));
  return private.expense_json(v_new);
end;
$$;

-- POST /rest/v1/rpc/restore_expense { expense_id }   (current member, unlocked)
create or replace function public.restore_expense(expense_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.expenses;
  v_new public.expenses;
begin
  perform private.require_user();
  select e.* into v_old from public.expenses e where e.id = restore_expense.expense_id for update;
  if not found then
    perform private.api_error('not_found', 'Expense not found', 404);
  end if;
  if not private.is_trip_member(v_old.trip_id) then
    perform private.api_error('forbidden', 'You are not a member of this trip', 403);
  end if;
  if private.trip_is_locked(v_old.trip_id) then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;
  if v_old.deleted_at is null then
    return private.expense_json(v_old);  -- already live
  end if;

  update public.expenses e set deleted_at = null where e.id = v_old.id returning e.* into v_new;
  perform private.write_log(v_old.trip_id, 'restore', 'expense', v_old.id,
                            private.expense_json(v_old), private.expense_json(v_new));
  return private.expense_json(v_new);
end;
$$;

-- =============================================================================
-- 5.H Settlements
-- =============================================================================

-- POST /rest/v1/rpc/record_settlement
--   { trip_id, from_member, to_member, debt_currency, debt_amount,
--     paid_currency, paid_amount, fx_rate?, paid_at?, idempotency_key }
-- Same rules as POST /rest/v1/settlements (shared trigger), plus the §8
-- idempotent_replay contract: a repeated idempotency_key returns the ORIGINAL
-- row with "idempotent_replay": true (HTTP 200) and never records a second
-- payment. (A repeated key on the plain table POST is a 409 unique violation.)
create or replace function public.record_settlement(jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  p         jsonb := coalesce($1, '{}'::jsonb);
  v_trip_id uuid;
  v_key     text;
  v_row     public.settlements;
begin
  perform private.require_user();
  v_trip_id := private.j_uuid(p, 'trip_id', true);
  v_key     := private.j_text(p, 'idempotency_key', true, 200);
  if not private.is_trip_member(v_trip_id) then
    perform private.api_error('forbidden', 'You are not a member of this trip', 403);
  end if;

  select s.* into v_row from public.settlements s where s.trip_id = v_trip_id and s.idempotency_key = v_key;
  if found then
    return to_jsonb(v_row) || jsonb_build_object('idempotent_replay', true);
  end if;

  insert into public.settlements (
    trip_id, from_member, to_member, debt_currency, debt_amount, paid_currency, paid_amount,
    fx_rate, paid_at, idempotency_key)
  values (
    v_trip_id,
    private.j_uuid(p, 'from_member', true),
    private.j_uuid(p, 'to_member', true),
    private.j_text(p, 'debt_currency', true, 3),
    private.j_minor(p, 'debt_amount', true, 1),
    private.j_text(p, 'paid_currency', true, 3),
    private.j_minor(p, 'paid_amount', true, 1),
    private.j_rate(p, 'fx_rate'),
    coalesce(private.j_timestamptz(p, 'paid_at'), now()),
    v_key)
  on conflict (trip_id, idempotency_key) do nothing
  returning * into v_row;

  if not found then  -- lost a race with the same key
    select s.* into v_row from public.settlements s where s.trip_id = v_trip_id and s.idempotency_key = v_key;
    return to_jsonb(v_row) || jsonb_build_object('idempotent_replay', true);
  end if;
  return to_jsonb(v_row) || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- =============================================================================
-- 5.F Join + invite rotation — service_role only, called by the Edge
-- Functions after they verify the caller's JWT. join_trip_as reports failures
-- as a result (not an exception) so the rate-limit attempt row is committed.
-- =============================================================================

create or replace function private.join_failure(status integer, code text, message text) returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'status', status, 'code', code, 'message', message);
$$;

create or replace function private.join_preview(t public.trips) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'trip', jsonb_build_object('id', t.id, 'name', t.name, 'start_date', t.start_date, 'end_date', t.end_date),
    'placeholders', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'display_name', m.display_name) order by m.joined_at, m.id)
      from public.trip_members m
      where m.trip_id = t.id and m.user_id is null and m.removed_at is null), '[]'::jsonb));
$$;

create or replace function public.join_trip_as(
  p_user_id              uuid,
  p_code                 text    default null,
  p_token                text    default null,
  p_claim_placeholder_id uuid    default null,
  p_preview              boolean default false,
  p_client_hash          text    default null,
  p_max_user_failures    integer default 10,
  p_max_client_failures  integer default 30,
  p_window_minutes       integer default 15
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_since        timestamptz := now() - make_interval(mins => greatest(coalesce(p_window_minutes, 15), 1));
  v_code         text := nullif(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_token        text := nullif(btrim(coalesce(p_token, '')), '');
  v_target       text;
  v_trip_id      uuid;
  v_trip         public.trips;
  v_member       public.trip_members;
  v_profile_name text;
begin
  if p_user_id is null or not exists (select 1 from public.profiles pr where pr.id = p_user_id) then
    return private.join_failure(401, 'unauthenticated', 'Sign in first');
  end if;
  if (v_code is null) = (v_token is null) then
    return private.join_failure(422, 'validation_error', 'Send either code or token');
  end if;
  v_target := encode(extensions.digest(coalesce(v_code, v_token), 'sha256'), 'hex');

  -- 1. rate limit failed lookups per user and per client (IP hash)
  if (select count(*) from private.join_attempts a
      where a.user_id = p_user_id and a.outcome = 'invalid' and a.created_at > v_since)
       >= coalesce(p_max_user_failures, 10)
     or (p_client_hash is not null
         and (select count(*) from private.join_attempts a
              where a.client_hash = p_client_hash and a.outcome = 'invalid' and a.created_at > v_since)
             >= coalesce(p_max_client_failures, 30)) then
    insert into private.join_attempts (user_id, client_hash, target_hash, outcome)
    values (p_user_id, p_client_hash, v_target, 'blocked');
    return private.join_failure(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
  end if;

  -- 2. resolve the invite
  select i.trip_id into v_trip_id
  from public.trip_invites i
  where (v_code is not null and i.invite_code = v_code)
     or (v_token is not null and i.invite_token = v_token);
  if v_trip_id is null then
    insert into private.join_attempts (user_id, client_hash, target_hash, outcome)
    values (p_user_id, p_client_hash, v_target, 'invalid');
    return private.join_failure(404, 'invite_invalid', 'This invite link or code is not valid');
  end if;
  insert into private.join_attempts (user_id, client_hash, target_hash, outcome)
  values (p_user_id, p_client_hash, v_target, 'valid');

  select t.* into v_trip from public.trips t where t.id = v_trip_id for update;
  perform private.act_as(p_user_id);  -- triggers attribute log rows / notifications to the joiner

  -- 3. already a current member: idempotent
  select m.* into v_member from public.trip_members m
  where m.trip_id = v_trip_id and m.user_id = p_user_id and m.removed_at is null;
  if found then
    return jsonb_build_object('ok', true, 'trip_id', v_trip_id, 'member_id', v_member.id,
                              'claimed', false, 'already_member', true,
                              'joining_enabled', v_trip.joining_enabled)
        || case when p_preview then private.join_preview(v_trip) else '{}'::jsonb end;
  end if;

  if not v_trip.joining_enabled then
    return private.join_failure(403, 'joining_disabled', 'Joining is turned off for this trip');
  end if;
  if v_trip.is_locked then
    return private.join_failure(403, 'trip_locked', 'This trip is locked');
  end if;

  -- preview: lets the UI offer "join as new member" vs "I am <placeholder>"
  if p_preview then
    return jsonb_build_object('ok', true, 'trip_id', v_trip_id, 'already_member', false,
                              'joining_enabled', true)
        || private.join_preview(v_trip);
  end if;

  select nullif(btrim(pr.display_name), '') into v_profile_name from public.profiles pr where pr.id = p_user_id;
  if v_profile_name is null then
    return private.join_failure(422, 'validation_error', 'Set your display name before joining a trip');
  end if;

  -- 4. claim: fill user_id on the SAME trip_members.id
  if p_claim_placeholder_id is not null then
    update public.trip_members m
       set user_id = p_user_id, display_name = coalesce(v_profile_name, m.display_name), joined_at = now()
     where m.id = p_claim_placeholder_id and m.trip_id = v_trip_id
       and m.user_id is null and m.removed_at is null
    returning m.* into v_member;
    if not found then
      return private.join_failure(422, 'validation_error', 'That placeholder is not available to claim');
    end if;
    return jsonb_build_object('ok', true, 'trip_id', v_trip_id, 'member_id', v_member.id, 'claimed', true);
  end if;

  -- 5. join as a member; someone who left before gets their old row back
  -- (never a second row for the same person)
  update public.trip_members m
     set removed_at = null, joined_at = now(), role = 'member', display_name = v_profile_name
   where m.id = (select m2.id from public.trip_members m2
                 where m2.trip_id = v_trip_id and m2.user_id = p_user_id
                 order by m2.removed_at desc limit 1)
  returning m.* into v_member;
  if not found then
    insert into public.trip_members (trip_id, user_id, display_name, role)
    values (v_trip_id, p_user_id, v_profile_name, 'member')
    returning * into v_member;
  end if;
  return jsonb_build_object('ok', true, 'trip_id', v_trip_id, 'member_id', v_member.id, 'claimed', false);
end;
$$;

create or replace function public.regenerate_invite_as(p_user_id uuid, p_trip_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_invite public.trip_invites;
begin
  if p_user_id is null then
    perform private.api_error('unauthenticated', 'Sign in first', 401);
  end if;
  perform private.act_as(p_user_id);
  if not private.is_trip_admin(p_trip_id) then
    perform private.api_error('forbidden', 'Only trip admins can regenerate the invite', 403);
  end if;
  if private.trip_is_locked(p_trip_id) then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;

  -- old link and code stop working the moment this commits
  update public.trip_invites i
     set invite_token = private.new_invite_token(), invite_code = private.new_invite_code(), created_at = now()
   where i.trip_id = p_trip_id
  returning i.* into v_invite;
  if not found then
    insert into public.trip_invites (trip_id, invite_token, invite_code)
    values (p_trip_id, private.new_invite_token(), private.new_invite_code())
    returning * into v_invite;
  end if;
  return jsonb_build_object('invite_token', v_invite.invite_token, 'invite_code', v_invite.invite_code,
                            'join_path', '/join/' || v_invite.invite_token);
end;
$$;

-- =============================================================================
-- 5.K FX — called by fetch_fx_rates with the vendor's raw rates as strings.
--   p_rates = { "<CODE>": "<units of CODE per 1 p_vendor_base>", ... }
-- Stores CODE->HKD and HKD->CODE for every seeded currency, computed and
-- inverted in numeric (never float). Returns the codes the vendor lacked.
-- =============================================================================
create or replace function public.upsert_fx_rates(
  p_rate_date date, p_vendor_base text, p_rates jsonb, p_source text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_base    text := upper(btrim(p_vendor_base));
  v_hkd     numeric;
  v_x       numeric;
  v_to_hkd  numeric;
  v_from    numeric;
  v_code    text;
  v_stored  integer := 0;
  v_missing text[] := '{}';
begin
  if p_rate_date is null or p_rates is null or jsonb_typeof(p_rates) <> 'object'
     or coalesce(btrim(p_source), '') = '' then
    raise exception 'upsert_fx_rates: rate_date, rates object and source are required';
  end if;
  v_hkd := case when v_base = 'HKD' then 1 else private.try_numeric(p_rates ->> 'HKD') end;
  if v_hkd is null or v_hkd <= 0 then
    raise exception 'upsert_fx_rates: vendor rates contain no HKD rate';
  end if;

  for v_code in select c.code from public.currencies c where c.code <> 'HKD' order by c.code loop
    v_x := case when v_code = v_base then 1 else private.try_numeric(p_rates ->> v_code) end;
    if v_x is null or v_x <= 0 then
      v_missing := v_missing || v_code;
      continue;
    end if;
    v_to_hkd := round(v_hkd / v_x, 14);  -- 1 CODE = v_to_hkd HKD
    v_from   := round(v_x / v_hkd, 14);  -- 1 HKD  = v_from CODE
    if v_to_hkd <= 0 or v_from <= 0 then
      v_missing := v_missing || v_code;
      continue;
    end if;
    insert into public.fx_rates (rate_date, base_currency, quote_currency, rate, source)
    values (p_rate_date, v_code, 'HKD', v_to_hkd, p_source),
           (p_rate_date, 'HKD', v_code, v_from, p_source)
    on conflict (rate_date, base_currency, quote_currency) do update
       set rate = excluded.rate, source = excluded.source;
    v_stored := v_stored + 1;
  end loop;

  return jsonb_build_object('rate_date', p_rate_date, 'currencies_stored', v_stored,
                            'missing', to_jsonb(v_missing));
end;
$$;

-- =============================================================================
-- Function privileges: nothing is executable by default; grant per role.
-- =============================================================================
revoke all on all functions in schema public  from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.create_trip(jsonb),
  public.update_trip(jsonb),
  public.lock_trip(uuid),
  public.unlock_trip(uuid),
  public.delete_trip(uuid),
  public.get_trip_invite(uuid),
  public.set_member_role(uuid, text),
  public.remove_member(uuid),
  public.save_expense(jsonb),
  public.soft_delete_expense(uuid, timestamptz),
  public.restore_expense(uuid),
  public.record_settlement(jsonb)
to authenticated;

grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;

-- RLS / storage policies are evaluated as the caller, so these must be callable.
grant execute on function
  private.is_trip_member(uuid),
  private.is_trip_admin(uuid),
  private.is_trip_owner(uuid),
  private.trip_is_locked(uuid),
  private.is_expense_member(uuid),
  private.path_trip_id(text),
  private.photo_path_ok(text),
  private.api_error(text, text, integer, text)
to authenticated;
