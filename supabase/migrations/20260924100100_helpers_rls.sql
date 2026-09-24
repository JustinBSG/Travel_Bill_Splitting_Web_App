-- =============================================================================
-- Helpers, Row Level Security and table privileges (requirement §6, §8)
--
-- RLS is the authorizer for PostgREST reads and the few direct writes the API
-- allows. Table privileges are granted explicitly (column lists where it
-- matters) so the result does not depend on the project's default grants.
-- Everything else goes through SECURITY DEFINER RPCs that check explicitly.
-- =============================================================================

grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Error contract (§8). Raises a PostgREST "PGRST" error: HTTP `status`, body
-- { code, message, details, hint } where code is one of the contract codes
-- (forbidden, trip_locked, share_sum_mismatch, ...). Never pass secrets here.
-- -----------------------------------------------------------------------------
create or replace function private.api_error(
  code text, message text, status integer, details text default null
) returns void
language plpgsql
set search_path = ''
as $$
begin
  raise sqlstate 'PGRST' using
    message = json_build_object('code', code, 'message', message, 'details', details, 'hint', null)::text,
    detail  = json_build_object('status', status, 'headers', json_build_object())::text;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS helpers (§6): SECURITY DEFINER, stable, search_path pinned. Definer
-- rights let policies on trip_members call them without recursing into RLS.
-- -----------------------------------------------------------------------------
create or replace function private.is_trip_member(tid uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trip_members m
    where m.trip_id = tid and m.user_id = (select auth.uid()) and m.removed_at is null
  );
$$;

create or replace function private.is_trip_admin(tid uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trip_members m
    where m.trip_id = tid and m.user_id = (select auth.uid()) and m.removed_at is null
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function private.is_trip_owner(tid uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trip_members m
    where m.trip_id = tid and m.user_id = (select auth.uid()) and m.removed_at is null
      and m.role = 'owner'
  );
$$;

create or replace function private.trip_is_locked(tid uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select t.is_locked from public.trips t where t.id = tid), false);
$$;

create or replace function private.is_expense_member(eid uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.expenses e
    join public.trip_members m on m.trip_id = e.trip_id
    where e.id = eid and m.user_id = (select auth.uid()) and m.removed_at is null
  );
$$;

-- Caller's current membership row in a trip (NULL if not a current member).
create or replace function private.current_member_id(tid uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.id from public.trip_members m
  where m.trip_id = tid and m.user_id = (select auth.uid()) and m.removed_at is null;
$$;

-- Activity-log actor: current membership, else the caller's latest row in the
-- trip (e.g. an admin who just removed themself).
create or replace function private.actor_member_id(tid uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.id from public.trip_members m
  where m.trip_id = tid and m.user_id = (select auth.uid())
  order by (m.removed_at is null) desc, m.joined_at desc
  limit 1;
$$;

-- Storage paths are {trip_id}/...; NULL when the first segment is not a uuid.
create or replace function private.path_trip_id(object_name text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

-- {trip_id}/{expense_id}/{uuid}.jpg (any depth of url-safe segments, image extension).
create or replace function private.photo_path_ok(object_name text) returns boolean
language sql immutable
set search_path = ''
as $$
  select object_name ~ '^[0-9a-fA-F-]{36}(/[0-9A-Za-z_-]{1,64}){1,3}\.(jpe?g|png|webp|heic|heif)$'
     and char_length(object_name) <= 300;
$$;

create or replace function private.is_valid_timezone(tz text) returns boolean
language plpgsql stable
set search_path = ''
as $$
begin
  if tz is null or not (tz = 'UTC' or tz ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}$') then
    return false;
  end if;
  perform now() at time zone tz;
  return true;
exception when others then
  return false;
end;
$$;

-- Edge Functions call service-role-only RPCs on behalf of a verified user.
-- Setting the JWT claims for this transaction makes auth.uid() (and therefore
-- every trigger's actor attribution) resolve to that user.
create or replace function private.act_as(uid uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end;
$$;

-- -----------------------------------------------------------------------------
-- JSON body readers for the jsonb RPCs. Each raises validation_error (422)
-- with the field name. Money readers accept a JSON integer or a digit string
-- and reject anything fractional ("never accept JS-number / float amounts").
-- -----------------------------------------------------------------------------
create or replace function private.j_text(
  p jsonb, k text, required boolean default false, max_len integer default null
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  s text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if required then perform private.api_error('validation_error', k || ' is required', 422); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform private.api_error('validation_error', k || ' must be a string', 422);
  end if;
  s := btrim(v #>> '{}');
  if s = '' then
    if required then perform private.api_error('validation_error', k || ' is required', 422); end if;
    return null;
  end if;
  if max_len is not null and char_length(s) > max_len then
    perform private.api_error('validation_error', k || ' is too long (max ' || max_len || ' characters)', 422);
  end if;
  return s;
end;
$$;

create or replace function private.j_uuid(p jsonb, k text, required boolean default false) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if required then perform private.api_error('validation_error', k || ' is required', 422); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string'
     or (v #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    perform private.api_error('validation_error', k || ' must be a uuid', 422);
  end if;
  return (v #>> '{}')::uuid;
end;
$$;

create or replace function private.j_minor(
  p jsonb, k text, required boolean default false, min_value integer default 1
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  s text;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if required then perform private.api_error('validation_error', k || ' is required', 422); end if;
    return null;
  end if;
  if jsonb_typeof(v) = 'number' then
    s := v::text;
  elsif jsonb_typeof(v) = 'string' then
    s := btrim(v #>> '{}');
  else
    perform private.api_error('validation_error', k || ' must be an integer amount in minor units', 422);
  end if;
  if s !~ '^-?[0-9]{1,12}$' then
    perform private.api_error('validation_error', k || ' must be an integer amount in minor units', 422);
  end if;
  n := s::numeric;
  if n < min_value or n > 2147483647 then
    perform private.api_error('validation_error', k || ' is out of range', 422);
  end if;
  return n::integer;
end;
$$;

create or replace function private.j_date(p jsonb, k text, required boolean default false) returns date
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  d date;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if required then perform private.api_error('validation_error', k || ' is required', 422); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform private.api_error('validation_error', k || ' must be a date (YYYY-MM-DD)', 422);
  end if;
  begin
    d := (v #>> '{}')::date;
  exception when others then
    d := null;
  end;
  if d is null then
    perform private.api_error('validation_error', k || ' is not a valid date', 422);
  end if;
  return d;
end;
$$;

-- ISO 8601 with an explicit offset or Z, so the instant never depends on the
-- server's session time zone.
create or replace function private.j_timestamptz(p jsonb, k text, required boolean default false)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  t timestamptz;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if required then perform private.api_error('validation_error', k || ' is required', 422); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string'
     or (v #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    perform private.api_error('validation_error',
      k || ' must be an ISO 8601 timestamp with a UTC offset, e.g. 2026-10-13T14:10:00+09:00', 422);
  end if;
  begin
    t := (v #>> '{}')::timestamptz;
  exception when others then
    t := null;
  end;
  if t is null then
    perform private.api_error('validation_error', k || ' is not a valid timestamp', 422);
  end if;
  return t;
end;
$$;

create or replace function private.j_bool(p jsonb, k text, default_value boolean) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
begin
  if v is null or jsonb_typeof(v) = 'null' then return default_value; end if;
  if jsonb_typeof(v) <> 'boolean' then
    perform private.api_error('validation_error', k || ' must be true or false', 422);
  end if;
  return v::text::boolean;
end;
$$;

create or replace function private.j_float(
  p jsonb, k text, min_value double precision, max_value double precision
) returns double precision
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  f double precision;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) <> 'number' then
    perform private.api_error('validation_error', k || ' must be a number', 422);
  end if;
  f := v::text::double precision;
  if f < min_value or f > max_value then
    perform private.api_error('validation_error', k || ' is out of range', 422);
  end if;
  return f;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security (§6). A table without a policy is closed, not public.
-- -----------------------------------------------------------------------------
alter table public.currencies            enable row level security;
alter table public.profiles              enable row level security;
alter table public.trips                 enable row level security;
alter table public.trip_invites          enable row level security;
alter table public.trip_days             enable row level security;
alter table public.trip_members          enable row level security;
alter table public.expenses              enable row level security;
alter table public.expense_participants  enable row level security;
alter table public.settlements           enable row level security;
alter table public.activity_log          enable row level security;
alter table public.notifications         enable row level security;
alter table public.notification_settings enable row level security;
alter table public.push_subscriptions    enable row level security;
alter table public.fx_rates              enable row level security;
alter table private.join_attempts        enable row level security;

-- profiles: own row only
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- reference data
create policy currencies_select on public.currencies
  for select to authenticated using (true);
create policy fx_rates_select on public.fx_rates
  for select to authenticated using (true);

-- trips: current members read; admins rename / toggle joining while unlocked.
-- INSERT via create_trip, DELETE via delete_trip, is_locked via lock/unlock RPCs.
create policy trips_select_member on public.trips
  for select to authenticated using (private.is_trip_member(id));
create policy trips_update_admin on public.trips
  for update to authenticated
  using (private.is_trip_admin(id) and not is_locked)
  with check (private.is_trip_admin(id) and not is_locked);

-- trip_invites: admins only; rows are written by create_trip / regenerate_invite
create policy trip_invites_select_admin on public.trip_invites
  for select to authenticated using (private.is_trip_admin(trip_id));

-- trip_days: members read; admins edit while unlocked
create policy trip_days_select_member on public.trip_days
  for select to authenticated using (private.is_trip_member(trip_id));
create policy trip_days_insert_admin on public.trip_days
  for insert to authenticated
  with check (private.is_trip_admin(trip_id) and not private.trip_is_locked(trip_id));
create policy trip_days_update_admin on public.trip_days
  for update to authenticated
  using (private.is_trip_admin(trip_id) and not private.trip_is_locked(trip_id))
  with check (private.is_trip_admin(trip_id) and not private.trip_is_locked(trip_id));
create policy trip_days_delete_admin on public.trip_days
  for delete to authenticated
  using (private.is_trip_admin(trip_id) and not private.trip_is_locked(trip_id));

-- trip_members: members read (incl. removed rows, shown as "left the trip");
-- any current member may add a placeholder while unlocked. Role changes,
-- removal, joining and claiming go through RPCs / join_trip.
create policy trip_members_select_member on public.trip_members
  for select to authenticated using (private.is_trip_member(trip_id));
create policy trip_members_insert_placeholder on public.trip_members
  for insert to authenticated
  with check (
    private.is_trip_member(trip_id) and not private.trip_is_locked(trip_id)
    and user_id is null and role = 'member' and removed_at is null
  );

-- expenses: members read. The write policies below are the §6 rule; table
-- privileges are NOT granted for writes, so expenses change only through
-- save_expense / soft_delete_expense / restore_expense (one transaction with
-- participants, FX lock and log). No DELETE policy at all.
create policy expenses_select_member on public.expenses
  for select to authenticated using (private.is_trip_member(trip_id));
create policy expenses_insert_member on public.expenses
  for insert to authenticated
  with check (private.is_trip_member(trip_id) and not private.trip_is_locked(trip_id));
create policy expenses_update_member on public.expenses
  for update to authenticated
  using (private.is_trip_member(trip_id) and not private.trip_is_locked(trip_id))
  with check (private.is_trip_member(trip_id) and not private.trip_is_locked(trip_id));

-- expense_participants: read-only here; written only by save_expense
create policy expense_participants_select_member on public.expense_participants
  for select to authenticated using (private.is_expense_member(expense_id));

-- settlements: members read; members record repayments while unlocked
create policy settlements_select_member on public.settlements
  for select to authenticated using (private.is_trip_member(trip_id));
create policy settlements_insert_member on public.settlements
  for insert to authenticated
  with check (
    private.is_trip_member(trip_id) and not private.trip_is_locked(trip_id)
    and created_by = (select auth.uid())
  );

-- activity_log: members read; rows come from triggers / RPCs only
create policy activity_log_select_member on public.activity_log
  for select to authenticated using (private.is_trip_member(trip_id));

-- notifications: own rows; the client may only set read_at
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- notification_settings / push_subscriptions: own rows, all verbs
create policy notification_settings_own on public.notification_settings
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Table privileges. Start from nothing, then grant exactly what the REST
-- catalog (§5) needs. anon gets nothing: every call is authenticated.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

grant select                           on public.currencies            to authenticated;
grant select                           on public.fx_rates              to authenticated;
grant select                           on public.profiles              to authenticated;
grant update (display_name, language)  on public.profiles              to authenticated;
grant select                           on public.trips                 to authenticated;
grant update (name, joining_enabled)   on public.trips                 to authenticated;
grant select                           on public.trip_invites          to authenticated;
grant select, insert, update, delete   on public.trip_days             to authenticated;
grant select                           on public.trip_members          to authenticated;
grant insert (trip_id, user_id, display_name, role)
                                       on public.trip_members          to authenticated;
grant select                           on public.expenses              to authenticated;
grant select                           on public.expense_participants  to authenticated;
grant select                           on public.settlements           to authenticated;
grant insert (trip_id, from_member, to_member, debt_currency, debt_amount,
              paid_currency, paid_amount, fx_rate, paid_at, idempotency_key)
                                       on public.settlements           to authenticated;
grant select                           on public.activity_log          to authenticated;
grant select                           on public.notifications         to authenticated;
grant update (read_at)                 on public.notifications         to authenticated;
grant select, insert, update, delete   on public.notification_settings to authenticated;
grant select, insert, update, delete   on public.push_subscriptions    to authenticated;

-- Edge Functions (service role) read subscriptions/settings, prune dead push
-- endpoints and upsert FX rates. The hard-delete / append-only triggers still
-- apply to this role.
grant select, insert, update, delete on all tables in schema public to service_role;
